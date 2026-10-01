import type { DocumentSnapshot, Firestore, Precondition, WriteBatch, WriteResult } from 'firebase-admin/firestore';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { toFirestore, type PValue } from '../codec.js';
import { connect, loadWorkspace, projectIdOf } from '../config.js';
import { samePValue } from '../diff.js';
import { findPush, listPushes, newPushId, pushKind, savePush, type JournalChange, type PushRecord } from '../journal.js';
import { toSnapshotDoc } from '../snapshot.js';
import { allPulled } from '../targets.js';
import { bold, cmd, confirm, dim, green, red, section, show, timeAgo, yellow } from '../ui.js';
import { pull } from './pull.js';

const BATCH_LIMIT = 500;

export interface RevertOptions { yes?: boolean; force?: boolean; dryRun?: boolean }

/** One write that undoes one change of the push, and what it would overwrite. */
interface Undo {
  change: JournalChange;
  live: DocumentSnapshot;
  /** The journal entry for the undo itself (so a revert can be reverted). */
  entry: Omit<JournalChange, 'writeTime'>;
  write: (b: WriteBatch, db: Firestore, pre?: Precondition) => void;
  /** Why this can't be undone safely: someone changed it after the push. */
  conflict?: string;
}

const docLabel = (c: JournalChange) => `${c.collection}/${c.id}`;
const pick = (fields: Record<string, PValue>, names: string[]) =>
  Object.fromEntries(names.filter((f) => fields[f] !== undefined).map((f) => [f, fields[f]]));
const sameDoc = (a: Record<string, PValue>, b: Record<string, PValue>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].every((f) => samePValue(a[f], b[f]));
const toData = (fields: Record<string, PValue>, db: Firestore) =>
  Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, toFirestore(v, db)]));

/** Work out the write that undoes `c`, given the document as it is now. Undefined: already undone. */
function plan(c: JournalChange, live: DocumentSnapshot): Undo | undefined {
  const now = live.exists ? toSnapshotDoc(live).fields : undefined;
  const base = { change: c, live };
  if (c.kind === 'create') {
    if (!now) return undefined;
    return {
      ...base,
      entry: { collection: c.collection, id: c.id, kind: 'delete', before: now, after: null },
      write: (b, db, pre) => b.delete(db.collection(c.collection).doc(c.id), pre),
      conflict: sameDoc(now, c.after!) ? undefined : 'it was edited after your push',
    };
  }
  if (c.kind === 'delete') {
    if (now && sameDoc(now, c.before!)) return undefined;
    return {
      ...base,
      entry: { collection: c.collection, id: c.id, kind: 'create', before: now ?? null, after: c.before },
      // With --force over an existing document, `set` replaces it with the deleted version.
      write: (b, db) => { const ref = db.collection(c.collection).doc(c.id); if (now) b.set(ref, toData(c.before!, db)); else b.create(ref, toData(c.before!, db)); },
      conflict: now ? 'a document with this id was created after your push' : undefined,
    };
  }
  // update: put back the touched fields that aren't already back to what they were.
  if (!now) {
    return {
      ...base,
      entry: { collection: c.collection, id: c.id, kind: 'create', before: null, after: c.before! },
      write: (b, db) => b.set(db.collection(c.collection).doc(c.id), toData(c.before!, db)),
      conflict: 'it was deleted after your push',
    };
  }
  const fields = c.fields!.filter((f) => !samePValue(now[f], c.before![f]));
  if (!fields.length) return undefined;
  const changedSince = fields.filter((f) => !samePValue(now[f], c.after![f]));
  return {
    ...base,
    entry: { collection: c.collection, id: c.id, kind: 'update', fields, before: pick(now, fields), after: pick(c.before!, fields) },
    write: (b, db, pre) => {
      const pairs: unknown[] = [];
      for (const f of fields) pairs.push(new FieldPath(f), c.before![f] === undefined ? FieldValue.delete() : toFirestore(c.before![f], db));
      const [first, firstVal, ...rest] = pairs;
      (b.update as Function).call(b, db.collection(c.collection).doc(c.id), first, firstVal, ...rest, ...(pre ? [pre] : []));
    },
    conflict: changedSince.length
      ? `${changedSince.map((f) => `"${f}"`).join(', ')} ${changedSince.length === 1 ? 'was' : 'were'} changed after your push`
      : undefined,
  };
}

