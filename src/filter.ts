// Filters for `pull`, written the way you'd write them with the Firestore SDK:
//   --where "branch == 'Scranton'"   --order-by "salesTotal desc"   --limit 10
//   --query "where('salesTotal', '>=', 100000).orderBy('salesTotal', 'desc').limit(10)"
//   --query @top-sellers.txt   (the same, read from a file: no shell quoting rules apply)
import fs from 'node:fs';
import type { Firestore, Query } from 'firebase-admin/firestore';
import { FieldPath, Filter } from 'firebase-admin/firestore';
import { CellError, checkGeo, checkRefPath, decodeCell, isoToTimestamp, toFirestore, type FieldType, type PValue } from './codec.js';

export const OPERATORS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any'] as const;
export type Operator = (typeof OPERATORS)[number];
const LIST_OPERATORS: Operator[] = ['in', 'not-in', 'array-contains-any'];

/**
 * A value as written. `bare` keeps the text of an unquoted value, which takes its column's type;
 * `items` the elements of a list, each typed on its own.
 */
export interface Literal { value: PValue; bare?: string; items?: Literal[] }

export type Condition =
  | { kind: 'where'; field: string; op: Operator; value: Literal }
  | { kind: 'and' | 'or'; conditions: Condition[] };

export interface QuerySpec {
  conditions: Condition[]; // all must match
  orderBy: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  limitToLast?: number;
  /** The filter as the user wrote it, for messages. */
  label: string;
}

export class FilterError extends Error {}

// ---------- Tokens ----------

type Token =
  | { kind: 'str'; text: string }
  | { kind: 'word'; text: string }
  | { kind: 'op'; text: string }
  | { kind: 'punct'; text: string };

const PUNCT = '()[],';
const OP_CHARS = '=!<>';

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let text = '';
      for (i++; ; i++) {
        if (i >= input.length) throw new FilterError(`missing closing ${c} in: ${input}`);
        if (input[i] === c) {
          // A doubled quote is the quote itself: 'O''Brien' (works the same in every shell).
          if (input[i + 1] !== c) break;
          text += c;
          i++;
          continue;
        }
        if (input[i] === '\\' && i + 1 < input.length) {
          const e = input[++i];
          text += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else text += input[i];
      }
      i++;
      out.push({ kind: 'str', text });
    } else if (PUNCT.includes(c) || (c === '.' && out[out.length - 1]?.text === ')')) {
      // "." only separates calls: where(…).orderBy(…). Elsewhere it's part of a word (address.city, 1.5).
      out.push({ kind: 'punct', text: c });
      i++;
    } else if (OP_CHARS.includes(c)) {
      const two = input.slice(i, i + 2);
      const text = ['==', '!=', '<=', '>='].includes(two) ? two : c;
      out.push({ kind: 'op', text });
      i += text.length;
    } else {
      let j = i;
      while (j < input.length && !/\s/.test(input[j]) && !`'"${PUNCT}${OP_CHARS}`.includes(input[j])) j++;
      out.push({ kind: 'word', text: input.slice(i, j) });
      i = j;
    }
  }
  return out;
}

