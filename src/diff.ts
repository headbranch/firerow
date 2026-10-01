// Pure logic: compare an edited table against the pulled snapshot to produce a
// change plan, and check that plan against the live documents for conflicts.
import { CellError, decodeCell, encodeCell, guessCell, type Column, type PValue } from './codec.js';
import type { Snapshot, SnapshotDoc } from './snapshot.js';
import { cmd } from './ui.js';
import type { Table } from './table.js';

export interface DocCreate { id?: string; fields: Record<string, PValue>; line: number }
export interface DocUpdate { id: string; set: Record<string, PValue>; remove: string[]; line: number }
export interface DocDelete { id: string }

export interface Plan {
  creates: DocCreate[];
  updates: DocUpdate[];
  deletes: DocDelete[];
  /**
   * Columns that were in the snapshot but removed from the CSV. Left untouched in
   * Firestore unless deleted with applyFieldDelete.
   */
  droppedColumns: DroppedColumn[];
  /**
   * Header renames: a removed column whose values reappear, unchanged, under a new name.
   * Until applied (applyRename), the new field is added and the old one kept.
   */
  renames: FieldRename[];
  /** New columns with no `:type` in their header: each value's type was guessed (see guessCell). */
  untypedColumns: UntypedColumn[];
}

/** What was guessed for a column without a type: how many values of each type, and where. */
export interface UntypedColumn { field: string; values: { line: number; text: string; type: PValue['t'] }[] }

export interface FieldRename { from: string; to: string; docs: number; applied: boolean }

/** A removed column, and the (still present) documents that have that field. */
export interface DroppedColumn { field: string; docs: { id: string; line: number }[]; deleted: boolean }

/** Start of a conflict marker written into a cell by a merging `pull`. */
export const CONFLICT_START = '<<<<<<<';

export class PlanError extends Error {
  constructor(public problems: string[]) {
    super(problems.join('\n'));
  }
}

/** Stable, key-order-independent serialisation for equality checks. */
export function canonical(p: PValue | undefined): string {
  if (p === undefined) return '<absent>';
  return JSON.stringify(p, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v);
}

export const samePValue = (a: PValue | undefined, b: PValue | undefined) => canonical(a) === canonical(b);

/** Number of document writes (creates + updates + deletes) in a plan. */
export const planSize = (p: Plan) => p.creates.length + p.updates.length + p.deletes.length;

export const isEmptyPlan = (p: Plan) => planSize(p) === 0;

