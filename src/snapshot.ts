// A snapshot records exactly what was pulled from Firestore, so `push` can tell
// what *you* changed in the CSV apart from what someone else changed remotely.
import fs from 'node:fs';
import path from 'node:path';
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';
import { fromFirestore, type Column, type PValue } from './codec.js';
import { matchesPattern } from './paths.js';

export interface SnapshotDoc {
  id: string;
  /** Firestore updateTime as "seconds.nanos"; used for conflict checks. */
  updateTime: string;
  fields: Record<string, PValue>;
}

export interface Snapshot {
  collection: string;
  pulledAt: string;
  columns: Column[];
  docs: SnapshotDoc[];
  /** Only some documents were pulled (e.g. `pull users/alice`), not the whole collection. */
  partial?: boolean;
}

export function readSnapshot(file: string): Snapshot | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
}

export function writeSnapshot(file: string, snap: Snapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap));
}

export function toSnapshotDoc(d: { id: string; updateTime?: { seconds: number; nanoseconds: number }; data(): Record<string, unknown> | undefined }): SnapshotDoc {
  const fields: Record<string, PValue> = {};
  for (const [k, v] of Object.entries(d.data() ?? {})) fields[k] = fromFirestore(v);
  return { id: d.id, updateTime: d.updateTime ? `${d.updateTime.seconds}.${d.updateTime.nanoseconds}` : '', fields };
}

/** Run a query in pages (ordered by document path) so large results don't time out. */
async function* paged(query: Query, pageSize = 500): AsyncGenerator<QueryDocumentSnapshot> {
  let last: QueryDocumentSnapshot | undefined;
  let count = 0;
  for (;;) {
    let q = query.orderBy(FieldPath.documentId()).limit(pageSize);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    for (const d of page.docs) yield d;
    count += page.size;
    if (page.size < pageSize) break;
    last = page.docs[page.docs.length - 1];
    process.stderr.write(`\r  fetched ${count} documents…`);
  }
  if (count >= pageSize) process.stderr.write('\n');
}

/** Read every document in one collection. */
/** Read specific documents (1 read each). Documents that don't exist are left out. */
export async function fetchDocuments(db: Firestore, collection: string, ids: string[]): Promise<Map<string, SnapshotDoc>> {
  const out = new Map<string, SnapshotDoc>();
  const col = db.collection(collection);
  for (let i = 0; i < ids.length; i += 100) {
    for (const s of await db.getAll(...ids.slice(i, i + 100).map((id) => col.doc(id)))) {
      if (s.exists) out.set(s.id, toSnapshotDoc(s));
    }
  }
  return out;
}

/** Number of documents in a collection (a count query: 1 read per 1,000 documents). */
export async function countDocuments(db: Firestore, collection: string): Promise<number> {
  return (await db.collection(collection).count().get()).data().count;
}

export async function fetchCollection(db: Firestore, segs: string[]): Promise<SnapshotDoc[]> {
  const out: SnapshotDoc[] = [];
  for await (const d of paged(db.collection(segs.join('/')))) out.push(toSnapshotDoc(d));
  return out;
}

/**
 * Read every collection matching a pattern like users/*\/bookmarks with a single
 * collection-group query, grouped by concrete collection path.
 */
export async function fetchPattern(db: Firestore, pattern: string[]): Promise<Map<string, SnapshotDoc[]>> {
  const groups = new Map<string, SnapshotDoc[]>();
  for await (const d of paged(db.collectionGroup(pattern[pattern.length - 1]))) {
    const collection = d.ref.parent.path;
    if (!matchesPattern(pattern, collection.split('/'))) continue;
    if (!groups.has(collection)) groups.set(collection, []);
    groups.get(collection)!.push(toSnapshotDoc(d));
  }
  return groups;
}
