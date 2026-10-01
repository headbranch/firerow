import path from 'node:path';
import { loadWorkspace } from '../config.js';
import { computePlan, isEmptyPlan, planSize, type Plan } from '../diff.js';
import { csvPath, parseCollectionOrDocument, snapshotPath } from '../paths.js';
import { applyChoices, readConflicts, saveConflicts } from '../conflicts.js';
import { assertNotEditing } from '../session.js';
import { readSnapshot, type Snapshot } from '../snapshot.js';
import { docsToCsv, readCsv, writeCsv, type Table } from '../table.js';
import { resolveLocal } from '../targets.js';
import { bold, cmd, confirm, dim, green } from '../ui.js';

/**
 * Throw away unpushed edits: rebuild CSVs from their snapshots — whole collections, or just some
 * documents (users/alice). Offline — no Firestore reads.
 */
export async function discard(args: string[], opts: { yes?: boolean }): Promise<void> {
  const ws = loadWorkspace();

  // Split what was named into collections (or patterns) and documents.
  const collectionArgs: string[] = [];
  const docArgs = new Map<string, { segs: string[]; ids: Set<string> }>();
  for (const a of args.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)) {
    const { collection, id } = parseCollectionOrDocument(a);
    if (id === undefined) { collectionArgs.push(a); continue; }
    const name = collection.join('/');
    if (!docArgs.has(name)) docArgs.set(name, { segs: collection, ids: new Set() });
    docArgs.get(name)!.ids.add(id);
  }
  // Nothing named at all → every pulled collection.
  const targets = collectionArgs.length || !docArgs.size ? resolveLocal(ws.root, collectionArgs) : [];
  for (const t of targets) docArgs.delete(t.join('/')); // the whole collection covers its documents
  assertNotEditing(ws.root, [...targets.map((s) => s.join('/')), ...docArgs.keys()]);

  const dirty: { segs: string[]; snap: Snapshot; what: string }[] = [];
  for (const segs of targets) {
    const snap = readSnapshot(snapshotPath(ws.root, segs));
    if (!snap) throw new Error(`${segs.join('/')} hasn't been pulled, so there's nothing to discard.`);
    let what: string;
    try {
      const plan = computePlan(snap, readCsv(csvPath(ws.root, segs)));
      if (isEmptyPlan(plan) && !plan.droppedColumns.length) continue;
      const n = planSize(plan);
      what = n ? `${n} unpushed change${n === 1 ? '' : 's'}` : 'column changes';
    } catch {
      what = 'edits (the CSV currently has problems)'; // missing, unparsable or invalid — restoring fixes it
    }
    dirty.push({ segs, snap, what });
  }

  const docWork = [...docArgs.values()].map(({ segs, ids }) => planDocs(ws.root, segs, ids)).filter((w) => w.docs.length);

  if (!dirty.length && !docWork.length) { console.log(green('Nothing to discard.')); return; }
  for (const d of dirty) console.log(`${bold(d.segs.join('/'))}: ${d.what}`);
  for (const w of docWork) for (const d of w.docs) console.log(`${bold(`${w.segs.join('/')}/${d.id}`)}: ${d.what}`);
  const count = dirty.length + docWork.reduce((n, w) => n + w.docs.length, 0);
  if (!opts.yes && !(await confirm(`\nDiscard ${count === 1 ? 'these edits' : `edits in ${count} ${dirty.length ? 'places' : 'documents'}`}? This can't be undone.`))) {
    console.log(dim('Nothing was discarded.'));
    return;
  }
  for (const { segs, snap } of dirty) {
    const file = csvPath(ws.root, segs);
    writeCsv(file, docsToCsv(snap.docs, snap.columns));
    saveConflicts(ws.root, segs, []);
    console.log(`${green('✓')} restored ${path.relative(process.cwd(), file)}`);
  }
  for (const w of docWork) {
    writeCsv(csvPath(ws.root, w.segs), restoreDocs(w.table, w.snap, w.docs.map((d) => d.id)));
    const ids = new Set(w.docs.map((d) => d.id));
    saveConflicts(ws.root, w.segs, readConflicts(ws.root, w.segs).filter((c) => !ids.has(c.id)));
    for (const d of w.docs) console.log(`${green('✓')} ${d.done} ${w.segs.join('/')}/${d.id}`);
  }
}

interface DocWork { segs: string[]; snap: Snapshot; table: Table; docs: { id: string; what: string; done: string }[] }

/** Which of the named documents have unpushed edits, and what discarding does to each. */
function planDocs(root: string, segs: string[], ids: Set<string>): DocWork {
  const name = segs.join('/');
  const snap = readSnapshot(snapshotPath(root, segs));
  if (!snap) throw new Error(`${name} hasn't been pulled, so there's nothing to discard.`);
  let table: Table;
  try {
    table = readCsv(csvPath(root, segs));
  } catch (e) {
    throw new Error(`${(e as Error).message}\nTo restore the whole CSV instead, run ${cmd(`firerow discard ${name}`)}.`);
  }
  // The plan says which rows changed; if the CSV has problems, treat every named row as changed.
  let plan: Plan | undefined;
  try { plan = computePlan(snap, table); } catch { /* invalid cells somewhere: restore regardless */ }
  const touched = plan && new Set([
    ...plan.creates.flatMap((c) => (c.id ? [c.id] : [])), ...plan.updates.map((u) => u.id), ...plan.deletes.map((d) => d.id),
  ]);

  const docs: DocWork['docs'] = [];
  for (const id of ids) {
    const pulled = snap.docs.some((d) => d.id === id);
    const inCsv = table.rows.some((r) => r.id === id);
    if (!pulled && !inCsv) throw new Error(`${name}/${id} isn't in your CSV or in what was last pulled.`);
    if (touched && !touched.has(id)) continue; // no unpushed edits
    if (!pulled) docs.push({ id, what: 'new, not pushed yet — the row will be removed', done: 'removed' });
    else if (!inCsv) docs.push({ id, what: 'deleted from the CSV — the row will be put back', done: 'put back' });
    else docs.push({ id, what: 'edited — the row will be restored', done: 'restored' });
  }
  return { segs, snap, table, docs };
}

/** The CSV with these documents' rows back to the snapshot (or removed, if they were new). */
function restoreDocs(table: Table, snap: Snapshot, ids: string[]): string {
  const discard = new Set(ids);
  const pulled = new Map(snap.docs.map((d) => [d.id, d]));
  const blank = (id: string) => ({ id, cells: table.columns.map(() => ''), line: 0 });
  // Edited rows are restored where they are; new ones are dropped (and duplicates of an id too).
  const placed = new Set<string>();
  const rows: Table['rows'] = [];
  for (const r of table.rows) {
    if (!discard.has(r.id)) { rows.push(r); continue; }
    if (pulled.has(r.id) && !placed.has(r.id)) { rows.push(blank(r.id)); placed.add(r.id); }
  }
  // Deleted rows go back where they were: before the next pulled document still in the CSV.
  const order = snap.docs.map((d) => d.id);
  for (const id of ids) {
    if (!pulled.has(id) || placed.has(id)) continue;
    const after = order.slice(order.indexOf(id) + 1);
    const at = rows.findIndex((r) => after.includes(r.id));
    rows.splice(at < 0 ? rows.length : at, 0, blank(id));
    placed.add(id);
  }
  // Fill in the pulled values (applyChoices handles values that don't fit a column's type).
  const choices = [...placed].flatMap((id) => table.columns.map((c) => ({ id, field: c.field, value: pulled.get(id)!.fields[c.field] })));
  return applyChoices({ ...table, rows }, choices);
}
