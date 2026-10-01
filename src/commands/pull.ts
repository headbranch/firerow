import fs from 'node:fs';
import path from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import { connect, loadWorkspace } from '../config.js';
import { computePlan, isEmptyPlan, PlanError, type Plan } from '../diff.js';
import { saveConflicts } from '../conflicts.js';
import { mergeRemote } from '../merge.js';
import { assertNotEditing } from '../session.js';
import { csvPath, isPattern, matchesPattern, snapshotPath } from '../paths.js';
import {
  countDocuments, fetchCollection, fetchDocuments, fetchPattern, readSnapshot, writeSnapshot,
  type Snapshot, type SnapshotDoc,
} from '../snapshot.js';
import { buildColumns, docsToCsv, readCsv, rowsToCsv, writeCsv, type Table } from '../table.js';
import { allPulled, parsePullArgs } from '../targets.js';
import { resolve } from './resolve.js';
import { cmd, confirm, dim, formatCount, green, yellow } from '../ui.js';

/**
 * The local copy's documents with fresh versions of `ids` swapped in (a document that no
 * longer exists is dropped). `missing` lists requested ids that exist nowhere.
 */
async function refreshDocs(db: Firestore, collection: string, ids: string[], base?: Snapshot): Promise<{ docs: SnapshotDoc[]; missing: string[] }> {
  const fresh = await fetchDocuments(db, collection, ids);
  const docs = new Map((base?.docs ?? []).map((d) => [d.id, d]));
  const missing: string[] = [];
  for (const id of ids) {
    if (fresh.has(id)) docs.set(id, fresh.get(id)!);
    else { if (!docs.has(id)) missing.push(id); docs.delete(id); }
  }
  return { docs: [...docs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), missing };
}

/** Download a collection again and rewrite its CSV + snapshot (a partial copy refreshes just its documents). */
export async function pullCollection(db: Firestore, root: string, segs: string[]): Promise<{ file: string; count: number }> {
  const snap = readSnapshot(snapshotPath(root, segs));
  const now = new Date().toISOString();
  if (snap?.partial) {
    const { docs } = await refreshDocs(db, segs.join('/'), snap.docs.map((d) => d.id), snap);
    return writeLocal(root, segs, docs, now, true);
  }
  return writeLocal(root, segs, await fetchCollection(db, segs), now);
}

/** Write a collection's CSV and snapshot from a list of documents. */
export function writeLocal(root: string, segs: string[], docs: SnapshotDoc[], pulledAt: string, partial = false): { file: string; count: number } {
  const file = csvPath(root, segs);
  const snapFile = snapshotPath(root, segs);
  // Keep the user's column order from last time.
  const previous = fs.existsSync(file) ? safeColumns(file) : readSnapshot(snapFile)?.columns;
  const columns = buildColumns(docs, previous);
  writeCsv(file, docsToCsv(docs, columns));
  writeSnapshot(snapFile, { collection: segs.join('/'), pulledAt, columns, docs, ...(partial && { partial }) });
  saveConflicts(root, segs, []); // a clean copy has no conflicts left
  return { file, count: docs.length };
}

function safeColumns(file: string) {
  try { return readCsv(file).columns; } catch { return undefined; }
}

/** Unpushed edits for a collection, if any. Throws if its CSV can't be read. */
function pendingEdits(root: string, segs: string[]): { snap: Snapshot; table: Table; plan: Plan } | undefined {
  const file = csvPath(root, segs);
  const snap = readSnapshot(snapshotPath(root, segs));
  if (!snap || !fs.existsSync(file)) return undefined;
  const table = readCsv(file);
  try {
    const plan = computePlan(snap, table);
    return isEmptyPlan(plan) ? undefined : { snap, table, plan };
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    throw new Error(`${path.relative(process.cwd(), file)} has problems, so your edits can't be merged:\n  ${e.problems.join('\n  ')}\n`
      + `Fix them and pull again, or run ${cmd(`firerow discard ${segs.join('/')}`)} to throw your edits away.`);
  }
}

export interface PullOptions { all?: boolean; yes?: boolean }

