import fs from 'node:fs';
import path from 'node:path';
import { toEJson, type Json, type PValue } from '../codec.js';
import { connect, loadWorkspace } from '../config.js';
import { computePlan, planSize, PlanError, type Plan } from '../diff.js';
import { csvPath, isPattern, snapshotPath } from '../paths.js';
import { fetchCollection, fetchDocuments, fetchPattern, readSnapshot, type Snapshot } from '../snapshot.js';
import { readCsv } from '../table.js';
import { allPulled, parseArgs, resolveLocal } from '../targets.js';
import { cmd, dim, formatCount, green, yellow } from '../ui.js';

export const SOURCES = ['pulled', 'local', 'remote'] as const;
export type Source = (typeof SOURCES)[number];

interface Exported { collection: string; docs: { id: string; fields: Record<string, PValue> }[] }

/**
 * { "<collection>": { "<id>": { field: value } } }, with values in the same JSON form as map,
 * array and `any` cells: plain JSON, plus {"$timestamp": …}, {"$ref": …}, {"$geo": …}, {"$bytes": …}.
 */
export function toJson(collections: Exported[]): Record<string, Record<string, Record<string, Json>>> {
  const out: Record<string, Record<string, Record<string, Json>>> = {};
  for (const c of [...collections].sort((a, b) => a.collection.localeCompare(b.collection))) {
    const docs: Record<string, Record<string, Json>> = {};
    for (const d of c.docs) docs[d.id] = Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, toEJson(v)]));
    out[c.collection] = docs;
  }
  return out;
}

/**
 * The documents as they'd be after pushing the CSV as it is (without renaming or deleting fields,
 * which push only does when asked). New rows with a blank _id have no id until they're pushed,
 * so they're left out and counted.
 */
export function applyPlan(snap: Snapshot, plan: Plan): { docs: Exported['docs']; withoutId: number } {
  const docs = new Map(snap.docs.map((d) => [d.id, d.fields]));
  for (const d of plan.deletes) docs.delete(d.id);
  for (const u of plan.updates) {
    const fields = { ...docs.get(u.id), ...u.set };
    for (const f of u.remove) delete fields[f];
    docs.set(u.id, fields);
  }
  let withoutId = 0;
  for (const c of plan.creates) {
    if (c.id) docs.set(c.id, c.fields);
    else withoutId++;
  }
  const sorted = [...docs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { docs: sorted.map(([id, fields]) => ({ id, fields })), withoutId };
}

const note = (s: string) => console.error(yellow(s));

/** What was last pulled or pushed (offline). */
function fromPulled(root: string, args: string[]): Exported[] {
  return pulledTargets(root, args).map(({ segs, snap }) => {
    const name = segs.join('/');
    if (snap.partial) note(`${name} is a partial copy: only its ${formatCount(snap.docs.length)} pulled documents are exported.`);
    let pending: boolean;
    try { pending = planSize(computePlan(snap, readCsv(csvPath(root, segs)))) > 0; } catch { pending = true; }
    if (pending) {
      note(`${name} has unpushed edits, which aren't exported.`
        + dim(` Use ${cmd('--from local')} to include them, or push them first.`));
    }
    return { collection: name, docs: snap.docs };
  });
}

/** The CSVs as they are, unpushed edits included (offline). */
function fromLocal(root: string, args: string[]): Exported[] {
  const problems: string[] = [];
  const out: Exported[] = [];
  for (const { segs, snap } of pulledTargets(root, args)) {
    const name = segs.join('/');
    const file = csvPath(root, segs);
    try {
      const { docs, withoutId } = applyPlan(snap, computePlan(snap, readCsv(file)));
      if (snap.partial) note(`${name} is a partial copy: only its pulled documents (and new rows) are exported.`);
      if (withoutId) note(`${name}: ${withoutId} new row${withoutId === 1 ? ' has' : 's have'} a blank _id, so no id yet — left out. Give ${withoutId === 1 ? 'it an id' : 'them ids'}, or push first.`);
      out.push({ collection: name, docs });
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
      problems.push(`Fix these problems in ${path.relative(process.cwd(), file)}:\n  ${e.problems.join('\n  ')}`);
    }
  }
  if (problems.length) throw new Error(`${problems.join('\n\n')}\n\nOr export what was last pulled with ${cmd('--from pulled')}.`);
  return out;
}

/**
 * Straight from Firestore (1 read per document). Named collections and patterns are read in full,
 * pulled or not; with none named, every pulled collection — a partial copy just its documents, like `pull`.
 */
async function fromRemote(ws: ReturnType<typeof loadWorkspace>, args: string[]): Promise<Exported[]> {
  const db = connect(ws);
  const out: Exported[] = [];
  const named = parseArgs(args);
  if (!named.length) {
    const pulled = allPulled(ws.root);
    if (!pulled.length) throw new Error(`Nothing pulled yet — name the collection(s) to export, e.g. ${cmd('firerow export users --from remote')}.`);
    for (const segs of pulled) {
      const name = segs.join('/');
      const snap = readSnapshot(snapshotPath(ws.root, segs))!;
      console.error(dim(`Reading ${name}…`));
      const docs = snap.partial
        ? [...(await fetchDocuments(db, name, snap.docs.map((d) => d.id))).values()].sort((a, b) => (a.id < b.id ? -1 : 1))
        : await fetchCollection(db, segs);
      out.push({ collection: name, docs });
    }
    return out;
  }
  for (const segs of named) {
    console.error(dim(`Reading ${segs.join('/')}…`));
    if (!isPattern(segs)) { out.push({ collection: segs.join('/'), docs: await fetchCollection(db, segs) }); continue; }
    const groups = await fetchPattern(db, segs);
    if (!groups.size) note(`No documents in any collection matching ${segs.join('/')}.`);
    for (const [collection, docs] of groups) out.push({ collection, docs });
  }
  return out;
}

function pulledTargets(root: string, args: string[]): { segs: string[]; snap: Snapshot }[] {
  const targets = resolveLocal(root, args);
  if (!targets.length) {
    throw new Error(`Nothing pulled yet. Run ${cmd('firerow pull <collection>')} first, or read straight from Firestore with ${cmd('--from remote')}.`);
  }
  return targets.map((segs) => {
    const snap = readSnapshot(snapshotPath(root, segs));
    if (!snap) {
      const name = segs.join('/');
      throw new Error(`${name} hasn't been pulled. Run ${cmd(`firerow pull ${name}`)} first, or use ${cmd('--from remote')}.`);
    }
    return { segs, snap };
  });
}

/** Write collections as JSON. Notes go to stderr, so the JSON can be piped when no file is given. */
export async function exportJson(args: string[], opts: { output?: string; from?: string }): Promise<void> {
  const from = (opts.from ?? 'pulled') as Source;
  if (!SOURCES.includes(from)) throw new Error(`--from must be one of: ${SOURCES.join(', ')}.`);
  const ws = loadWorkspace();
  const collections = from === 'remote' ? await fromRemote(ws, args)
    : from === 'local' ? fromLocal(ws.root, args)
      : fromPulled(ws.root, args);

  const json = JSON.stringify(toJson(collections), null, 2) + '\n';
  if (!opts.output) { process.stdout.write(json); return; }
  fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
  fs.writeFileSync(opts.output, json);
  const docs = collections.reduce((n, c) => n + c.docs.length, 0);
  const where = collections.length === 1 ? collections[0].collection : `${collections.length} collections`;
  console.log(`${green('✓')} ${opts.output} ${dim(`(${formatCount(docs)} document${docs === 1 ? '' : 's'} from ${where})`)}`);
}
