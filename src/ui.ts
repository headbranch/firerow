import readlineCore from 'node:readline';
import readline from 'node:readline/promises';
import { encodeCell, type Column, type PValue } from './codec.js';
import { deletableColumns, type Conflict, type Plan, type UntypedColumn } from './diff.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (code: number) => `\x1b[${code}m`;
/**
 * Wrap text in a style that ends with its own off-code (not a full reset), and re-open the style
 * after any nested text that turns it off — so yellow(`run ${cmd('firerow push')} now`) stays yellow.
 */
const paint = (on: number, off: number) => (s: string) =>
  (tty ? esc(on) + s.split(esc(off)).join(esc(off) + esc(on)) + esc(off) : s);
export const green = paint(32, 39);
export const red = paint(31, 39);
export const yellow = paint(33, 39);
export const dim = paint(2, 22);
export const bold = paint(1, 22);

/**
 * A command to run next, e.g. cmd('firerow push users'): bold cyan, or "quoted" without colour.
 * Opens with one combined code (normal intensity, bold, cyan) so it isn't dimmed inside dim text,
 * and closes with the separate off-codes that the surrounding style re-opens after.
 */
export const cmd = (s: string) => (tty ? `\x1b[22;1;36m${s}${esc(39)}${esc(22)}` : `"${s}"`);

/** A full-width rule and a heading, so each collection's output stands apart when skimming. */
export function section(title: string): void {
  const width = Math.max(20, (process.stdout.columns || 80) - 1);
  console.log(`\n${dim('─'.repeat(width))}\n${title}`);
}

export async function ask(question: string, fallback = ''): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

/**
 * Wait for a single keypress (no Enter needed) and return it: a character like "c", or "enter".
 * Ctrl+C returns null. Without a terminal, falls back to reading a line ("" counts as "enter").
 */
export async function readKey(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const line = (await rl.question(question)).trim();
      return line === '' ? 'enter' : line;
    } catch {
      return null; // input closed
    } finally {
      rl.close();
    }
  }
  process.stdout.write(question);
  const stdin = process.stdin;
  readlineCore.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
      let result: string | null;
      if (key?.ctrl && key.name === 'c') result = null;
      else if (key?.name === 'return' || key?.name === 'enter') result = 'enter';
      else if (str && str.length === 1 && str >= ' ') result = str;
      else return; // arrows, function keys…: keep waiting
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write(result && result !== 'enter' ? `${result}\n` : '\n'); // echo the choice
      resolve(result);
    };
    stdin.on('keypress', onKey);
  });
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return /^y(es)?$/i.test(await ask(`${question} ${dim('[y/N]')} `));
}

