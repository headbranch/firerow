// Pure logic for `firerow edit`: combine CSV rows into one temporary sheet (rows identified
// by a `_path` column), and split an edited sheet back into the collection CSVs.
//
// Two kinds of sheet:
//   • collection sheet — every row of the collections; rows can be added and deleted.
//   • document sheet   — only the documents you named; their rows can't be added or removed,
//                         and every other row of those collections is left exactly as it was.
import { parse } from 'csv-parse/sync';
import {
  CellError, decodeCell, encodeCell, formatHeader, inferColumnType, parseHeader,
  type Column, type FieldType, type PValue,
} from './codec.js';
import { canonical, computePlan, CONFLICT_START, PlanError } from './diff.js';
import { parseCollectionPath, isPattern } from './paths.js';
import type { Snapshot } from './snapshot.js';
import { ID_COLUMN, parseCsv, rowsToCsv, type Table } from './table.js';
import { cmd } from './ui.js';

const PATH_COLUMN = '_path';

export interface SheetSource { name: string; file: string; table: Table }

/** What the sheet started from — needed to split it back correctly. */
export interface SheetLayout {
  collections: string[];
  /** Sheet columns when it was created (a column missing later was removed). */
  columns: Column[];
  /** Each collection's own columns when the sheet was created. */
  fileColumns: Record<string, Column[]>;
  /** Document sheet: the paths of the documents it edits (and nothing else). */
  documents?: string[];
  /** Per collection, the columns whose header had no type (their values are guessed one by one). */
  fileUntyped?: Record<string, string[]>;
}

interface Row { id: string; values: Record<string, PValue> }

function decodeRows(table: Table, where: (line: number, field?: string) => string, problems: string[]): Row[] {
  return table.rows.map((r) => {
    const values: Record<string, PValue> = {};
    table.columns.forEach((c, j) => {
      const text = r.cells[j];
      if (text.trimStart().startsWith(CONFLICT_START)) {
        problems.push(`${where(r.line, c.field)}: unresolved conflict`);
        return;
      }
      try {
        const v = decodeCell(text, c.type);
        if (v !== undefined) values[c.field] = v;
      } catch (e) {
        if (!(e instanceof CellError)) throw e;
        problems.push(`${where(r.line, c.field)}: ${e.message}`);
      }
    });
    return { id: r.id, values };
  });
}

/**
 * Build the sheet. Every source must decode cleanly first. With `documents` (collection →
 * ids), only those rows go in: a document sheet.
 */
export function buildSheet(sources: SheetSource[], documents?: Map<string, Set<string>>): { text: string; layout: SheetLayout; rows: number; problems: string[] } {
  const problems: string[] = [];
  const types = new Map<string, Set<FieldType>>();
  for (const s of sources) {
    for (const c of s.table.columns) {
      if (!types.has(c.field)) types.set(c.field, new Set());
      types.get(c.field)!.add(c.type);
    }
  }
  // A column keeps its type when every collection agrees on it; otherwise it holds JSON (`any`).
  const columns: Column[] = [...types].map(([field, ts]) => ({ field, type: ts.size === 1 ? [...ts][0] : 'any' }));
  // Left untyped in every collection that has it → stays untyped in the sheet too.
  const bare = (f: string) => sources.every((s) => !s.table.columns.some((c) => c.field === f) || !!s.table.untyped?.has(f));

  const body: string[][] = [];
  const paths: string[] = [];
  for (const s of sources) {
    const rows = decodeRows(s.table, (line, field) => `${s.file} line ${line}${field ? `, column "${field}"` : ''}`, problems);
    const wanted = documents?.get(s.name);
    for (const id of wanted ?? []) {
      if (!rows.some((r) => r.id === id)) problems.push(`${s.name}/${id} isn't in your local copy — run ${cmd(`firerow pull ${s.name}/${id}`)} first`);
    }
    for (const r of rows) {
      if (wanted && !wanted.has(r.id)) continue;
      paths.push(`${s.name}/${r.id}`);
      body.push([`${s.name}/${r.id}`, ...columns.map((c) => encodeCell(r.values[c.field], c.type))]);
    }
  }
  return {
    text: rowsToCsv([[PATH_COLUMN, ...columns.map((c) => formatHeader(c, bare(c.field)))], ...body]),
    layout: {
      collections: sources.map((s) => s.name),
      columns,
      fileColumns: Object.fromEntries(sources.map((s) => [s.name, s.table.columns])),
      fileUntyped: Object.fromEntries(sources.map((s) => [s.name, [...(s.table.untyped ?? [])]])),
      ...(documents && { documents: paths }),
    },
    rows: body.length,
    problems,
  };
}

