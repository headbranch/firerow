// Pure logic for a merging `pull`: re-apply your unpushed edits on top of fresh
// Firestore data (like `git pull`), marking cells where both sides changed.
import { encodeCell, encodeGuessed, formatHeader, type Column, type PValue } from './codec.js';
import { CONFLICT_START, samePValue, type Plan } from './diff.js';
import type { Snapshot, SnapshotDoc } from './snapshot.js';
import { buildColumns, ID_COLUMN, type Table } from './table.js';

interface ConflictCell { conflict: true; mine: PValue | undefined; theirs: PValue | undefined }
type Cell = PValue | ConflictCell;
const isConflict = (c: Cell | undefined): c is ConflictCell => !!c && 'conflict' in c;

export interface MergeConflict { line: number; id: string; field: string; local?: PValue; remote?: PValue }

export interface MergeResult {
  /** New snapshot: exactly what Firestore has now. */
  snapshot: Snapshot;
  /** CSV rows (header first) with your edits re-applied. */
  csv: string[][];
  /** Fields changed on both sides: the local value and the remote one, as found at merge time. */
  conflicts: MergeConflict[];
  /** Document-level situations worth telling the user about. */
  notes: string[];
}

export function mergeRemote(base: Snapshot, table: Table, plan: Plan, remote: SnapshotDoc[], pulledAt: string, partial = false): MergeResult {
  const baseById = new Map(base.docs.map((d) => [d.id, d]));
  const remoteIds = new Set(remote.map((d) => d.id));
  const updates = new Map(plan.updates.map((u) => [u.id, u]));
  const deletes = new Set(plan.deletes.map((d) => d.id));
  const creates = new Map(plan.creates.filter((c) => c.id).map((c) => [c.id!, c]));
  const notes: string[] = [];
  const rows: { id: string; cells: Record<string, Cell> }[] = [];

  for (const r of remote) {
    const row = { id: r.id, cells: { ...r.fields } as Record<string, Cell> };

    if (deletes.has(r.id)) {
      // Still delete it — unless someone changed it since you pulled.
      if (baseById.get(r.id)!.updateTime === r.updateTime) continue;
      notes.push(`${r.id}: you deleted it, but it was changed in Firestore since — it's back in the CSV. Delete the row again if you still want it gone.`);
      rows.push(row);
      continue;
    }

    const u = updates.get(r.id);
    if (u) {
      const before = baseById.get(r.id)!.fields;
      for (const f of [...Object.keys(u.set), ...u.remove]) {
        const mine = u.set[f];
        const theirs = r.fields[f];
        if (samePValue(before[f], theirs) || samePValue(theirs, mine)) {
          if (mine === undefined) delete row.cells[f];
          else row.cells[f] = mine;
        } else {
          row.cells[f] = { conflict: true, mine, theirs };
        }
      }
    }

    const c = creates.get(r.id);
    if (c) {
      // You both created a document with this id: keep theirs, fill in / flag your values.
      creates.delete(r.id);
      notes.push(`${r.id}: you created it, but a document with this id now exists — merged your values into it.`);
      for (const col of table.columns) {
        const mine = c.fields[col.field];
        const theirs = r.fields[col.field];
        if (mine === undefined || samePValue(mine, theirs)) continue;
        row.cells[col.field] = theirs === undefined ? mine : { conflict: true, mine, theirs };
      }
    }
    rows.push(row);
  }

  // You edited documents that have since been deleted: keep your row (pushing re-creates it).
  for (const u of plan.updates) {
    if (remoteIds.has(u.id)) continue;
    const cells: Record<string, Cell> = { ...baseById.get(u.id)!.fields, ...u.set };
    for (const f of u.remove) delete cells[f];
    rows.push({ id: u.id, cells });
    notes.push(`${u.id}: deleted in Firestore, but you edited it — pushing will re-create it. Delete the row to accept the deletion.`);
  }

  // Your new rows that don't clash with anything stay as they are.
  for (const c of plan.creates) {
    if (c.id && !creates.has(c.id)) continue; // merged above
    rows.push({ id: c.id ?? '', cells: { ...c.fields } });
  }

  // Columns: yours (order and types), plus fields that are new in Firestore.
  // Columns you removed stay removed.
  const snapshotColumns = buildColumns(remote, base.columns);
  const known = new Set([...table.columns, ...base.columns].map((c) => c.field));
  // New columns you left untyped keep a bare header, with each value written so it's read back
  // as the same type on push.
  const untyped = new Set(plan.untypedColumns.map((c) => c.field));
  const bare = (f: string) => !!table.untyped?.has(f) && !base.columns.some((c) => c.field === f);
  const columns: Column[] = [...table.columns, ...snapshotColumns.filter((c) => !known.has(c.field))];

  const conflicts: MergeResult['conflicts'] = [];
  const show = (v: PValue | undefined, col: Column) => (v === undefined ? '(empty)' : encodeCell(v, col.type));
  const header = [ID_COLUMN, ...columns.map((c) => formatHeader(c, bare(c.field)))];
  const body = rows.map((r, i) => [
    r.id,
    ...columns.map((col) => {
      const cell = r.cells[col.field];
      if (!isConflict(cell)) return untyped.has(col.field) ? encodeGuessed(cell) : encodeCell(cell, col.type);
      conflicts.push({ line: i + 2, id: r.id, field: col.field, local: cell.mine, remote: cell.theirs });
      return `${CONFLICT_START} local: ${show(cell.mine, col)} | remote: ${show(cell.theirs, col)} >>>>>>>`;
    }),
  ]);

  return {
    snapshot: { collection: base.collection, pulledAt, columns: snapshotColumns, docs: remote, ...(partial && { partial }) },
    csv: [header, ...body],
    conflicts,
    notes,
  };
}
