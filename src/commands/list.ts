import { connect, loadWorkspace, projectIdOf } from '../config.js';
import { computePlan, planSize } from '../diff.js';
import { csvPath, snapshotPath } from '../paths.js';
import { countDocuments, readSnapshot } from '../snapshot.js';
import { readCsv } from '../table.js';
import { allPulled } from '../targets.js';
import { bold, cmd, dim, formatCount, green, red, timeAgo, yellow } from '../ui.js';

/** Local state of a pulled collection — read from disk only, no Firestore reads. */
function localState(root: string, segs: string[]): string {
  const snap = readSnapshot(snapshotPath(root, segs));
  if (!snap) return dim('not pulled');
  const n = snap.docs.length;
  const pulled = green(snap.partial
    ? `${formatCount(n)} document${n === 1 ? '' : 's'} pulled ${timeAgo(snap.pulledAt)}`
    : `pulled ${timeAgo(snap.pulledAt)}`);
  try {
    const changes = planSize(computePlan(snap, readCsv(csvPath(root, segs))));
    return changes ? pulled + yellow(` · ${changes} unpushed change${changes === 1 ? '' : 's'}`) : pulled;
  } catch {
    return pulled + red(` · CSV has problems (see ${cmd('firerow status')})`);
  }
}

export interface ListOptions { count?: boolean }

export async function list(docPath: string | undefined, opts: ListOptions = {}): Promise<void> {
  const ws = loadWorkspace();
  const db = connect(ws);
  const parent = docPath?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/^collections\//, '');
  if (parent && parent.split('/').length % 2 !== 0) {
    throw new Error(`"${docPath}" is not a document path. To list a document's subcollections, use <collection>/<id>.`);
  }

  const remote = (parent ? await db.doc(parent).listCollections() : await db.listCollections()).map((c) => c.path);
  const pulled = allPulled(ws.root);
  const depth = parent ? parent.split('/').length + 1 : 1;
  const counts = new Map<string, number>();
  if (opts.count !== false) {
    await Promise.all(remote.map(async (p) => counts.set(p, await countDocuments(db, p))));
  }

  type Row = { name: string; docs: string; state: string; nested: string[] };
  const rows: Row[] = remote.map((name) => ({ name, docs: formatCount(counts.get(name)), state: localState(ws.root, name.split('/')), nested: [] }));
  // Pulled collections at this level that Firestore no longer lists (every document deleted).
  for (const q of pulled) {
    const name = q.join('/');
    if (q.length !== depth || remote.includes(name) || (parent && !name.startsWith(`${parent}/`))) continue;
    rows.push({ name, docs: '0', state: localState(ws.root, q) + dim(' · no longer in Firestore'), nested: [] });
  }
  // Deeper collections you've pulled under each one, e.g. "users/*/bookmarks: 40 pulled".
  for (const row of rows) {
    const groups = new Map<string, number>();
    for (const q of pulled) {
      if (q.length <= depth || q.slice(0, depth).join('/') !== row.name) continue;
      const pattern = q.map((s, i) => (i >= depth && i % 2 === 1 ? '*' : s)).join('/');
      groups.set(pattern, (groups.get(pattern) ?? 0) + 1);
    }
    row.nested = [...groups].map(([p, n]) => `${p}: ${n} pulled`);
  }

  const where = parent ? `Subcollections of ${bold(parent)}` : `Collections in ${bold(projectIdOf(ws))}`
    + (ws.config.databaseId && ws.config.databaseId !== '(default)' ? ` (database ${ws.config.databaseId})` : '');
  if (!rows.length) {
    console.log(dim(parent ? `${parent} has no subcollections.` : 'This database has no collections.'));
    return;
  }
  console.log(`${where}:\n`);

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const nameW = Math.max('COLLECTION'.length, ...rows.map((r) => r.name.length));
  // Without counts, the DOCUMENTS column is left out entirely.
  const docsW = opts.count === false ? 0 : Math.max('DOCUMENTS'.length, ...rows.map((r) => r.docs.length));
  const docsCell = (s: string) => (docsW ? `${s.padStart(docsW)}   ` : '');
  console.log(dim(`  ${'COLLECTION'.padEnd(nameW)}   ${docsCell('DOCUMENTS')}LOCAL`));
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(nameW)}   ${docsCell(r.docs)}${r.state}`);
    for (const n of r.nested) console.log(dim(`  ${' '.repeat(nameW + 3 + (docsW ? docsW + 3 : 0))}└ ${n}`));
  }

  if (rows.some((r) => !pulled.some((q) => q.join('/') === r.name))) {
    console.log(dim(`\nTo download a specific collection, run ${cmd('firerow pull <collection>')}`
      + `${parent ? '.' : `, or ${cmd('firerow pull --all')} for every collection.`}`));
  }
}
