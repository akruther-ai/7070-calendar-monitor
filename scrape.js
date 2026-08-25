const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CALENDAR_URL = 'https://7070athletics.pushpress.com/landing/calendar?framed=1';
const API_URL = 'https://api.pushpress.com/v2/graph/graphql';
const TIME_ZONE = 'America/Denver';
const TARGET_DAYS_AHEAD = 21;
const MAX_PAGE_TURNS = 8;

function localDateParts(date, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addCalendarDays(ymd, days) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid calendar date: ${ymd}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

function calendarInputFromRequest(request) {
  try {
    if (request.method() !== 'POST' || request.url() !== API_URL) return null;
    const body = request.postDataJSON();
    if (body?.operationName !== 'GetPublicCalendarItems') return null;
    return body.variables?.getCalendarItemsInput || null;
  } catch {
    return null;
  }
}

function isCalendarResponse(response) {
  return Boolean(calendarInputFromRequest(response.request()));
}

async function captureCalendarResponse(response) {
  const input = calendarInputFromRequest(response.request());
  if (!input) throw new Error('Received a non-calendar response unexpectedly.');

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new Error(`Could not parse PushPress calendar response: ${err.message}`);
  }

  const items = json?.data?.getPublicCalendarItems;
  if (!Array.isArray(items)) {
    const apiErrors = Array.isArray(json?.errors)
      ? json.errors.map(e => e?.message).filter(Boolean).join('; ')
      : '';
    throw new Error(`PushPress calendar response did not contain an items array${apiErrors ? `: ${apiErrors}` : ''}.`);
  }

  console.log(`Captured ${input.startDate}..${input.endDate}: ${items.length} events`);
  return { startDate: input.startDate, endDate: input.endDate, items };
}

function middleSchoolMatch(item) {
  const searchable = [item?.title, item?.calendarItemType?.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return searchable.includes('middle school');
}

(async () => {
  // GitHub's ubuntu-24.04 runner includes Google Chrome. Using Playwright's
  // supported Chrome channel avoids downloading a separate browser image on
  // every scheduled run while preserving full Playwright browser automation.
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: TIME_ZONE,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();

  try {
    const today = localDateParts(new Date());
    const targetEnd = addCalendarDays(today, TARGET_DAYS_AHEAD);
    const captured = [];

    // Start waiting before navigation so the initial calendar API response
    // cannot race past the listener. This replaces the old fixed 5-second wait.
    const initialResponsePromise = page.waitForResponse(isCalendarResponse, { timeout: 30000 });
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    captured.push(await captureCalendarResponse(await initialResponsePromise));

    let nextButton = page.locator('button.fc-next-button').first();
    if (!(await nextButton.count())) {
      nextButton = page.locator('button[title*="next" i], button[aria-label*="next" i]').first();
    }
    if (!(await nextButton.count())) {
      const iconButtons = page.locator('button[class*="IconButton-module__icon-button"]');
      if ((await iconButtons.count()) >= 2) {
        // PushPress currently renders: Today, previous-arrow, next-arrow, Filter.
        nextButton = iconButtons.nth(1);
      }
    }

    if (!(await nextButton.count())) {
      const buttons = await page.locator('button').evaluateAll(btns =>
        btns.map(b => ({
          text: b.innerText,
          title: b.title,
          aria: b.getAttribute('aria-label'),
          className: b.className,
        }))
      );
      throw new Error(`Could not locate calendar Next button. Buttons: ${JSON.stringify(buttons)}`);
    }

    const maxCapturedEnd = () => captured.reduce(
      (max, c) => c.endDate > max ? c.endDate : max,
      ''
    );

    for (let turn = 0; turn < MAX_PAGE_TURNS && maxCapturedEnd() < targetEnd; turn++) {
      const responsePromise = page.waitForResponse(isCalendarResponse, { timeout: 15000 });
      await nextButton.click();
      captured.push(await captureCalendarResponse(await responsePromise));
    }

    if (!captured.length) {
      throw new Error('The PushPress page did not return any GetPublicCalendarItems responses.');
    }
    if (maxCapturedEnd() < targetEnd) {
      throw new Error(
        `Calendar coverage is incomplete: captured through ${maxCapturedEnd()}, expected at least ${targetEnd}. Refusing to overwrite the last good feed.`
      );
    }

    const all = captured.flatMap(c => c.items);
    const malformed = all.filter(item => !item?.uuid || !item?.startDatetime);
    if (malformed.length) {
      throw new Error(`Calendar scrape contained ${malformed.length} item(s) without uuid/startDatetime; refusing to publish ambiguous data.`);
    }

    // UUID is expected to identify one calendar occurrence. Detect a backend
    // behavior change rather than silently collapsing two differently timed
    // classes into one record.
    const seenUuidStart = new Map();
    for (const item of all) {
      const priorStart = seenUuidStart.get(item.uuid);
      if (priorStart && priorStart !== item.startDatetime) {
        throw new Error(`PushPress reused UUID ${item.uuid} for different start times (${priorStart} vs ${item.startDatetime}).`);
      }
      seenUuidStart.set(item.uuid, item.startDatetime);
    }

    const deduped = Array.from(new Map(all.map(item => [item.uuid, item])).values())
      .sort((a, b) => String(a.startDatetime).localeCompare(String(b.startDatetime)));

    if (deduped.length < 20) {
      throw new Error(`Calendar scrape returned only ${deduped.length} unique events; refusing to publish suspiciously sparse data.`);
    }

    // Registration monitoring only needs current/future Middle School classes.
    // Matching the calendar-item type as well as the title protects against a
    // future class whose display title omits the literal words “Middle School.”
    const middleSchool = deduped.filter(item => {
      const startDate = String(item.startDatetime).slice(0, 10);
      return startDate >= today && middleSchoolMatch(item);
    });

    if (!middleSchool.length) {
      throw new Error('No current/future Middle School classes were found; refusing to overwrite the last good feed.');
    }

    const dateRange = {
      startDate: captured.reduce((min, c) => !min || c.startDate < min ? c.startDate : min, ''),
      endDate: captured.reduce((max, c) => c.endDate > max ? c.endDate : max, ''),
    };

    const dataDir = path.join(__dirname, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(path.join(dataDir, 'calendar.json'), JSON.stringify({
      source: CALENDAR_URL,
      timeZone: TIME_ZONE,
      requestedFrom: today,
      targetThrough: targetEnd,
      dateRange,
      count: deduped.length,
      items: deduped,
    }, null, 2) + '\n');

    fs.writeFileSync(path.join(dataDir, 'middle-school.json'), JSON.stringify({
      source: CALENDAR_URL,
      timeZone: TIME_ZONE,
      requestedFrom: today,
      targetThrough: targetEnd,
      dateRange,
      filter: 'current/future item where title or calendarItemType.name contains "middle school" (case-insensitive)',
      count: middleSchool.length,
      items: middleSchool,
    }, null, 2) + '\n');

    console.log(`Done: ${deduped.length} total events; ${middleSchool.length} current/future Middle School events; through ${dateRange.endDate}.`);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
