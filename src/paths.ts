import path from 'node:path';
import { cmd } from './ui.js';

export const CONFIG_FILE = 'firerow.config.json';
export const COLLECTIONS_DIR = 'collections';
export const STATE_DIR = '.firerow';
const CSV_NAME = 'documents.csv';

// In a command argument, stands for "every document": users/*/bookmarks means the
// bookmarks collection of every user. It only ever expands to ordinary collections.
const WILDCARD = '*';

function segments(input: string): string[] {
  const segs = input.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs[segs.length - 1] === CSV_NAME) segs.pop(); // tab-completed file path…
  if (segs[0] === COLLECTIONS_DIR) segs.shift(); // …or folder path
  return segs;
}

// Normalise and validate a collection path: "users", "users/alice/bookmarks",
// or a pattern with wildcards in document positions, "users/*/bookmarks".
export function parseCollectionPath(input: string): string[] {
  const segs = segments(input);
  if (segs.length === 0 || segs.length % 2 === 0) {
    throw new Error(segs.length
      ? `"${input}" is a document, not a collection. Use its collection ("${segs.slice(0, -1).join('/')}") here; `
        + `to fetch just that document, use ${cmd(`firerow pull ${segs.join('/')}`)}.`
      : `"${input}" is not a collection path. Use "<collection>", "<collection>/<id>/<subcollection>" or "<collection>/*/<subcollection>".`);
  }
  segs.forEach((s, i) => {
    if (!s.includes(WILDCARD)) return;
    if (s !== WILDCARD || i % 2 === 0) {
      throw new Error(`"${input}": "*" can only stand for a whole document id, as in "<collection>/*/<subcollection>".`);
    }
  });
  return segs;
}

/** A collection path, or a document path (an even number of parts, e.g. users/alice). */
export function parseCollectionOrDocument(input: string): { collection: string[]; id?: string } {
  const segs = segments(input);
  if (segs.length === 0 || segs.length % 2 === 1) return { collection: parseCollectionPath(input) };
  const id = segs.pop()!;
  const collection = parseCollectionPath(segs.join('/'));
  if (id.includes(WILDCARD) || isPattern(collection)) {
    throw new Error(`"${input}": "*" can't be used in a document path — use a collection pattern like "<collection>/*/<subcollection>".`);
  }
  return { collection, id };
}

export const isPattern = (segs: string[]) => segs.includes(WILDCARD);

/** Does a concrete collection path match a (possibly wildcard) pattern? */
export function matchesPattern(pattern: string[], collection: string[]): boolean {
  return pattern.length === collection.length && pattern.every((s, i) => s === WILDCARD || s === collection[i]);
}

// Characters Windows won't allow in file names (plus % so encoding is reversible).
function encodeSegment(seg: string): string {
  return seg.replace(/[<>:"|?*%\x00-\x1f]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`);
}

/** users → collections/users/documents.csv; users/alice/bookmarks → collections/users/alice/bookmarks/documents.csv */
export function csvPath(root: string, segs: string[]): string {
  return path.join(root, COLLECTIONS_DIR, ...segs.map(encodeSegment), CSV_NAME);
}

/** A per-collection JSON file under .firerow/<kind>/, e.g. snapshots or conflicts. */
export function statePath(root: string, kind: string, segs: string[]): string {
  return path.join(root, STATE_DIR, kind, ...segs.map(encodeSegment)) + '.json';
}

export const snapshotPath = (root: string, segs: string[]) => statePath(root, 'snapshots', segs);