export async function pull(args: string[], opts: PullOptions = {}): Promise<void> {
  const ws = loadWorkspace();
  const pulled = allPulled(ws.root);
  const named = parsePullArgs(args);

  // Two kinds of work: whole collections (or "*" patterns), and specific documents to (re)fetch.
  const full = new Map(named.collections.map((s) => [s.join('/'), s]));
  const docs = new Map([...named.docs].map(([c, ids]) => [c, new Set(ids)]));
  if ((!full.size && !docs.size) || opts.all) {
    // Refresh everything you've pulled: whole collections in full, partial ones document by document.
    for (const p of pulled) {
      const snap = readSnapshot(snapshotPath(ws.root, p))!;
      if (!snap.partial) full.set(p.join('/'), p);
      else docs.set(p.join('/'), new Set([...(docs.get(p.join('/')) ?? []), ...snap.docs.map((d) => d.id)]));
    }
  }
  // --all: every top-level collection too, in full.
  let topLevel: string[] = [];
  if (opts.all) {
    topLevel = (await connect(ws).listCollections()).map((c) => c.id);
    for (const id of topLevel) full.set(id, [id]);
  }
  // A whole-collection fetch already covers any documents asked for in it.
  const patterns = [...full.values()].filter(isPattern);
  for (const c of docs.keys()) if (full.has(c) || patterns.some((p) => matchesPattern(p, c.split('/')))) docs.delete(c);

  if (!full.size && !docs.size) {
    // Never pull a whole database by accident: ask for a name instead.
    const cols = await connect(ws).listCollections();
    throw new Error(`Nothing pulled yet — name the collection(s) to pull, e.g. ${cmd(`firerow pull ${cols[0]?.id ?? '<collection>'}`)}`
      + `, or use ${cmd('firerow pull --all')}.`
      + `${cols.length ? `\nCollections: ${cols.map((c) => c.id).join(', ')}` : ''}`);
  }

  // Check every local CSV we might touch before reading anything from Firestore.
  const local = new Map<string, string[]>();
  for (const t of full.values()) {
    for (const segs of isPattern(t) ? pulled.filter((p) => matchesPattern(t, p)) : [t]) local.set(segs.join('/'), segs);
  }
  for (const c of docs.keys()) local.set(c, c.split('/'));
  assertNotEditing(ws.root, [...local.keys()]);
  const pending = new Map<string, NonNullable<ReturnType<typeof pendingEdits>>>();
  const problems: string[] = [];
  for (const [name, segs] of local) {
    try { const p = pendingEdits(ws.root, segs); if (p) pending.set(name, p); } catch (e) { problems.push((e as Error).message); }
  }
  if (problems.length) throw new Error(problems.join('\n\n'));

  const db = connect(ws);
  if (opts.all && !(await confirmAll(db, ws.root, topLevel, pulled, opts.yes))) {
    console.log(dim('Nothing was pulled.'));
    return;
  }

  // Fetch: one query per collection, one collection-group query per "*" pattern,
  // and a direct read (1 read each) for specific documents.
  const fetched = new Map<string, { docs: SnapshotDoc[]; partial: boolean }>();
  for (const t of full.values()) {
    console.log(dim(`Reading ${t.join('/')}…`));
    if (!isPattern(t)) { fetched.set(t.join('/'), { docs: await fetchCollection(db, t), partial: false }); continue; }
    const groups = await fetchPattern(db, t);
    for (const [name, list] of groups) fetched.set(name, { docs: list, partial: false });
    // Pulled collections that now have no documents at all.
    for (const p of pulled) if (matchesPattern(t, p) && !groups.has(p.join('/'))) fetched.set(p.join('/'), { docs: [], partial: false });
  }
  for (const [name, ids] of docs) {
    console.log(dim(`Reading ${ids.size} document${ids.size === 1 ? '' : 's'} from ${name}…`));
    const base = readSnapshot(snapshotPath(ws.root, name.split('/')));
    const { docs: list, missing } = await refreshDocs(db, name, [...ids], base);
    for (const id of missing) console.log(yellow(`  ${name}/${id} doesn't exist in Firestore.`));
    if (!base && !list.length) continue; // nothing to save
    // Adding documents to a fully pulled collection keeps it full; otherwise the copy is partial.
    fetched.set(name, { docs: list, partial: base ? !!base.partial : true });
  }
  if (!fetched.size) { console.log(dim('Nothing to pull.')); return; }

  const pulledAt = new Date().toISOString();
  const conflicted: string[] = [];
  let fields = 0;
  // Plain results are listed together; a merge report (which can run several lines) gets its own block.
  console.log();
  let prev: 'line' | 'block' | undefined;
  for (const name of [...fetched.keys()].sort()) {
    const segs = name.split('/');
    const { docs: list, partial } = fetched.get(name)!;
    const p = pending.get(name);
    const kind = p ? 'block' : 'line';
    if (prev && (kind === 'block' || prev === 'block')) console.log();
    prev = kind;
    if (p) {
      const n = writeMerged(ws.root, segs, p.snap, p.table, p.plan, list, pulledAt, partial);
      if (n) { conflicted.push(name); fields += n; }
    } else {
      const { file, count } = writeLocal(ws.root, segs, list, pulledAt, partial);
      console.log(`${green('✓')} ${path.relative(process.cwd(), file)} ${dim(docCount(count, partial))}`);
    }
  }
  await offerResolve(conflicted, fields);
}