/** Does every value fit this column type (so the collection can keep it)? */
const fits = (type: FieldType, values: PValue[]) =>
  type === 'any' || values.every((v) => v.t === type || (v.t === 'null' && type !== 'string'));

/**
 * Write one collection's CSV. It keeps its own column order and types where its values still
 * fit them (`keep` decides which of its own columns survive), then gains any sheet column it
 * now has values for.
 */
function collectionCsv(own: Column[], docs: Row[], sheetColumns: Column[], keep: (field: string) => boolean, bare: (field: string) => boolean): string {
  const valuesOf = (f: string) => docs.flatMap((d) => (d.values[f] === undefined ? [] : [d.values[f]]));
  const fields = [
    ...own.map((c) => c.field).filter(keep),
    ...sheetColumns.map((c) => c.field).filter((f) => !own.some((c) => c.field === f) && valuesOf(f).length),
  ];
  const cols: Column[] = fields.map((field) => {
    const values = valuesOf(field);
    const ownType = own.find((c) => c.field === field)?.type;
    const sheetType = sheetColumns.find((c) => c.field === field)?.type ?? 'string';
    if (ownType && fits(ownType, values)) return { field, type: ownType };
    if (!values.length) return { field, type: ownType ?? sheetType };
    return { field, type: inferColumnType(new Set(values.map((v) => v.t))) };
  });
  return rowsToCsv([
    [ID_COLUMN, ...cols.map((c) => formatHeader(c, bare(c.field)))],
    ...docs.map((d) => [d.id, ...cols.map((c) => encodeCell(d.values[c.field], c.type))]),
  ]);
}

/**
 * Split an edited sheet back into one CSV per collection. A document sheet needs the
 * collections' `current` tables, since it only replaces the rows it holds.
 */
