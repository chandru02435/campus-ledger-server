const test = require('node:test');
const assert = require('node:assert/strict');
const { pct, average, computeDues, totals } = require('../src/services/calc');

const heads = [
  { id: 1, name: 'Tuition', amount_paise: 1_000_000, due_date: '2026-08-15' },
  { id: 2, name: 'Library', amount_paise: 200_000, due_date: '2026-12-01' },
];

test('attendance percentage excludes excused classes', () => {
  assert.equal(pct(2, 3), 67);            // P, L attended; A missed; E not counted
  assert.equal(pct(0, 0), 100);           // nothing counted yet
  assert.equal(pct(9, 12), 75);
});
test('average of nothing is null, not zero', () => {
  assert.equal(average([]), null);
  assert.equal(average([80, 70]), 75);
});
test('partial payment goes to the oldest due date first', () => {
  const d = computeDues(heads, new Map(), 400_000, '2026-10-15');
  assert.deepEqual(d.map(x => [x.head, x.paid, x.balance, x.status]),
    [['Tuition', 400_000, 600_000, 'Overdue'], ['Library', 0, 200_000, 'Pending']]);
});
test('discount lowers what is owed and balances never go negative', () => {
  const d = computeDues(heads, new Map([[1, 100_000], [2, 999_999_999]]), 900_000, '2026-10-15');
  assert.equal(d[0].net, 900_000); assert.equal(d[0].balance, 0); assert.equal(d[0].status, 'Paid');
  assert.equal(d[1].discount, 200_000);       // capped at the fee amount
  assert.ok(d.every(x => x.balance >= 0));
  assert.deepEqual(totals(d), { net: 900_000, paid: 900_000, balance: 0 });
});
test('status: partial before due date, overdue after', () => {
  assert.equal(computeDues(heads, new Map(), 50_000, '2026-01-01')[0].status, 'Partial');
  assert.equal(computeDues(heads, new Map(), 0, '2026-09-01')[0].status, 'Overdue');
});
