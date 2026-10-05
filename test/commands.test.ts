import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newHeader } from '../src/commands/create.js';
import { applyPlan, toJson } from '../src/commands/export.js';
import { computePlan } from '../src/diff.js';
import type { Snapshot } from '../src/snapshot.js';
import { parseCsv, rowsToCsv } from '../src/table.js';

test('create: comma-separated columns keep their types; bare names stay untyped', () => {
  assert.deepEqual(newHeader('name:string,age:Number, tags:array ,note'), ['_id', 'name:string', 'age:number', 'tags:array', 'note']);
  assert.deepEqual(newHeader('first name:string'), ['_id', 'first name:string']);
  assert.deepEqual(newHeader(), ['_id']);
});

test('create: rejects unknown types, _id and duplicates', () => {
  assert.throws(() => newHeader('age:int'), /unknown type "int"/);
  assert.throws(() => newHeader('_id'), /always the first column/);
  assert.throws(() => newHeader('a:string,a:number'), /listed twice/);
  assert.throws(() => newHeader('name:string price:number'), /commas, not spaces/);
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
