import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { PValue } from '../src/codec.js';
import { computePlan } from '../src/diff.js';
import { buildSheet, splitSheet, type SheetSource } from '../src/sheet.js';
import type { Snapshot } from '../src/snapshot.js';
import { buildColumns, docsToCsv, readCsv } from '../src/table.js';

const S = (v: string): PValue => ({ t: 'string', v });
const N = (v: number): PValue => ({ t: 'number', v });

function snapshot(collection: string, docs: Record<string, Record<string, PValue>>): Snapshot {
  const list = Object.entries(docs).map(([id, fields]) => ({ id, updateTime: '1', fields }));
  return { collection, pulledAt: '', columns: buildColumns(list), docs: list };
}

const alice = snapshot('users/alice/bookmarks', {
  b1: { title: S('A1'), url: S('https://a1') },
  b2: { title: S('A2'), url: S('https://a2'), stars: N(3) },
});
const bob = snapshot('users/bob/bookmarks', { b1: { title: S('B1'), url: S('https://b1') } });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sheet-'));
function source(snap: Snapshot): SheetSource {
  const file = path.join(dir, `${snap.collection.replace(/\//g, '_')}.csv`);
  fs.writeFileSync(file, docsToCsv(snap.docs, snap.columns));
  return { name: snap.collection, file, table: readCsv(file) };
}
const tableOf = (text: string) => {
  const file = path.join(dir, `split-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(file, text);
  return readCsv(file);
};

test('build: one row per document, identified by _path, union of columns', () => {
  const { text, rows, problems, layout } = buildSheet([source(alice), source(bob)]);
  assert.deepEqual(problems, []);
  assert.equal(rows, 3);
  const records: string[][] = parse(text, { bom: true });
  assert.deepEqual(records, [
    ['_path', 'stars:number', 'title:string', 'url:string'],
    ['users/alice/bookmarks/b1', '', 'A1', 'https://a1'],
    ['users/alice/bookmarks/b2', '3', 'A2', 'https://a2'],
    ['users/bob/bookmarks/b1', '', 'B1', 'https://b1'],
  ]);
  assert.deepEqual(layout.collections, ['users/alice/bookmarks', 'users/bob/bookmarks']);
});

test('split: an untouched sheet changes nothing', () => {
  const { text, layout } = buildSheet([source(alice), source(bob)]);
  const { files, problems } = splitSheet(text, layout);
  assert.deepEqual(problems, []);
  for (const snap of [alice, bob]) {
    const plan = computePlan(snap, tableOf(files.get(snap.collection)!));
    assert.deepEqual([plan.creates, plan.updates, plan.deletes, plan.renames], [[], [], [], []]);
  }
  // bob never had "stars", and still doesn't.
  assert.ok(!files.get('users/bob/bookmarks')!.includes('stars'));
});

test('split: renaming a column renames it in every collection', () => {
  const { text, layout } = buildSheet([source(alice), source(bob)]);
  const { files } = splitSheet(text.replace('title', 'label'), layout);
  for (const snap of [alice, bob]) {
    const plan = computePlan(snap, tableOf(files.get(snap.collection)!));
    assert.deepEqual(plan.renames.map((r) => [r.from, r.to]), [['title', 'label']]);
  }
});

test('split: edits, moves between rows, new rows and deleted rows land in the right collection', () => {
  const { text, layout } = buildSheet([source(alice), source(bob)]);
  const edited = text
    .replace('users/alice/bookmarks/b2,3,A2', 'users/alice/bookmarks/b2,4,A2') // edit
    .replace(/\r\nusers\/alice\/bookmarks\/b1,[^\r]*/, '') // delete
    + 'users/bob/bookmarks/,,New,https://new\r\n' // new auto-id row
    + 'users/bob/bookmarks/b7,5,Seven,https://7\r\n'; // new row; bob gets a "stars" column
  const { files, problems } = splitSheet(edited, layout);
  assert.deepEqual(problems, []);

  const a = computePlan(alice, tableOf(files.get('users/alice/bookmarks')!));
  assert.deepEqual(a.updates.map((u) => [u.id, u.set]), [['b2', { stars: N(4) }]]);
  assert.deepEqual(a.deletes, [{ id: 'b1' }]);

  const b = computePlan(bob, tableOf(files.get('users/bob/bookmarks')!));
  assert.deepEqual(b.creates.map((c) => [c.id, c.fields]), [
    [undefined, { title: S('New'), url: S('https://new') }],
    ['b7', { stars: N(5), title: S('Seven'), url: S('https://7') }],
  ]);
});

test('split: rows for collections outside the sheet, bad paths and bad cells are reported', () => {
  const { text, layout } = buildSheet([source(alice), source(bob)]);
  const { problems } = splitSheet(text
    + 'users/carol/bookmarks/x,,C,https://c\r\n'
    + 'nonsense,,X,https://x\r\n'
    + ',,orphan,\r\n'
    + 'users/bob/bookmarks/b9,many,B9,https://9\r\n', layout);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /line 5: users\/carol\/bookmarks isn't part of this sheet/);
  assert.match(problems[1], /line 6: "nonsense" isn't a document path/);
  assert.match(problems[2], /line 7: "_path" is empty/);
  assert.match(problems[3], /line 8, column "stars": "many" is not a number/);
});

test('build: mixed types across collections become a JSON (any) column, and split keeps each type', () => {
  const carol = snapshot('users/carol/bookmarks', { c1: { title: S('C1'), stars: S('lots') } });
  const { text, layout } = buildSheet([source(alice), source(carol)]);
  assert.match(text, /stars:any/);
  const { files, problems } = splitSheet(text, layout);
  assert.deepEqual(problems, []);
  assert.match(files.get('users/alice/bookmarks')!, /stars:number/);
  assert.equal(computePlan(carol, tableOf(files.get('users/carol/bookmarks')!)).updates.length, 0);
});

import { checkSplit } from '../src/sheet.js';

test('apply-time checks: moving a row to another collection, or editing an id, is caught', () => {
  const snaps = new Map([[alice.collection, alice], [bob.collection, bob]]);
  const { text, layout } = buildSheet([source(alice), source(bob)]);

  const moved = splitSheet(text.replace('users/alice/bookmarks/b2', 'users/bob/bookmarks/b2'), layout);
  assert.deepEqual(moved.problems, []);
  const [problem] = checkSplit(moved.files, snaps);
  assert.match(problem, /users\/alice\/bookmarks\/b2 was moved to users\/bob\/bookmarks\/b2/);

  const renamed = splitSheet(text.replace('users/bob/bookmarks/b1', 'users/bob/bookmarks/b9'), layout);
  assert.match(checkSplit(renamed.files, snaps)[0], /^users\/bob\/bookmarks: looks like _id was changed from "b1" to "b9"/);

  const fine = splitSheet(text.replace('A2', 'A2 edited'), layout);
  assert.deepEqual(checkSplit(fine.files, snaps), []);
});

// ---------- Document sheets ----------

test('document sheet: only the named documents, and every other row is left alone', () => {
  const a = source(alice);
  const b = source(bob);
  const picks = new Map([['users/alice/bookmarks', new Set(['b2'])], ['users/bob/bookmarks', new Set(['b1'])]]);
  const { text, layout, rows, problems } = buildSheet([a, b], picks);
  assert.deepEqual(problems, []);
  assert.equal(rows, 2);
  assert.deepEqual(layout.documents, ['users/alice/bookmarks/b2', 'users/bob/bookmarks/b1']);
  assert.ok(!text.includes('users/alice/bookmarks/b1'));

  // Edit b2's title, clear its stars, and add a "note" column (filled in for bob only).
  const edited = text
    .replace('url:string', 'url:string,note')
    .replace('users/alice/bookmarks/b2,3,A2,https://a2', 'users/alice/bookmarks/b2,,A2!,https://a2,')
    .replace('users/bob/bookmarks/b1,,B1,https://b1', 'users/bob/bookmarks/b1,,B1,https://b1,hi');
  const current = new Map([[a.name, a.table], [b.name, b.table]]);
  const { files, problems: p2 } = splitSheet(edited, layout, current);
  assert.deepEqual(p2, []);

  const pa = computePlan(alice, tableOf(files.get('users/alice/bookmarks')!));
  assert.deepEqual(pa.updates.map((u) => [u.id, u.set, u.remove]), [['b2', { title: S('A2!') }, ['stars']]]);
  assert.deepEqual([pa.creates, pa.deletes], [[], []]); // b1 wasn't in the sheet, and is untouched
  const pb = computePlan(bob, tableOf(files.get('users/bob/bookmarks')!));
  assert.deepEqual(pb.updates.map((u) => [u.id, u.set]), [['b1', { note: S('hi') }]]);
});

test('document sheet: removing a column clears it only for those documents', () => {
  const a = source(alice);
  const { text, layout } = buildSheet([a], new Map([['users/alice/bookmarks', new Set(['b2'])]]));
  // Drop the "url" column from the sheet.
  const noUrl = text.split('\r\n').map((l) => l.split(',').filter((_, i) => i !== 3).join(',')).join('\r\n');
  const { files, problems } = splitSheet(noUrl, layout, new Map([[a.name, a.table]]));
  assert.deepEqual(problems, []);
  const plan = computePlan(alice, tableOf(files.get('users/alice/bookmarks')!));
  assert.deepEqual(plan.updates.map((u) => [u.id, u.remove]), [['b2', ['url']]]); // b1 keeps its url
  assert.deepEqual(plan.droppedColumns, []);
});

test('document sheet: rows can\'t be added, removed or renamed', () => {
  const a = source(alice);
  const { text, layout } = buildSheet([a], new Map([['users/alice/bookmarks', new Set(['b2'])]]));
  const current = new Map([[a.name, a.table]]);
  const header = text.split('\r\n')[0];
  assert.match(splitSheet(`${header}\r\n`, layout, current).problems[0], /was removed from the sheet — this sheet can't delete documents/);
  assert.match(splitSheet(`${text}users/alice/bookmarks/b9,,X,https://x\r\n`, layout, current).problems[0], /can't add or rename documents/);
  assert.match(splitSheet(`${text},,X,https://x\r\n`, layout, current).problems[0], /only edits the documents you opened/);
  assert.match(buildSheet([a], new Map([['users/alice/bookmarks', new Set(['zz'])]])).problems[0], /isn't in your local copy/);
});

test('an untyped new column stays untyped through an edit sheet', () => {
  const file = path.join(dir, 'untyped.csv');
  fs.writeFileSync(file, docsToCsv(alice.docs, alice.columns).replace('url:string', 'url:string,active').replace('https://a1', 'https://a1,TRUE'));
  const src = { name: alice.collection, file, table: readCsv(file) };
  const { text, layout } = buildSheet([src, source(bob)]);
  assert.ok(parse(text, { bom: true })[0].includes('active'), 'bare in the sheet');
  const { files } = splitSheet(text, layout);
  const after = tableOf(files.get(alice.collection)!);
  assert.ok(after.untyped?.has('active'), 'bare in the collection again');
  assert.deepEqual(computePlan(alice, after).untypedColumns.map((c) => [c.field, c.values.map((v) => v.type)]), [['active', ['boolean']]]);
});
