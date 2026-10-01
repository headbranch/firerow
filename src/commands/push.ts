import path from 'node:path';
import type { DocumentReference, DocumentSnapshot, Firestore, Precondition, WriteBatch, WriteResult } from 'firebase-admin/firestore';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { toFirestore, type PValue } from '../codec.js';
import { connect, loadWorkspace, projectIdOf } from '../config.js';
import { newPushId, savePush, type JournalChange } from '../journal.js';
import { applyFieldDelete, applyRename, computePlan, deletableColumns, findConflicts, isEmptyPlan, planSize, PlanError, type Conflict, type LiveDoc, type Plan } from '../diff.js';
import { csvPath, snapshotPath } from '../paths.js';
import { assertNotEditing, readSession } from '../session.js';
import { readSnapshot, toSnapshotDoc, type Snapshot, type SnapshotDoc } from '../snapshot.js';
import { readCsv, type Table } from '../table.js';
import { resolveLocal } from '../targets.js';
import { bold, cmd, confirm, dim, formatCount, green, printConflicts, printOrphanWarning, printPlan, red, section, timeAgo, yellow } from '../ui.js';
import { mergeCollection, offerResolve, pullCollection, writeLocal } from './pull.js';

const BATCH_LIMIT = 500;

/** Just the named fields of a document (fields it doesn't have are left out). */
function pick(fields: Record<string, PValue>, names: string[]): Record<string, PValue> {
  return Object.fromEntries(names.filter((f) => fields[f] !== undefined).map((f) => [f, fields[f]]));
}

interface Local { segs: string[]; name: string; snap: Snapshot; table: Table; plan: Plan; base: Map<string, SnapshotDoc> }

function loadLocal(root: string, segs: string[]): Local {
  const name = segs.join('/');
  const snap = readSnapshot(snapshotPath(root, segs));
  if (!snap) throw new Error(`No snapshot for ${name}. Run ${cmd(`firerow pull ${name}`)} first.`);
  const table = readCsv(csvPath(root, segs));
  try {
    const plan = computePlan(snap, table);
    return { segs, name, snap, table, plan, base: new Map(snap.docs.map((d) => [d.id, d])) };
  } catch (e) {
    if (e instanceof PlanError) {
      throw new Error(`Fix these problems in ${path.relative(process.cwd(), csvPath(root, segs))}:\n  ${e.problems.join('\n  ')}`);
    }
    throw e;
  }
}

/** Load every target, reporting all broken CSVs at once rather than stopping at the first. */
function loadAll(root: string, targets: string[][]): Local[] {
  const loaded: Local[] = [];
  const problems: string[] = [];
  for (const segs of targets) {
    try { loaded.push(loadLocal(root, segs)); } catch (e) { problems.push((e as Error).message); }
  }
  if (problems.length) throw new Error(problems.join('\n\n'));
  return loaded;
}

/** Show pending local changes without touching Firestore. */
export async function status(args: string[]): Promise<void> {
  const ws = loadWorkspace();
  const targets = resolveLocal(ws.root, args);
  if (!targets.length) { console.log(dim(`Nothing pulled yet. Try ${cmd('firerow pull <collection>')}.`)); return; }
  const session = readSession(ws.root);
  if (session) {
    console.log(yellow(`An edit sheet is open (${session.sheet}) — its changes aren't in the CSVs yet. `
      + `Apply it with ${cmd('firerow edit --apply')} (or ${cmd('firerow edit --cancel')}).`));
  }
  // Only collections with something to say are shown (like `git status`); the rest are counted.
  let unchanged = 0;
  for (const segs of targets) {
    let t: Local;
    try {
      t = loadLocal(ws.root, segs);
    } catch (e) {
      section(bold(segs.join('/')));
      console.log(red((e as Error).message));
      process.exitCode = 1;
      continue;
    }
    if (isEmptyPlan(t.plan) && !deletableColumns(t.plan).length && !t.plan.untypedColumns.length) { unchanged++; continue; }
    section(title(t));
    printPlan(t.plan, t.table.columns, t.base);
  }
  const total = targets.length;
  if (unchanged === total) console.log(green(`No changes`) + dim(` in ${total === 1 ? targets[0].join('/') : `${total} collections`}.`));
  else if (unchanged) console.log(dim(`\n${unchanged} other collection${unchanged === 1 ? ' has' : 's have'} no changes.`));
}

