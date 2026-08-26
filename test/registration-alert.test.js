'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  advanceMarkerFor,
  createAdvanceIssue,
  dispatchSuccessor,
  main,
  markerFor,
  openingTimesWithin,
  stateMatchesSchedule,
  validateFeed,
  watchMain,
} = require('../registration-alert');
const { registrationOpenMs } = require('../lib/registration-time');

function event(uuid, startDatetime, title = 'Middle School Skills') {
  return { uuid, startDatetime, title, mainCoach: { firstName: 'Test', lastName: 'Coach' } };
}

test('feed validation sorts valid events and rejects ambiguity', () => {
  const first = event('a', '2026-09-01T16:30:00.000Z');
  const second = event('b', '2026-09-01T17:30:00.000Z');
  assert.deepEqual(validateFeed({ count: 2, items: [second, first] }).map(item => item.uuid), ['a', 'b']);
  assert.throws(() => validateFeed({ count: 1, items: [first, second] }), /count mismatch/);
  assert.throws(() => validateFeed({ count: 2, items: [first, first] }), /duplicate schedule/);
  assert.throws(() => validateFeed({
    count: 2,
    items: [first, { ...first, startDatetime: '2026-09-02T16:30:00.000Z' }],
  }), /reused UUID/);
  assert.throws(() => validateFeed({ count: 1, items: [{ uuid: 'missing-time' }] }), /malformed/);
});

test('schedule state and issue markers include UUID plus start time', () => {
  const item = event('abc', '2026-09-01T16:30:00.000Z');
  const opensAt = registrationOpenMs(item.startDatetime);
  assert.equal(markerFor(item), '<!-- 7070-event:abc|2026-09-01T16:30:00.000Z -->');
  assert.equal(advanceMarkerFor(item), '<!-- 7070-advance:abc|2026-09-01T16:30:00.000Z -->');
  assert.equal(stateMatchesSchedule({ startDatetime: item.startDatetime }, item, opensAt), true);
  assert.equal(stateMatchesSchedule({ registrationOpenedAt: new Date(opensAt).toISOString() }, item, opensAt), true);
  assert.equal(stateMatchesSchedule({ startDatetime: '2026-09-02T16:30:00.000Z' }, item, opensAt), false);
});

test('watch-window openings are unique, ordered, and bounded', () => {
  const first = event('a', '2026-09-01T16:30:00.000Z');
  const sameTime = event('b', '2026-09-01T16:30:00.000Z');
  const later = event('c', '2026-09-01T17:30:00.000Z');
  const firstOpening = registrationOpenMs(first.startDatetime);
  const laterOpening = registrationOpenMs(later.startDatetime);

  assert.deepEqual(
    openingTimesWithin([later, sameTime, first], firstOpening - 1, laterOpening),
    [firstOpening, laterOpening],
  );
  assert.deepEqual(openingTimesWithin([first, later], firstOpening, laterOpening - 1), []);
});

test('ambiguous issue-creation failures are not retried immediately', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    throw new Error('connection reset after request');
  };
  try {
    const item = event('abc', '2026-09-01T16:30:00.000Z');
    await assert.rejects(
      createAdvanceIssue([{ event: item, opensAt: registrationOpenMs(item.startDatetime) }], 'owner/repo', 'token'),
      /connection reset/,
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('successor dispatch targets the registration workflow on main', async () => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  let request;
  global.fetch = async (url, options = {}) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  };
  console.log = () => {};
  try {
    await dispatchSuccessor('owner/repo', 'test-token', 'main');
    assert.equal(
      request.url,
      'https://api.github.com/repos/owner/repo/actions/workflows/registration-alert.yml/dispatches',
    );
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), { ref: 'main' });
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
  }
});

