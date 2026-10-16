import fs from 'node:fs';
import path from 'node:path';
import type { Firestore, Query } from 'firebase-admin/firestore';
import type { FieldType } from '../codec.js';
import { connect, loadWorkspace } from '../config.js';
import { computePlan, isEmptyPlan, PlanError, type Plan } from '../diff.js';
import { saveConflicts } from '../conflicts.js';
import { buildQuery, querySpec, type FilterOptions, type QuerySpec } from '../filter.js';
import { mergeRemote } from '../merge.js';
import { assertNotEditing } from '../session.js';
import { csvPath, isPattern, matchesPattern, snapshotPath } from '../paths.js';
import {
  countDocuments, fetchCollection, fetchDocuments, fetchPattern, fetchQuery, readSnapshot, writeSnapshot,
  type Snapshot, type SnapshotDoc,
} from '../snapshot.js';
import { buildColumns, docsToCsv, readCsv, rowsToCsv, writeCsv, type Table } from '../table.js';
import { allPulled, parsePullArgs } from '../targets.js';
import { resolve } from './resolve.js';
import { cmd, confirm, dim, formatCount, green, readKey, yellow } from '../ui.js';

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
  return { docs: [...docs.values()].sort(byId), missing };
}

const byId = (a: SnapshotDoc, b: SnapshotDoc) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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

export interface PullOptions extends FilterOptions { all?: boolean; yes?: boolean; add?: boolean; replace?: boolean }

/**
 * What a pull fetched for one collection: the documents to write, and — for a filtered or
 * document pull — just the ones it returned, in case you'd rather keep only those (--replace).
 */
interface Fetched { docs: SnapshotDoc[]; partial: boolean; matches?: SnapshotDoc[] }

