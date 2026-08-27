'use strict';

const fs = require('fs');
const path = require('path');
const {
  formatInstantLocal,
  formatInstantLocalDate,
  formatLocalWall,
  localDateKey,
  registrationOpenMs,
  scheduleKey,
} = require('./lib/registration-time');

const CALENDAR_URL = 'https://7070athletics.pushpress.com/landing/calendar?framed=1';
const WORKFLOW_FILE = 'registration-alert.yml';
const FEED_PATH = path.join(__dirname, 'data', 'middle-school.json');
const STATE_PATH = path.join(__dirname, 'data', 'registration-alerted.json');
const ASSIGNEE = 'akruther-ai';
const INITIAL_GRACE_MS = 20 * 60 * 1000;
const ADVANCE_NOTICE_MS = 30 * 60 * 60 * 1000;
const LATE_AFTER_MS = 15 * 60 * 1000;
const ALERT_CLOSE_AFTER_MS = 24 * 60 * 60 * 1000;
const STATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const WATCH_HORIZON_MS = (5 * 60 * 60 * 1000) + (15 * 60 * 1000);
// Begin a self-sustaining guard chain well before the first known opening.
// This lets one already-created workflow survive a later scheduler outage by
// keeping an active watcher and one pending successor across the alert window.
const WATCH_GUARD_LEAD_MS = 12 * 60 * 60 * 1000;
const WATCH_WAKE_SLOP_MS = 1000;
const SUCCESSOR_RETRY_MS = 5 * 60 * 1000;
const MAX_ISSUE_PAGES = 10;
const MAX_GITHUB_ATTEMPTS = 3;

function guardLeadMsFromHours(value = process.env.WATCH_GUARD_LEAD_HOURS) {
  if (value === undefined || value === '') return WATCH_GUARD_LEAD_MS;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('WATCH_GUARD_LEAD_HOURS must be a positive number.');
  }
  return hours * 60 * 60 * 1000;
}

function readRequiredJson(file, description) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`${description} is missing or unreadable: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${description} contains invalid JSON: ${err.message}`);
  }
}

function readState(statePath = STATE_PATH) {
  if (!fs.existsSync(statePath)) return { initialized: false, alerted: {}, advanceAlerted: {} };
  const state = readRequiredJson(statePath, 'Alert state');
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Alert state must be a JSON object.');
  }
  if (!state.alerted || typeof state.alerted !== 'object' || Array.isArray(state.alerted)) {
    state.alerted = {};
  }
  if (!state.advanceAlerted || typeof state.advanceAlerted !== 'object' || Array.isArray(state.advanceAlerted)) {
    state.advanceAlerted = {};
  }
  if (state.initialized !== undefined && typeof state.initialized !== 'boolean') {
    throw new Error('Alert state initialized flag must be a boolean.');
  }
  state.initialized = Boolean(state.initialized);
  return state;
}

function validateFeed(feed) {
  if (!feed || typeof feed !== 'object' || Array.isArray(feed) || !Array.isArray(feed.items)) {
    throw new Error('data/middle-school.json is missing a valid items array.');
  }
  if (feed.count !== undefined && feed.count !== feed.items.length) {
    throw new Error(`Middle School feed count mismatch: metadata says ${feed.count}, file contains ${feed.items.length}.`);
  }

  const malformed = feed.items.filter(event =>
    !event || typeof event !== 'object' || !event.uuid || !event.startDatetime
  );
  if (malformed.length) {
    throw new Error(`Middle School feed contains ${malformed.length} malformed event(s).`);
  }

  const seen = new Map();
  for (const event of feed.items) {
    const priorStart = seen.get(event.uuid);
    if (priorStart) {
      const detail = priorStart === event.startDatetime
        ? `duplicate schedule ${event.uuid}|${event.startDatetime}`
        : `reused UUID ${event.uuid} for ${priorStart} and ${event.startDatetime}`;
      throw new Error(`Middle School feed contains ${detail}.`);
    }
    // This validates the date shape and catches impossible calendar fields.
    registrationOpenMs(event.startDatetime);
    seen.set(event.uuid, event.startDatetime);
  }

  return [...feed.items].sort((a, b) =>
    String(a.startDatetime).localeCompare(String(b.startDatetime))
  );
}

