#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { discard } from './commands/discard.js';
import { edit } from './commands/edit.js';
import { init } from './commands/init.js';
import { list } from './commands/list.js';
import { pull } from './commands/pull.js';
import { push, status } from './commands/push.js';
import { resolve } from './commands/resolve.js';
import { log, revert } from './commands/revert.js';
import { untrack } from './commands/untrack.js';
import { red } from './ui.js';

// Always end with one blank line, so each command's output is spaced from the next prompt.
// (Tracks the last characters written so it never doubles up an existing blank line.)
let tail = '';
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    tail = (tail + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())).slice(-2);
    return write(chunk, ...rest);
  }) as typeof stream.write;
}
process.on('exit', () => {
  if (tail && tail !== '\n\n') process.stdout.write(tail.endsWith('\n') ? '\n' : '\n\n');
});

const program = new Command()
  .name('firerow')
  .description('Edit Firestore collections as CSV files.')
  .version(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);

program.command('init')
  .description('connect this folder to a Firebase project')
  .option('-k, --service-account <file>', 'path to the service-account JSON key')
  .option('-d, --database <id>', 'Firestore database id')
  .option('-f, --force', 'overwrite an existing firerow.config.json')
  .action((opts) => init(opts));

program.command('pull')
  .description('download collections to collections/<path>/documents.csv, merging any unpushed edits (default: every pulled collection)')
  .argument('[paths...]', 'collections, documents or patterns, space- or comma-separated: <collection> <collection>/<id> "<collection>/*/<subcollection>"')
  .option('-a, --all', "also pull every top-level collection (shows document counts and asks first)")
  .option('-y, --yes', 'with --all: skip the confirmation prompt')
  .action((c: string[], opts) => pull(c, opts));

program.command('status')
  .description('show local edits that have not been pushed (offline)')
  .argument('[collections...]', 'collections or patterns; default: every pulled collection')
  .action((c: string[]) => status(c));

program.command('push')
  .description('push your CSV edits to Firestore')
  .argument('[collections...]', 'collections or patterns, space- or comma-separated; default: every pulled collection')
  .option('-n, --dry-run', 'show the changes without writing')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('-f, --force', 'overwrite fields that changed in Firestore since you pulled')
  .option('-p, --pull', 're-pull the pushed collections afterwards (costs one read per document)')
  .option('--rename-fields', 'when a column header was renamed, rename the field in Firestore (delete the old one)')
  .option('--delete-fields', 'when a column was removed from the CSV, delete that field in Firestore')
  .action((c: string[], opts) => push(c, opts));

program.command('edit')
  .description('edit several collections (or some documents) in one temporary sheet, then apply it back to their CSVs (offline)')
  .argument('[paths...]', 'collections, patterns ("<collection>/*/<subcollection>") or documents (<collection>/<id>); default: every pulled collection')
  .option('--app <program>', 'open the sheet with this program instead of the default app')
  .option('--no-open', "don't open the sheet, just create it")
  .option('--no-wait', "don't wait — finish later with --apply or --cancel")
  .option('--apply', 'apply the open sheet to the collection CSVs')
  .option('--cancel', 'throw the open sheet away')
  .action((c: string[], opts) => edit(c, opts));

program.command('resolve')
  .description("go through conflicts left by a merging pull, choosing the local value, the remote one, or your own")
  .argument('[collections...]', 'collections or patterns; default: every pulled collection')
  .option('--local', 'use the local value (your CSV) for every conflict, without asking')
  .option('--remote', "use the remote value (Firestore's) for every conflict, without asking")
  .action((c: string[], opts) => resolve(c, opts));

program.command('discard')
  .description('throw away unpushed edits, restoring CSVs to what was last pulled/pushed (offline)')
  .argument('[paths...]', 'collections, patterns or documents (<collection>/<id>); default: every pulled collection')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action((c: string[], opts) => discard(c, opts));

program.command('log')
  .description('list recent pushes, newest first (offline)')
  .option('-n, --number <count>', 'how many to show (default 20)')
  .option('--oneline', 'one line per push')
  .action((opts) => log(opts));

program.command('revert')
  .description("undo a push: put back what it changed (default: the latest push that hasn't been undone)")
  .argument('[push]', 'push id from "firerow log" (the start of it is enough)')
  .option('-n, --dry-run', 'show what would be reverted without writing')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('-f, --force', 'revert even documents that were changed in Firestore after the push')
  .action((p: string | undefined, opts) => revert(p, opts));

program.command('untrack')
  .description('stop tracking collections: delete their local CSVs (nothing in Firestore is touched; offline)')
  .argument('<collections...>', 'collections or patterns ("<collection>/*/<subcollection>")')
  .option('-r, --recursive', 'also untrack every tracked collection under them (subcollections)')
  .option('-f, --force', 'untrack even if there are unpushed edits (they are lost)')
  .action((c: string[], opts) => untrack(c, opts));

program.command('list').alias('ls')
  .description("list Firestore collections with document counts, and what you've pulled locally")
  .argument('[document]', 'list the subcollections of this document (<collection>/<id>) instead')
  .option('--no-count', "don't count documents (counting costs 1 read per 1,000 documents)")
  .action((d, opts) => list(d, opts));

program.parseAsync().catch((e: Error) => {
  console.error(red(`Error: ${e.message}`));
  process.exit(1);
});
