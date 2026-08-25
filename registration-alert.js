const fs = require('fs');
const path = require('path');

const TIME_ZONE = 'America/Denver';
const FEED_PATH = path.join(__dirname, 'data', 'middle-school.json');
const STATE_PATH = path.join(__dirname, 'data', 'registration-alerted.json');
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const ASSIGNEE = 'akruther-ai';

if (!REPO || !TOKEN) {
  throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseWallClock(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Unrecognized startDatetime: ${iso}`);
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]),
  };
}

function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second)
  );
  return asUtc - utcMs;
}

function zonedWallToUtcMs(parts, timeZone) {
  const wallAsUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second
  );
  let guess = wallAsUtc;
  for (let i = 0; i < 3; i++) {
    guess = wallAsUtc - tzOffsetMs(guess, timeZone);
  }
  return guess;
}

function registrationOpenMs(startDatetime) {
  // PushPress encodes the local class wall-clock time with a trailing Z.
  // Treat the date/time fields as America/Denver local time, subtract seven
  // calendar days at the same local clock time, then convert that wall time
  // to a real instant for comparison with the current time.
  const c = parseWallClock(startDatetime);
  const shifted = new Date(Date.UTC(
    c.year, c.month - 1, c.day - 7,
    c.hour, c.minute, c.second
  ));
  return zonedWallToUtcMs({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }, TIME_ZONE);
}

function formatLocalWall(iso) {
  const c = parseWallClock(iso);
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second));
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC'
  }).format(d);
  return `${date} at ${time} MT`;
}

function coachName(event) {
  return event.mainCoach
    ? `${event.mainCoach.firstName || ''} ${event.mainCoach.lastName || ''}`.trim() || 'Not listed'
    : 'Not listed';
}

async function createIssue(events, opensAt) {
  const [owner, repo] = REPO.split('/');
  const first = events[0];
  const markers = events.map(e => `<!-- 7070-event:${e.uuid} -->`);
  const lines = [
    `@${ASSIGNEE} **Registration is open now.**`,
    '',
  ];

  for (const event of events) {
    lines.push(`- **${String(event.title || '').trim()}** — ${formatLocalWall(event.startDatetime)} — Coach: ${coachName(event)}`);
  }

  lines.push(
    '',
    '7070 opens registration exactly 7 days before the class start time.',
    '',
    ...markers,
  );

  const titlePrefix = events.length > 1
    ? `7070 registration open: ${events.length} Middle School classes`
    : `7070 registration open: ${String(first.title || '').trim()}`;

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      'accept': 'application/vnd.github+json',
      'authorization': `Bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: `${titlePrefix} — ${formatLocalWall(first.startDatetime)}`,
      body: lines.join('\n'),
      assignees: [ASSIGNEE],
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub issue creation failed (${response.status}): ${await response.text()}`);
  }

  const issue = await response.json();
  console.log(`Created registration alert issue #${issue.number} for ${events.length} event(s) opening at ${new Date(opensAt).toISOString()}`);
}

(async () => {
  const feed = readJson(FEED_PATH, null);
  if (!feed || !Array.isArray(feed.items)) {
    throw new Error('data/middle-school.json is missing or invalid.');
  }

  const state = readJson(STATE_PATH, { initialized: false, alerted: {} });
  state.alerted = state.alerted || {};

  const now = Date.now();
  const initialGraceMs = 20 * 60 * 1000;
  let stateChanged = false;
  let alertsCreated = 0;

  const events = feed.items
    .filter(e => e && e.uuid && e.startDatetime)
    .sort((a, b) => String(a.startDatetime).localeCompare(String(b.startDatetime)));

  const dueGroups = new Map();

  for (const event of events) {
    if (state.alerted[event.uuid]) continue;

    const opensAt = registrationOpenMs(event.startDatetime);
    if (opensAt > now) continue;

    // On the very first run, suppress a backlog of old openings. We still alert
    // for anything that opened within the last 20 minutes.
    if (!state.initialized && opensAt < now - initialGraceMs) {
      state.alerted[event.uuid] = {
        suppressedInitialBacklog: true,
        registrationOpenedAt: new Date(opensAt).toISOString(),
      };
      stateChanged = true;
      continue;
    }

    const key = String(opensAt);
    if (!dueGroups.has(key)) dueGroups.set(key, []);
    dueGroups.get(key).push(event);
  }

  for (const [opensAtText, group] of dueGroups.entries()) {
    const opensAt = Number(opensAtText);
    await createIssue(group, opensAt);
    const notifiedAt = new Date().toISOString();
    for (const event of group) {
      state.alerted[event.uuid] = {
        notifiedAt,
        registrationOpenedAt: new Date(opensAt).toISOString(),
        title: event.title,
        startDatetime: event.startDatetime,
      };
    }
    stateChanged = true;
    alertsCreated++;
  }

  if (!state.initialized) {
    state.initialized = true;
    stateChanged = true;
  }

  // Persist state only when something meaningful changed. This avoids creating
  // a Git commit every five minutes just to update a last-checked timestamp.
  if (stateChanged) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
    console.log('Alert state changed and was written to disk.');
  } else {
    console.log('No newly opened registration windows; alert state unchanged.');
  }

  console.log(`Registration alert check complete; ${alertsCreated} new alert issue(s).`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
