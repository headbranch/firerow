import { CellError, decodeCell, encodeCell, type Column, type PValue } from '../codec.js';
import { loadWorkspace } from '../config.js';
import { applyChoices, isOpen, readConflicts, saveConflicts, type SavedConflict } from '../conflicts.js';
import { csvPath } from '../paths.js';
import { assertNotEditing } from '../session.js';
import { readCsv, writeCsv } from '../table.js';
import { resolveLocal } from '../targets.js';
import { ask, bold, cmd, dim, green, readKey, yellow } from '../ui.js';

/** `local` keeps the value in your CSV; `remote` takes the one currently in Firestore. */
export interface ResolveOptions { local?: boolean; remote?: boolean }

type Side = 'local' | 'remote';
type Choice = { id: string; field: string; value?: PValue };

const show = (v: PValue | undefined, col: Column) =>
  (v === undefined ? dim('(empty — field removed)') : encodeCell(v, col.type === 'any' ? v.t : col.type) || '""');

export async function resolve(args: string[], opts: ResolveOptions): Promise<void> {
  if (opts.local && opts.remote) throw new Error('Choose --local or --remote, not both.');
  const ws = loadWorkspace();
  const targets = resolveLocal(ws.root, args);
  assertNotEditing(ws.root, targets.map((s) => s.join('/')));

  // Every conflict still marked in its CSV (ones already fixed by hand are dropped).
  const work = targets.map((segs) => {
    const saved = readConflicts(ws.root, segs);
    if (!saved.length) return undefined;
    const table = readCsv(csvPath(ws.root, segs));
    const open = saved.filter((c) => isOpen(table, c));
    if (open.length < saved.length) saveConflicts(ws.root, segs, open);
    return open.length ? { segs, table, open } : undefined;
  }).filter((w) => w !== undefined);

  const total = work.reduce((n, w) => n + w.open.length, 0);
  if (!total) { console.log(green('No conflicts to resolve.')); return; }

  let all: Side | undefined = opts.local ? 'local' : opts.remote ? 'remote' : undefined;
  if (!all && !process.stdin.isTTY) {
    throw new Error(`${total} conflict(s) to resolve. resolve asks about each one; without a terminal, use --local or --remote.`);
  }

  let n = 0;
  let quit = false;
  const tally = { local: 0, remote: 0, custom: 0, skipped: 0 };
  for (const { segs, table, open } of work) {
    const name = segs.join('/');
    const choices: Choice[] = [];
    const left: SavedConflict[] = [];
    for (const c of open) {
      n++;
      const col = table.columns.find((x) => x.field === c.field)!;
      let pick: Side | 'custom' | 'skip' | undefined = quit ? 'skip' : all;
      if (!pick) {
        console.log(`\n${bold(c.field)} in ${bold(`${name}/${c.id}`)}   ${dim(`(${n} of ${total})`)}`);
        console.log(`  local:   ${show(c.local, col)}`);
        console.log(`  remote:  ${show(c.remote, col)}`);
        const key = await askChoice();
        if (key === 'L' || key === 'R') all = key === 'L' ? 'local' : 'remote';
        if (key === 'q') quit = true; // the rest stay marked for later
        const picks = { l: 'local', L: 'local', r: 'remote', R: 'remote', e: 'custom', s: 'skip', q: 'skip' } as const;
        pick = picks[key];
      }
      if (pick === 'skip') { left.push(c); tally.skipped++; continue; }
      const value = pick === 'custom' ? await askCustom(col) : pick === 'local' ? c.local : c.remote;
      choices.push({ id: c.id, field: c.field, value });
      tally[pick]++;
    }
    if (choices.length) writeCsv(csvPath(ws.root, segs), applyChoices(table, choices));
    saveConflicts(ws.root, segs, left);
  }

  const parts = [
    tally.local && `${tally.local} local`,
    tally.remote && `${tally.remote} remote`,
    tally.custom && `${tally.custom} custom`,
  ].filter(Boolean);
  console.log(`\n${green('✓')} Resolved ${total - tally.skipped} of ${total} conflict${total === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}.`);
  if (tally.skipped) console.log(yellow(`${tally.skipped} skipped — still marked in the CSV; run ${cmd('firerow resolve')} again when you're ready.`));
  const target = args.length ? ` ${args.map((a) => (a.includes('*') ? `"${a}"` : a)).join(' ')}` : '';
  console.log(dim(`Review with ${cmd(`firerow status${target}`)}, then ${cmd(`firerow push${target}`)}.`));
}

/** One keypress, no Enter. Ctrl+C counts as q (quit, leaving the rest marked). */
async function askChoice(): Promise<'l' | 'r' | 'e' | 's' | 'q' | 'L' | 'R'> {
  console.log(dim('  [l] use local   [r] use remote   [e] enter your own value   [s] skip   [q] quit'));
  console.log(dim('  [L] / [R]  use local / remote for all remaining'));
  for (;;) {
    const a = await readKey('  > ');
    if (a === null) return 'q';
    if (/^[lresqLR]$/.test(a)) return a as 'l' | 'r' | 'e' | 's' | 'q' | 'L' | 'R';
    console.log(yellow('  Press l, r, e, s or q (or L / R for all remaining).'));
  }
}

async function askCustom(col: Column): Promise<PValue | undefined> {
  for (;;) {
    const text = await ask(`  Value for ${col.field}${col.type === 'string' ? '' : ` (${col.type})`}, empty to remove the field: `);
    try {
      return decodeCell(text, col.type);
    } catch (e) {
      if (!(e instanceof CellError)) throw e;
      console.log(yellow(`  ${e.message}`));
    }
  }
}
