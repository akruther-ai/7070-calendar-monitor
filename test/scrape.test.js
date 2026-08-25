'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  addCalendarDays,
  calendarDateMs,
  middleSchoolMatch,
  validateCapturedCoverage,
  validatePopulation,
} = require('../scrape');

const events = [{}];

test('calendar-day arithmetic validates dates and crosses boundaries', () => {
  assert.equal(addCalendarDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.throws(() => calendarDateMs('2026-02-30'), /Invalid/);
  assert.throws(() => addCalendarDays('2026-08-25', 1.5), /integer/);
});

test('Middle School matching checks both title and item type', () => {
  assert.equal(middleSchoolMatch({ title: 'IPT Middle School' }), true);
  assert.equal(middleSchoolMatch({ title: 'Skills', calendarItemType: { name: 'Middle School' } }), true);
  assert.equal(middleSchoolMatch({ title: 'High School Skills' }), false);
});

test('captured coverage accepts contiguous advancing nonempty ranges', () => {
  assert.deepEqual(validateCapturedCoverage([
    { startDate: '2026-08-23', endDate: '2026-08-29', items: events },
    { startDate: '2026-08-29', endDate: '2026-09-05', items: events },
    { startDate: '2026-09-06', endDate: '2026-09-12', items: events },
    { startDate: '2026-09-13', endDate: '2026-09-19', items: events },
  ], '2026-08-25', '2026-09-15'), {
    startDate: '2026-08-23',
    endDate: '2026-09-19',
  });
});

test('captured coverage rejects empty, gapped, stalled, and short captures', () => {
  assert.throws(() => validateCapturedCoverage([
    { startDate: '2026-08-23', endDate: '2026-08-29', items: [] },
  ], '2026-08-25', '2026-08-29'), /contained no events/);

  assert.throws(() => validateCapturedCoverage([
    { startDate: '2026-08-23', endDate: '2026-08-29', items: events },
    { startDate: '2026-08-31', endDate: '2026-09-06', items: events },
  ], '2026-08-25', '2026-09-01'), /gap/);

  assert.throws(() => validateCapturedCoverage([
    { startDate: '2026-08-23', endDate: '2026-08-29', items: events },
    { startDate: '2026-08-24', endDate: '2026-08-29', items: events },
  ], '2026-08-25', '2026-08-29'), /did not advance/);

  assert.throws(() => validateCapturedCoverage([
    { startDate: '2026-08-23', endDate: '2026-08-29', items: events },
  ], '2026-08-25', '2026-09-15'), /incomplete/);
});

test('population safety threshold compares with the last known good feed', () => {
  assert.doesNotThrow(() => validatePopulation('Calendar', 50, 100, 20));
  assert.throws(() => validatePopulation('Calendar', 49, 100, 20), /safety threshold 50/);
  assert.doesNotThrow(() => validatePopulation('Calendar', 20, null, 20));
  assert.throws(() => validatePopulation('Calendar', 19, null, 20), /safety threshold 20/);
});
