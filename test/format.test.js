import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, formatPercentChange } from '../src/format.js';

test('money: thousands separators and exactly two decimals, with the configured currency', () => {
  assert.equal(formatMoney(2266.3, 'USD'), 'USD 2,266.30');
  assert.equal(formatMoney(33.9, 'USD'), 'USD 33.90');
  assert.equal(formatMoney(67.8, 'USD'), 'USD 67.80');
  assert.equal(formatMoney(0, 'USD'), 'USD 0.00');
  assert.equal(formatMoney(5, 'USD'), 'USD 5.00');
  assert.equal(formatMoney(1000, 'USD'), 'USD 1,000.00');
  assert.equal(formatMoney(1234567.891, 'USD'), 'USD 1,234,567.89');
  assert.equal(formatMoney('12.5', 'USD'), 'USD 12.50', 'numeric strings from SQL drivers');
  assert.equal(formatMoney(2266.3, 'EUR'), 'EUR 2,266.30');
  assert.equal(formatMoney(2266.3, 'INR'), 'INR 2,266.30');
});

test('money: floating-point noise and negatives', () => {
  assert.equal(formatMoney(0.1 + 0.2, 'USD'), 'USD 0.30');
  assert.equal(formatMoney(2266.3000000000002, 'USD'), 'USD 2,266.30');
  assert.equal(formatMoney(-5, 'USD'), '-USD 5.00');
  assert.equal(formatMoney(-1234.5, 'USD'), '-USD 1,234.50');
  assert.equal(formatMoney(-0.001, 'USD'), 'USD 0.00', 'never "-USD 0.00"');
});

test('money: missing or non-numeric values show N/A rather than "USD NaN"', () => {
  for (const value of [null, undefined, '', 'abc', NaN, Infinity]) {
    assert.equal(formatMoney(value, 'USD'), 'N/A', String(value));
  }
});

test('money: formatting never changes the amount (round-trip for 5,000 random two-decimal values)', () => {
  let seed = 12345;
  const next = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < 5000; i += 1) {
    const cents = Math.floor(next() * 5_000_000_000); // up to 50 million with cents
    const value = cents / 100;
    const text = formatMoney(value, 'USD');
    assert.match(text, /^USD \d{1,3}(,\d{3})*\.\d{2}$/, text);
    assert.equal(Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100), cents, `${value} -> ${text}`);
  }
});

test('percent change: sign, direction and rounding', () => {
  assert.deepEqual(formatPercentChange(12.5), { label: '+12.5%', direction: 'positive' });
  assert.deepEqual(formatPercentChange(-23.1), { label: '-23.1%', direction: 'negative' });
  assert.deepEqual(formatPercentChange(100), { label: '+100%', direction: 'positive' });
  assert.deepEqual(formatPercentChange(-100), { label: '-100%', direction: 'negative' });
  assert.deepEqual(formatPercentChange(0), { label: '0%', direction: 'neutral' });
  assert.deepEqual(formatPercentChange(-0.04), { label: '0%', direction: 'neutral' }, 'rounds to zero: no sign');
  assert.deepEqual(formatPercentChange(-23.099999999), { label: '-23.1%', direction: 'negative' });
  assert.deepEqual(formatPercentChange(1250.55), { label: '+1,250.6%', direction: 'positive' });
});

test('percent change: unavailable baselines use the supplied label', () => {
  assert.deepEqual(formatPercentChange(null), { label: 'N/A', direction: 'unavailable' });
  assert.deepEqual(formatPercentChange(undefined, 'N/A (no previous-period revenue)'), { label: 'N/A (no previous-period revenue)', direction: 'unavailable' });
  assert.equal(formatPercentChange(NaN).direction, 'unavailable');
});