export function computePlan(snap: Snapshot, table: Table): Plan {
  const problems: string[] = [];
  const baseById = new Map(snap.docs.map((d) => [d.id, d]));
  const baseColType = new Map(snap.columns.map((c) => [c.field, c.type]));
  // New columns with no type in the header: each value is read as what it clearly is.
  const guessed = new Set(table.columns.map((c) => c.field).filter((f) => !baseColType.has(f) && table.untyped?.has(f)));
  const read = (text: string, col: Column) => (guessed.has(col.field) ? guessCell(text) : decodeCell(text, col.type));
  const plan: Plan = {
    creates: [], updates: [], deletes: [],
    droppedColumns: [],
    renames: [],
    untypedColumns: table.columns.flatMap((c, j) => (guessed.has(c.field) ? [{
      field: c.field,
      values: table.rows.flatMap((r) => {
        let v: PValue | undefined;
        try { v = guessCell(r.cells[j]); } catch { /* invalid cell: reported when the row is decoded */ }
        return v ? [{ line: r.line, text: r.cells[j].trim(), type: v.t }] : [];
      }),
    }] : [])).filter((c) => c.values.length),
  };
  // Values of columns that are new in the CSV, per existing document — used to spot renames.
  const newColumns = table.columns.map((c) => c.field).filter((f) => !baseColType.has(f));
  const newValues = new Map(newColumns.map((f) => [f, new Map<string, PValue | undefined>()]));

  // Cells a merging pull marked as conflicts must be resolved by hand first.
  for (const row of table.rows) {
    row.cells.forEach((cell, j) => {
      if (cell.trimStart().startsWith(CONFLICT_START)) {
        problems.push(`line ${row.line}, column "${table.columns[j].field}": unresolved conflict — run ${cmd('firerow resolve')}, or replace the whole cell with the value you want`);
      }
    });
  }
  if (problems.length) throw new PlanError(problems);

  const decodeRow = (cells: string[], line: number): (PValue | undefined)[] =>
    table.columns.map((col, j) => {
      try {
        return read(cells[j], col);
      } catch (e) {
        if (e instanceof CellError) {
          problems.push(`line ${line}, column "${col.field}": ${e.message}`);
          return undefined;
        }
        throw e;
      }
    });

  const seenIds = new Map<string, number>();
  for (const row of table.rows) {
    if (row.id) {
      if (row.id.includes('/')) problems.push(`line ${row.line}: document id "${row.id}" can't contain "/"`);
      const prev = seenIds.get(row.id);
      if (prev) problems.push(`line ${row.line}: document id "${row.id}" is duplicated (also on line ${prev})`);
      seenIds.set(row.id, row.line);
    }
    const base = row.id ? baseById.get(row.id) : undefined;

    if (!base) {
      const values = decodeRow(row.cells, row.line);
      const fields: Record<string, PValue> = {};
      table.columns.forEach((c, j) => { if (values[j] !== undefined) fields[c.field] = values[j]!; });
      plan.creates.push({ id: row.id || undefined, fields, line: row.line });
      continue;
    }

    const upd: DocUpdate = { id: base.id, set: {}, remove: [], line: row.line };
    table.columns.forEach((col, j) => {
      const text = row.cells[j];
      const before = base.fields[col.field];
      // Fast path: untouched cell text under an unchanged column type is never a change.
      // This avoids spurious diffs from float / timestamp formatting.
      if (baseColType.get(col.field) === col.type && text === encodeCell(before, col.type)) return;
      let after: PValue | undefined;
      try {
        after = read(text, col);
      } catch (e) {
        if (e instanceof CellError) { problems.push(`line ${row.line}, column "${col.field}": ${e.message}`); return; }
        throw e;
      }
      newValues.get(col.field)?.set(base.id, after);
      if (samePValue(before, after)) return;
      if (after === undefined) upd.remove.push(col.field);
      else upd.set[col.field] = after;
    });
    if (Object.keys(upd.set).length || upd.remove.length) plan.updates.push(upd);
  }

  for (const d of snap.docs) if (!seenIds.has(d.id)) plan.deletes.push({ id: d.id });

  const kept = snap.docs.filter((d) => seenIds.has(d.id));
  for (const { field } of snap.columns) {
    if (table.columns.some((c) => c.field === field)) continue;
    const docs = kept.filter((d) => d.fields[field] !== undefined).map((d) => ({ id: d.id, line: seenIds.get(d.id)! }));
    plan.droppedColumns.push({ field, docs, deleted: false });
  }

  // A dropped column + a new column holding exactly the same values = a renamed header.
  for (const { field: from } of plan.droppedColumns) {
    const to = newColumns.find((f) => !plan.renames.some((r) => r.to === f)
      && kept.every((d) => samePValue(d.fields[from], newValues.get(f)!.get(d.id))));
    const docs = kept.filter((d) => d.fields[from] !== undefined).length;
    if (to && docs) plan.renames.push({ from, to, docs, applied: false });
  }

  if (!problems.length) problems.push(...findIdEdits(plan, baseById, table));
  if (problems.length) throw new PlanError(problems);
  return plan;
}

