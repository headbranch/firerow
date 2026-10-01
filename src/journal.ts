// A record of every push: what each written document looked like before and after, so a push
// can be listed (`firerow log`) and undone (`firerow revert`). Stored in .firerow/pushes/<id>.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PValue } from './codec.js';
import { STATE_DIR } from './paths.js';
import { cmd } from './ui.js';

/**
 * One document written by a push. `before`/`after` hold whole documents for a create or delete
 * (null when it didn't exist), and only the touched `fields` for an update (a field missing from
 * the record means it was absent).
 */
export interface JournalChange {
  collection: string;
  id: string;
  kind: 'create' | 'update' | 'delete';
  fields?: string[];
  before: Record<string, PValue> | null;
  after: Record<string, PValue> | null;
  /** Firestore updateTime right after the write ("seconds.nanos"); empty for a delete. */
  writeTime: string;
}

export interface PushRecord {
  id: string;
  pushedAt: string;
  projectId: string;
  databaseId: string;
  changes: JournalChange[];
  /** False when the push failed partway: only the changes listed were written. */
  complete: boolean;
  /** This push was `firerow revert <revertOf>`. */
  revertOf?: string;
  /** Set on a push once it has been reverted. */
  revertedBy?: string;
}

const dir = (root: string) => path.join(root, STATE_DIR, 'pushes');

/** A short random id, like a git short hash: 7 hex characters, unique in this workspace. */
export function newPushId(root: string): string {
  const taken = new Set(listPushes(root).map((p) => p.id));
  for (;;) {
    const id = crypto.randomBytes(4).toString('hex').slice(0, 7);
    if (!taken.has(id)) return id;
  }
}

export function savePush(root: string, record: PushRecord): void {
  fs.mkdirSync(dir(root), { recursive: true });
  fs.writeFileSync(path.join(dir(root), `${record.id}.json`), JSON.stringify(record));
}

/** Every recorded push, newest first. */
export function listPushes(root: string): PushRecord[] {
  if (!fs.existsSync(dir(root))) return [];
  const pushes = fs.readdirSync(dir(root))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir(root), f), 'utf8')) as PushRecord)
    .sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : a.pushedAt > b.pushedAt ? -1 : 0));
  return migrateLongIds(root, pushes);
}

/** Ids from before short ids ("20261001-031040-c0ed") are renamed to short ones, references included. */
const LONG_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
function migrateLongIds(root: string, pushes: PushRecord[]): PushRecord[] {
  if (!pushes.some((p) => LONG_ID.test(p.id))) return pushes;
  const rename = (id: string) => (LONG_ID.test(id) ? crypto.createHash('sha1').update(id).digest('hex').slice(0, 7) : id);
  for (const p of pushes) {
    const old = p.id;
    p.id = rename(p.id);
    if (p.revertOf) p.revertOf = rename(p.revertOf);
    if (p.revertedBy) p.revertedBy = rename(p.revertedBy);
    savePush(root, p);
    if (old !== p.id) fs.rmSync(path.join(dir(root), `${old}.json`), { force: true });
  }
  return pushes;
}

/** A push by id or unique id prefix (like a short git hash). */
export function findPush(root: string, ref: string): PushRecord {
  const matches = listPushes(root).filter((p) => p.id.startsWith(ref));
  if (!matches.length) throw new Error(`No push "${ref}". Run ${cmd('firerow log')} to see recent pushes.`);
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} pushes — use more of the id.`);
  return matches[0];
}

/**
 * What a push did: an ordinary push, an undo (a revert of a push), or a redo (a revert of an
 * undo, which re-applies the push).
 */
export function pushKind(p: PushRecord, byId: Map<string, PushRecord>): 'push' | 'undo' | 'redo' {
  if (!p.revertOf) return 'push';
  const target = byId.get(p.revertOf);
  return target && pushKind(target, byId) === 'undo' ? 'redo' : 'undo';
}