function coachName(event) {
  return event.mainCoach
    ? `${event.mainCoach.firstName || ''} ${event.mainCoach.lastName || ''}`.trim() || 'Not listed'
    : 'Not listed';
}

function markerFor(event) {
  return `<!-- 7070-event:${scheduleKey(event)} -->`;
}

function advanceMarkerFor(event) {
  return `<!-- 7070-advance:${scheduleKey(event)} -->`;
}

function stateMatchesSchedule(entry, event, opensAt) {
  if (!entry) return false;
  if (entry.startDatetime) return entry.startDatetime === event.startDatetime;
  // Migration support for state written before startDatetime was persisted.
  return entry.registrationOpenedAt === new Date(opensAt).toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function openingTimesWithin(events, afterMs, throughMs) {
  return [...new Set(events
    .map(event => registrationOpenMs(event.startDatetime))
    .filter(opensAt => opensAt > afterMs && opensAt <= throughMs))]
    .sort((a, b) => a - b);
}

async function githubRequest(url, options, description, token, { retryPost = false } = {}) {
  const method = String(options?.method || 'GET').toUpperCase();
  // POST issue creation is intentionally not retried. A lost response is
  // ambiguous: GitHub may have created the issue. The next scheduled run will
  // recover its marker, avoiding an immediate duplicate POST. Workflow
  // dispatch is safe to retry because the concurrency group retains one
  // pending successor even if an ambiguous response creates two runs.
  const canRetry = method !== 'POST' || retryPost;
  let lastError;
  for (let attempt = 1; attempt <= MAX_GITHUB_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          ...(options?.body ? { 'content-type': 'application/json' } : {}),
          ...(options?.headers || {}),
        },
      });
      const raw = await response.text();
      if (response.ok) {
        return {
          data: raw ? JSON.parse(raw) : null,
          headers: response.headers,
          status: response.status,
        };
      }

      const retryable = canRetry && (response.status === 429 || response.status >= 500);
      lastError = new Error(`${description} failed (${response.status}): ${raw}`);
      if (!retryable || attempt === MAX_GITHUB_ATTEMPTS) throw lastError;

      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : 500 * (2 ** (attempt - 1));
      console.warn(`${description} failed transiently; retrying in ${backoffMs} ms.`);
      await sleep(backoffMs);
    } catch (err) {
      lastError = err;
      if (!canRetry || attempt === MAX_GITHUB_ATTEMPTS || /failed \(4\d\d\)/.test(String(err.message))) throw err;
      const backoffMs = 500 * (2 ** (attempt - 1));
      console.warn(`${description} errored transiently; retrying in ${backoffMs} ms: ${err.message}`);
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

async function fetchRecentAlertMarkers(repoFullName, token) {
  const [owner, repo] = repoFullName.split('/');
  const found = { live: new Map(), advance: new Map() };
  const markerPatterns = [
    { target: found.live, pattern: /<!-- 7070-event:([^|>]+\|[^>]+) -->/g },
    { target: found.advance, pattern: /<!-- 7070-advance:([^|>]+\|[^>]+) -->/g },
  ];

  for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const result = await githubRequest(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100&sort=created&direction=desc&page=${page}`,
      {},
      'GitHub issue lookup',
      token,
    );
    const issues = result.data;
    if (!Array.isArray(issues)) throw new Error('GitHub issue lookup returned a non-array response.');

    for (const issue of issues) {
      const body = String(issue.body || '');
      for (const { target, pattern } of markerPatterns) {
        for (const match of body.matchAll(pattern)) {
          if (!target.has(match[1])) {
            target.set(match[1], {
              createdAt: issue.created_at || null,
              issueNumber: issue.number || null,
              creatorLogin: issue.user?.login || null,
            });
          }
        }
      }
    }
    if (issues.length < 100) break;
  }
  return found;
}

async function dispatchSuccessor(
  repoFullName,
  token,
  ref = process.env.GITHUB_REF_NAME || 'main',
  guardLeadHours = process.env.WATCH_GUARD_LEAD_HOURS || '12',
) {
  const [owner, repo] = repoFullName.split('/');
  await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      body: JSON.stringify({
        ref,
        inputs: { guard_lead_hours: String(guardLeadHours) },
      }),
    },
    'GitHub successor-watcher dispatch',
    token,
    { retryPost: true },
  );
  console.log('Queued one successor registration watcher before sleeping.');
}

async function ensureRecoveryNotification(issueNumber, events, repoFullName, token) {
  const [owner, repo] = repoFullName.split('/');
  const marker = '<!-- 7070-recovery-notification -->';
  const commentsResult = await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
    {},
    `GitHub recovery-comment lookup for issue #${issueNumber}`,
    token,
  );
  const comments = commentsResult.data;
  if (!Array.isArray(comments)) {
    throw new Error(`GitHub recovery-comment lookup for issue #${issueNumber} returned a non-array response.`);
  }
  if (comments.some(comment => String(comment.body || '').includes(marker))) return false;

  const statusLine = events.length > 1
    ? `Registration is open for the ${events.length} classes represented by this alert.`
    : `Registration is open for ${String(events[0]?.title || 'the represented class').trim()}.`;
  await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({
        body: `@${ASSIGNEE} **Automated recovery confirmation:** ${statusLine} Check availability now.\n\n${marker}`,
      }),
    },
    `GitHub recovery notification for issue #${issueNumber}`,
    token,
  );
  console.log(`Added bot recovery notification to manually created issue #${issueNumber}.`);
  return true;
}

