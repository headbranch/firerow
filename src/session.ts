// An open `firerow edit` sheet. While one is open, the collections in it are "checked
// out" to the sheet: other commands that would change their CSVs refuse to run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { csvPath, STATE_DIR } from './paths.js';
import type { SheetLayout } from './sheet.js';
import { cmd } from './ui.js';

export interface EditSession extends SheetLayout {
  /** Sheet file, relative to the workspace root. */
  sheet: string;
  /** What was passed to `firerow edit`, for hints like "firerow push <args>". */
  args: string[];
  /** Hash of each collection CSV when the sheet was made, to spot edits made meanwhile. */
  hashes: Record<string, string>;
}

const sessionFile = (root: string) => path.join(root, STATE_DIR, 'edit', 'session.json');
export const sheetDir = (root: string) => path.join(root, STATE_DIR, 'edit');

export function readSession(root: string): EditSession | undefined {
  const f = sessionFile(root);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as EditSession) : undefined;
}

export function writeSession(root: string, s: EditSession): void {
  fs.mkdirSync(path.dirname(sessionFile(root)), { recursive: true });
  fs.writeFileSync(sessionFile(root), JSON.stringify(s, null, 2));
}

export function endSession(root: string): void {
  fs.rmSync(sessionFile(root), { force: true });
}

export function hashCsv(root: string, name: string): string {
  const f = csvPath(root, name.split('/'));
  return fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') : 'missing';
}

/** Refuse to touch collections that are checked out to an open edit sheet. */
export function assertNotEditing(root: string, names: string[]): void {
  const s = readSession(root);
  if (!s) return;
  const busy = names.filter((n) => s.collections.includes(n));
  if (!busy.length) return;
  const shown = busy.length > 3 ? `${busy.slice(0, 3).join(', ')} and ${busy.length - 3} more` : busy.join(', ');
  throw new Error(`${shown} ${busy.length === 1 ? 'is' : 'are'} open in an edit sheet (${s.sheet}).\n`
    + `Finish it first: ${cmd('firerow edit --apply')} to apply it, or ${cmd('firerow edit --cancel')} to throw it away.`);
}
