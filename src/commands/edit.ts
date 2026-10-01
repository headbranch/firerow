import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkspace } from '../config.js';
import { computePlan, planSize } from '../diff.js';
import { csvPath, snapshotPath } from '../paths.js';
import { endSession, hashCsv, readSession, sheetDir, writeSession, type EditSession } from '../session.js';
import { buildSheet, checkSplit, splitSheet } from '../sheet.js';
import { readSnapshot } from '../snapshot.js';
import { readCsv, writeCsv } from '../table.js';
import { parsePullArgs, resolveLocal } from '../targets.js';
import { bold, cmd, dim, green, readKey, red, yellow } from '../ui.js';

export interface EditOptions { open?: boolean; wait?: boolean; app?: string; apply?: boolean; cancel?: boolean }

const rel = (f: string) => path.relative(process.cwd(), f);

export async function edit(args: string[], opts: EditOptions): Promise<void> {
  const ws = loadWorkspace();
  const session = readSession(ws.root);

  if (opts.apply || opts.cancel) {
    if (args.length) throw new Error(`--${opts.apply ? 'apply' : 'cancel'} works on the open sheet; don't name collections.`);
    if (!session) throw new Error('No edit sheet is open.');
    if (opts.cancel) return cancel(ws.root, session);
    const ok = apply(ws.root, session);
    if (!ok) process.exitCode = 1;
    return;
  }
  if (session) {
    throw new Error(`An edit sheet is already open (${session.sheet}).\n`
      + `Finish it first: ${cmd('firerow edit --apply')} to apply it, or ${cmd('firerow edit --cancel')} to throw it away.`);
  }

  // Documents (users/alice) get a document sheet; collections get a collection sheet.
  const named = parsePullArgs(args);
  if (named.docs.size && named.collections.length) {
    throw new Error('Name either collections or documents to edit, not both.');
  }
  const documents = named.docs.size ? named.docs : undefined;
  const targets = documents ? [...documents.keys()].map((c) => c.split('/')) : resolveLocal(ws.root, args);
  if (!targets.length) throw new Error('Nothing pulled yet. Pull the collections you want to edit first.');
  for (const segs of targets) {
    if (!readSnapshot(snapshotPath(ws.root, segs))) throw new Error(`${segs.join('/')} hasn't been pulled. Run ${cmd(`firerow pull ${segs.join('/')}`)} first.`);
  }

  // One whole collection: nothing to combine — just open its CSV.
  if (!documents && targets.length === 1) {
    const file = csvPath(ws.root, targets[0]);
    if (opts.open !== false) openFile(file, opts.app);
    console.log(`${opts.open !== false ? 'Opened' : 'Edit'} ${rel(file)} — save it, then ${cmd('firerow status')} / ${cmd('firerow push')}.`);
    return;
  }

  const names = targets.map((s) => s.join('/'));
  const sources = targets.map((segs) => {
    const file = csvPath(ws.root, segs);
    return { name: segs.join('/'), file: rel(file), table: readCsv(file) };
  });
  const built = buildSheet(sources, documents);
  if (built.problems.length) {
    throw new Error(`Fix these first, then run edit again:\n  ${built.problems.join('\n  ')}`);
  }

  const label = (args.length ? args.join('+') : 'all').replace(/\*/g, 'all').replace(/[\\/:,|?"<>]+/g, '.').replace(/^\.+|\.+$/g, '');
  const sheet = path.join(sheetDir(ws.root), `${label || 'sheet'}.csv`);
  writeCsv(sheet, built.text);
  writeSession(ws.root, {
    ...built.layout,
    sheet: path.relative(ws.root, sheet),
    args,
    hashes: Object.fromEntries(names.map((n) => [n, hashCsv(ws.root, n)])),
  });

  if (documents) {
    console.log(`${green('✓')} Edit sheet for ${built.rows === 1 ? bold(built.layout.documents![0]) : `${built.rows} documents`}: ${bold(rel(sheet))}`);
    console.log(dim('  Change values, clear cells, or add, remove and rename columns. Rows can\'t be added or removed here.'));
  } else {
    console.log(`${green('✓')} Edit sheet with ${built.rows} row${built.rows === 1 ? '' : 's'} from ${names.length} collections: ${bold(rel(sheet))}`);
    console.log(dim(`  Rows are identified by ${bold('_path')} (e.g. ${names[0]}/<id>); end it with "/" for a new auto id.`));
  }
  if (opts.open !== false) openFile(sheet, opts.app);

  if (opts.wait === false || !process.stdin.isTTY) {
    console.log(`\nWhen you're done: ${cmd('firerow edit --apply')} (or ${cmd('firerow edit --cancel')}).`);
    return;
  }
  await waitAndApply(ws.root);
}

/** Wait for Enter, apply; on problems in the sheet, let the user fix them and try again. */
async function waitAndApply(root: string): Promise<void> {
  const question = `\nSave the sheet, then press ${bold('Enter')} to apply it (or ${bold('c')} to cancel): `;
  for (;;) {
    let key = await readKey(question);
    // Any other key: ask again (a keypress can't be undone, so only Enter and c count).
    while (key !== null && key !== 'enter' && !/^c(ancel)?$/i.test(key)) key = await readKey(dim('Press Enter to apply, or c to cancel: '));
    const session = readSession(root)!;
    if (key !== 'enter') return cancel(root, session);
    if (apply(root, session)) return;
    if (!readSession(root)) return; // gave up (e.g. CSVs changed underneath)
    console.log(dim('Fix the sheet and save it — or press c to cancel.'));
  }
}

/** Split the sheet back into the collection CSVs. Returns true when applied. */
function apply(root: string, s: EditSession): boolean {
  const sheet = path.join(root, s.sheet);
  const changed = s.collections.filter((n) => hashCsv(root, n) !== s.hashes[n]);
  if (changed.length) {
    console.error(red(`These CSVs changed after the sheet was made, so applying it would overwrite those edits:\n  ${changed.join('\n  ')}`));
    console.error(`Your sheet is still at ${rel(sheet)}. Copy what you need, then run ${cmd('firerow edit --cancel')}.`);
    return false;
  }
  if (!fs.existsSync(sheet)) {
    console.error(red(`The sheet ${rel(sheet)} is gone. Run ${cmd('firerow edit --cancel')} to close the session.`));
    return false;
  }

  // A document sheet only replaces its own rows, so it needs the rest of each collection.
  const current = s.documents ? new Map(s.collections.map((n) => [n, readCsv(csvPath(root, n.split('/')))])) : undefined;
  const { files, problems } = splitSheet(fs.readFileSync(sheet), s, current);
  if (!problems.length) {
    const snapshots = new Map(s.collections.map((n) => [n, readSnapshot(snapshotPath(root, n.split('/')))!]));
    problems.push(...checkSplit(files, snapshots));
  }
  if (problems.length) {
    console.error(red(`Problems in ${rel(sheet)}:\n  ${problems.join('\n  ')}`));
    return false;
  }
  for (const [name, text] of files) writeCsv(csvPath(root, name.split('/')), text);
  endSession(root);
  removeSheet(sheet);

  console.log(`${green('✓')} Applied the sheet to ${s.collections.length} collection${s.collections.length === 1 ? '' : 's'}:`);
  let pending = 0;
  for (const name of s.collections) {
    try {
      const n = planSize(computePlan(readSnapshot(snapshotPath(root, name.split('/')))!, readCsv(csvPath(root, name.split('/')))));
      pending += n;
      if (n) console.log(`  ${name}: ${n} unpushed change${n === 1 ? '' : 's'}`);
    } catch (e) {
      console.log(yellow(`  ${name}: ${(e as Error).message.split('\n')[0]}`));
    }
  }
  if (!pending) console.log(dim(`  (no document changes — renamed or removed columns show up in ${cmd('firerow status')})`));
  const target = s.args.length ? ` ${s.args.map((a) => (a.includes('*') ? `"${a}"` : a)).join(' ')}` : '';
  console.log(`\nReview with ${cmd(`firerow status${target}`)}, then ${cmd(`firerow push${target}`)}.`);
  return true;
}

function cancel(root: string, s: EditSession): void {
  endSession(root);
  removeSheet(path.join(root, s.sheet));
  console.log(dim('Edit sheet thrown away. Your collection CSVs were not changed.'));
}

function removeSheet(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    console.log(yellow(`Couldn't delete ${rel(file)} (still open in another app?). It's no longer used — delete it when you can.`));
  }
}

function openFile(file: string, app?: string): void {
  const fail = () => console.log(yellow(`Couldn't open it automatically — open ${rel(file)} yourself.`));
  try {
    const child = app
      ? spawn(`${app} "${file}"`, { shell: true, detached: true, stdio: 'ignore' })
      : process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', `"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' });
    child.on('error', fail);
    child.unref();
  } catch {
    fail();
  }
}
