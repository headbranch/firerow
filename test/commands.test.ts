import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHeader } from '../src/commands/create.js';
import { unpushedOutside } from '../src/commands/pull.js';
import { applyPlan, toJson } from '../src/commands/export.js';
import { computePlan } from '../src/diff.js';
import type { Snapshot } from '../src/snapshot.js';
import { parseCsv, rowsToCsv } from '../src/table.js';
import { checkOperands, parsePullArgs } from '../src/targets.js';

test('create: comma-separated columns keep their types; bare names stay untyped', () => {
  assert.deepEqual(newHeader('name:string,age:Number, tags:array ,note'), ['_id', 'name:string', 'age:number', 'tags:array', 'note']);
  assert.deepEqual(newHeader('first name:string'), ['_id', 'first name:string']);
  assert.deepEqual(newHeader(), ['_id']);
});

test('create: columns separated by spaces are refused, with the quoted command to run instead', () => {
  // What PowerShell passes for an unquoted name:string,branch:string,salesTotal:number.
  assert.throws(() => newHeader('name:string branch:string salesTotal:number', 'employees'),
    (e: Error) => e.message.includes('firerow create employees "name:string,branch:string,salesTotal:number"'));
  assert.throws(() => newHeader('name:string branch:string,salesTotal:number', 'employees'),
    (e: Error) => e.message.includes('"name:string,branch:string,salesTotal:number"'));
});

test('create: rejects unknown types, _id and duplicates', () => {
  assert.throws(() => newHeader('age:int'), /unknown type "int"/);
  assert.throws(() => newHeader('_id'), /always the first column/);
  assert.throws(() => newHeader('a:string,a:number'), /listed twice/);
  assert.throws(() => newHeader('name:string price:numbr'), /commas, not spaces/);
});

test('create: rows added to a new collection become creates, typed by header or guessed', () => {
  const empty: Snapshot = { collection: 'products', pulledAt: '', columns: [], docs: [] };
  const header = newHeader('name:string,price:number,live');
  assert.deepEqual(computePlan(empty, parseCsv(rowsToCsv([header]), 'x')).creates, []);
  const plan = computePlan(empty, parseCsv(rowsToCsv([header, ['p1', 'Mug', '9.5', 'true'], ['', '42', '', '']]), 'x'));
  assert.deepEqual(plan.creates.map((c) => [c.id, c.fields]), [
    ['p1', { name: { t: 'string', v: 'Mug' }, price: { t: 'number', v: 9.5 }, live: { t: 'boolean', v: true } }],
    [undefined, { name: { t: 'string', v: '42' } }],
  ]);
  assert.deepEqual([plan.updates, plan.deletes], [[], []]);
});

test('export: collections keyed by path, documents by id, special types tagged', () => {
  const snaps: Snapshot[] = [
    { collection: 'users/a/orders', pulledAt: '', columns: [], docs: [{ id: 'o1', updateTime: '', fields: { total: { t: 'number', v: 3 } } }] },
    {
      collection: 'users', pulledAt: '', columns: [], docs: [{
        id: 'a', updateTime: '', fields: {
          name: { t: 'string', v: 'Ann' },
          joined: { t: 'timestamp', v: { s: 1700000000, n: 0 } },
          best: { t: 'reference', v: 'users/b' },
          address: { t: 'map', v: { home: { t: 'geopoint', v: { lat: 1, lng: 2 } }, zip: { t: 'null' } } },
        },
      }],
    },
  ];
  const json = toJson(snaps);
  assert.deepEqual(Object.keys(json), ['users', 'users/a/orders']);
  assert.deepEqual(json.users.a, {
    name: 'Ann',
    joined: { $timestamp: '2023-11-14T22:13:20Z' },
    best: { $ref: 'users/b' },
    address: { home: { $geo: [1, 2] }, zip: null },
  });
  assert.deepEqual(json['users/a/orders'], { o1: { total: 3 } });
});

