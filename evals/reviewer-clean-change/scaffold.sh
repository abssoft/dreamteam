#!/bin/bash
# Fixture: base line on main, correct task change with covering tests.
set -euo pipefail

git init -q -b main
git config user.email "fixture@example.invalid"
git config user.name "Fixture"

cat > package.json <<'JSON'
{
  "name": "fixture-orders",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON

mkdir -p src test
cat > src/orders.mjs <<'JS'
export function createOrder(id) {
  return { id, items: [] };
}
JS

cat > test/orders.test.mjs <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrder } from '../src/orders.mjs';

test('createOrder starts empty', () => {
  assert.deepEqual(createOrder('a').items, []);
});
JS

git add -A
git commit -qm "base: orders module"

git checkout -qb task-totals

cat > src/totals.mjs <<'JS'
export function sumTotals(items) {
  let total = 0;
  for (const item of items) {
    total += item.amount;
  }
  return total;
}
JS

cat > test/totals.test.mjs <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { sumTotals } from '../src/totals.mjs';

test('sumTotals of an empty list is zero', () => {
  assert.equal(sumTotals([]), 0);
});

test('sumTotals adds every amount including the last one', () => {
  assert.equal(sumTotals([{ amount: 10 }, { amount: 20 }, { amount: 12 }]), 42);
});
JS

git add -A
git commit -qm "task: totals module"
