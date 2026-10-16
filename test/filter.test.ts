import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Firestore } from 'firebase-admin/firestore';
import { buildQuery, FilterError, parseCondition, querySpec, typed, type Condition } from '../src/filter.js';

/** A condition with its values as plain PValues, for comparing. */
function plain(c: Condition): unknown {
  if (c.kind !== 'where') return { [c.kind]: c.conditions.map(plain) };
  return [c.field, c.op, c.value.value];
}

test('filter: field op value, with SDK operators and literals', () => {
  assert.deepEqual(plain(parseCondition('age >= 18')), ['age', '>=', { t: 'number', v: 18 }]);
  assert.deepEqual(plain(parseCondition("city == 'Ho Chi Minh City'")), ['city', '==', { t: 'string', v: 'Ho Chi Minh City' }]);
  assert.deepEqual(plain(parseCondition('country==VN')), ['country', '==', { t: 'string', v: 'VN' }]);
  assert.deepEqual(plain(parseCondition('active != false')), ['active', '!=', { t: 'boolean', v: false }]);
  assert.deepEqual(plain(parseCondition('deletedAt == null')), ['deletedAt', '==', { t: 'null' }]);
  assert.deepEqual(plain(parseCondition('address.city == Hanoi')), ['address.city', '==', { t: 'string', v: 'Hanoi' }]);
  assert.deepEqual(plain(parseCondition(`"first name" == "O'Brien"`)), ['first name', '==', { t: 'string', v: "O'Brien" }]);
  // A doubled quote is the quote itself — the escape that survives every shell.
  assert.deepEqual(plain(parseCondition("desk == 'Pam''s desk'")), ['desk', '==', { t: 'string', v: "Pam's desk" }]);
  assert.deepEqual(plain(parseCondition("note == ''")), ['note', '==', { t: 'string', v: '' }]);
  assert.deepEqual(plain(parseCondition("q in ['''', '']")), ['q', 'in', { t: 'array', v: [{ t: 'string', v: "'" }, { t: 'string', v: '' }] }]);
  assert.deepEqual(plain(parseCondition("role not-in ['guest', \"banned\"]")),
    ['role', 'not-in', { t: 'array', v: [{ t: 'string', v: 'guest' }, { t: 'string', v: 'banned' }] }]);
  assert.deepEqual(plain(parseCondition('tags array-contains-any [vip, 2]')),
    ['tags', 'array-contains-any', { t: 'array', v: [{ t: 'string', v: 'vip' }, { t: 'number', v: 2 }] }]);
});

test('filter: special types use SDK-style constructors', () => {
  assert.deepEqual(plain(parseCondition("createdAt > Timestamp('2026-01-01T00:00:00Z')")),
    ['createdAt', '>', { t: 'timestamp', v: { s: 1767225600, n: 0 } }]);
  assert.deepEqual(plain(parseCondition("owner == ref('users/alice')")), ['owner', '==', { t: 'reference', v: 'users/alice' }]);
  assert.deepEqual(plain(parseCondition('home == GeoPoint(10.8, -106.7)')), ['home', '==', { t: 'geopoint', v: { lat: 10.8, lng: -106.7 } }]);
  assert.throws(() => parseCondition('home == GeoPoint(100, 0)'), FilterError);
  assert.throws(() => parseCondition("x == Foo('a')"), /unknown value type Foo/);
});