test('daily advance digest, issue recovery, live confirmation, and closure are idempotent', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '7070-alert-test-'));
  const feedPath = path.join(tempDir, 'middle-school.json');
  const statePath = path.join(tempDir, 'state.json');
  const items = [
    event('a', '2026-09-01T16:30:00.000Z'),
    event('b', '2026-09-01T17:30:00.000Z'),
    event('c', '2026-09-01T18:30:00.000Z'),
  ];
  fs.writeFileSync(feedPath, JSON.stringify({ count: items.length, items }));
  fs.writeFileSync(statePath, JSON.stringify({ initialized: true, alerted: {} }));

  const originalFetch = global.fetch;
  const originalLog = console.log;
  const issues = [];
  const requests = [];
  let activeNow = Date.parse('2026-08-24T23:00:00.000Z');
  let nextIssueNumber = 100;

  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ method, url, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET') {
      return new Response(JSON.stringify(issues), { status: 200 });
    }
    if (method === 'POST') {
      const payload = JSON.parse(options.body);
      const created = {
        ...payload,
        number: nextIssueNumber++,
        created_at: new Date(activeNow).toISOString(),
        state: 'open',
      };
      issues.unshift(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }
    if (method === 'PATCH') {
      const issueNumber = Number(String(url).split('/').pop());
      const existing = issues.find(issue => issue.number === issueNumber);
      if (existing) existing.state = 'closed';
      return new Response(JSON.stringify(existing || { number: issueNumber }), { status: 200 });
    }
    return new Response('unsupported', { status: 500 });
  };
  console.log = () => {};

  try {
    let result = await main({
      repoFullName: 'owner/repo', token: 'test-token', nowMs: activeNow, feedPath, statePath,
    });
    assert.deepEqual(result, { advanceNoticesCreated: 1, alertsCreated: 0, stateChanged: true });
    assert.equal(issues.length, 1);
    assert.match(issues[0].title, /^UPCOMING — 7070 registration on Tuesday, August 25, 2026$/);
    assert.equal((issues[0].body.match(/7070-advance:/g) || []).length, 3);
    assert.match(issues[0].body, /4:30 PM MDT/);
    assert.match(issues[0].body, /6:30 PM MDT/);

    let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(new Set(Object.values(state.advanceAlerted).map(entry => entry.issueNumber)), new Set([100]));

    // Simulate issue creation succeeding while the state commit is lost.
    state.advanceAlerted = {};
    fs.writeFileSync(statePath, JSON.stringify(state));
    result = await main({
      repoFullName: 'owner/repo', token: 'test-token', nowMs: activeNow, feedPath, statePath,
    });
    assert.equal(result.advanceNoticesCreated, 0);
    assert.equal(issues.length, 1);
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(Object.values(state.advanceAlerted).every(entry => entry.recoveredFromIssue), true);

    const requestsBeforeIdempotentRun = requests.length;
    result = await main({
      repoFullName: 'owner/repo', token: 'test-token', nowMs: activeNow, feedPath, statePath,
    });
    assert.deepEqual(result, { advanceNoticesCreated: 0, alertsCreated: 0, stateChanged: false });
    assert.equal(requests.length, requestsBeforeIdempotentRun);

    // First live window confirms without closing the shared daily digest.
    activeNow = Date.parse('2026-08-25T22:31:00.000Z');
    result = await main({
      repoFullName: 'owner/repo', token: 'test-token', nowMs: activeNow, feedPath, statePath,
    });
    assert.equal(result.alertsCreated, 1);
    assert.equal(issues.find(issue => issue.number === 100).state, 'open');

    // The remaining two distinct openings each confirm, then the digest closes.
    activeNow = Date.parse('2026-08-26T00:31:00.000Z');
    result = await main({
      repoFullName: 'owner/repo', token: 'test-token', nowMs: activeNow, feedPath, statePath,
    });
    assert.equal(result.alertsCreated, 2);
    assert.equal(issues.find(issue => issue.number === 100).state, 'closed');
    assert.equal(issues.filter(issue => issue.title.startsWith('LATE —')).length, 1);
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(Object.values(state.advanceAlerted).every(entry => entry.issueClosedAt), true);
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('watcher sleeps to each distinct opening and confirms it immediately', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '7070-watch-test-'));
  const feedPath = path.join(tempDir, 'middle-school.json');
  const statePath = path.join(tempDir, 'state.json');
  const items = [
    event('a', '2026-09-01T16:02:00.000Z'),
    event('b', '2026-09-01T16:02:00.000Z'),
    event('c', '2026-09-01T16:04:00.000Z'),
  ];
  fs.writeFileSync(feedPath, JSON.stringify({ count: items.length, items }));
  fs.writeFileSync(statePath, JSON.stringify({ initialized: true, alerted: {}, advanceAlerted: {} }));

  const originalFetch = global.fetch;
  const originalLog = console.log;
  const issues = [];
  const waits = [];
  let successorDispatches = 0;
  let activeNow = Date.parse('2026-08-25T22:00:00.000Z');
  let nextIssueNumber = 200;

  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method === 'GET') {
      return new Response(JSON.stringify(issues), { status: 200 });
    }
    if (method === 'POST') {
      const created = {
        ...JSON.parse(options.body),
        number: nextIssueNumber++,
        created_at: new Date(activeNow).toISOString(),
        state: 'open',
      };
      issues.unshift(created);
      return new Response(JSON.stringify(created), { status: 201 });
    }
    if (method === 'PATCH') {
      const issueNumber = Number(String(url).split('/').pop());
      const existing = issues.find(issue => issue.number === issueNumber);
      if (existing) existing.state = 'closed';
      return new Response(JSON.stringify(existing || { number: issueNumber }), { status: 200 });
    }
    return new Response('unsupported', { status: 500 });
  };
  console.log = () => {};

  try {
    const result = await watchMain({
      repoFullName: 'owner/repo',
      token: 'test-token',
      feedPath,
      statePath,
      nowFn: () => activeNow,
      sleepFn: async waitMs => {
        waits.push(waitMs);
        activeNow += waitMs;
      },
      dispatchFn: async () => {
        successorDispatches++;
      },
      watchHorizonMs: 5 * 60 * 1000,
    });

    assert.deepEqual(result, { advanceNoticesCreated: 1, alertsCreated: 2, stateChanged: true });
    assert.deepEqual(waits, [121000, 120000]);
    assert.equal(successorDispatches, 1);
    assert.equal(issues.filter(issue => issue.title.startsWith('7070 registration open:')).length, 2);
    assert.equal(issues.some(issue => issue.title.includes('2 Middle School classes')), true);
    assert.equal(issues.some(issue => issue.title.startsWith('LATE —')), false);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(Object.keys(state.alerted).length, 3);
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
