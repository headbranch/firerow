import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CellError, decodeCell, encodeCell, parseHeader, type PValue } from '../src/codec.js';
import { computePlan, findConflicts, PlanError, type LiveDoc } from '../src/diff.js';
import type { Snapshot } from '../src/snapshot.js';
import { buildColumns, docsToCsv, readCsv } from '../src/table.js';

const S = (v: string): PValue => ({ t: 'string', v });
const N = (v: number): PValue => ({ t: 'number', v });

const snap: Snapshot = {
  collection: 'users',
  pulledAt: '',
  columns: [],
  docs: [
    { id: 'a', updateTime: '1.0', fields: { name: S('Ann'), age: N(30), tags: { t: 'array', v: [S('x')] } } },
    { id: 'b', updateTime: '1.0', fields: { name: S('Bob'), joined: { t: 'timestamp', v: { s: 1700000000, n: 123456789 } } } },
    { id: 'c', updateTime: '1.0', fields: { name: S(''), score: N(0.1 + 0.2) } },
  ],
};
snap.columns = buildColumns(snap.docs);

/** Round-trip the snapshot through a real CSV file, optionally editing the text. */
function tableFrom(edit: (csv: string) => string = (s) => s) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')), 'documents.csv');
  fs.writeFileSync(file, edit(docsToCsv(snap.docs, snap.columns)));
  return readCsv(file);
}

test('columns get typed headers', () => {
  const headers = snap.columns.map((c) => `${c.field}:${c.type}`);
  assert.deepEqual(headers, ['age:number', 'joined:timestamp', 'name:string', 'score:number', 'tags:array']);
});

test('untouched CSV produces an empty plan (no float/timestamp drift)', () => {
  const plan = computePlan(snap, tableFrom());
  assert.deepEqual([plan.creates, plan.updates, plan.deletes], [[], [], []]);
});

test('edits, clears, creates and deletes', () => {
  const table = tableFrom((csv) => csv
    .replace('Ann', 'Anne')
    .replace(/\r\nc,.*\r\n/, '\r\n') // delete row c
    + ',,,New person,,\r\nd1,5,,Dee,,"[""y""]"\r\n');
  // Clear Bob's joined timestamp.
  const b = table.rows.find((r) => r.id === 'b')!;
  b.cells[table.columns.findIndex((c) => c.field === 'joined')] = '';

  const plan = computePlan(snap, table);
  assert.deepEqual(plan.updates.map((u) => [u.id, u.set, u.remove]), [
    ['a', { name: S('Anne') }, []],
    ['b', {}, ['joined']],
  ]);
  assert.deepEqual(plan.deletes, [{ id: 'c' }]);
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.creates[0].id, undefined);
  assert.deepEqual(plan.creates[0].fields, { name: S('New person') });
  assert.deepEqual(plan.creates[1].fields, { age: N(5), name: S('Dee'), tags: { t: 'array', v: [S('y')] } });
});

test('empty string vs absent field', () => {
  assert.equal(encodeCell(S(''), 'string'), '""');
  assert.deepEqual(decodeCell('""', 'string'), S(''));
  assert.equal(decodeCell('', 'string'), undefined);
});

test('bad cells are reported with line and column', () => {
  const table = tableFrom((csv) => csv.replace('30', 'thirty'));
  assert.throws(() => computePlan(snap, table), (e: PlanError) => /line 2, column "age"/.test(e.message));
});

test('duplicate ids are rejected', () => {
  const table = tableFrom((csv) => csv + 'a,1,,x,,\r\n');
  assert.throws(() => computePlan(snap, table), /duplicated/);
});

test('editing an _id is blocked', () => {
  assert.throws(() => computePlan(snap, tableFrom((csv) => csv.replace('\r\na,', '\r\nanne,'))),
    /line 2: looks like _id was changed from "a" to "anne"/);
  assert.throws(() => computePlan(snap, tableFrom((csv) => csv.replace('\r\na,', '\r\n,'))),
    /changed from "a" to blank/);
});

