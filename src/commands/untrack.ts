import fs from 'node:fs';
import path from 'node:path';
import { loadWorkspace } from '../config.js';
import { computePlan, isEmptyPlan, planSize } from '../diff.js';
import { COLLECTIONS_DIR, csvPath, snapshotPath } from '../paths.js';
import { assertNotEditing } from '../session.js';
import { readSnapshot } from '../snapshot.js';
import { readCsv } from '../table.js';
import { allPulled, dropState, removeEmptyDirs, resolveLocal } from '../targets.js';
import { bold, cmd, dim, green, yellow } from '../ui.js';

/**
 * Stop tracking collections: delete their CSVs and local state. Offline, and nothing in Firestore
 * is touched. Refuses while there are unpushed edits, unless forced.
 */
export async function untrack(args: string[], opts: { force?: boolean; recursive?: boolean }): Promise<void> {
  if (!args.length) throw new Error(`Name the collection(s) to stop tracking: ${cmd('firerow untrack <collection>')}, or a pattern like "<collection>/*/<subcollection>".`);
  const ws = loadWorkspace();
  const named = resolveLocal(ws.root, args);
  const pulled = allPulled(ws.root);
  const under = (segs: string[]) => pulled.filter((p) => p.length > segs.length && segs.every((s, i) => p[i] === s));
  // --recursive: every tracked collection under the named ones, too.
  const all = new Map(named.map((s) => [s.join('/'), s]));
  if (opts.recursive) for (const segs of named) for (const sub of under(segs)) all.set(sub.join('/'), sub);
  const targets = [...all.values()];
  assertNotEditing(ws.root, targets.map((s) => s.join('/')));

  const dirty: { name: string; what: string }[] = [];
  for (const segs of targets) {
    const snap = readSnapshot(snapshotPath(ws.root, segs));
    if (!snap) throw new Error(`${segs.join('/')} isn't tracked, so there's nothing to untrack.`);
    try {
      const plan = computePlan(snap, readCsv(csvPath(ws.root, segs)));
      if (isEmptyPlan(plan) && !plan.droppedColumns.length) continue;
      const n = planSize(plan);
      dirty.push({ name: segs.join('/'), what: n ? `${n} unpushed change${n === 1 ? '' : 's'}` : 'column changes' });
    } catch {
      dirty.push({ name: segs.join('/'), what: 'edits (the CSV currently has problems)' });
    }
  }

  if (dirty.length && !opts.force) {
    process.exitCode = 1;
    for (const d of dirty) console.log(`${bold(d.name)}: ${yellow(d.what)}`);
    const names = dirty.map((d) => d.name).join(',');
    console.log(`\nNothing was untracked. First ${cmd(`firerow push ${names}`)} or ${cmd(`firerow discard ${names}`)}`
      + ` — or use ${bold('--force')} to untrack anyway and lose these edits.`);
    return;
  }

  const collectionsDir = path.join(ws.root, COLLECTIONS_DIR);
  for (const segs of targets) {
    const file = csvPath(ws.root, segs);
    fs.rmSync(file, { force: true });
    // The folder goes too, unless it still holds subcollections you've pulled.
    removeEmptyDirs(path.dirname(file), collectionsDir);
    dropState(ws.root, segs);
    console.log(`${green('✓')} untracked ${segs.join('/')}`);
  }
  // Subcollections stay tracked unless --recursive; say so, since that's easy to miss.
  const left = [...new Set(named.flatMap(under).map((s) => s.join('/')))].filter((n) => !all.has(n));
  if (left.length) {
    const shown = left.slice(0, 3).join(', ') + (left.length > 3 ? `, and ${left.length - 3} more` : '');
    console.log(yellow(`\nStill tracked underneath: ${shown}.`) + dim(' Add --recursive to untrack them too.'));
  }
  console.log(dim(`\nNothing in Firestore was changed. ${cmd('firerow pull <collection>')} brings a collection back.`));
}
