// The CSV <-> in-memory table layer.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import {
  encodeCell, formatHeader, inferColumnType, parseHeader, type Column, type PValue,
} from './codec.js';
import type { SnapshotDoc } from './snapshot.js';
import { cmd } from './ui.js';

export const ID_COLUMN = '_id';

export interface Table {
  columns: Column[];
  rows: { id: string; cells: string[]; line: number }[];
  /** Fields whose header had no `:type` (plain text by default). */
  untyped?: Set<string>;
}

/**
 * Choose columns for a set of docs. Keeps the order (and explicit types) of
 * `previous` where the field still exists, then appends new fields alphabetically.
 */
export function buildColumns(docs: SnapshotDoc[], previous: Column[] = []): Column[] {
  const seen = new Map<string, Set<PValue['t']>>();
  for (const d of docs) {
    for (const [k, v] of Object.entries(d.fields)) {
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k)!.add(v.t);
    }
  }
  const cols: Column[] = [];
  for (const prev of previous) {
    if (seen.has(prev.field)) {
      cols.push({ field: prev.field, type: inferColumnType(seen.get(prev.field)!) });
      seen.delete(prev.field);
    }
  }
  for (const field of [...seen.keys()].sort()) cols.push({ field, type: inferColumnType(seen.get(field)!) });
  return cols;
}

export function docsToCsv(docs: SnapshotDoc[], columns: Column[]): string {
  const header = [ID_COLUMN, ...columns.map((c) => formatHeader(c))];
  const rows = docs.map((d) => [d.id, ...columns.map((c) => encodeCell(d.fields[c.field], c.type))]);
  return rowsToCsv([header, ...rows]);
}

export function rowsToCsv(rows: string[][]): string {
  // BOM so Excel opens it as UTF-8.
  return '\uFEFF' + stringify(rows, { record_delimiter: 'windows' });
}

export function writeCsv(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, content);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EBUSY' || (e as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`Can't write ${file} — is it open in Excel? Close it and try again.`);
    }
    throw e;
  }
}

export function readCsv(file: string): Table {
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run ${cmd('firerow pull')} for this collection first.`);
  return parseCsv(fs.readFileSync(file), file);
}

/** Parse CSV content; `file` is only used in error messages. */
export function parseCsv(content: Buffer | string, file: string): Table {
  if (Buffer.isBuffer(content) && content.subarray(0, 2).toString() === 'PK') {
    throw new Error(`${file} was saved as an Excel workbook, not a CSV. Use "Save As → CSV UTF-8 (Comma delimited)".`);
  }
  const records: string[][] = parse(content, { bom: true, relax_column_count: true, skip_empty_lines: true });
  if (records.length === 0) throw new Error(`${file} is empty (it needs at least the header row).`);
  const [header, ...body] = records;
  if (header[0]?.trim() !== ID_COLUMN) throw new Error(`${file}: the first column must be "${ID_COLUMN}".`);

  const columns = header.slice(1).map(parseHeader);
  const dupCol = columns.find((c, i) => columns.findIndex((o) => o.field === c.field) !== i);
  if (dupCol) throw new Error(`${file}: column "${dupCol.field}" appears twice.`);
  if (columns.some((c) => c.field === '')) throw new Error(`${file}: a column header is blank.`);

  const rows = body
    .map((r, i) => ({ id: (r[0] ?? '').trim(), cells: columns.map((_, j) => r[j + 1] ?? ''), line: i + 2 }))
    // Ignore rows that are completely blank (Excel sometimes leaves them).
    .filter((r) => r.id !== '' || r.cells.some((c) => c !== ''));
  // A header "name:string" is explicitly text; a bare "name" leaves the type open for new columns.
  const untyped = new Set(header.slice(1).map((h) => h.trim()).filter((h) => parseHeader(h).field === h));
  return { columns, rows, untyped };
}