test('filter: helpful errors', () => {
  assert.throws(() => parseCondition('age = 18'), /use == for equality/);
  assert.throws(() => parseCondition('city == Ho Chi Minh City'), /put text with spaces in quotes/);
  assert.throws(() => parseCondition('city == Hanoi, Da Nang'), /use a list/);
  assert.throws(() => parseCondition('city in Hanoi'), /in needs a list/);
  assert.throws(() => parseCondition("name == 'open"), /missing closing '/);
  assert.throws(() => parseCondition('tags contains vip'), /Firestore's operator names/);
  assert.throws(() => parseCondition('age >='), /expected a value/);
});

test('filter: --query takes the chained or comma-separated SDK form', () => {
  const s = querySpec({ query: "where('age', '>=', 18).where(or(where('a', '==', 1), where('b', '==', 2))).orderBy('age', 'desc').limit(10)" })!;
  assert.deepEqual(s.conditions.map(plain), [
    ['age', '>=', { t: 'number', v: 18 }],
    { or: [['a', '==', { t: 'number', v: 1 }], ['b', '==', { t: 'number', v: 2 }]] },
  ]);
  assert.deepEqual(s.orderBy, [{ field: 'age', direction: 'desc' }]);
  assert.equal(s.limit, 10);

  const m = querySpec({ query: "where('x', 'in', [1, 2]), orderBy('x'), limitToLast(5)" })!;
  assert.deepEqual(m.orderBy, [{ field: 'x', direction: 'asc' }]);
  assert.equal(m.limitToLast, 5);
  assert.throws(() => querySpec({ query: "startAt('a')" }), /isn't supported/);
  assert.throws(() => querySpec({ query: "where('a', '==', 1) where('b', '==', 2)" }), /expected "\."/);
});

test('filter: and/or inside --where, parentheses to group', () => {
  const S = (v: string) => ({ t: 'string', v });
  assert.deepEqual(plain(parseCondition("filedBy == 'Toby Flenderson' or severity >= 3")),
    { or: [['filedBy', '==', S('Toby Flenderson')], ['severity', '>=', { t: 'number', v: 3 }]] });
  assert.deepEqual(plain(parseCondition("branch == Scranton AND department == Sales and active == true")),
    { and: [['branch', '==', S('Scranton')], ['department', '==', S('Sales')], ['active', '==', { t: 'boolean', v: true }]] });
  assert.deepEqual(plain(parseCondition("(branch == 'Scranton' and department == 'Sales') or salesTotal >= 100000")), {
    or: [{ and: [['branch', '==', S('Scranton')], ['department', '==', S('Sales')]] }, ['salesTotal', '>=', { t: 'number', v: 100000 }]],
  });
  assert.deepEqual(plain(parseCondition('((a == 1))')), ['a', '==', { t: 'number', v: 1 }]);
  // "and"/"or" where a value is expected is just a value.
  assert.deepEqual(plain(parseCondition('role == or and x == and')), { and: [['role', '==', S('or')], ['x', '==', S('and')]] });

  assert.throws(() => parseCondition('a == 1 and b == 2 or c == 3'), /use parentheses when mixing and\/or/);
  assert.throws(() => parseCondition('a == 1 or b == 2 and c == 3'), /use parentheses when mixing and\/or/);
  assert.throws(() => parseCondition('(a == 1 or b == 2'), /expected "\)"/);
  assert.throws(() => parseCondition('a == 1) or b == 2'), /has no matching \(/);
  assert.throws(() => parseCondition('a == 1 b == 2'), /join conditions with and\/or/);
  assert.throws(() => parseCondition('a == 1 or'), /expected a field name/);
});

test('filter: options combine; several --where all have to match', () => {
  const s = querySpec({ where: ['active == true', "status == 'failed' or priority >= 3"], orderBy: ['createdAt desc'], limit: '100' })!;
  assert.deepEqual(s.conditions.map(plain), [
    ['active', '==', { t: 'boolean', v: true }],
    { or: [['status', '==', { t: 'string', v: 'failed' }], ['priority', '>=', { t: 'number', v: 3 }]] },
  ]);
  assert.deepEqual(s.orderBy, [{ field: 'createdAt', direction: 'desc' }]);
  assert.equal(s.limit, 100);
  assert.equal(querySpec({}), undefined);
  assert.equal(querySpec({ where: [] }), undefined);
  assert.throws(() => querySpec({ limit: '0' }), /whole number/);
  assert.throws(() => querySpec({ orderBy: ['a'], limit: '1', limitToLast: '1' }), /not both/);
  assert.throws(() => querySpec({ limitToLast: '5' }), /needs an orderBy/);
  assert.throws(() => querySpec({ orderBy: ['a sideways'] }), /asc or desc/);
});

test('filter: unquoted values take their column type; quoted text stays text', () => {
  const v = (s: string) => (parseCondition(s) as Condition & { kind: 'where' }).value;
  assert.deepEqual(typed(v('zip == 01234'), 'string'), { t: 'string', v: '01234' });
  assert.deepEqual(typed(v('code == 42'), 'string'), { t: 'string', v: '42' });
  assert.deepEqual(typed(v("n == '42'"), 'number'), { t: 'string', v: '42' });
  assert.deepEqual(typed(v('n == 42'), 'number'), { t: 'number', v: 42 });
  assert.deepEqual(typed(v('d > 2026-01-01'), 'timestamp'), { t: 'timestamp', v: { s: 1767225600, n: 0 } });
  assert.deepEqual(typed(v("d > '2026-01-01'"), 'timestamp'), { t: 'timestamp', v: { s: 1767225600, n: 0 } });
  assert.deepEqual(typed(v("o == 'users/a'"), 'reference'), { t: 'reference', v: 'users/a' });
  assert.deepEqual(typed(v('ok == TRUE'), 'boolean'), { t: 'boolean', v: true });
  assert.deepEqual(typed(v('zip in [01234, 7]'), 'string'), { t: 'array', v: [{ t: 'string', v: '01234' }, { t: 'string', v: '7' }] });
  // Unknown column, or a value that doesn't fit it: as written.
  assert.deepEqual(typed(v('n == abc'), 'number'), { t: 'string', v: 'abc' });
  assert.deepEqual(typed(v('d > 2026-01-01'), undefined), { t: 'string', v: '2026-01-01' });
});

test('filter: builds a Firestore query (no network)', () => {
  const db = new Firestore({ projectId: 'test' });
  const spec = querySpec({ where: ['age >= 18', '_id != alice', '(a == 1 and b == 2) or c == 3'], orderBy: ['age desc'], limit: '5' })!;
  assert.doesNotThrow(() => buildQuery(db.collection('users'), spec, db, () => undefined));
  assert.throws(() => buildQuery(db.collectionGroup('orders'), spec, db, () => undefined, true), /_id filters/);
});

test('filter: --query @file reads the query from a file, with // comments and line breaks', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fr-')), 'top-sellers.txt');
  fs.writeFileSync(file, '\uFEFF// Scranton\'s best\r\nwhere(\'branch\', \'==\', "Scranton")\r\n  .where(\'price\', \'==\', \'$5\')\r\n  // the top 10\r\n  .limit(10)\r\n');
  const s = querySpec({ query: `@${file}`, where: ['active == true'] })!;
  assert.deepEqual(s.conditions.map(plain), [
    ['branch', '==', { t: 'string', v: 'Scranton' }],
    ['price', '==', { t: 'string', v: '$5' }],
    ['active', '==', { t: 'boolean', v: true }],
  ]);
  assert.equal(s.limit, 10);
  assert.throws(() => querySpec({ query: '@no-such-file.txt' }), /can't read the query file/);
  fs.writeFileSync(file, '// nothing but a comment\n');
  assert.throws(() => querySpec({ query: `@${file}` }), /is empty/);
});
