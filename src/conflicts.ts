// Conflicts left by a merging `pull`, saved with their exact values so `resolve` doesn't have
// to parse them back out of the marker text in the CSV (which is only there for humans).
import fs from 'node:fs';
import path from 'node:path';
import { decodeCell, encodeCell, formatHeader, type PValue } from './codec.js';
import { CONFLICT_START } from './diff.js';
import { statePath } from './paths.js';
import { ID_COLUMN, rowsToCsv, type Table } from './table.js';

export interface SavedConflict { id: string; field: string; local?: PValue; remote?: PValue }

const file = (root: string, segs: string[]) => statePath(root, 'conflicts', segs);

export function readConflicts(root: string, segs: string[]): SavedConflict[] {
  const f = file(root, segs);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as SavedConflict[]) : [];
}

/** Save a collection's conflicts (an empty list clears them). */
export function saveConflicts(root: string, segs: string[], conflicts: SavedConflict[]): void {
  const f = file(root, segs);
  if (!conflicts.length) { fs.rmSync(f, { force: true }); return; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(conflicts));
}

/** Is this conflict still marked in the table (not already fixed by hand)? */
export function isOpen(table: Table, c: SavedConflict): boolean {
  const row = table.rows.find((r) => r.id === c.id);
  const j = table.columns.findIndex((col) => col.field === c.field);
  return !!row && j >= 0 && row.cells[j].trimStart().startsWith(CONFLICT_START);
}

/**
 * Replace marked cells with the chosen values and return the new CSV text. If a value doesn't
 * fit its column's type (e.g. text in a number column), the column becomes a JSON (`any`) column.
 */
export function applyChoices(table: Table, choices: { id: string; field: string; value?: PValue }[]): string {
  const columns = table.columns.map((c) => ({ ...c }));
  const cells = table.rows.map((r) => [...r.cells]);
  for (const { id, field, value } of choices) {
    const i = table.rows.findIndex((r) => r.id === id);
    const j = columns.findIndex((c) => c.field === field);
    if (i < 0 || j < 0) continue;
    const col = columns[j];
    const fitsColumn = !value || col.type === 'any' || value.t === col.type || (value.t === 'null' && col.type !== 'string');
    if (!fitsColumn) {
      // Re-encode the column as JSON so both kinds of value can live in it.
      for (const row of cells) {
        if (row[j].trimStart().startsWith(CONFLICT_START)) continue;
        try { row[j] = encodeCell(decodeCell(row[j], col.type), 'any'); } catch { /* invalid cell: leave it for status to report */ }
      }
      col.type = 'any';
    }
    cells[i][j] = encodeCell(value, col.type);
  }
  return rowsToCsv([
    // Headers the user left untyped stay that way, so their values are still guessed one by one.
    [ID_COLUMN, ...columns.map((c) => formatHeader(c, !!table.untyped?.has(c.field) && c.type === 'string'))],
    ...table.rows.map((r, i) => [r.id, ...cells[i]]),
  ]);
}
