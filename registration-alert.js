const fs = require('fs');
const path = require('path');

const TIME_ZONE = 'America/Denver';
const CALENDAR_URL = 'https://7070athletics.pushpress.com/landing/calendar?framed=1';
const FEED_PATH = path.join(__dirname, 'data', 'middle-school.json');
const STATE_PATH = path.join(__dirname, 'data', 'registration-alerted.json');
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const ASSIGNEE = 'akruther-ai';
const INITIAL_GRACE_MS = 20 * 60 * 1000;
const STATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

if (!REPO || !TOKEN) {
  throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
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

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { initialized: false, alerted: {} };
  const state = readRequiredJson(STATE_PATH, 'Alert state');
  if (!state || typeof state !== 'object') throw new Error('Alert state must be a JSON object.');
  state.alerted = state.alerted && typeof state.alerted === 'object' ? state.alerted : {};
  state.initialized = Boolean(state.initialized);
  return state;
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

function scheduleKey(event) {
  return `${event.uuid}|${event.startDatetime}`;
}

function markerFor(event) {
  return `<!-- 7070-event:${scheduleKey(event)} -->`;
}

function stateMatchesSchedule(entry, event, opensAt) {
  if (!entry) return false;
  if (entry.startDatetime) return entry.startDatetime === event.startDatetime;
  // Migration support for state written before startDatetime was persisted.
  return entry.registrationOpenedAt === new Date(opensAt).toISOString();
}

async function fetchRecentAlertMarkers() {
  const [owner, repo] = REPO.split('/');
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${TOKEN}`,
        'x-github-api-version': '2022-11-28',
      },
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub issue lookup failed (${response.status}): ${await response.text()}`);
  }

  const issues = await response.json();
  const found = new Map();
  const markerPattern = /<!-- 7070-event:([^|>]+\|[^>]+) -->/g;
  for (const issue of issues) {
    const body = String(issue.body || '');
    for (const match of body.matchAll(markerPattern)) {
      if (!found.has(match[1])) found.set(match[1], issue.created_at || null);
    }
  }
  return found;
}

async function createIssue(events, opensAt) {
  const [owner, repo] = REPO.split('/');
  const first = events[0];
  const markers = events.map(markerFor);
  const delayMinutes = Math.max(0, Math.floor((Date.now() - opensAt) / 60000));
  const isLate = delayMinutes > 15;
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

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
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
  return issue;
}

(async () => {
  const feed = readRequiredJson(FEED_PATH, 'Middle School feed');
  if (!feed || !Array.isArray(feed.items)) {
    throw new Error('data/middle-school.json is missing a valid items array.');
  }

  const state = readState();
  const now = Date.now();
  let stateChanged = false;
  let alertsCreated = 0;

  const events = feed.items
    .filter(e => e && e.uuid && e.startDatetime)
    .sort((a, b) => String(a.startDatetime).localeCompare(String(b.startDatetime)));

  const dueGroups = new Map();

  for (const event of events) {
    const opensAt = registrationOpenMs(event.startDatetime);
    const opensAtIso = new Date(opensAt).toISOString();
    const prior = state.alerted[event.uuid];

    if (stateMatchesSchedule(prior, event, opensAt)) {
      // Migrate older state entries so future reschedules can be distinguished.
      if (!prior.startDatetime) {
        prior.startDatetime = event.startDatetime;
        prior.title = prior.title || event.title;
        stateChanged = true;
      }
      continue;
    }

    if (opensAt > now) continue;

    // On the very first run only, suppress a backlog of old openings while
    // retaining enough schedule detail to recognize a later reschedule.
    if (!state.initialized && opensAt < now - INITIAL_GRACE_MS) {
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

  // GitHub Issues are the second idempotency layer. If an issue was created but
  // the state-file commit/push failed, the marker prevents a duplicate alert on
  // the next run and lets us reconstruct the missing state.
  const existingMarkers = dueGroups.size ? await fetchRecentAlertMarkers() : new Map();

  for (const [opensAtText, group] of dueGroups.entries()) {
    const opensAt = Number(opensAtText);
    const opensAtIso = new Date(opensAt).toISOString();
    const needsIssue = [];

    for (const event of group) {
      const existingCreatedAt = existingMarkers.get(scheduleKey(event));
      if (existingCreatedAt !== undefined) {
        state.alerted[event.uuid] = {
          notifiedAt: existingCreatedAt || new Date().toISOString(),
          registrationOpenedAt: opensAtIso,
          title: event.title,
          startDatetime: event.startDatetime,
          recoveredFromIssue: true,
        };
        stateChanged = true;
      } else {
        needsIssue.push(event);
      }
    }

    if (!needsIssue.length) continue;

    const issue = await createIssue(needsIssue, opensAt);
    const notifiedAt = issue.created_at || new Date().toISOString();
    for (const event of needsIssue) {
      state.alerted[event.uuid] = {
        notifiedAt,
        registrationOpenedAt: opensAtIso,
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

  // Keep the state file bounded over the long term. UUIDs older than 90 days
  // no longer matter because the feed only contains current/future classes.
  for (const [uuid, entry] of Object.entries(state.alerted)) {
    const opened = Date.parse(entry?.registrationOpenedAt || '');
    if (Number.isFinite(opened) && opened < now - STATE_RETENTION_MS) {
      delete state.alerted[uuid];
      stateChanged = true;
    }
  }

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
