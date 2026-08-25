'use strict';

const fs = require('fs');
const path = require('path');
const { parseWallClock } = require('./lib/registration-time');

const CALENDAR_URL = 'https://7070athletics.pushpress.com/landing/calendar?framed=1';
const API_URL = 'https://api.pushpress.com/v2/graph/graphql';
const TIME_ZONE = 'America/Denver';
const TARGET_DAYS_AHEAD = 21;
const MAX_PAGE_TURNS = 8;
const MIN_TOTAL_EVENTS = 20;
const MIN_MIDDLE_SCHOOL_EVENTS = 1;
const MIN_BASELINE_RATIO = 0.5;

function localDateParts(date, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function calendarDateMs(ymd) {
  const match = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid calendar date: ${ymd}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${ymd}`);
  }
  return date.getTime();
}

function addCalendarDays(ymd, days) {
  if (!Number.isInteger(days)) throw new Error(`Calendar-day offset must be an integer: ${days}`);
  const shifted = new Date(calendarDateMs(ymd));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
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
      ? json.errors.map(error => error?.message).filter(Boolean).join('; ')
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

function validateCapturedCoverage(captured, today, targetEnd) {
  calendarDateMs(today);
  calendarDateMs(targetEnd);
  if (!Array.isArray(captured) || !captured.length) {
    throw new Error('The PushPress page did not return any GetPublicCalendarItems responses.');
  }

  let maxEnd = '';
  let minStart = '';
  for (const [index, capture] of captured.entries()) {
    const startDate = capture?.startDate;
    const endDate = capture?.endDate;
    calendarDateMs(startDate);
    calendarDateMs(endDate);
    if (startDate > endDate) {
      throw new Error(`Calendar response ${index + 1} has an inverted range: ${startDate}..${endDate}.`);
    }
    if (!Array.isArray(capture.items) || !capture.items.length) {
      throw new Error(`Calendar response ${startDate}..${endDate} contained no events; refusing to publish incomplete data.`);
    }

    if (index === 0 && (startDate > today || endDate < today)) {
      throw new Error(`Initial calendar response ${startDate}..${endDate} does not cover today (${today}).`);
    }
    if (index > 0) {
      const nextAllowedStart = addCalendarDays(maxEnd, 1);
      if (startDate > nextAllowedStart) {
        throw new Error(`Calendar coverage has a gap after ${maxEnd}; next response starts ${startDate}.`);
      }
      if (endDate <= maxEnd) {
        throw new Error(`Calendar navigation did not advance beyond ${maxEnd}; received ${startDate}..${endDate}.`);
      }
    }

    minStart = !minStart || startDate < minStart ? startDate : minStart;
    maxEnd = endDate > maxEnd ? endDate : maxEnd;
  }

  if (maxEnd < targetEnd) {
    throw new Error(`Calendar coverage is incomplete: captured through ${maxEnd}, expected at least ${targetEnd}. Refusing to overwrite the last good feed.`);
  }
  return { startDate: minStart, endDate: maxEnd };
}

function readPreviousItemCount(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.items) ? parsed.items.length : null;
  } catch (err) {
    console.warn(`Could not read prior baseline ${file}: ${err.message}`);
    return null;
  }
}

function validatePopulation(label, nextCount, previousCount, minimum) {
  const baselineMinimum = Number.isInteger(previousCount)
    ? Math.floor(previousCount * MIN_BASELINE_RATIO)
    : 0;
  const required = Math.max(minimum, baselineMinimum);
  if (nextCount < required) {
    const comparison = Number.isInteger(previousCount) ? `; previous feed contained ${previousCount}` : '';
    throw new Error(`${label} scrape returned only ${nextCount} event(s), below safety threshold ${required}${comparison}. Refusing to overwrite the last good feed.`);
  }
}

async function main({ now = new Date() } = {}) {
  // GitHub's ubuntu-24.04 runner includes Google Chrome. Using Playwright's
  // supported Chrome channel avoids downloading a separate browser image.
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: TIME_ZONE,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();

  try {
    const today = localDateParts(now);
    const targetEnd = addCalendarDays(today, TARGET_DAYS_AHEAD);
    const captured = [];

    // Start waiting before navigation so the initial API response cannot race
    // past the listener.
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
      const buttons = await page.locator('button').evaluateAll(buttons =>
        buttons.map(button => ({
          text: button.innerText,
          title: button.title,
          aria: button.getAttribute('aria-label'),
          className: button.className,
        }))
      );
      throw new Error(`Could not locate calendar Next button. Buttons: ${JSON.stringify(buttons)}`);
    }

    const maxCapturedEnd = () => captured.reduce(
      (max, capture) => capture.endDate > max ? capture.endDate : max,
      ''
    );

    for (let turn = 0; turn < MAX_PAGE_TURNS && maxCapturedEnd() < targetEnd; turn++) {
      const responsePromise = page.waitForResponse(isCalendarResponse, { timeout: 15000 });
      await nextButton.click();
      captured.push(await captureCalendarResponse(await responsePromise));
    }

    const dateRange = validateCapturedCoverage(captured, today, targetEnd);
    const all = captured.flatMap(capture => capture.items);
    const malformed = all.filter(item => !item?.uuid || !item?.startDatetime);
    if (malformed.length) {
      throw new Error(`Calendar scrape contained ${malformed.length} item(s) without uuid/startDatetime; refusing to publish ambiguous data.`);
    }
    for (const item of all) parseWallClock(item.startDatetime);

    // UUID is expected to identify one calendar occurrence. Detect a backend
    // behavior change rather than silently collapsing differently timed items.
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

    // Registration monitoring only needs current/future Middle School classes.
    const middleSchool = deduped.filter(item => {
      const startDate = String(item.startDatetime).slice(0, 10);
      return startDate >= today && middleSchoolMatch(item);
    });

    const dataDir = path.join(__dirname, 'data');
    const calendarPath = path.join(dataDir, 'calendar.json');
    const middleSchoolPath = path.join(dataDir, 'middle-school.json');
    validatePopulation(
      'Calendar',
      deduped.length,
      readPreviousItemCount(calendarPath),
      MIN_TOTAL_EVENTS,
    );
    validatePopulation(
      'Middle School',
      middleSchool.length,
      readPreviousItemCount(middleSchoolPath),
      MIN_MIDDLE_SCHOOL_EVENTS,
    );

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(calendarPath, JSON.stringify({
      source: CALENDAR_URL,
      timeZone: TIME_ZONE,
      requestedFrom: today,
      targetThrough: targetEnd,
      dateRange,
      count: deduped.length,
      items: deduped,
    }, null, 2) + '\n');

    fs.writeFileSync(middleSchoolPath, JSON.stringify({
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
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  addCalendarDays,
  calendarDateMs,
  localDateParts,
  main,
  middleSchoolMatch,
  validateCapturedCoverage,
  validatePopulation,
};