test('_id changes that also change values, and copies of rows, are allowed', () => {
  const replaced = computePlan(snap, tableFrom((csv) => csv.replace('\r\na,', '\r\nanne,').replace('Ann', 'Anne')));
  assert.deepEqual([replaced.creates.map((c) => c.id), replaced.deletes], [['anne'], [{ id: 'a' }]]);
  // Duplicating a row under a new id deletes nothing, so it's just a create.
  const copied = computePlan(snap, tableFrom((csv) => csv + csv.split('\r\n')[1].replace(/^a,/, 'a2,') + '\r\n'));
  assert.deepEqual([copied.creates.map((c) => c.id), copied.deletes], [['a2'], []]);
});

test('changing a column type re-types values', () => {
  const table = tableFrom((csv) => csv.replace('age:number', 'age:string'));
  const plan = computePlan(snap, table);
  assert.deepEqual(plan.updates.map((u) => [u.id, u.set]), [['a', { age: S('30') }]]);
});

test('headers', () => {
  assert.deepEqual(parseHeader('createdAt:timestamp'), { field: 'createdAt', type: 'timestamp' });
  assert.deepEqual(parseHeader('url:thing'), { field: 'url:thing', type: 'string' });
});

test('special types round-trip through cells', () => {
  const values: [PValue, Parameters<typeof encodeCell>[1]][] = [
    [{ t: 'timestamp', v: { s: 1700000000, n: 5 } }, 'timestamp'],
    [{ t: 'timestamp', v: { s: -1, n: 500_000_000 } }, 'timestamp'],
    [{ t: 'geopoint', v: { lat: 10.5, lng: -20.25 } }, 'geopoint'],
    [{ t: 'reference', v: 'users/a' }, 'reference'],
    [{ t: 'map', v: { at: { t: 'timestamp', v: { s: 0, n: 0 } }, r: { t: 'reference', v: 'x/y' } } }, 'map'],
    [S('hello'), 'any'],
    [{ t: 'null' }, 'number'],
  ];
  for (const [p, type] of values) assert.deepEqual(decodeCell(encodeCell(p, type), type), p, `${type} ${encodeCell(p, type)}`);
});

test('geopoints and references are validated', () => {
  const geo = (lat: number, lng: number): PValue => ({ t: 'geopoint', v: { lat, lng } });
  // Tiny coordinates are written in exponent form and must read back.
  assert.deepEqual(decodeCell(encodeCell(geo(1e-7, -2.5e-8), 'geopoint'), 'geopoint'), geo(1e-7, -2.5e-8));
  assert.deepEqual(decodeCell('+10, 20', 'geopoint'), geo(10, 20));
  assert.deepEqual(decodeCell('{"$geo": [1, 2]}', 'any'), geo(1, 2));
  for (const bad of ['91, 0', '0, -181', 'abc, 1', '1,', '1, 2, 3', 'Infinity, 0']) {
    assert.throws(() => decodeCell(bad, 'geopoint'), CellError, bad);
  }
  assert.throws(() => decodeCell('{"$geo": [100, 0]}', 'any'), CellError);
  assert.throws(() => decodeCell('[{"$geo": [0, 200]}]', 'array'), CellError);

  assert.deepEqual(decodeCell('/users/a/posts/1', 'reference'), { t: 'reference', v: 'users/a/posts/1' });
  assert.deepEqual(decodeCell('{"$ref": "users/a"}', 'any'), { t: 'reference', v: 'users/a' });
  for (const bad of ['users', 'users/a/posts', 'users//a', '/', 'users/a/']) {
    assert.throws(() => decodeCell(bad, 'reference'), CellError, bad);
  }
  assert.throws(() => decodeCell('{"$ref": "users"}', 'any'), CellError);
});

