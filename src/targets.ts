// Which collections a command acts on: the ones named (one per argument, "*" patterns
// allowed), or every collection that has been pulled into this workspace.
import fs from 'node:fs';
import path from 'node:path';
import { csvPath, isPattern, matchesPattern, parseCollectionOrDocument, parseCollectionPath, STATE_DIR, statePath } from './paths.js';
import { readSnapshot } from './snapshot.js';
import { cmd } from './ui.js';

export function allPulled(root: string): string[][] {
  const base = path.join(root, STATE_DIR, 'snapshots');
  if (!fs.existsSync(base)) return [];
  return (fs.readdirSync(base, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.json'))
    .map((f) => readSnapshot(path.join(base, f))!.collection.split('/'))
    // Only real collection paths are ever tracked; a "*" pattern is never a collection.
    .filter((segs) => segs.length % 2 === 1 && !isPattern(segs))
    .sort((a, b) => a.join('/').localeCompare(b.join('/')));
}

/**
 * What's in collections/ is what's tracked: a collection whose CSV was deleted is no longer
 * pulled. Its leftover snapshot (and any saved conflicts) are removed. Returns what was dropped.
 */
export function untrackDeleted(root: string): string[] {
  const dropped: string[] = [];
  for (const segs of allPulled(root)) {
    if (fs.existsSync(csvPath(root, segs))) continue;
    dropState(root, segs);
    dropped.push(segs.join('/'));
  }
  return dropped;
}

/** Remove a collection's snapshot and saved conflicts, so it's no longer tracked. */
export function dropState(root: string, segs: string[]): void {
  for (const kind of ['snapshots', 'conflicts']) {
    const file = statePath(root, kind, segs);
    fs.rmSync(file, { force: true });
    removeEmptyDirs(path.dirname(file), path.join(root, STATE_DIR, kind));
  }
}

/** Remove `dir` and its parents while they're empty, stopping at (and keeping) `stop`. */
export function removeEmptyDirs(dir: string, stop: string): void {
  for (; dir !== stop && dir.startsWith(stop); dir = path.dirname(dir)) {
    try { fs.rmdirSync(dir); } catch { break; }
  }
}

/**
 * Paths are named one per argument, separated by spaces: firerow pull users staff. An argument
 * with a comma or space in it (users,staff — or "users staff", which is what PowerShell makes of
 * an unquoted users,staff) is refused, with the command to run instead.
 */
export function checkOperands(command: string, args: string[]): void {
  const bad = args.find((a) => /[\s,]/.test(a.trim()));
  if (!bad) return;
  const parts = args.flatMap((a) => a.split(/[\s,]+/)).filter(Boolean).map((p) => (p.includes('*') ? `"${p}"` : p));
  throw new Error(`"${bad.trim()}": name each collection or document as its own argument, separated by spaces:\n`
    + `  ${cmd(`firerow ${command} ${parts.join(' ')}`)}`);
}

const named = (args: string[]) => args.map((a) => a.trim()).filter(Boolean);

/** ["users", "users/*\/bookmarks"] → parsed paths (patterns kept as patterns), deduplicated. */
export function parseArgs(args: string[] = []): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const a of named(args)) {
    const segs = parseCollectionPath(a);
    if (!seen.has(segs.join('/'))) { seen.add(segs.join('/')); out.push(segs); }
  }
  return out;
}

/** `pull` also takes document paths: users/alice fetches just that document. */
export function parsePullArgs(args: string[] = []): { collections: string[][]; docs: Map<string, Set<string>> } {
  const collections = new Map<string, string[]>();
  const docs = new Map<string, Set<string>>();
  for (const a of named(args)) {
    const { collection, id } = parseCollectionOrDocument(a);
    const name = collection.join('/');
    if (id === undefined) collections.set(name, collection);
    else docs.set(name, (docs.get(name) ?? new Set()).add(id));
  }
  return { collections: [...collections.values()], docs };
}

/**
 * Collections to work on locally (status/push): named ones, with patterns expanded to
 * the matching collections you've pulled; nothing named → every pulled collection.
 */
export function resolveLocal(root: string, args: string[] = []): string[][] {
  const named = parseArgs(args);
  const pulled = allPulled(root);
  if (!named.length) return pulled;
  const out = new Map<string, string[]>();
  for (const segs of named) {
    if (!isPattern(segs)) { out.set(segs.join('/'), segs); continue; }
    const matches = pulled.filter((p) => matchesPattern(segs, p));
    if (!matches.length) throw new Error(`No pulled collections match "${segs.join('/')}". Run ${cmd(`firerow pull ${segs.join('/')}`)} first.`);
    for (const m of matches) out.set(m.join('/'), m);
  }
  return [...out.values()];
}