async function createIssue(events, opensAt, repoFullName, token, nowMs = Date.now()) {
  const [owner, repo] = repoFullName.split('/');
  const first = events[0];
  const markers = events.map(markerFor);
  const delayMinutes = Math.max(0, Math.floor((nowMs - opensAt) / 60000));
  const isLate = nowMs - opensAt > LATE_AFTER_MS;
  const statusLine = isLate
    ? `@${ASSIGNEE} **LATE ALERT: registration opened about ${delayMinutes} minutes ago. Check availability now.**`
    : `@${ASSIGNEE} **Registration is open now.**`;

  const lines = [statusLine, ''];
  for (const event of events) {
    lines.push(`- **${String(event.title || '').trim()}** — ${formatLocalWall(event.startDatetime)} — Coach: ${coachName(event)}`);
  }
  lines.push(
    '',
    `[Open the 7070 calendar](${CALENDAR_URL})`,
    '',
    '7070 opens registration exactly 7 days before the class start time.',
    '',
    ...markers,
  );

  const basePrefix = events.length > 1
    ? `7070 registration open: ${events.length} Middle School classes`
    : `7070 registration open: ${String(first.title || '').trim()}`;
  const titlePrefix = isLate ? `LATE — ${basePrefix}` : basePrefix;

  const result = await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `${titlePrefix} — ${formatLocalWall(first.startDatetime)}`,
        body: lines.join('\n'),
        assignees: [ASSIGNEE],
      }),
    },
    'GitHub issue creation',
    token,
  );
  const issue = result.data;
  console.log(`Created registration alert issue #${issue.number} for ${events.length} event(s) opening at ${new Date(opensAt).toISOString()}`);
  return issue;
}

async function createAdvanceIssue(entries, repoFullName, token) {
  const [owner, repo] = repoFullName.split('/');
  const sorted = [...entries].sort((a, b) => a.opensAt - b.opensAt);
  const openingDate = formatInstantLocalDate(sorted[0].opensAt);
  const markers = sorted.map(({ event }) => advanceMarkerFor(event));
  const lines = [
    `@${ASSIGNEE} **Advance notice: the following registration windows are expected on ${openingDate}.**`,
    '',
  ];
  for (const { event, opensAt } of sorted) {
    lines.push(`- **Opens ${formatInstantLocal(opensAt)}** — ${String(event.title || '').trim()} — class is ${formatLocalWall(event.startDatetime)} — Coach: ${coachName(event)}`);
  }
  lines.push(
    '',
    `[Open the 7070 calendar](${CALENDAR_URL})`,
    '',
    'The live checker will create a separate confirmation when registration is due to be open.',
    '',
    ...markers,
  );

  const result = await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `UPCOMING — 7070 registration on ${openingDate}`,
        body: lines.join('\n'),
        assignees: [ASSIGNEE],
      }),
    },
    'GitHub advance-notice issue creation',
    token,
  );
  const issue = result.data;
  console.log(`Created advance registration issue #${issue.number} for ${entries.length} event(s) on ${openingDate}.`);
  return issue;
}