test('conflicts: only when someone else changed a field you changed', () => {
  const table = tableFrom((csv) => csv.replace('Ann', 'Anne'));
  const plan = computePlan(snap, table);
  const base = new Map(snap.docs.map((d) => [d.id, d]));
  const live = (fields: Record<string, PValue>): Map<string, LiveDoc> => new Map([['a', { exists: true, updateTime: '2.0', fields }]]);

  // Someone else changed `age` only → fine.
  assert.deepEqual(findConflicts(plan, base, live({ ...base.get('a')!.fields, age: N(31) })), []);
  // Someone else changed `name` → conflict.
  assert.equal(findConflicts(plan, base, live({ ...base.get('a')!.fields, name: S('Annie') })).length, 1);
  // Someone else made the same change → fine.
  assert.deepEqual(findConflicts(plan, base, live({ ...base.get('a')!.fields, name: S('Anne') })), []);
  // Deleted remotely → conflict.
  assert.equal(findConflicts(plan, base, new Map([['a', { exists: false, updateTime: '', fields: {} }]])).length, 1);
});

// ---------- Collection paths, files and "*" patterns ----------

import { csvPath, matchesPattern, parseCollectionPath } from '../src/paths.js';
import { parseArgs, resolveLocal } from '../src/targets.js';
import { writeSnapshot } from '../src/snapshot.js';
import { snapshotPath } from '../src/paths.js';

test('each collection is a folder with documents.csv, mirroring the database', () => {
  assert.equal(csvPath('R', ['users']), path.join('R', 'collections', 'users', 'documents.csv'));
  assert.equal(csvPath('R', ['users', 'alice', 'bookmarks']), path.join('R', 'collections', 'users', 'alice', 'bookmarks', 'documents.csv'));
  // Tab-completed file or folder paths work as collection names too.
  assert.deepEqual(parseCollectionPath('collections/users/alice/bookmarks/documents.csv'), ['users', 'alice', 'bookmarks']);
  assert.deepEqual(parseCollectionPath('collections\\users\\'), ['users']);
});

test('a snapshot for a "*" pattern is never treated as a collection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  writeSnapshot(snapshotPath(root, ['users']), { collection: 'users', pulledAt: '', columns: [], docs: [] });
  writeSnapshot(path.join(root, '.firerow', 'snapshots', 'stale.json'), { collection: 'users/*/bookmarks', pulledAt: '', columns: [], docs: [] });
  assert.deepEqual(resolveLocal(root, []).map((s) => s.join('/')), ['users']);
});

test('"*" patterns', () => {
  const pat = parseCollectionPath('users/*/orders/*/items');
  assert.ok(matchesPattern(pat, 'users/alice/orders/o1/items'.split('/')));
  assert.ok(!matchesPattern(pat, 'posts/alice/orders/o1/items'.split('/')));
  assert.ok(!matchesPattern(parseCollectionPath('users/*/bookmarks'), ['users']));
  assert.throws(() => parseCollectionPath('*/a/b'), /whole document id/);
  assert.throws(() => parseCollectionPath('users/al*/b'), /whole document id/);
});