export function splitSheet(text: string | Buffer, layout: SheetLayout, current?: Map<string, Table>): { files: Map<string, string>; problems: string[] } {
  const problems: string[] = [];
  const files = new Map<string, string>();
  if (Buffer.isBuffer(text) && text.subarray(0, 2).toString() === 'PK') {
    return { files, problems: ['the sheet was saved as an Excel workbook — use "Save As → CSV UTF-8 (Comma delimited)"'] };
  }
  const records: string[][] = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true });
  const [header = [], ...body] = records;
  if (header[0]?.trim() !== PATH_COLUMN) return { files, problems: [`the first column must be "${PATH_COLUMN}"`] };
  const columns = header.slice(1).map(parseHeader);
  const sheetBare = new Set(header.slice(1).map((h) => h.trim()).filter((h) => parseHeader(h).field === h));
  const dup = columns.find((c, i) => columns.findIndex((o) => o.field === c.field) !== i);
  if (dup) problems.push(`column "${dup.field}" appears twice`);
  if (columns.some((c) => !c.field)) problems.push('a column header is blank');
  if (problems.length) return { files, problems };

  // Rows per collection, decoded with the sheet's column types.
  const docSheet = layout.documents ? new Set(layout.documents) : undefined;
  const seen = new Set<string>();
  const inSheet = new Set(layout.collections);
  const rows = new Map<string, Row[]>(layout.collections.map((n) => [n, []]));
  body.forEach((r, i) => {
    const line = i + 2;
    const cells = columns.map((_, j) => r[j + 1] ?? '');
    const pathText = (r[0] ?? '').trim().replace(/\\/g, '/');
    if (!pathText) {
      if (cells.some((c) => c !== '')) {
        problems.push(docSheet
          ? `line ${line}: "${PATH_COLUMN}" is empty — this sheet only edits the documents you opened; add new documents in the collection's CSV`
          : `line ${line}: "${PATH_COLUMN}" is empty — use <collection>/<id>, or <collection>/ for a new auto id`);
      }
      return;
    }
    if (docSheet) {
      // A document sheet edits exactly the documents it was opened with.
      const path = pathText.replace(/\/+$/, '');
      if (!docSheet.has(path)) {
        problems.push(`line ${line}: ${pathText} — this sheet only edits the documents you opened, so it can't add or rename documents`);
        return;
      }
      if (seen.has(path)) { problems.push(`line ${line}: ${path} appears twice`); return; }
      seen.add(path);
    }
    const autoId = pathText.endsWith('/');
    const segs = pathText.split('/').filter(Boolean);
    const id = autoId ? '' : segs.pop()!;
    const collection = segs.join('/');
    let valid = true;
    try { valid = !isPattern(parseCollectionPath(collection)); } catch { valid = false; }
    if (!valid || !inSheet.has(collection)) {
      problems.push(valid
        ? `line ${line}: ${collection} isn't part of this sheet — pull it and include it when you run ${cmd('firerow edit')}`
        : `line ${line}: "${pathText}" isn't a document path (use <collection>/<id>)`);
      return;
    }
    const values: Record<string, PValue> = {};
    columns.forEach((c, j) => {
      const text = cells[j];
      if (text.trimStart().startsWith(CONFLICT_START)) { problems.push(`line ${line}, column "${c.field}": unresolved conflict`); return; }
      try {
        const v = decodeCell(text, c.type);
        if (v !== undefined) values[c.field] = v;
      } catch (e) {
        if (!(e instanceof CellError)) throw e;
        problems.push(`line ${line}, column "${c.field}": ${e.message}`);
      }
    });
    rows.get(collection)!.push({ id, values });
  });
  for (const p of docSheet ?? []) {
    if (!seen.has(p)) problems.push(`${p} was removed from the sheet — this sheet can't delete documents; put its row back (to delete it, remove its row from the collection's CSV)`);
  }
  if (problems.length) return { files, problems };

  const sheetFields = new Set(columns.map((c) => c.field));
  for (const name of layout.collections) {
    const own = layout.fileColumns[name] ?? [];
    // A header stays untyped only if it was untyped in the collection (or is new) and still is in the sheet.
    const fileBare = new Set(layout.fileUntyped?.[name] ?? []);
    const bare = (f: string) => sheetBare.has(f) && (fileBare.has(f) || !own.some((c) => c.field === f));
    if (!docSheet) {
      // Collection sheet: its rows are the collection; columns removed from the sheet go.
      files.set(name, collectionCsv(own, rows.get(name)!, columns, (f) => sheetFields.has(f), bare));
      continue;
    }
    // Document sheet: replace just its documents' rows; everything else stays as it was.
    const edited = new Map(rows.get(name)!.map((r) => [r.id, r]));
    const removed = layout.columns.map((c) => c.field).filter((f) => !sheetFields.has(f));
    const all = decodeRows(current!.get(name)!, () => name, []).map((r) => {
      const e = edited.get(r.id);
      if (!e) return r;
      const values = { ...r.values };
      for (const f of [...sheetFields, ...removed]) delete values[f];
      return { id: r.id, values: { ...values, ...e.values } };
    });
    files.set(name, collectionCsv(own, all, columns, () => true, (f) => sheetBare.has(f) ? bare(f) : fileBare.has(f) && !sheetFields.has(f)));
  }
  return { files, problems };
}

/**
 * Check the split files the way `push` will, so problems are fixed in the sheet while it's
 * still open: an edited id within a collection, and a row whose `_path` was changed to
 * another collection (documents can't move — that would be a delete plus a copy).
 */
export function checkSplit(files: Map<string, string>, snapshots: Map<string, Snapshot>): string[] {
  const problems: string[] = [];
  const created: { path: string; sig: string }[] = [];
  const deleted = new Map<string, string>(); // signature → path
  const sig = (fields: Record<string, PValue>) => canonical({ t: 'map', v: fields });

  for (const [name, text] of files) {
    const snap = snapshots.get(name)!;
    try {
      const plan = computePlan(snap, parseCsv(text, name));
      for (const c of plan.creates) if (Object.keys(c.fields).length) created.push({ path: `${name}/${c.id ?? ''}`, sig: sig(c.fields) });
      for (const d of plan.deletes) deleted.set(sig(snap.docs.find((x) => x.id === d.id)!.fields), `${name}/${d.id}`);
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
      // Line numbers there refer to the collection's own file, not the sheet — drop them.
      problems.push(...e.problems.map((p) => `${name}: ${p.replace(/^line \d+(: |, )/, '')}`));
    }
  }
  for (const c of created) {
    const from = deleted.get(c.sig);
    if (!from || from.split('/').slice(0, -1).join('/') === c.path.split('/').slice(0, -1).join('/')) continue;
    deleted.delete(c.sig);
    problems.push(`looks like ${from} was moved to ${c.path} — documents can't move between collections. `
      + 'Change its _path back. To really move it, delete it and add the new row in separate pushes.');
  }
  return problems;
}