async function closeIssue(issueNumber, repoFullName, token) {
  const [owner, repo] = repoFullName.split('/');
  await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    },
    `Closing GitHub issue #${issueNumber}`,
    token,
  );
  console.log(`Closed completed registration issue #${issueNumber}.`);
}

async function main({
  repoFullName = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
  nowMs = Date.now(),
  feedPath = FEED_PATH,
  statePath = STATE_PATH,
} = {}) {
  if (!repoFullName || !token || !repoFullName.includes('/')) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
  }

  const feed = readRequiredJson(feedPath, 'Middle School feed');
  const events = validateFeed(feed);
  const state = readState(statePath);
  const hadLegacyFields = Object.hasOwn(state, 'lastCheckedAt') || Object.hasOwn(state, 'feedGeneratedAt');
  delete state.lastCheckedAt;
  delete state.feedGeneratedAt;

  let stateChanged = hadLegacyFields;
  let alertsCreated = 0;
  let advanceNoticesCreated = 0;
  const dueGroups = new Map();
  const futureByDate = new Map();
  const eventsByUuid = new Map(events.map(event => [event.uuid, event]));

  // An advance issue can contain a full day's windows. If one represented
  // schedule changes or disappears before opening, invalidate the whole issue
  // and rebuild a coherent daily digest from the current feed.
  const invalidAdvanceIssueNumbers = new Set();
  for (const [uuid, entry] of Object.entries(state.advanceAlerted)) {
    const current = eventsByUuid.get(uuid);
    const opensAt = Date.parse(entry?.registrationOpenedAt || '');
    const changed = current && !stateMatchesSchedule(entry, current, registrationOpenMs(current.startDatetime));
    const removedBeforeOpening = !current && Number.isFinite(opensAt) && opensAt > nowMs;
    if (!changed && !removedBeforeOpening) continue;

    if (Number.isInteger(entry?.issueNumber) && !entry.issueClosedAt) {
      invalidAdvanceIssueNumbers.add(entry.issueNumber);
    } else {
      delete state.advanceAlerted[uuid];
      stateChanged = true;
    }
  }

  for (const issueNumber of invalidAdvanceIssueNumbers) {
    await closeIssue(issueNumber, repoFullName, token);
    for (const [uuid, entry] of Object.entries(state.advanceAlerted)) {
      if (entry?.issueNumber === issueNumber) delete state.advanceAlerted[uuid];
    }
    stateChanged = true;
  }

  for (const event of events) {
    const opensAt = registrationOpenMs(event.startDatetime);
    const opensAtIso = new Date(opensAt).toISOString();
    const prior = state.alerted[event.uuid];

    if (opensAt > nowMs) {
      const dateKey = localDateKey(opensAt);
      if (!futureByDate.has(dateKey)) futureByDate.set(dateKey, []);
      futureByDate.get(dateKey).push({ event, opensAt });
    }

    if (stateMatchesSchedule(prior, event, opensAt)) {
      if (!prior.startDatetime) {
        prior.startDatetime = event.startDatetime;
        prior.title = prior.title || event.title;
        stateChanged = true;
      }
      continue;
    }

    if (opensAt > nowMs) continue;

    // On the very first run only, suppress a backlog of old openings while
    // retaining enough schedule detail to recognize a later reschedule.
    if (!state.initialized && opensAt < nowMs - INITIAL_GRACE_MS) {
      state.alerted[event.uuid] = {
        suppressedInitialBacklog: true,
        registrationOpenedAt: opensAtIso,
        title: event.title,
        startDatetime: event.startDatetime,
      };
      stateChanged = true;
      continue;
    }

    const key = String(opensAt);
    if (!dueGroups.has(key)) dueGroups.set(key, []);
    dueGroups.get(key).push(event);
  }

  const advanceGroups = new Map();
  for (const [dateKey, entries] of futureByDate) {
    const earliest = Math.min(...entries.map(entry => entry.opensAt));
    if (earliest > nowMs + ADVANCE_NOTICE_MS) continue;

    const missing = [];
    for (const entry of entries) {
      const prior = state.advanceAlerted[entry.event.uuid];
      if (stateMatchesSchedule(prior, entry.event, entry.opensAt)) {
        if (!prior.startDatetime) {
          prior.startDatetime = entry.event.startDatetime;
          prior.title = prior.title || entry.event.title;
          stateChanged = true;
        }
      } else {
        missing.push(entry);
      }
    }
    if (missing.length) advanceGroups.set(dateKey, missing);
  }

  // GitHub Issues are the second idempotency layer. If issue creation succeeds
  // but the state push fails, the marker reconstructs state on the next run.
  const existingMarkers = dueGroups.size || advanceGroups.size
    ? await fetchRecentAlertMarkers(repoFullName, token)
    : { live: new Map(), advance: new Map() };

  for (const entries of advanceGroups.values()) {
    const needsIssue = [];
    for (const entry of entries) {
      const existing = existingMarkers.advance.get(scheduleKey(entry.event));
      if (existing !== undefined) {
        state.advanceAlerted[entry.event.uuid] = {
          notifiedAt: existing.createdAt || new Date(nowMs).toISOString(),
          registrationOpenedAt: new Date(entry.opensAt).toISOString(),
          title: entry.event.title,
          startDatetime: entry.event.startDatetime,
          issueNumber: existing.issueNumber,
          recoveredFromIssue: true,
        };
        stateChanged = true;
      } else {
        needsIssue.push(entry);
      }
    }

    if (!needsIssue.length) continue;

    const issue = await createAdvanceIssue(needsIssue, repoFullName, token);
    const notifiedAt = issue.created_at || new Date(nowMs).toISOString();
    for (const { event, opensAt } of needsIssue) {
      state.advanceAlerted[event.uuid] = {
        notifiedAt,
        registrationOpenedAt: new Date(opensAt).toISOString(),
        title: event.title,
        startDatetime: event.startDatetime,
        issueNumber: issue.number,
      };
    }
    stateChanged = true;
    advanceNoticesCreated++;
  }

  for (const [opensAtText, group] of dueGroups.entries()) {
    const opensAt = Number(opensAtText);
    const opensAtIso = new Date(opensAt).toISOString();
    const needsIssue = [];
    const manualRecoveryIssues = new Map();

    for (const event of group) {
      const existing = existingMarkers.live.get(scheduleKey(event));
      if (existing !== undefined) {
        state.alerted[event.uuid] = {
          notifiedAt: existing.createdAt || new Date(nowMs).toISOString(),
          registrationOpenedAt: opensAtIso,
          title: event.title,
          startDatetime: event.startDatetime,
          issueNumber: existing.issueNumber,
          recoveredFromIssue: true,
        };
        if (
          Number.isInteger(existing.issueNumber) &&
          existing.creatorLogin &&
          existing.creatorLogin !== 'github-actions[bot]'
        ) {
          if (!manualRecoveryIssues.has(existing.issueNumber)) {
            manualRecoveryIssues.set(existing.issueNumber, []);
          }
          manualRecoveryIssues.get(existing.issueNumber).push(event);
        }
        stateChanged = true;
      } else {
        needsIssue.push(event);
      }
    }

    // Manually created catch-up issues do not reliably notify their own
    // creator. A marker-backed bot comment restores the actual notification
    // path and is idempotent if the state push is lost.
    for (const [issueNumber, recoveredEvents] of manualRecoveryIssues) {
      await ensureRecoveryNotification(issueNumber, recoveredEvents, repoFullName, token);
    }

    if (!needsIssue.length) continue;

    const issue = await createIssue(needsIssue, opensAt, repoFullName, token, nowMs);
    const notifiedAt = issue.created_at || new Date(nowMs).toISOString();
    for (const event of needsIssue) {
      state.alerted[event.uuid] = {
        notifiedAt,
        registrationOpenedAt: opensAtIso,
        title: event.title,
        startDatetime: event.startDatetime,
        issueNumber: issue.number,
      };
    }
    stateChanged = true;
    alertsCreated++;
  }

  if (!state.initialized) {
    state.initialized = true;
    stateChanged = true;
  }

  // Registration issues are actionable for one day. Close them afterward so
  // open-issue searches remain bounded without deleting the audit trail.
  const issueEntries = new Map();
  for (const [uuid, entry] of Object.entries(state.alerted)) {
    const notified = Date.parse(entry?.notifiedAt || '');
    if (
      Number.isInteger(entry?.issueNumber) &&
      !entry.issueClosedAt &&
      Number.isFinite(notified) &&
      notified < nowMs - ALERT_CLOSE_AFTER_MS
    ) {
      if (!issueEntries.has(entry.issueNumber)) issueEntries.set(entry.issueNumber, []);
      issueEntries.get(entry.issueNumber).push(uuid);
    }
  }
  for (const [issueNumber] of issueEntries) {
    await closeIssue(issueNumber, repoFullName, token);
    const closedAt = new Date(nowMs).toISOString();
    for (const entry of Object.values(state.alerted)) {
      if (entry?.issueNumber === issueNumber) entry.issueClosedAt = closedAt;
    }
    stateChanged = true;
  }

  // Keep each daily advance digest open until every represented window has a
  // live confirmation (or has been stale for a full day).
  const advanceIssueEntries = new Map();
  for (const [uuid, entry] of Object.entries(state.advanceAlerted)) {
    if (!Number.isInteger(entry?.issueNumber) || entry.issueClosedAt) continue;
    if (!advanceIssueEntries.has(entry.issueNumber)) advanceIssueEntries.set(entry.issueNumber, []);
    advanceIssueEntries.get(entry.issueNumber).push({ uuid, entry });
  }
  for (const [issueNumber, entries] of advanceIssueEntries) {
    const allConfirmedOrExpired = entries.every(({ uuid, entry }) => {
      const live = state.alerted[uuid];
      const opened = Date.parse(entry?.registrationOpenedAt || '');
      const confirmed = Boolean(
        live?.notifiedAt &&
        !live.suppressedInitialBacklog &&
        live.startDatetime === entry.startDatetime
      );
      return confirmed || (Number.isFinite(opened) && opened < nowMs - ALERT_CLOSE_AFTER_MS);
    });
    if (!allConfirmedOrExpired) continue;

    await closeIssue(issueNumber, repoFullName, token);
    const closedAt = new Date(nowMs).toISOString();
    for (const entry of Object.values(state.advanceAlerted)) {
      if (entry?.issueNumber === issueNumber) entry.issueClosedAt = closedAt;
    }
    stateChanged = true;
  }

  // Keep state bounded; the live feed only contains current/future classes.
  for (const [uuid, entry] of Object.entries(state.alerted)) {
    const opened = Date.parse(entry?.registrationOpenedAt || '');
    if (Number.isFinite(opened) && opened < nowMs - STATE_RETENTION_MS) {
      delete state.alerted[uuid];
      stateChanged = true;
    }
  }
  for (const [uuid, entry] of Object.entries(state.advanceAlerted)) {
    const opened = Date.parse(entry?.registrationOpenedAt || '');
    if (Number.isFinite(opened) && opened < nowMs - STATE_RETENTION_MS) {
      delete state.advanceAlerted[uuid];
      stateChanged = true;
    }
  }

  if (stateChanged) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    console.log('Alert state changed and was written to disk.');
  } else {
    console.log('No new advance or live registration windows; alert state unchanged.');
  }

  console.log(`Registration alert check complete; ${advanceNoticesCreated} advance digest(s), ${alertsCreated} live alert issue(s).`);
  return { advanceNoticesCreated, alertsCreated, stateChanged };
}

