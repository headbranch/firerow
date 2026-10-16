import fs from 'node:fs';
import path from 'node:path';
import { formatHeader, parseHeader } from '../codec.js';
import { connect, loadWorkspace } from '../config.js';
import { csvPath, isPattern, parseCollectionPath, snapshotPath } from '../paths.js';
import { readSnapshot, writeSnapshot } from '../snapshot.js';
import { ID_COLUMN, rowsToCsv, writeCsv } from '../table.js';
import { bold, cmd, dim, green, openFile } from '../ui.js';

/** "name:string" — a column with a known type (an unknown one stays part of the name). */
const isTyped = (col: string) => col.includes(':') && !parseHeader(col).field.includes(':');

/**
 * Columns separated by spaces instead of commas: every piece has a type ("first name:string" is
 * one column with a space in it). Not accepted, since columns are one quoted, comma-separated
 * list, but PowerShell turns an unquoted name:string,age:number into exactly this.
 */
export function spaceSeparated(text: string): string[] | undefined {
  const pieces = text.trim().split(/\s+/);
  return pieces.length > 1 && pieces.every(isTyped) ? pieces : undefined;
}

/** For columns that didn't arrive as one comma-separated list: the command to run instead. */
export function quoteColumnsError(collection: string, columns: string[]): Error {
  return new Error('Columns go in one set of double quotes, separated by commas:\n'
    + `  ${bold(`firerow create ${collection} "${columns.join(',')}"`)}`);
}

/**
 * The header row for a new collection's CSV: "_id", then each comma-separated column as given —
 * "name:string" keeps its type, a bare "name" leaves it to be guessed from the values.
 */
export function newHeader(columns = '', collection = '<collection>'): string[] {
  const header = [ID_COLUMN];
  const seen = new Set<string>();
  const list = columns.split(',').map((x) => x.trim()).filter(Boolean);
  if (list.some((x) => spaceSeparated(x))) throw quoteColumnsError(collection, list.flatMap((x) => spaceSeparated(x) ?? [x]));
  for (const raw of list) {
    const col = parseHeader(raw);
    // parseHeader reads an unknown type as part of the name; here it's almost certainly a typo.
    if (col.field.includes(':')) {
      const type = col.field.slice(col.field.lastIndexOf(':') + 1);
      // "name:string price:numbr": columns separated by a space (one with a typo in its type).
      if (/\s/.test(raw)) throw new Error(`"${raw}": separate columns with commas, not spaces.`);
      throw new Error(`"${raw}": unknown type "${type}". Use one of string, number, boolean, timestamp, geopoint, reference, bytes, array, map, null or any.`);
    }
    if (col.field === ID_COLUMN) throw new Error(`"${ID_COLUMN}" is always the first column; leave it out.`);
    if (seen.has(col.field)) throw new Error(`Column "${col.field}" is listed twice.`);
    seen.add(col.field);
    header.push(formatHeader(col, col.field === raw));
  }
  return header;
}

/**
 * Start a new collection locally: an empty CSV (just the header) and an empty snapshot, so it's
 * tracked like a pulled collection. Firestore has no empty collections — `push` creates it with
 * its first documents.
 */
export async function create(name: string, columns: string | undefined, opts: { open?: boolean; app?: string } = {}): Promise<void> {
  const ws = loadWorkspace();
  const segs = parseCollectionPath(name);
  if (isPattern(segs)) throw new Error(`"${name}": create one collection at a time — "*" patterns aren't allowed here.`);
  const header = newHeader(columns, name);
  const collection = segs.join('/');
  const file = csvPath(ws.root, segs);
  const rel = path.relative(process.cwd(), file);

  if (readSnapshot(snapshotPath(ws.root, segs))) {
    throw new Error(`${collection} is already tracked (${rel}). Add rows to it and run ${cmd(`firerow push ${collection}`)}.`);
  }
  if (fs.existsSync(file)) throw new Error(`${rel} already exists. Delete it first, or pick another name.`);

  // Make sure there's nothing there to clash with (1 read, even when empty).
  const existing = await connect(ws).collection(collection).limit(1).get();
  if (!existing.empty) {
    throw new Error(`${collection} already exists in Firestore. Run ${cmd(`firerow pull ${collection}`)} to work on it.`);
  }

  writeCsv(file, rowsToCsv([header]));
  writeSnapshot(snapshotPath(ws.root, segs), { collection, pulledAt: new Date().toISOString(), columns: [], docs: [] });
  console.log(`${green('✓')} ${rel} ${dim(`(new collection${header.length > 1 ? `: ${header.slice(1).join(', ')}` : ''})`)}`);
  if (opts.open !== false) openFile(file, opts.app);
  console.log(dim(`\nFirestore only creates a collection along with its first document: `
    + `${opts.open !== false ? 'add rows in the CSV that just opened' : 'add rows to it'} (a blank _id gets an auto id), save, `
    + `then ${cmd(`firerow push ${collection}`)}.`));
}
