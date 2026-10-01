import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PValue } from '../src/codec.js';
import { computePlan, PlanError } from '../src/diff.js';
import { mergeRemote } from '../src/merge.js';
import type { Snapshot, SnapshotDoc } from '../src/snapshot.js';
import { buildColumns, docsToCsv, readCsv, rowsToCsv } from '../src/table.js';

const S = (v: string): PValue => ({ t: 'string', v });
const N = (v: number): PValue => ({ t: 'number', v });

const base: Snapshot = {
  collection: 'users',
  pulledAt: '',
  columns: [],
  docs: [
    { id: 'a', updateTime: '1', fields: { name: S('Ann'), age: N(30) } },
    { id: 'b', updateTime: '1', fields: { name: S('Bob'), age: N(40) } },
    { id: 'c', updateTime: '1', fields: { name: S('Cy'), age: N(50) } },
    { id: 'k', updateTime: '1', fields: { name: S('Kim'), age: N(60) } },
  ],
};
base.columns = buildColumns(base.docs);

function tmpFile(content: string) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-')), 'documents.csv');
  fs.writeFileSync(file, content);
  return file;
}

// Your local edits (on top of `base`):
//   a: name Ann→Anne, age 30→31     b: age 40→41       c: deleted     k: deleted
//   new rows: (auto id) "Newbie", d1 "Dee" age 5
const mine = readCsv(tmpFile(docsToCsv(base.docs, base.columns)
  .replace('a,30,Ann', 'a,31,Anne').replace('b,40,Bob', 'b,41,Bob')
  .replace(/\r\nc,[^\r]*/, '').replace(/\r\nk,[^\r]*/, '')
  + ',,Newbie\r\nd1,5,Dee\r\n'));

// Meanwhile in Firestore:
//   a: age changed to 35 (clashes with yours; name untouched)
//   b: deleted            c: edited (so your delete is suspect)     k: untouched
//   d1: created by someone else with age 6      e: new doc with a new field
const remote: SnapshotDoc[] = [
  { id: 'a', updateTime: '2', fields: { name: S('Ann'), age: N(35) } },
  { id: 'c', updateTime: '2', fields: { name: S('Cyrus'), age: N(50) } },
  { id: 'd1', updateTime: '2', fields: { name: S('Dee'), age: N(6) } },
  { id: 'e', updateTime: '2', fields: { name: S('Eve'), email: S('eve@example.com') } },
  { id: 'k', updateTime: '1', fields: { name: S('Kim'), age: N(60) } },
];

test('merge re-applies clean edits and marks clashing cells', () => {
  const plan = computePlan(base, mine);
  const m = mergeRemote(base, mine, plan, remote, 'now');
  const file = tmpFile(rowsToCsv(m.csv));
  const text = fs.readFileSync(file, 'utf8');

  assert.deepEqual(m.conflicts.map((c) => `${c.id}.${c.field}`), ['a.age', 'd1.age']);
  assert.match(text, /a,<<<<<<< local: 31 \| remote: 35 >>>>>>>,Anne/);
  assert.deepEqual(m.conflicts.map(({ id, field, local, remote }) => [id, field, local, remote]), [
    ['a', 'age', N(31), N(35)],
    ['d1', 'age', N(5), N(6)],
  ]);
  assert.match(text, /\r\nc,50,Cyrus/, 'your delete of an edited doc is undone');
  assert.doesNotMatch(text, /\r\nk,/, 'your delete of an untouched doc still stands');
  assert.match(text, /\r\nb,41,Bob/, 'your edit to a remotely-deleted doc is kept');
  assert.match(text, /\r\n,,Newbie/);
  assert.equal(m.notes.length, 3); // c restored, b deleted remotely, d1 created by both
  assert.equal(m.snapshot.docs, remote);
  assert.ok(m.csv[0].some((h) => h.startsWith('email')), 'new remote field becomes a column');

  // Can't push until conflicts are resolved.
  assert.throws(() => computePlan(m.snapshot, readCsv(file)),
    (e: PlanError) => e.problems.length === 2 && /line 2, column "age": unresolved conflict/.test(e.problems[0]));

  // Resolve: keep yours for a, theirs for d1.
  const resolved = readCsv(tmpFile(text
    .replace('<<<<<<< local: 31 | remote: 35 >>>>>>>', '31')
    .replace('<<<<<<< local: 5 | remote: 6 >>>>>>>', '6')));
  const after = computePlan(m.snapshot, resolved);
  assert.deepEqual(after.updates.map((u) => [u.id, u.set]), [['a', { age: N(31), name: S('Anne') }]]);
  assert.deepEqual(after.creates.map((c) => [c.id, c.fields]), [
    ['b', { age: N(41), name: S('Bob') }],
    [undefined, { name: S('Newbie') }],
  ]);
  assert.deepEqual(after.deletes, [{ id: 'k' }]);
});

test('merge with no overlap has no conflicts', () => {
  const edited = readCsv(tmpFile(docsToCsv(base.docs, base.columns).replace('b,40,Bob', 'b,41,Bob')));
  const theirs = base.docs.map((d) => (d.id === 'a' ? { ...d, updateTime: '2', fields: { ...d.fields, age: N(99) } } : d));
  const m = mergeRemote(base, edited, computePlan(base, edited), theirs, 'now');
  assert.equal(m.conflicts.length, 0);
  const after = computePlan(m.snapshot, readCsv(tmpFile(rowsToCsv(m.csv))));
  assert.deepEqual(after.updates.map((u) => [u.id, u.set]), [['b', { age: N(41) }]]);
  assert.match(rowsToCsv(m.csv), /\r\na,99,Ann/, 'their change comes through');
});

// ---------- resolve ----------

import { applyChoices, isOpen } from '../src/conflicts.js';
import { readCsv as readTable } from '../src/table.js';

test('resolve: chosen values replace the marked cells; a mismatched type turns the column into JSON', () => {
  const plan = computePlan(base, mine);
  const m = mergeRemote(base, mine, plan, remote, 'now');
  const table = readTable(tmpFile(rowsToCsv(m.csv)));
  assert.ok(m.conflicts.every((c) => isOpen(table, c)));

  // a.age: keep local (31). d1.age: a custom text value — doesn't fit a number column.
  const text = applyChoices(table, [
    { id: 'a', field: 'age', value: N(31) },
    { id: 'd1', field: 'age', value: S('six') },
  ]);
  const after = readTable(tmpFile(text));
  assert.ok(m.conflicts.every((c) => !isOpen(after, c)));
  assert.match(text, /age:any/);
  const resolved = computePlan(m.snapshot, after);
  assert.deepEqual(resolved.updates.map((u) => [u.id, u.set]), [['a', { age: N(31), name: S('Anne') }], ['d1', { age: S('six') }]]);
});

test('a new column you left untyped stays untyped through a merge (so type detection still applies)', () => {
  const edited = readCsv(tmpFile(docsToCsv(base.docs, base.columns)
    .replace('_id,age:number,name:string', '_id,age:number,name:string,active,since')
    .replace('a,30,Ann', 'a,30,Ann,TRUE,2024-05-01T00:00:00Z')));
  const plan = computePlan(base, edited);
  const m = mergeRemote(base, edited, plan, remote, 'now');
  assert.ok(m.csv[0].includes('active') && m.csv[0].includes('since'), 'headers stay bare');
  const again = computePlan(m.snapshot, readCsv(tmpFile(rowsToCsv(m.csv))));
  assert.deepEqual(again.untypedColumns.map((c) => [c.field, c.values.map((v) => v.type)]), [['active', ['boolean']], ['since', ['timestamp']]]);
});