const docCount = (n: number, partial: boolean) =>
  `(${formatCount(n)} document${n === 1 ? '' : 's'}${partial ? ', partial copy' : ''})`;

/** Show what `pull --all` will fetch, with document counts (= reads), and ask. */
async function confirmAll(db: Firestore, root: string, topLevel: string[], pulled: string[][], yes?: boolean): Promise<boolean> {
  const counts = await Promise.all(topLevel.map((c) => countDocuments(db, c)));
  const deeper = pulled.filter((s) => s.length > 1);
  const deeperDocs = deeper.reduce((n, s) => n + (readSnapshot(snapshotPath(root, s))?.docs.length ?? 0), 0);
  const total = counts.reduce((a, b) => a + b, 0) + deeperDocs;

  const w = Math.max(...topLevel.map((c) => c.length), 0);
  const cw = Math.max(...counts.map((n) => formatCount(n).length), 0);
  console.log(`pull --all fetches every top-level collection${deeper.length ? `, plus the ${deeper.length} subcollections you've pulled` : ''}:\n`);
  topLevel.forEach((c, i) => {
    const isNew = !pulled.some((s) => s.join('/') === c);
    console.log(`  ${c.padEnd(w)}   ${formatCount(counts[i]).padStart(cw)} docs   ${isNew ? yellow('new') : dim('pulled')}`);
  });
  if (deeper.length) console.log(dim(`  …and ${deeper.length} pulled subcollections (about ${formatCount(deeperDocs)} docs)`));
  console.log(`\nThat's about ${formatCount(total)} document reads.`);
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error('pull --all asks before downloading; add --yes to run it without asking.');
  return confirm('Continue?');
}

/** Fetch the latest data, re-apply unpushed edits on top, write the result and report conflicts. */
export async function mergeCollection(db: Firestore, root: string, segs: string[], snap: Snapshot, table: Table, plan: Plan): Promise<number> {
  const now = new Date().toISOString();
  if (!snap.partial) return writeMerged(root, segs, snap, table, plan, await fetchCollection(db, segs), now, false);
  // A partial copy refreshes its own documents — plus any new rows' ids, in case they now exist.
  const ids = [...snap.docs.map((d) => d.id), ...plan.creates.flatMap((c) => (c.id ? [c.id] : []))];
  const { docs } = await refreshDocs(db, segs.join('/'), ids, snap);
  return writeMerged(root, segs, snap, table, plan, docs, now, true);
}

/** Merge and write; returns how many fields were left for the user to decide. */
function writeMerged(root: string, segs: string[], snap: Snapshot, table: Table, plan: Plan, remoteDocs: SnapshotDoc[], pulledAt: string, partial: boolean): number {
  const file = csvPath(root, segs);
  const rel = path.relative(process.cwd(), file);
  const merged = mergeRemote(snap, table, plan, remoteDocs, pulledAt, partial);
  writeCsv(file, rowsToCsv(merged.csv));
  writeSnapshot(snapshotPath(root, segs), merged.snapshot);
  saveConflicts(root, segs, merged.conflicts.map((c) => ({ id: c.id, field: c.field, local: c.local, remote: c.remote })));

  const n = merged.conflicts.length;
  console.log(`${green('✓')} ${rel} ${dim(docCount(remoteDocs.length, partial))} — merged the remote changes into your edits`);
  if (n) console.log(yellow(`  ${n} field${n === 1 ? ' was' : 's were'} changed both locally and remotely:`));
  for (const c of merged.conflicts) console.log(yellow(`    ${c.field} in ${c.id} ${dim(`(line ${c.line})`)}`));
  for (const note of merged.notes) console.log(yellow(`  ${note}`));
  return n;
}

/**
 * After a merge left fields changed on both sides, offer to go through them right away
 * (only when someone can answer); otherwise say how.
 */
export async function offerResolve(conflicted: string[], fields: number): Promise<void> {
  if (!conflicted.length) return;
  const names = conflicted.join(',');
  if (process.stdin.isTTY && await confirm(`\nChoose which value${fields === 1 ? '' : 's'} to keep?`)) {
    await resolve(conflicted, {});
    return;
  }
  console.log(`\nWhen you're ready: ${cmd(`firerow resolve ${names}`)} (or edit the marked cells by hand), then ${cmd(`firerow push ${names}`)}.`);
}