// ---------- Parser ----------

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(private readonly input: string) { this.tokens = tokenize(input); }

  peek(): Token | undefined { return this.tokens[this.pos]; }
  next(): Token | undefined { return this.tokens[this.pos++]; }
  done(): boolean { return this.pos >= this.tokens.length; }
  is(text: string): boolean { const t = this.peek(); return !!t && t.kind !== 'str' && t.text === text; }

  expect(text: string): void {
    if (!this.is(text)) throw this.error(`expected "${text}"`);
    this.pos++;
  }

  error(message: string): FilterError {
    const t = this.peek();
    return new FilterError(`${message} (${t ? `at "${t.text}"` : 'at the end'} in: ${this.input})`);
  }

  field(): string {
    const t = this.next();
    if (!t || t.kind === 'op' || t.kind === 'punct') { this.pos--; throw this.error('expected a field name'); }
    return t.text;
  }

  operator(): Operator {
    const t = this.next();
    if (t && t.kind !== 'punct' && (OPERATORS as readonly string[]).includes(t.text)) return t.text as Operator;
    this.pos--;
    if (t?.text === '=') throw this.error('use == for equality');
    if (t?.text === 'not' || t?.text === 'contains') throw this.error(`use Firestore's operator names (${OPERATORS.join(' ')})`);
    throw this.error(`expected an operator (${OPERATORS.join(' ')})`);
  }

  value(): Literal {
    const t = this.next();
    if (!t) throw this.error('expected a value');
    if (t.kind === 'str') return { value: { t: 'string', v: t.text } };
    if (t.text === '[') {
      const items: Literal[] = [];
      while (!this.is(']')) {
        items.push(this.value());
        if (!this.is(']')) this.expect(',');
      }
      this.pos++;
      return { value: { t: 'array', v: items.map((x) => x.value) }, items };
    }
    if (t.kind !== 'word') { this.pos--; throw this.error('expected a value'); }
    if (this.is('(')) return { value: this.construct(t.text) };
    if (t.text === 'true' || t.text === 'false') return { value: { t: 'boolean', v: t.text === 'true' }, bare: t.text };
    if (t.text === 'null') return { value: { t: 'null' } };
    if (NUMBER.test(t.text)) return { value: { t: 'number', v: Number(t.text) }, bare: t.text };
    return { value: { t: 'string', v: t.text }, bare: t.text };
  }

  /** Timestamp('2005-03-24'), GeoPoint(41.41, -75.66), ref('employees/michael'), Bytes('aGk='). */
  private construct(name: string): PValue {
    const args = this.args();
    const strings = (n: number) => args.length === n && args.every((a) => a.t === 'string');
    const numbers = (n: number) => args.length === n && args.every((a) => a.t === 'number' && typeof a.v === 'number');
    const v = (a: PValue) => (a as { v: string | number }).v;
    try {
      switch (name.toLowerCase()) {
        case 'timestamp': case 'date':
          if (strings(1)) return { t: 'timestamp', v: isoToTimestamp(v(args[0]) as string) };
          if (numbers(2)) return { t: 'timestamp', v: { s: v(args[0]) as number, n: v(args[1]) as number } };
          break;
        case 'geopoint':
          if (numbers(2)) return { t: 'geopoint', v: checkGeo(v(args[0]) as number, v(args[1]) as number, args.map(v).join(', ')) };
          break;
        case 'ref': case 'doc':
          if (strings(1)) return { t: 'reference', v: checkRefPath(v(args[0]) as string) };
          break;
        case 'bytes':
          if (strings(1)) return { t: 'bytes', v: v(args[0]) as string };
          break;
        default:
          throw new FilterError(`unknown value type ${name}() in: ${this.input} — use Timestamp('…'), GeoPoint(lat, lng), ref('path') or Bytes('base64')`);
      }
    } catch (e) {
      if (e instanceof CellError) throw new FilterError(`${e.message} in: ${this.input}`);
      throw e;
    }
    throw new FilterError(`wrong arguments for ${name}() in: ${this.input} — use Timestamp('2005-03-24'), GeoPoint(lat, lng), ref('employees/michael') or Bytes('base64')`);
  }

  private args(): PValue[] {
    this.expect('(');
    const out: PValue[] = [];
    while (!this.is(')')) {
      out.push(this.value().value);
      if (!this.is(')')) this.expect(',');
    }
    this.pos++;
    return out;
  }

  /** field op value. */
  condition(): Condition {
    const field = this.field();
    const op = this.operator();
    const value = this.value();
    return checkCondition({ kind: 'where', field, op, value }, this.input);
  }

  /** The and/or joining two conditions, if that's what comes next. */
  private connective(): 'and' | 'or' | undefined {
    const t = this.peek();
    const word = t?.kind === 'word' ? t.text.toLowerCase() : '';
    return word === 'and' || word === 'or' ? word : undefined;
  }

  /**
   * A --where filter: conditions joined by and/or, with parentheses for grouping. Mixing and with
   * or needs parentheses — "a and b or c" is refused rather than read by precedence rules.
   */
  expression(): Condition {
    const conditions = [this.term()];
    let kind: 'and' | 'or' | undefined;
    for (let next = this.connective(); next; next = this.connective()) {
      if (kind && next !== kind) throw this.error('use parentheses when mixing and/or: (a and b) or c, or a and (b or c)');
      kind = next;
      this.pos++;
      conditions.push(this.term());
    }
    return kind ? { kind, conditions } : conditions[0];
  }

  private term(): Condition {
    if (!this.is('(')) return this.condition();
    this.pos++;
    const c = this.expression();
    this.expect(')');
    return c;
  }

  /** The inside of where(…): 'field', 'op', value — or a single or(…)/and(…). */
  whereArgs(): Condition {
    this.expect('(');
    let c: Condition;
    const t = this.peek();
    if (t?.kind === 'word' && (t.text === 'or' || t.text === 'and')) {
      this.pos++;
      c = this.composite(t.text);
    } else {
      const field = this.field();
      this.expect(',');
      const op = this.peek()?.kind === 'str' ? this.quotedOperator() : this.operator();
      this.expect(',');
      c = checkCondition({ kind: 'where', field, op, value: this.value() }, this.input);
    }
    this.expect(')');
    return c;
  }

  private quotedOperator(): Operator {
    const t = this.next()!;
    if ((OPERATORS as readonly string[]).includes(t.text)) return t.text as Operator;
    this.pos--;
    throw this.error(`expected an operator (${OPERATORS.join(' ')})`);
  }

  /** or(where(…), where(…)) / and(…), after the name. */
  composite(kind: 'and' | 'or'): Condition {
    this.expect('(');
    const conditions: Condition[] = [];
    while (!this.is(')')) {
      const t = this.next();
      if (t?.kind === 'word' && t.text === 'where') conditions.push(this.whereArgs());
      else if (t?.kind === 'word' && (t.text === 'or' || t.text === 'and')) conditions.push(this.composite(t.text));
      else { this.pos--; throw this.error('expected where(…), or(…) or and(…)'); }
      if (!this.is(')')) this.expect(',');
    }
    this.pos++;
    if (!conditions.length) throw new FilterError(`${kind}() needs at least one where(…) in: ${this.input}`);
    return { kind, conditions };
  }

  /** A number argument in parentheses, as in limit(10). */
  count(name: string): number {
    this.expect('(');
    const t = this.next();
    this.expect(')');
    return positiveInt(t?.kind === 'word' ? t.text : '', name);
  }
}