test('export --from local: the CSV applied to the snapshot; rows without an id are counted, not exported', () => {
  const snap: Snapshot = {
    collection: 'users', pulledAt: '', columns: [], docs: [
      { id: 'a', updateTime: '1.0', fields: { name: { t: 'string', v: 'Ann' }, age: { t: 'number', v: 30 }, old: { t: 'string', v: 'x' } } },
      { id: 'b', updateTime: '1.0', fields: { name: { t: 'string', v: 'Bob' } } },
    ],
  };
  snap.columns = [{ field: 'age', type: 'number' }, { field: 'name', type: 'string' }, { field: 'old', type: 'string' }];
  // "old" column removed (kept in Firestore unless push is told to delete it), Ann edited, Bob deleted, two rows added.
  const csv = rowsToCsv([['_id', 'name:string', 'age:number'], ['a', 'Anne', ''], ['c', 'Cy', '5'], ['', 'Dee', '']]);
  const { docs, withoutId } = applyPlan(snap, computePlan(snap, parseCsv(csv, 'x')));
  assert.deepEqual(docs, [
    { id: 'a', fields: { name: { t: 'string', v: 'Anne' }, old: { t: 'string', v: 'x' } } },
    { id: 'c', fields: { name: { t: 'string', v: 'Cy' }, age: { t: 'number', v: 5 } } },
  ]);
  assert.equal(withoutId, 1);
});

test('paths: one per argument; commas or spaces inside one are refused with the command to run', () => {
  const { collections, docs } = parsePullArgs(['employees/jim', 'employees/dwight', 'sales']);
  assert.deepEqual(collections, [['sales']]);
  assert.deepEqual([...docs.get('employees')!], ['jim', 'dwight']);
  assert.doesNotThrow(() => checkOperands('pull', ['users', 'users/*/orders']));
  const fix = (args: string[]) => {
    try { checkOperands('pull', args); } catch (e) { return (e as Error).message.split('\n')[1].trim().replace(/^"|"$/g, ''); }
    return '';
  };
  assert.match(fix(['users,staff']), /firerow pull users staff$/);
  // What PowerShell passes for an unquoted users,staff.
  assert.match(fix(['users staff']), /firerow pull users staff$/);
  assert.match(fix(['employees', 'users/*/orders,sales']), /firerow pull employees "users\/\*\/orders" sales$/);
});

test('pull --replace: finds the unpushed changes it would drop (rows outside the pull)', () => {
  const S = (v: string) => ({ t: 'string' as const, v });
  const doc = (id: string, branch: string) => ({ id, updateTime: '1.0', fields: { branch: S(branch) } });
  const snap: Snapshot = {
    collection: 'employees', pulledAt: '', columns: [{ field: 'branch', type: 'string' }],
    docs: [doc('andy', 'Stamford'), doc('dwight', 'Scranton'), doc('karen', 'Stamford'), doc('michael', 'Scranton'), doc('toby', 'Scranton')],
  };
  // Andy edited, Karen and Toby deleted, Dwight edited, Ryan and an id-less row added.
  const csv = rowsToCsv([['_id', 'branch:string'], ['andy', 'Nashua'], ['dwight', 'Utica'], ['michael', 'Scranton'], ['ryan', 'Nashua'], ['', 'Albany']]);
  const plan = computePlan(snap, parseCsv(csv, 'x'));
  const keep = new Set(['dwight', 'michael', 'toby']); // what the pull returned
  assert.deepEqual(unpushedOutside(plan, keep), [
    { id: 'andy', kind: 'edited' },
    { id: 'karen', kind: 'deleted' },
    { id: 'ryan', kind: 'new' },
    { id: '', kind: 'new' },
  ]);
  // Changes only to rows the pull returned: nothing in the way.
  assert.deepEqual(unpushedOutside(computePlan(snap, parseCsv(rowsToCsv([['_id', 'branch:string'], ...snap.docs.map((d) => [d.id, d.id === 'dwight' ? 'Utica' : (d.fields.branch as { v: string }).v])]), 'x')), keep), []);
});