/** Turn a detected header rename into a real field rename: also delete the old field. */
export function applyRename(plan: Plan, base: Map<string, SnapshotDoc>, rename: FieldRename): void {
  for (const u of plan.updates) {
    if (base.get(u.id)!.fields[rename.from] !== undefined && !u.remove.includes(rename.from)) u.remove.push(rename.from);
  }
  plan.droppedColumns = plan.droppedColumns.filter((c) => c.field !== rename.from);
  rename.applied = true;
}

/** Removed columns that could be deleted: not part of a rename, and some document still has the field. */
export const deletableColumns = (plan: Plan) =>
  plan.droppedColumns.filter((c) => !c.deleted && c.docs.length && !plan.renames.some((r) => r.from === c.field));

/** Delete a removed column's field from every document that has it. */
export function applyFieldDelete(plan: Plan, column: DroppedColumn): void {
  for (const { id, line } of column.docs) {
    let u = plan.updates.find((x) => x.id === id);
    if (!u) plan.updates.push(u = { id, set: {}, remove: [], line });
    if (!u.remove.includes(column.field)) u.remove.push(column.field);
  }
  plan.updates.sort((a, b) => a.line - b.line);
  column.deleted = true;
}

/**
 * Document ids are read-only. The CSV has no hidden row identity, so an edited
 * `_id` shows up as "delete old + create new" — spot it by a new row whose
 * values exactly match a deleted document (for the columns in the CSV).
 */
function findIdEdits(plan: Plan, baseById: Map<string, SnapshotDoc>, table: Table): string[] {
  const problems: string[] = [];
  const unmatched = new Set(plan.deletes.map((d) => d.id));
  const signature = (fields: Record<string, PValue>) =>
    table.columns.map((c) => canonical(fields[c.field])).join('\u0000');

  for (const c of plan.creates) {
    if (Object.keys(c.fields).length === 0) continue;
    const sig = signature(c.fields);
    const oldId = [...unmatched].find((id) => signature(baseById.get(id)!.fields) === sig);
    if (!oldId) continue;
    unmatched.delete(oldId);
    const now = c.id ? `"${c.id}"` : 'blank';
    problems.push(`line ${c.line}: looks like _id was changed from "${oldId}" to ${now}. `
      + 'Document ids can\'t be edited — change it back. To really replace the document, '
      + 'delete the row and add the new one in separate pushes.');
  }
  return problems;
}

export interface LiveDoc { exists: boolean; updateTime: string; fields: Record<string, PValue> }

export interface Conflict { id: string; message: string }

/**
 * Three-way check: base (snapshot) vs remote (Firestore now) vs local (your CSV, as a plan).
 * Only a conflict if someone else changed something *you* are also changing.
 */
export function findConflicts(plan: Plan, base: Map<string, SnapshotDoc>, live: Map<string, LiveDoc>, partial = false): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const c of plan.creates) {
    if (!c.id || !live.get(c.id)?.exists) continue;
    conflicts.push({
      id: c.id,
      message: partial
        ? "you are creating it, but it already exists in Firestore (it's just not in your partial copy) — pull that document first"
        : 'you are creating it, but a document with this id now exists',
    });
  }
  for (const u of plan.updates) {
    const l = live.get(u.id);
    if (!l?.exists) { conflicts.push({ id: u.id, message: 'was deleted in Firestore since you pulled' }); continue; }
    const b = base.get(u.id)!;
    for (const field of [...Object.keys(u.set), ...u.remove]) {
      const theirs = l.fields[field];
      const mine = u.set[field];
      if (!samePValue(b.fields[field], theirs) && !samePValue(theirs, mine)) {
        conflicts.push({ id: u.id, message: `field "${field}" was changed in Firestore since you pulled` });
      }
    }
  }
  for (const d of plan.deletes) {
    const l = live.get(d.id);
    if (l?.exists && l.updateTime !== base.get(d.id)!.updateTime) {
      conflicts.push({ id: d.id, message: 'you are deleting it, but it was modified in Firestore since you pulled' });
    }
  }
  return conflicts;
}