async function watchMain({
  repoFullName = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
  feedPath = FEED_PATH,
  statePath = STATE_PATH,
  nowFn = Date.now,
  sleepFn = sleep,
  dispatchFn = dispatchSuccessor,
  watchHorizonMs = WATCH_HORIZON_MS,
  guardLeadMs = guardLeadMsFromHours(),
  successorRetryMs = SUCCESSOR_RETRY_MS,
} = {}) {
  if (!Number.isFinite(watchHorizonMs) || watchHorizonMs <= 0) {
    throw new Error('Watch horizon must be a positive number of milliseconds.');
  }
  if (!Number.isFinite(guardLeadMs) || guardLeadMs < watchHorizonMs) {
    throw new Error('Guard lead must be finite and at least as long as the watch horizon.');
  }
  if (!Number.isFinite(successorRetryMs) || successorRetryMs <= 0) {
    throw new Error('Successor retry interval must be a positive number of milliseconds.');
  }

  const startedAt = nowFn();
  const watchThrough = startedAt + watchHorizonMs;
  let checkedThrough = startedAt;
  const totals = {
    advanceNoticesCreated: 0,
    alertsCreated: 0,
    stateChanged: false,
  };
  let successorDispatched = false;
  let guardActivated = false;

  const mergeResult = result => {
    totals.advanceNoticesCreated += result.advanceNoticesCreated;
    totals.alertsCreated += result.alertsCreated;
    totals.stateChanged = totals.stateChanged || result.stateChanged;
  };

  mergeResult(await main({ repoFullName, token, nowMs: startedAt, feedPath, statePath }));

  while (true) {
    const nowMs = nowFn();
    if (nowMs >= watchThrough) break;

    const feed = readRequiredJson(feedPath, 'Middle School feed');
    const events = validateFeed(feed);
    const [guardOpening] = openingTimesWithin(events, checkedThrough, nowMs + guardLeadMs);
    if (guardOpening === undefined) break;
    guardActivated = true;

    if (!successorDispatched) {
      try {
        await dispatchFn(
          repoFullName,
          token,
          process.env.GITHUB_REF_NAME || 'main',
          String(guardLeadMs / (60 * 60 * 1000)),
        );
        successorDispatched = true;
      } catch (err) {
        // Keep the already-running guard alive and retry during transient
        // Actions/API incidents instead of silently losing the chain.
        console.warn(`Could not queue a successor watcher; will retry: ${err.message}`);
      }
    }

    const [nextOpening] = openingTimesWithin(events, checkedThrough, watchThrough);
    const openingWaitMs = nextOpening === undefined
      ? watchThrough - nowMs
      : Math.max(0, nextOpening - nowMs) + WATCH_WAKE_SLOP_MS;
    const waitMs = successorDispatched
      ? openingWaitMs
      : Math.min(openingWaitMs, successorRetryMs);

    if (nextOpening === undefined) {
      console.log(
        `Registration guard active for ${formatInstantLocal(guardOpening)}; ` +
        `holding this runner for ${Math.ceil(waitMs / 60000)} minute(s).`,
      );
    } else {
      console.log(
        `Watcher armed for ${formatInstantLocal(nextOpening)}; waiting ${Math.ceil(waitMs / 60000)} minute(s).`,
      );
    }
    await sleepFn(waitMs);

    if (nextOpening !== undefined && nowFn() >= nextOpening) {
      const checkNow = nowFn();
      mergeResult(await main({ repoFullName, token, nowMs: checkNow, feedPath, statePath }));
      // If a timer wakes early, leave the opening eligible for another pass.
      checkedThrough = Math.max(checkedThrough, checkNow);
    }
  }

  if (guardActivated && !successorDispatched) {
    throw new Error('Registration guard ended without a queued successor watcher.');
  }

  console.log(
    `Registration watch complete through ${new Date(watchThrough).toISOString()}; ` +
    `${totals.advanceNoticesCreated} advance digest(s), ${totals.alertsCreated} live alert issue(s).`,
  );
  return totals;
}

if (require.main === module) {
  const command = process.argv.includes('--watch') ? watchMain : main;
  command().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  ALERT_CLOSE_AFTER_MS,
  ADVANCE_NOTICE_MS,
  INITIAL_GRACE_MS,
  LATE_AFTER_MS,
  SUCCESSOR_RETRY_MS,
  WATCH_GUARD_LEAD_MS,
  WATCH_HORIZON_MS,
  advanceMarkerFor,
  closeIssue,
  createAdvanceIssue,
  createIssue,
  dispatchSuccessor,
  ensureRecoveryNotification,
  fetchRecentAlertMarkers,
  guardLeadMsFromHours,
  main,
  markerFor,
  openingTimesWithin,
  readState,
  stateMatchesSchedule,
  validateFeed,
  watchMain,
};