function printUndo(u: Undo): void {
  const c = u.change;
  const now = u.live.exists ? toSnapshotDoc(u.live).fields : {};
  if (u.entry.kind === 'delete') {
    console.log(red(`- delete ${c.id}`) + dim('  (created by the push)'));
  } else if (u.entry.kind === 'create') {
    console.log(green(`+ re-create ${c.id}`) + dim(c.kind === 'delete' ? '  (deleted by the push)' : '  (deleted since the push)'));
    for (const [f, v] of Object.entries(u.entry.after!)) console.log(green(`    ${f}: ${show(v, undefined)}`));
  } else {
    console.log(yellow(`~ restore ${c.id}`));
    for (const f of u.entry.fields!) {
      const back = c.before![f] === undefined ? dim('(field removed)') : show(c.before![f], undefined);
      console.log(`    ${f}: ${now[f] === undefined ? dim('(absent)') : show(now[f], undefined)} → ${back}`);
    }
  }
}

const describe = (p: PushRecord) => {
  const n = p.changes.length;
  return `${bold(p.id)} ${dim(`(pushed ${timeAgo(p.pushedAt)}, ${n} change${n === 1 ? '' : 's'})`)}`;
};

export async function revert(ref: string | undefined, opts: RevertOptions): Promise<void> {
  const ws = loadWorkspace();
  // Like an undo stack: with no id, the latest push that hasn't been reverted, skipping undos
  // (a revert of a push) so repeated `firerow revert` keeps going back. A redo (a revert of an
  // undo) re-applies a push, so it counts as one.
  const pushes = listPushes(ws.root);
  const byId = new Map(pushes.map((p) => [p.id, p]));
  const isUndo = (p: PushRecord) => pushKind(p, byId) === 'undo';
  const target = ref ? findPush(ws.root, ref) : pushes.find((p) => !p.revertedBy && !isUndo(p));
  if (!target) throw new Error(`No pushes to revert. Run ${cmd('firerow log')} to see recent pushes.`);
  if (target.revertedBy) throw new Error(`Push ${target.id} was already reverted by ${target.revertedBy}. To redo it, run ${cmd(`firerow revert ${target.revertedBy}`)}.`);
  const projectId = projectIdOf(ws);
  const databaseId = ws.config.databaseId ?? '(default)';
  if (target.projectId !== projectId || target.databaseId !== databaseId) {
    throw new Error(`Push ${target.id} was made to ${target.projectId} / ${target.databaseId}, but this folder is connected to ${projectId} / ${databaseId}.`);
  }

  const note = !target.revertOf ? ''
    : isUndo(target) ? ` — it undid ${target.revertOf}, so this redoes that push`
    : ` — it redid ${byId.get(target.revertOf)?.revertOf ?? 'a push'}, so this undoes that push again`;
  console.log(`Reverting ${describe(target)}${dim(note)}`);
  if (!target.complete) console.log(yellow('That push failed partway; only the changes it actually wrote are undone.'));

  // Read every document the push wrote, as it is now (1 read each).
  const db = connect(ws);
  const live: DocumentSnapshot[] = [];
  for (let i = 0; i < target.changes.length; i += 100) {
    live.push(...await db.getAll(...target.changes.slice(i, i + 100).map((c) => db.collection(c.collection).doc(c.id))));
  }
  const undos = target.changes.map((c, i) => plan(c, live[i])).filter((u) => u !== undefined);
  if (!undos.length) { console.log(green('\nNothing to revert: every change is already back to how it was.')); return; }

  for (const collection of [...new Set(undos.map((u) => u.change.collection))]) {
    section(bold(collection));
    for (const u of undos.filter((x) => x.change.collection === collection)) printUndo(u);
  }

  const conflicts = undos.filter((u) => u.conflict);
  if (conflicts.length) {
    console.log(red(bold(`\n${conflicts.length} document${conflicts.length === 1 ? ' was' : 's were'} changed in Firestore after your push:`)));
    for (const u of conflicts) console.log(red(`  ${docLabel(u.change)}: ${u.conflict}`));
    if (!opts.force) {
      process.exitCode = 1;
      console.log(`\nNothing was reverted. Reverting would overwrite those changes; use ${bold('--force')} if that's what you want.`);
      return;
    }
    console.log(yellow('--force: overwriting them.'));
  }
  if (opts.dryRun) { console.log(dim('\n--dry-run: nothing was written.')); return; }
  if (!opts.yes && !(await confirm(`\nRevert ${undos.length} change${undos.length === 1 ? '' : 's'}?`))) {
    console.log(dim('Aborted. Nothing was written.'));
    return;
  }

  // Each write fails if the document changed between our read and now (unless --force).
  const results: WriteResult[] = [];
  const id = newPushId(ws.root);
  const record = (complete: boolean) => savePush(ws.root, {
    id, pushedAt: new Date().toISOString(), projectId, databaseId, complete, revertOf: target.id,
    changes: results.map((r, i) => ({ ...undos[i].entry, writeTime: `${r.writeTime.seconds}.${r.writeTime.nanoseconds}` })),
  });
  try {
    for (let i = 0; i < undos.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      for (const u of undos.slice(i, i + BATCH_LIMIT)) {
        u.write(batch, db, opts.force || !u.live.exists ? undefined : { lastUpdateTime: u.live.updateTime! });
      }
      results.push(...await batch.commit());
    }
  } catch (e) {
    if (results.length) record(false);
    console.error(red(`\nRevert failed after ${results.length}/${undos.length} changes: ${(e as Error).message}`));
    if (results.length) console.error(yellow(`Run ${cmd(`firerow revert ${target.id}`)} again to finish, or ${cmd(`firerow revert ${id}`)} to undo what was written.`));
    process.exitCode = 1;
    return;
  }
  record(true);
  savePush(ws.root, { ...target, revertedBy: id });
  console.log(green(`\n✓ Reverted ${undos.length} change${undos.length === 1 ? '' : 's'}.`) + dim(` Undo this with ${cmd(`firerow revert ${id}`)}.`));

  // Bring the local copies of those documents up to date (merging with any unpushed edits).
  const tracked = new Set(allPulled(ws.root).map((s) => s.join('/')));
  const docs = [...new Set(undos.filter((u) => tracked.has(u.change.collection)).map((u) => docLabel(u.change)))];
  if (!docs.length) return;
  console.log();
  try {
    await pull(docs);
  } catch (e) {
    console.log(yellow(`\nCouldn't update your local copy: ${(e as Error).message}`));
    console.log(yellow(`Run ${cmd('firerow pull')} for ${[...new Set(undos.map((u) => u.change.collection))].join(', ')} when you can.`));
  }
}

