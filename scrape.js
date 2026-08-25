const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CALENDAR_URL = 'https://7070athletics.pushpress.com/landing/calendar?framed=1';
const API_URL = 'https://api.pushpress.com/v2/graph/graphql';
const TIME_ZONE = 'America/Denver';

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

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: TIME_ZONE,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();

  const captured = [];

  page.on('response', async response => {
    const input = calendarInputFromRequest(response.request());
    if (!input) return;
    try {
      const json = await response.json();
      const items = json?.data?.getPublicCalendarItems;
      if (Array.isArray(items)) {
        captured.push({ startDate: input.startDate, endDate: input.endDate, items });
        console.log(`Captured ${input.startDate}..${input.endDate}: ${items.length} events`);
      }
    } catch (err) {
      console.warn('Could not parse calendar response:', err.message);
    }
  });

  try {
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const today = localDateParts(new Date());
    const targetEnd = localDateParts(addDays(new Date(), 62));

    let nextButton = page.locator('button.fc-next-button').first();
    if (!(await nextButton.count())) {
      nextButton = page.locator('button[title*="next" i], button[aria-label*="next" i]').first();
    }
    if (!(await nextButton.count())) {
      const iconButtons = page.locator('button[class*="IconButton-module__icon-button"]');
      if ((await iconButtons.count()) >= 2) {
        // PushPress renders: Today, previous-arrow, next-arrow, Filter.
        nextButton = iconButtons.nth(1);
      }
    }

    if (!(await nextButton.count())) {
      const buttons = await page.locator('button').evaluateAll(btns =>
        btns.map(b => ({ text: b.innerText, title: b.title, aria: b.getAttribute('aria-label'), className: b.className }))
      );
      throw new Error(`Could not locate calendar Next button. Buttons: ${JSON.stringify(buttons)}`);
    }

    const maxCapturedEnd = () => captured.reduce((max, c) => c.endDate > max ? c.endDate : max, '');

    for (let i = 0; i < 70 && maxCapturedEnd() < targetEnd; i++) {
      const responsePromise = page.waitForResponse(
        resp => !!calendarInputFromRequest(resp.request()),
        { timeout: 10000 }
      ).catch(() => null);

      await nextButton.click();
      await responsePromise;
      await page.waitForTimeout(250);
    }

    if (!captured.length) {
      throw new Error('The PushPress page did not return any GetPublicCalendarItems responses.');
    }

    const all = captured.flatMap(c => c.items);
    const deduped = Array.from(new Map(all.map(item => [item.uuid, item])).values())
      .sort((a, b) => String(a.startDatetime).localeCompare(String(b.startDatetime)));

    const middleSchool = deduped.filter(item =>
      String(item.title || '').toLowerCase().includes('middle school')
    );

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
      filter: 'title contains "middle school" (case-insensitive)',
      count: middleSchool.length,
      items: middleSchool,
    }, null, 2) + '\n');

    console.log(`Done: ${deduped.length} total events; ${middleSchool.length} Middle School events; through ${dateRange.endDate}.`);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