/** A collection's heading: its path, and when (and how much of it) was pulled. */
function title(t: Local): string {
  const partial = t.snap.partial ? `, partial copy of ${formatCount(t.snap.docs.length)} documents` : '';
  return `${bold(t.name)} ${dim(`(pulled ${timeAgo(t.snap.pulledAt)}${partial})`)}`;
}

export interface PushOptions { dryRun?: boolean; yes?: boolean; force?: boolean; pull?: boolean; renameFields?: boolean; deleteFields?: boolean }

interface Checked extends Local {
  ref: (key: string) => DocumentReference;
  liveSnaps: Map<string, DocumentSnapshot>;
  live: Map<string, LiveDoc>;
  conflicts: Conflict[];
}

/** Re-read only the documents this collection's plan touches, and find conflicts. */
async function check(db: Firestore, t: Local): Promise<Checked> {
  const ref = (id: string) => db.collection(t.name).doc(id);
  const touched = [
    ...t.plan.creates.flatMap((c) => (c.id ? [c.id] : [])),
    ...t.plan.updates.map((u) => u.id),
    ...t.plan.deletes.map((d) => d.id),
  ];
  const liveSnaps = new Map<string, DocumentSnapshot>();
  for (let i = 0; i < touched.length; i += 100) {
    const keys = touched.slice(i, i + 100);
    const got = await db.getAll(...keys.map(ref)); // results come back in request order
    got.forEach((s, j) => liveSnaps.set(keys[j], s));
  }
  const live = new Map<string, LiveDoc>();
  for (const [key, s] of liveSnaps) {
    const d = toSnapshotDoc(s);
    live.set(key, { exists: s.exists, updateTime: d.updateTime, fields: d.fields });
  }
  return { ...t, ref, liveSnaps, live, conflicts: findConflicts(t.plan, t.base, live, !!t.snap.partial) };
}

/** Group items by key, keeping first-seen order. */
function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(item);
  }
  return [...groups.values()];
}