test('collection arguments: commas, spaces, duplicates, patterns', () => {
  assert.deepEqual(parseArgs(['users,staff', 'users/*/bookmarks', ' staff ']).map((s) => s.join('/')),
    ['users', 'staff', 'users/*/bookmarks']);
  assert.throws(() => parseArgs(['users,users/abc']), /is a document, not a collection/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  assert.deepEqual(resolveLocal(root, []), []); // nothing pulled yet
  for (const c of ['users', 'users/alice/bookmarks', 'users/bob/bookmarks', 'posts/p1/bookmarks']) {
    writeSnapshot(snapshotPath(root, c.split('/')), { collection: c, pulledAt: '', columns: [], docs: [] });
  }
  assert.deepEqual(resolveLocal(root, ['users/*/bookmarks']).map((s) => s.join('/')), ['users/alice/bookmarks', 'users/bob/bookmarks']);
  assert.equal(resolveLocal(root, []).length, 4);
  assert.throws(() => resolveLocal(root, ['teams/*/members']), /No pulled collections match/);
});

// ---------- Renamed column headers ----------

import { applyRename } from '../src/diff.js';

test('a renamed header is detected, and only becomes a real rename when applied', () => {
  const plan = computePlan(snap, tableFrom((csv) => csv.replace(',name:string,', ',fullName,')));
  assert.deepEqual(plan.renames, [{ from: 'name', to: 'fullName', docs: 3, applied: false }]);
  // As-is: a copy — fullName is added, name is left alone.
  assert.ok(plan.updates.every((u) => u.set.fullName && u.remove.length === 0));

  applyRename(plan, new Map(snap.docs.map((d) => [d.id, d])), plan.renames[0]);
  assert.deepEqual(plan.updates.map((u) => [u.id, u.set, u.remove]), [
    ['a', { fullName: S('Ann') }, ['name']],
    ['b', { fullName: S('Bob') }, ['name']],
    ['c', { fullName: S('') }, ['name']],
  ]);
  assert.deepEqual(plan.droppedColumns, []);
});

test('not a rename when the values changed too, or a column was just removed', () => {
  const edited = computePlan(snap, tableFrom((csv) => csv.replace(',name:string,', ',fullName,').replace('Ann', 'Anne')));
  assert.deepEqual(edited.renames, []);
  const t = tableFrom();
  const j = t.columns.findIndex((c) => c.field === 'name');
  t.columns.splice(j, 1);
  for (const r of t.rows) r.cells.splice(j, 1);
  const removed = computePlan(snap, t);
  assert.deepEqual(removed.renames, []);
});

// ---------- Removed columns (deleting fields) ----------

import { applyFieldDelete, deletableColumns } from '../src/diff.js';

/** The pulled CSV with some columns removed (header and cells), optionally edited first. */
function withoutColumns(fields: string[], edit?: (csv: string) => string) {
  const t = tableFrom(edit);
  for (const f of fields) {
    const j = t.columns.findIndex((c) => c.field === f);
    t.columns.splice(j, 1);
    for (const r of t.rows) r.cells.splice(j, 1);
  }
  return t;
}

test('a removed column is left alone until the delete is applied', () => {
  const plan = computePlan(snap, withoutColumns(['name']));
  assert.deepEqual([plan.creates, plan.updates, plan.deletes], [[], [], []]);
  const [col] = deletableColumns(plan);
  assert.deepEqual(col, { field: 'name', docs: [{ id: 'a', line: 2 }, { id: 'b', line: 3 }, { id: 'c', line: 4 }], deleted: false });

  applyFieldDelete(plan, col);
  assert.deepEqual(plan.updates.map((u) => [u.id, u.set, u.remove]), [['a', {}, ['name']], ['b', {}, ['name']], ['c', {}, ['name']]]);
  assert.deepEqual(deletableColumns(plan), []);
});

test('deleting a field merges with other edits and skips deleted documents', () => {
  // Edit a's age, delete row b, remove the "name" column.
  const plan = computePlan(snap, withoutColumns(['name'], (csv) => csv.replace('a,30,', 'a,31,').replace(/\r\nb,[^\r]*/, '')));
  const [col] = deletableColumns(plan);
  assert.deepEqual(col.docs.map((d) => d.id), ['a', 'c']);
  applyFieldDelete(plan, col);
  assert.deepEqual(plan.updates.map((u) => [u.id, u.set, u.remove]), [['a', { age: N(31) }, ['name']], ['c', {}, ['name']]]);
  assert.deepEqual(plan.deletes, [{ id: 'b' }]);
});

test('a renamed column is not offered for deletion', () => {
  const plan = computePlan(snap, tableFrom((csv) => csv.replace(',name:string,', ',fullName,')));
  assert.equal(plan.renames.length, 1);
  assert.deepEqual(deletableColumns(plan), []);
});

// ---------- Pulling specific documents ----------

import { parsePullArgs } from '../src/targets.js';
import { parseCollectionOrDocument } from '../src/paths.js';

test('pull arguments: documents and collections', () => {
  const { collections, docs } = parsePullArgs(['users/alice,users/bob', 'staff', 'users/alice/bookmarks/b1', 'collections/teams/red']);
  assert.deepEqual(collections.map((s) => s.join('/')), ['staff']);
  assert.deepEqual([...docs].map(([c, ids]) => [c, [...ids]]), [
    ['users', ['alice', 'bob']],
    ['users/alice/bookmarks', ['b1']],
    ['teams', ['red']],
  ]);
  assert.throws(() => parseCollectionOrDocument('users/*'), /can't be used in a document path/);
  assert.throws(() => parseCollectionOrDocument('users/*/bookmarks/b1'), /can't be used in a document path/);
});

test('a partial copy only ever deletes documents that were pulled', () => {
  // Only "a" and "b" were pulled out of a much bigger collection.
  const partial: Snapshot = { ...snap, docs: snap.docs.slice(0, 2), partial: true };
  const plan = computePlan(partial, tableFrom((csv) => csv.replace(/\r\nb,[^\r]*/, '').replace(/\r\nc,[^\r]*/, '')));
  assert.deepEqual(plan.deletes, [{ id: 'b' }]);
  // A row for a document that wasn't pulled is a create — the push-time check catches it if it exists.
  const withC = computePlan(partial, tableFrom());
  assert.deepEqual(withC.creates.map((c) => c.id), ['c']);
  const base = new Map(partial.docs.map((d) => [d.id, d]));
  const [conflict] = findConflicts(withC, base, new Map([['c', { exists: true, updateTime: '9', fields: {} }]]), true);
  assert.match(conflict.message, /already exists in Firestore .* partial copy/);
});

// ---------- New columns without a type ----------

test('a new column with no type: each value is read as what it clearly is', () => {
  const add = (header: string, a: string, b: string, c: string) => tableFrom((csv) => {
    const [h, ...rows] = csv.split('\r\n');
    const vals = [a, b, c];
    return [h + ',' + header, ...rows.map((r, i) => (r ? `${r},${vals[i]}` : r))].join('\r\n');
  });
  const types = (field: string, a: string, b: string, c: string) =>
    computePlan(snap, add(field, a, b, c)).updates.map((u) => u.set[field]?.t);

  assert.deepEqual(types('active', 'TRUE', 'false', ''), ['boolean', 'boolean']); // any case (Excel writes TRUE)
  assert.deepEqual(types('rank', '1', '2.5', '-3'), ['number', 'number', 'number']);
  assert.deepEqual(types('since', '2024-05-01', '2024-05-01T12:00:00Z', '2024-05-01T12:00:00.123+07:00'), ['timestamp', 'timestamp', 'timestamp']);
  assert.deepEqual(types('meta', '"{""a"":1}"', '"[1,2]"', 'null'), ['map', 'array', 'null']);
  // Mixed values each get their own type; things that only look like numbers or dates stay text.
  assert.deepEqual(types('price', '12', 'N/A', '9.99'), ['number', 'string', 'number']);
  assert.deepEqual(types('zip', '0123', '+8490', '2024-13-45'), ['string', 'string', 'string']);
  assert.deepEqual(types('j', '{not json', 'hello', ''), ['string', 'string']);

  // The plan reports what was guessed, value by value, so the warning can show it.
  const plan = computePlan(snap, add('price', '12', 'N/A', '9.99'));
  assert.deepEqual(plan.untypedColumns, [{ field: 'price', values: [
    { line: 2, text: '12', type: 'number' }, { line: 3, text: 'N/A', type: 'string' }, { line: 4, text: '9.99', type: 'number' },
  ] }]);
  // A typed header is taken at its word.
  const explicit = computePlan(snap, add('flag:string', 'true', 'false', 'true'));
  assert.deepEqual([explicit.untypedColumns, explicit.updates[0].set.flag], [[], S('true')]);
});

// ---------- :any columns (mixed types) ----------

test(':any cells read like untyped ones (TRUE is a boolean), and every value round-trips', () => {
  assert.deepEqual(decodeCell('TRUE', 'any'), { t: 'boolean', v: true }); // Excel's spelling
  assert.deepEqual(decodeCell('42', 'any'), N(42));
  assert.deepEqual(decodeCell('hello', 'any'), S('hello'));
  assert.deepEqual(decodeCell('"42"', 'any'), S('42')); // quoted: the text 42
  assert.deepEqual(decodeCell('2024-05-01T00:00:00Z', 'any')?.t, 'timestamp');
  assert.deepEqual(decodeCell('{"$timestamp":"2024-05-01T00:00:00Z"}', 'any')?.t, 'timestamp'); // older CSVs

  const values: PValue[] = [
    S('hello'), S('42'), S('true'), S('TRUE'), S('null'), S(''), S('  spaced  '), S('{"a":1}'), S('"q"'),
    S('N/A'), S('0123'), S('2024-05-01'), N(42), N(-2.5), { t: 'number', v: 'NaN' }, { t: 'boolean', v: false },
    { t: 'null' }, { t: 'timestamp', v: { s: 1700000000, n: 5 } }, { t: 'geopoint', v: { lat: 1, lng: 2 } },
    { t: 'reference', v: 'users/a' }, { t: 'map', v: { a: N(1) } }, { t: 'array', v: [S('x'), N(2)] },
  ];
  for (const p of values) assert.deepEqual(decodeCell(encodeCell(p, 'any'), 'any'), p, `${p.t} ${JSON.stringify(p)}`);
  // Ordinary text isn't quoted; only text that would be misread is.
  assert.equal(encodeCell(S('hello'), 'any'), 'hello');
  assert.equal(encodeCell(S('42'), 'any'), '"42"');
});

// ---------- Deleting a collection's folder stops tracking it ----------

import { untrackDeleted } from '../src/targets.js';
import { csvPath as csvFile } from '../src/paths.js';

test('a collection whose CSV was deleted is no longer tracked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
  for (const c of ['users', 'logs', 'users/alice/bookmarks']) {
    const segs = c.split('/');
    writeSnapshot(snapshotPath(root, segs), { collection: c, pulledAt: '', columns: [], docs: [] });
    fs.mkdirSync(path.dirname(csvFile(root, segs)), { recursive: true });
    fs.writeFileSync(csvFile(root, segs), '_id\r\n');
  }
  fs.rmSync(path.join(root, 'collections', 'logs'), { recursive: true });        // whole folder
  fs.rmSync(csvFile(root, ['users']));                                            // just users' CSV
  assert.deepEqual(untrackDeleted(root).sort(), ['logs', 'users']);
  assert.deepEqual(resolveLocal(root, []).map((s) => s.join('/')), ['users/alice/bookmarks']); // subcollection kept
  assert.ok(!fs.existsSync(snapshotPath(root, ['logs'])));
  assert.deepEqual(untrackDeleted(root), []); // nothing left to do
});

import { ignoreKeyAndState } from '../src/commands/init.js';

test('init keeps the key and .firerow/ out of git, without duplicating entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firerow-gi-'));
  const gi = path.join(root, '.gitignore');
  const read = () => fs.readFileSync(gi, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));

  ignoreKeyAndState(root, 'key.json'); // no .gitignore yet
  assert.deepEqual(read(), ['key.json', '.firerow/']);
  ignoreKeyAndState(root, 'key.json'); // running init again adds nothing
  assert.deepEqual(read(), ['key.json', '.firerow/']);

  fs.writeFileSync(gi, 'node_modules\n/.firerow\n*serviceAccount*.json'); // already covered, no trailing newline
  ignoreKeyAndState(root, 'serviceAccount.json');
  assert.equal(fs.readFileSync(gi, 'utf8'), 'node_modules\n/.firerow\n*serviceAccount*.json');

  fs.writeFileSync(gi, 'node_modules');
  ignoreKeyAndState(root, 'serviceAccount.json'); // both added, starting on a new line
  assert.deepEqual(read(), ['node_modules', 'serviceAccount.json', '.firerow/']);
});