/** "2 created, 1 updated": documents written, coloured like `status`. */
function counts(changes: JournalChange[]): string {
  const n = (k: JournalChange['kind']) => changes.filter((c) => c.kind === k).length;
  return [n('create') && green(`${n('create')} created`), n('update') && yellow(`${n('update')} updated`), n('delete') && red(`${n('delete')} deleted`)]
    .filter(Boolean).join(', ');
}

/** "Oct 1, 10:10 AM" in local time (with the year when it isn't this year). */
function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
  });
}

/** `firerow log`: recent pushes, newest first. */
export function log(opts: { number?: string; oneline?: boolean }): void {
  const ws = loadWorkspace();
  const pushes = listPushes(ws.root);
  if (!pushes.length) { console.log(dim('No pushes yet.')); return; }
  const byId = new Map(pushes.map((p) => [p.id, p]));
  const limit = Number(opts.number ?? 20);

  for (const p of pushes.slice(0, limit)) {
    // A sentence: "Pushed 3 minutes ago", "Undid 76562d1 3 minutes ago", "Redid 76562d1 …".
    const kind = pushKind(p, byId);
    const original = kind === 'redo' ? byId.get(p.revertOf!)?.revertOf ?? p.revertOf : p.revertOf;
    const what = kind === 'push' ? 'Pushed' : `${kind === 'undo' ? 'Undid' : 'Redid'} ${bold(original!)}`;
    const notes = [
      p.revertedBy && `${kind === 'undo' ? 'redone' : 'undone'} by ${p.revertedBy}`,
      !p.complete && red('failed partway'),
    ].filter(Boolean).map((s) => dim(' · ') + s).join('');

    const collections = [...new Set(p.changes.map((c) => c.collection))];
    if (opts.oneline) {
      const where = collections.slice(0, 2).join(', ') + (collections.length > 2 ? ` and ${collections.length - 2} more` : '');
      console.log(`${yellow(bold(p.id))}  ${what} ${timeAgo(p.pushedAt)}: ${counts(p.changes)} ${dim(`in ${where}`)}${notes}`);
      continue;
    }
    console.log(`${yellow(bold(p.id))}  ${what} ${timeAgo(p.pushedAt)} ${dim(`(${when(p.pushedAt)})`)}${notes}`);
    const width = Math.min(40, Math.max(...collections.map((c) => c.length)));
    for (const c of collections.slice(0, 5)) {
      console.log(`  ${c.padEnd(width)}  ${counts(p.changes.filter((x) => x.collection === c))}`);
    }
    if (collections.length > 5) console.log(dim(`  …and ${collections.length - 5} more collections`));
    console.log();
  }
  if (pushes.length > limit) console.log(dim(`${pushes.length - limit} older push${pushes.length - limit === 1 ? '' : 'es'} not shown. Use -n to show more.`));
}