function checkCondition(c: Condition & { kind: 'where' }, input: string): Condition {
  const isList = c.value.value.t === 'array';
  if (LIST_OPERATORS.includes(c.op) && !isList) {
    throw new FilterError(`${c.op} needs a list, like ${c.field} ${c.op} ['a', 'b'], in: ${input}`);
  }
  return c;
}

function positiveInt(text: string, name: string): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1) throw new FilterError(`${name} needs a whole number above 0, not "${text}"`);
  return n;
}

/** One --where filter: field op value, or several joined by and/or: "a == 1 or (b > 2 and c < 3)". */
export function parseCondition(input: string): Condition {
  const p = new Parser(input);
  const c = p.expression();
  if (!p.done()) {
    const extra = p.peek()!;
    if (extra.text === ',') throw p.error("to match several values, use a list: in ['a', 'b']");
    if (extra.text === ')') throw p.error('this ) has no matching (');
    throw p.error("unexpected text; put text with spaces in quotes, like 'Dunder Mifflin', and join conditions with and/or");
  }
  return c;
}

/** --query: the SDK's chained form, where(…).orderBy(…).limit(…), or comma-separated where(…), orderBy(…). */
export function parseQuery(input: string, spec: QuerySpec): void {
  const p = new Parser(input);
  if (p.is('.')) p.next();
  while (!p.done()) {
    const t = p.next()!;
    const name = t.kind === 'word' ? t.text : '';
    if (name === 'where') spec.conditions.push(p.whereArgs());
    else if (name === 'or' || name === 'and') spec.conditions.push(p.composite(name));
    else if (name === 'orderBy') {
      p.expect('(');
      const field = p.field();
      let direction: 'asc' | 'desc' = 'asc';
      if (p.is(',')) { p.next(); direction = orderDirection(p.next()?.text ?? '', input); }
      p.expect(')');
      spec.orderBy.push({ field, direction });
    } else if (name === 'limit') spec.limit = p.count('limit()');
    else if (name === 'limitToLast') spec.limitToLast = p.count('limitToLast()');
    else throw new FilterError(`"${t.text}" isn't supported in --query (use where, or, and, orderBy, limit, limitToLast) in: ${input}`);
    if (!p.done() && !p.is('.') && !p.is(',')) throw p.error('expected "." between calls');
    if (!p.done()) p.next();
  }
}

function orderDirection(text: string, input: string): 'asc' | 'desc' {
  if (text === 'asc' || text === 'desc') return text;
  throw new FilterError(`sort direction must be asc or desc, not "${text}", in: ${input}`);
}