export async function pull(args: string[], opts: PullOptions = {}): Promise<void> {
  const ws = loadWorkspace();
  const pulled = allPulled(ws.root);
  const named = parsePullArgs(args);
  const spec = querySpec(opts);
  if (opts.add && opts.replace) throw new Error('Use either --add or --replace, not both.');
  if ((opts.add || opts.replace) && !spec && !named.docs.size) {
    throw new Error(`--${opts.add ? 'add' : 'replace'} is for pulling some documents: with a filter (${cmd('--where …')}) or document paths (${cmd('users/alice')}).`);
  }
  if (spec) {
    // A filter picks documents from the collections you name; the result is a partial copy.
    if (opts.all) throw new Error("--all can't be combined with a filter; name the collections to filter.");
    if (named.docs.size) throw new Error('Filters apply to collections, not documents — name the collection, e.g. '
      + `${cmd(`firerow pull ${[...named.docs.keys()][0]} --where "…"`)}.`);
    if (!named.collections.length) throw new Error(`Name the collection to filter, e.g. ${cmd('firerow pull <collection> --where …')}.`);
  }

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
  const fetched = new Map<string, Fetched>();
  for (const t of full.values()) {
    if (spec) { await fetchFiltered(db, ws.root, t, spec, pulled, fetched, opts.yes); continue; }
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
    const asked = named.docs.get(name);
    fetched.set(name, { docs: list, partial: base ? !!base.partial : true, ...(asked && { matches: list.filter((d) => asked.has(d.id)) }) });
  }
  if (!fetched.size) { console.log(dim('Nothing to pull.')); return; }

  // Some documents pulled into a copy that has others too: add them, or keep only these?
  for (const [name, f] of fetched) {
    if (!f.matches) continue;
    const base = readSnapshot(snapshotPath(ws.root, name.split('/')));
    const keep = new Set(f.matches.map((d) => d.id));
    const others = base?.docs.filter((d) => !keep.has(d.id)).length ?? 0;
    if (!others) continue;
    const choice = opts.replace ? 'replace' : opts.add ? 'add' : await askReplace(name, f.matches.length, others);
    if (choice === null) { console.log(dim('Nothing was pulled.')); return; }
    if (choice === 'add') {
      if (!f.matches.length) fetched.delete(name); // nothing to add
      continue;
    }
    // Replacing drops rows; never ones with unpushed changes — those get handled first.
    const unpushed = pending.get(name) ? unpushedOutside(pending.get(name)!.plan, keep) : [];
    if (unpushed.length) {
      const ids = unpushed.flatMap((u) => (u.id ? [`${name}/${u.id}`] : []));
      throw new Error(`Can't replace ${name}: ${unpushed.length} row${unpushed.length === 1 ? '' : 's'} not in this pull ${unpushed.length === 1 ? 'has' : 'have'} unpushed changes:\n`
        + `  ${unpushed.map((u) => `${u.id || '(a new row without an _id)'} (${u.kind})`).join(', ')}\n`
        + `Push them (${cmd(`firerow push ${name}`)})`
        + `${ids.length ? ` or throw them away (${cmd(`firerow discard ${ids.join(' ')}`)})` : ''}, then pull again. Nothing was pulled.`);
    }
    fetched.set(name, { docs: [...f.matches].sort(byId), partial: true });
  }

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

/** Above this many matching documents, a filtered pull asks before reading them. */
const CONFIRM_ABOVE = 1000;

/**
 * A filtered pull: run the query and add the matching documents to the local copy (refreshing
 * those already there). Documents you have that don't match are kept, unless you choose to
 * replace the copy with just the matches.
 */
async function fetchFiltered(
  db: Firestore, root: string, t: string[], spec: QuerySpec, pulled: string[][],
  fetched: Map<string, Fetched>, yes?: boolean,
): Promise<void> {
  const name = t.join('/');
  const group = isPattern(t);
  // Unquoted values take the type of their column, from what you've pulled before.
  const types = new Map<string, FieldType>();
  for (const segs of group ? pulled.filter((p) => matchesPattern(t, p)) : [t]) {
    for (const c of readSnapshot(snapshotPath(root, segs))?.columns ?? []) if (!types.has(c.field)) types.set(c.field, c.type);
  }
  const q: Query = buildQuery(group ? db.collectionGroup(t[t.length - 1]) : db.collection(name), spec, db, (f) => types.get(f), group);

  try {
    if (spec.limitToLast === undefined) {
      const n = (await q.count().get()).data().count;
      console.log(dim(`Reading ${name}, ${spec.label}: ${formatCount(n)} matching document${n === 1 ? '' : 's'}…`));
      if (n > CONFIRM_ABOVE && !(await confirmReads(n, yes))) { console.log(dim(`Skipped ${name}.`)); return; }
    } else console.log(dim(`Reading ${name}, ${spec.label}…`));

    let found = 0;
    for (const [c, list] of await fetchQuery(q)) {
      if (group ? !matchesPattern(t, c.split('/')) : c !== name) continue;
      found += list.length;
      const base = readSnapshot(snapshotPath(root, c.split('/')));
      const docs = new Map((base?.docs ?? []).map((d) => [d.id, d]));
      for (const d of list) docs.set(d.id, d);
      // Adding documents to a fully pulled collection keeps it full; otherwise the copy is partial.
      fetched.set(c, { docs: [...docs.values()].sort(byId), partial: base ? !!base.partial : true, matches: list });
    }
    if (!found) console.log(yellow(`  No documents in ${name} match.`));
    // Collections you have where nothing matched: nothing to add, but replacing would empty them.
    for (const segs of group ? pulled.filter((p) => matchesPattern(t, p)) : [t]) {
      const base = fetched.has(segs.join('/')) ? undefined : readSnapshot(snapshotPath(root, segs));
      if (base?.docs.length) fetched.set(segs.join('/'), { docs: base.docs, partial: !!base.partial, matches: [] });
    }
  } catch (e) {
    // Firestore's own message (e.g. the link to create a missing index), without the gRPC code.
    throw new Error((e as Error).message.replace(/^\d+ [A-Z_]+: /, ''));
  }
}

/**
 * Ask whether to add the pulled documents to the local copy, or replace it with just them.
 * Without a terminal to ask in, they're added (nothing local is dropped unless you say so).
 */
async function askReplace(name: string, matches: number, others: number): Promise<'add' | 'replace' | null> {
  if (!process.stdin.isTTY) return 'add';
  const docs = (n: number) => `${formatCount(n)} document${n === 1 ? '' : 's'}`;
  console.log(`\n${name}: this pull has ${docs(matches)}; you also have ${docs(others)} locally that ${others === 1 ? "isn't" : "aren't"} in it.`);
  for (;;) {
    const key = await readKey(`  [a] add: keep them too   [r] replace: keep only ${matches === 1 ? 'this one' : `these ${formatCount(matches)}`}   ${dim('(--add / --replace)')} `);
    if (key === null) return null;
    if (key.toLowerCase() === 'a') return 'add';
    if (key.toLowerCase() === 'r') return 'replace';
  }
}

/** Unpushed changes to rows outside `keep`: what replacing the copy with just `keep` would throw away. */
export function unpushedOutside(plan: Plan, keep: Set<string>): { id: string; kind: 'edited' | 'deleted' | 'new' }[] {
  return [
    ...plan.updates.filter((u) => !keep.has(u.id)).map((u) => ({ id: u.id, kind: 'edited' as const })),
    ...plan.deletes.filter((d) => !keep.has(d.id)).map((d) => ({ id: d.id, kind: 'deleted' as const })),
    ...plan.creates.filter((c) => !c.id || !keep.has(c.id)).map((c) => ({ id: c.id ?? '', kind: 'new' as const })),
  ];
}

async function confirmReads(n: number, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error(`${formatCount(n)} documents match; add --yes to pull them without asking, or narrow the filter (e.g. --limit).`);
  return confirm(`That's ${formatCount(n)} document reads. Continue?`);
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
  const names = conflicted.join(' ');
  if (process.stdin.isTTY && await confirm(`\nChoose which value${fields === 1 ? '' : 's'} to keep?`)) {
    await resolve(conflicted, {});
    return;
  }
  console.log(`\nWhen you're ready: ${cmd(`firerow resolve ${names}`)} (or edit the marked cells by hand), then ${cmd(`firerow push ${names}`)}.`);
}