export async function push(args: string[], opts: PushOptions): Promise<void> {
  const ws = loadWorkspace();
  const targets = resolveLocal(ws.root, args);
  if (!targets.length) { console.log(dim(`Nothing pulled yet. Try ${cmd('firerow pull <collection>')}.`)); return; }
  assertNotEditing(ws.root, targets.map((s) => s.join('/')));

  // Everything is checked before anything is written.
  const candidates = loadAll(ws.root, targets).filter((t) => !isEmptyPlan(t.plan) || deletableColumns(t.plan).length);
  if (!candidates.length) { console.log(green('No changes to push.')); return; }
  const multi = targets.length > 1;
  const heading = (t: Local) => section(title(t));
  const canAsk = !opts.yes && !opts.dryRun && process.stdin.isTTY;
  const docs = (n: number) => `${n} document${n === 1 ? '' : 's'}`;

  // Renamed headers and removed columns both delete a field, so each is opt-in (flag or prompt).
  // The same rename/removal across many collections is asked about once.
  const inCollections = (n: number) => (n > 1 ? ` in ${n} collections` : '');
  const renames = groupBy(candidates.flatMap((t) => t.plan.renames.map((r) => ({ t, r }))), ({ r }) => `${r.from}\u0000${r.to}`);
  for (const group of renames) {
    const { from, to } = group[0].r;
    const n = group.reduce((sum, { r }) => sum + r.docs, 0);
    if (opts.renameFields || (canAsk && await confirm(
      `Looks like you renamed field "${from}" → "${to}"${inCollections(group.length)} (${docs(n)}). Rename it in Firestore (delete "${from}")?`,
    ))) for (const { t, r } of group) applyRename(t.plan, t.base, r);
  }
  const removals = groupBy(candidates.flatMap((t) => deletableColumns(t.plan).map((c) => ({ t, c }))), ({ c }) => c.field);
  for (const group of removals) {
    const field = group[0].c.field;
    const n = group.reduce((sum, { c }) => sum + c.docs.length, 0);
    if (opts.deleteFields || (canAsk && await confirm(
      `Column "${field}" was removed${inCollections(group.length)} (${docs(n)} ${n === 1 ? 'has' : 'have'} it). Delete the field "${field}" from Firestore?`,
    ))) for (const { t, c } of group) applyFieldDelete(t.plan, c);
  }

  for (const t of candidates) { heading(t); printPlan(t.plan, t.table.columns, t.base); }
  const pending = candidates.filter((t) => !isEmptyPlan(t.plan));
  if (!pending.length) { console.log(green('\nNo changes to push.')); return; }
  const names = pending.map((t) => t.name).join(',');
  if (opts.dryRun) { console.log(dim('\n--dry-run: nothing was written.')); return; }

  const db = connect(ws);
  const checked: Checked[] = [];
  for (const t of pending) checked.push(await check(db, t));

  const conflicted = checked.filter((t) => t.conflicts.length);
  if (conflicted.length) {
    for (const t of conflicted) { heading(t); printConflicts(t.conflicts); }
    if (!opts.force) {
      process.exitCode = 1;
      console.log(`\nNothing was written${multi ? ' to any collection' : ''}.`);
      const conflictedNames = conflicted.map((t) => t.name).join(',');
      // Offer to do the `pull` merge right away (only when someone can answer; never with --yes).
      if (!opts.yes && process.stdin.isTTY && await confirm('Merge the remote changes into your CSV now?')) {
        const needChoice: string[] = [];
        let fields = 0;
        for (const t of conflicted) {
          section(bold(t.name));
          const n = await mergeCollection(db, ws.root, t.segs, t.snap, t.table, t.plan);
          if (n) { needChoice.push(t.name); fields += n; }
        }
        await offerResolve(needChoice, fields);
        return;
      }
      console.log(`You can:\n`
        + `  • run ${cmd(`firerow pull ${conflictedNames}`)} to merge in the remote changes, then choose where both sides changed the same cell, or\n`
        + `  • run ${cmd(`firerow push ${names} --force`)} to overwrite them with your local values.`);
      return;
    }
    console.log(yellow('--force: overwriting conflicting changes.'));
  }

  // Deleting an already-deleted doc is a no-op; skip it quietly (but remember it for the local copy).
  const removedKeys = new Map(checked.map((t) => [t, t.plan.deletes.map((d) => d.id)]));
  for (const t of checked) t.plan.deletes = t.plan.deletes.filter((d) => t.live.get(d.id)?.exists);

  // Deleting a document leaves its subcollections behind; say so before confirming.
  const orphans = (await Promise.all(checked.flatMap((t) => t.plan.deletes.map(async (d) => {
    const cols = await t.ref(d.id).listCollections();
    return { path: t.ref(d.id).path, collections: cols.map((c) => c.id) };
  })))).filter((o) => o.collections.length);
  if (orphans.length) printOrphanWarning(orphans);

  const total = checked.reduce((n, t) => n + planSize(t.plan), 0);
  if (total > BATCH_LIMIT) {
    console.log(yellow(`\n${total} writes exceeds one batch (${BATCH_LIMIT}); they'll be applied in ${Math.ceil(total / BATCH_LIMIT)} batches and are not atomic as a whole.`));
  }
  if (!opts.yes && !(await confirm(`\nApply these changes to ${bold(names.replace(/,/g, ', '))}?`))) {
    console.log(dim('Aborted. Nothing was written.'));
    return;
  }

  // Build every write, remembering where each collection's writes start so results can be mapped back.
  const ops: ((b: WriteBatch) => void)[] = [];
  const journal: Omit<JournalChange, 'writeTime'>[] = []; // one per op, for `firerow revert`
  const start = new Map<Checked, number>();
  const createdRefs = new Map<Checked, DocumentReference[]>();
  for (const t of checked) {
    start.set(t, ops.length);
    // Precondition: fail if the doc changed between our read and our write.
    const precondition = (id: string): Precondition | undefined =>
      opts.force ? undefined : { lastUpdateTime: t.liveSnaps.get(id)!.updateTime! };
    // Auto ids are generated locally, so we know every created document's id up front.
    const refs: DocumentReference[] = [];
    for (const c of t.plan.creates) {
      const data: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(c.fields)) data[f] = toFirestore(v, db);
      const target = c.id ? t.ref(c.id) : db.collection(t.name).doc();
      refs.push(target);
      ops.push((b) => b.create(target, data));
      journal.push({ collection: t.name, id: target.id, kind: 'create', before: null, after: c.fields });
    }
    createdRefs.set(t, refs);
    for (const u of t.plan.updates) {
      // FieldPath keeps field names containing "." literal, and replaces maps wholesale.
      const pairs: unknown[] = [];
      for (const [f, v] of Object.entries(u.set)) pairs.push(new FieldPath(f), toFirestore(v, db));
      for (const f of u.remove) pairs.push(new FieldPath(f), FieldValue.delete());
      const pre = precondition(u.id);
      const [first, firstVal, ...rest] = pairs;
      ops.push((b) => (b.update as Function).call(b, t.ref(u.id), first, firstVal, ...rest, ...(pre ? [pre] : [])));
      const fields = [...Object.keys(u.set), ...u.remove];
      const was = t.live.get(u.id)!.fields;
      journal.push({ collection: t.name, id: u.id, kind: 'update', fields, before: pick(was, fields), after: pick(u.set, fields) });
    }
    for (const d of t.plan.deletes) {
      const pre = precondition(d.id);
      ops.push((b) => b.delete(t.ref(d.id), pre));
      journal.push({ collection: t.name, id: d.id, kind: 'delete', before: t.live.get(d.id)!.fields, after: null });
    }
  }

  let done = 0;
  const results: WriteResult[] = []; // one per op, in op order
  const pushId = newPushId(ws.root);
  // Record what was written (all of it, or the batches that made it before a failure).
  const record = (complete: boolean) => savePush(ws.root, {
    id: pushId, pushedAt: new Date().toISOString(), projectId: projectIdOf(ws), databaseId: ws.config.databaseId ?? '(default)',
    complete,
    changes: results.map((r, i) => ({ ...journal[i], writeTime: `${r.writeTime.seconds}.${r.writeTime.nanoseconds}` })),
  });
  try {
    for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const op of ops.slice(i, i + BATCH_LIMIT)) op(batch);
      results.push(...(await batch.commit()));
      done += Math.min(BATCH_LIMIT, ops.length - i);
    }
  } catch (e) {
    if (results.length) record(false);
    const msg = (e as Error).message;
    console.error(red(`\nWrite failed after ${done}/${ops.length} changes: ${msg}`));
    if (/FAILED_PRECONDITION|ALREADY_EXISTS/i.test(msg) || (e as { code?: number }).code === 9) {
      console.error(red(`A document was changed in Firestore while updating. Run ${cmd('firerow status')} and try again.`));
    }
    // Don't re-pull: that would overwrite the CSV and lose the edits that weren't applied.
    if (done > 0) {
      console.error(yellow(`Your CSVs were left as-is. Run ${cmd('firerow status')} to see what is still pending.`));
      console.error(yellow(`The ${done} change${done === 1 ? ' that was' : 's that were'} written can be undone with ${cmd(`firerow revert ${pushId}`)}.`));
    }
    process.exitCode = 1;
    return;
  }
  record(true);

  for (const t of checked) {
    // Update the local copy from what we already know, without re-reading the collection.
    const first = start.get(t)!;
    const time = (i: number) => `${results[first + i].writeTime.seconds}.${results[first + i].writeTime.nanoseconds}`;
    const docs = new Map(t.snap.docs.map((d) => [d.id, d]));
    for (const key of removedKeys.get(t)!) docs.delete(key);
    t.plan.creates.forEach((c, i) => {
      const d: SnapshotDoc = { id: createdRefs.get(t)![i].id, updateTime: time(i), fields: c.fields };
      docs.set(d.id, d);
    });
    t.plan.updates.forEach((u, i) => {
      // Start from the live copy we just read, so other people's changes to other fields are kept.
      const fields = { ...t.live.get(u.id)!.fields, ...u.set };
      for (const f of u.remove) delete fields[f];
      docs.set(u.id, { ...docs.get(u.id)!, updateTime: time(t.plan.creates.length + i), fields });
    });
    const sorted = [...docs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    writeLocal(ws.root, t.segs, sorted, t.snap.pulledAt, !!t.snap.partial);
  }

  const where = checked.length === 1 ? checked[0].name : `${checked.length} collections`;
  console.log(green(`\n✓ Pushed ${done} change${done === 1 ? '' : 's'} to ${where}.`) + dim(` Undo with ${cmd(`firerow revert ${pushId}`)}.`));

  if (opts.pull) {
    for (const t of checked) {
      const { file, count } = await pullCollection(db, ws.root, t.segs);
      console.log(`${green('✓')} Refreshed ${path.relative(process.cwd(), file)} ${dim(`(${formatCount(count)} document${count === 1 ? '' : 's'})`)}`);
    }
  }
}
