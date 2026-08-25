'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  localDateKey,
  parseWallClock,
  registrationOpenMs,
} = require('../lib/registration-time');

test('registration opens seven Denver calendar days before a summer class', () => {
  assert.equal(
    new Date(registrationOpenMs('2026-09-01T16:30:00.000Z')).toISOString(),
    '2026-08-25T22:30:00.000Z',
  );
});

test('seven-day wall-clock calculation remains correct across spring DST', () => {
  assert.equal(
    new Date(registrationOpenMs('2026-03-14T10:00:00.000Z')).toISOString(),
    '2026-03-07T17:00:00.000Z',
  );
});

test('seven-day wall-clock calculation remains correct across fall DST', () => {
  assert.equal(
    new Date(registrationOpenMs('2026-11-07T10:00:00.000Z')).toISOString(),
    '2026-10-31T16:00:00.000Z',
  );
});

test('calendar subtraction crosses leap day and year boundaries', () => {
  assert.equal(
    new Date(registrationOpenMs('2024-03-07T18:30:00.000Z')).toISOString(),
    '2024-03-01T01:30:00.000Z',
  );
  assert.equal(
    new Date(registrationOpenMs('2027-01-03T09:00:00.000Z')).toISOString(),
    '2026-12-27T16:00:00.000Z',
  );
});

test('local date grouping uses the Denver date rather than UTC date', () => {
  assert.equal(localDateKey(Date.parse('2026-08-26T00:30:00.000Z')), '2026-08-25');
});

test('impossible and malformed wall clocks fail closed', () => {
  assert.throws(() => parseWallClock('2026-02-30T12:00:00.000Z'), /Invalid/);
  assert.throws(() => parseWallClock('not-a-date'), /Unrecognized/);
});