/** "salesTotal desc" → a sort. */
export function parseOrderBy(input: string): { field: string; direction: 'asc' | 'desc' } {
  const p = new Parser(input);
  const field = p.field();
  const direction = p.done() ? 'asc' : orderDirection(p.next()!.text, input);
  if (!p.done()) throw p.error('expected "<field> [asc|desc]"');
  return { field, direction };
}

export interface FilterOptions { where?: string[]; orderBy?: string[]; limit?: string; limitToLast?: string; query?: string }

/**
 * --query @file: the query as written in a file, like curl's -d @file. Nothing in it goes through
 * the shell, so quotes and $ are just text. Lines starting with // are comments.
 */
export function readQueryFile(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new FilterError(`can't read the query file "${file}"`);
  }
  const query = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join(' ').replace(/\s+/g, ' ').trim();
  if (!query) throw new FilterError(`the query file "${file}" is empty`);
  return query;
}

/** The query described by pull's options, or undefined when there's no filter. */
export function querySpec(o: FilterOptions): QuerySpec | undefined {
  const spec: QuerySpec = { conditions: [], orderBy: [], label: '' };
  const label: string[] = [];
  if (o.query) {
    const query = o.query.startsWith('@') ? readQueryFile(o.query.slice(1)) : o.query;
    parseQuery(query, spec);
    label.push(query);
  }
  for (const w of o.where ?? []) { spec.conditions.push(parseCondition(w)); label.push(`where ${w}`); }
  for (const s of o.orderBy ?? []) { spec.orderBy.push(parseOrderBy(s)); label.push(`orderBy ${s}`); }
  if (o.limit !== undefined) { spec.limit = positiveInt(o.limit, '--limit'); label.push(`limit ${o.limit}`); }
  if (o.limitToLast !== undefined) { spec.limitToLast = positiveInt(o.limitToLast, '--limit-to-last'); label.push(`limitToLast ${o.limitToLast}`); }

  if (!spec.conditions.length && !spec.orderBy.length && spec.limit === undefined && spec.limitToLast === undefined) return undefined;
  if (spec.limit !== undefined && spec.limitToLast !== undefined) throw new FilterError('use either limit or limitToLast, not both');
  if (spec.limitToLast !== undefined && !spec.orderBy.length) throw new FilterError('limitToLast needs an orderBy, as in Firestore');
  spec.label = label.join(', ');
  return spec;
}

// ---------- Building the Firestore query ----------

/**
 * Give an unquoted value its column's type, as a CSV cell in that column would get it:
 * `extension == 0042` on a string column is the text "0042", `hiredAt > 2005-03-24` on a
 * timestamp column is a date. Quoted text stays text, except in date/reference columns.
 */
export function typed(lit: Literal, type: FieldType | undefined): PValue {
  if (lit.items) return { t: 'array', v: lit.items.map((x) => typed(x, type)) };
  if (!type || type === 'any' || type === 'array' || type === 'map') return lit.value;
  const text = lit.bare ?? (lit.value.t === 'string' && (type === 'timestamp' || type === 'reference') ? lit.value.v : undefined);
  if (text === undefined) return lit.value;
  try { return decodeCell(text, type) ?? lit.value; } catch { return lit.value; }
}

const fieldPath = (f: string) => (f === '_id' ? FieldPath.documentId() : f);

/** Apply the filter to a collection (or collection-group) query. `typeOf` gives a field's column type. */
export function buildQuery(base: Query, spec: QuerySpec, db: Firestore, typeOf: (field: string) => FieldType | undefined, group = false): Query {
  const toFilter = (c: Condition): Filter => {
    if (c.kind !== 'where') return Filter[c.kind](...c.conditions.map(toFilter));
    if (c.field === '_id' && group) throw new FilterError('_id filters can\'t be used with "*" patterns; filter on a field instead');
    return Filter.where(fieldPath(c.field), c.op, toFirestore(typed(c.value, typeOf(c.field)), db));
  };
  let q = base;
  if (spec.conditions.length) q = q.where(spec.conditions.length === 1 ? toFilter(spec.conditions[0]) : Filter.and(...spec.conditions.map(toFilter)));
  for (const o of spec.orderBy) q = q.orderBy(fieldPath(o.field), o.direction);
  if (spec.limit !== undefined) q = q.limit(spec.limit);
  if (spec.limitToLast !== undefined) q = q.limitToLast(spec.limitToLast);
  return q;
}