export function show(p: PValue | undefined, type: Column['type'] | undefined): string {
  // Fields whose column is gone (e.g. renamed) are shown in their own type.
  const s = encodeCell(p, type ?? p?.t ?? 'any').replace(/\s*\r?\n\s*/g, ' ');
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

export function printPlan(plan: Plan, columns: Column[], base: Map<string, { fields: Record<string, PValue> }>): void {
  const typeOf = (f: string) => columns.find((c) => c.field === f)?.type;
  for (const c of plan.creates) {
    console.log(green(`+ create ${c.id ?? dim('(auto id)')}`) + dim(`  line ${c.line}`));
    for (const [f, v] of Object.entries(c.fields)) console.log(green(`    ${f}: ${show(v, typeOf(f))}`));
  }
  for (const u of plan.updates) {
    console.log(yellow(`~ update ${u.id}`) + dim(`  line ${u.line}`));
    const before = base.get(u.id)!.fields;
    for (const [f, v] of Object.entries(u.set)) {
      const from = before[f] === undefined ? dim('(absent)') : show(before[f], typeOf(f));
      console.log(`    ${f}: ${from} → ${show(v, typeOf(f))}`);
    }
    for (const f of u.remove) console.log(red(`    ${f}: ${show(before[f], typeOf(f))} → (field removed)`));
  }
  for (const d of plan.deletes) console.log(red(`- delete ${d.id}`));
  const pendingRenames = plan.renames.filter((r) => !r.applied);
  for (const r of pendingRenames) {
    console.log(yellow(`\nLooks like you renamed field "${r.from}" → "${r.to}" (${r.docs} document${r.docs === 1 ? '' : 's'}).`));
    console.log(yellow(`This adds "${r.to}" and keeps "${r.from}". To rename instead, say yes when push asks, or use --rename-fields.`));
  }
  for (const c of deletableColumns(plan)) {
    const n = c.docs.length;
    console.log(yellow(`\nColumn "${c.field}" was removed from the CSV (${n} document${n === 1 ? ' has' : 's have'} it).`));
    console.log(yellow(`The field is kept in Firestore. To delete it, say yes when push asks, or use --delete-fields.`));
  }
  for (const c of plan.untypedColumns) printUntyped(c);
  console.log(`\n${plan.creates.length} to create, ${plan.updates.length} to update, ${plan.deletes.length} to delete.`);
}

// How guessed value types are described: [one, many].
const KIND: Record<PValue['t'], [string, string]> = {
  string: ['text', 'text'], number: ['number', 'numbers'], boolean: ['true/false', 'true/false'],
  timestamp: ['date', 'dates'], map: ['JSON object', 'JSON objects'], array: ['JSON array', 'JSON arrays'],
  null: ['null', 'nulls'], geopoint: ['geopoint', 'geopoints'], reference: ['reference', 'references'], bytes: ['bytes', 'bytes'],
};

/** Warn that a new column has no type, and show what each value was guessed as. */
function printUntyped(c: UntypedColumn): void {
  const counts = new Map<PValue['t'], number>();
  for (const v of c.values) counts.set(v.type, (counts.get(v.type) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const main = sorted[0][0];
  const summary = sorted.map(([t, n]) => `${n} ${KIND[t][n === 1 ? 0 : 1]}`).join(', ');
  console.log(yellow(`\nColumn "${c.field}" has no type set, so each value's type is guessed: ${summary}.`));
  if (sorted.length > 1) {
    const others = c.values.filter((v) => v.type !== main);
    for (const o of others.slice(0, 5)) console.log(yellow(`  line ${o.line}: ${o.text}  (${KIND[o.type][0]})`));
    if (others.length > 5) console.log(yellow(`  …and ${others.length - 5} more`));
  }
  const suggest = main === 'null' ? 'string' : main;
  console.log(dim(sorted.length > 1
    ? `Set a type in the header to be explicit — e.g. "${c.field}:${suggest}" (after fixing the values above), or "${c.field}:any" to keep the mix.`
    : `Set a type in the header to be explicit — e.g. "${c.field}:${suggest}".`));
}

export function printConflicts(conflicts: Conflict[]): void {
  console.log(red(bold(`\n${conflicts.length} conflict(s) with changes made in Firestore since you pulled:`)));
  for (const c of conflicts) console.log(red(`  ${c.id}: ${c.message}`));
}

export function printOrphanWarning(orphans: { path: string; collections: string[] }[]): void {
  console.log(yellow(bold(`\nWarning: ${orphans.length} document(s) you're deleting have subcollections.`)));
  console.log(yellow('Firestore does not delete subcollections with their parent — these will be left behind:'));
  for (const o of orphans) console.log(yellow(`  ${o.path}: ${o.collections.join(', ')}`));
}

export const formatCount = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString('en-US'));

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const [n, unit] = s < 60 ? [0, ''] : s < 3600 ? [s / 60, 'minute'] : s < 86400 ? [s / 3600, 'hour'] : [s / 86400, 'day'];
  if (!unit) return 'just now';
  const r = Math.floor(n);
  return `${r} ${unit}${r === 1 ? '' : 's'} ago`;
}
