const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CALENDAR_URL = 'https://7070athletics.pushpress.com/landing/calendar?framed=1';
const API_URL = 'https://api.pushpress.com/v2/graph/graphql';
const CLIENT_UUID = 'client_d818ab91eb63fd';
const TIME_ZONE = 'America/Denver';

const QUERY = `
query GetPublicCalendarItems($getCalendarItemsInput: GetCalendarItemsInput!) {
  getPublicCalendarItems(getCalendarItemsInput: $getCalendarItemsInput) {
    uuid
    title
    type
    isAllDay
    startDatetime
    endDatetime
    calendarItemType {
      uuid
      name
      color
      __typename
    }
    location {
      uuid
      __typename
    }
    mainCoach {
      userUuid
      firstName
      lastName
      __typename
    }
    assistantCoach {
      userUuid
      __typename
    }
    __typename
  }
}
`;

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

async function fetchRange(page, token, startDate, endDate) {
  return page.evaluate(async ({ API_URL, token, CLIENT_UUID, QUERY, startDate, endDate }) => {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'content-type': 'application/json',
        'authorization': token,
      },
      body: JSON.stringify({
        operationName: 'GetPublicCalendarItems',
        variables: {
          getCalendarItemsInput: {
            startDate,
            endDate,
            clientUuid: CLIENT_UUID,
            isPublicOnly: true,
          },
        },
        query: QUERY,
      }),
    });

    const json = await response.json();
    return { status: response.status, json };
  }, { API_URL, token, CLIENT_UUID, QUERY, startDate, endDate });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: TIME_ZONE,
  });
  const page = await context.newPage();

  try {
    await page.goto(CALENDAR_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const cookies = await context.cookies('https://7070athletics.pushpress.com');
    const publicToken = cookies.find(c => c.name === 'PUBLIC_TOKEN')?.value;
    if (!publicToken) {
      throw new Error('PushPress PUBLIC_TOKEN cookie was not issued to the browser.');
    }

    const now = new Date();
    const ranges = [];
    for (let offset = 0; offset < 63; offset += 7) {
      ranges.push({
        startDate: localDateParts(addDays(now, offset)),
        endDate: localDateParts(addDays(now, offset + 6)),
      });
    }

    const all = [];
    for (const range of ranges) {
      const result = await fetchRange(page, publicToken, range.startDate, range.endDate);
      if (result.status !== 200 || result.json.errors) {
        throw new Error(`PushPress calendar query failed for ${range.startDate}..${range.endDate}: ${JSON.stringify(result.json.errors || result.json)}`);
      }
      const items = result.json?.data?.getPublicCalendarItems || [];
      all.push(...items);
    }

    const deduped = Array.from(new Map(all.map(item => [item.uuid, item])).values())
      .sort((a, b) => String(a.startDatetime).localeCompare(String(b.startDatetime)));

    const middleSchool = deduped.filter(item =>
      String(item.title || '').toLowerCase().includes('middle school')
    );

    const generatedAt = new Date().toISOString();
    const dateRange = {
      startDate: ranges[0].startDate,
      endDate: ranges[ranges.length - 1].endDate,
    };

    const dataDir = path.join(__dirname, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(path.join(dataDir, 'calendar.json'), JSON.stringify({
      source: CALENDAR_URL,
      generatedAt,
      timeZone: TIME_ZONE,
      dateRange,
      count: deduped.length,
      items: deduped,
    }, null, 2) + '\n');

    fs.writeFileSync(path.join(dataDir, 'middle-school.json'), JSON.stringify({
      source: CALENDAR_URL,
      generatedAt,
      timeZone: TIME_ZONE,
      dateRange,
      filter: 'title contains "middle school" (case-insensitive)',
      count: middleSchool.length,
      items: middleSchool,
    }, null, 2) + '\n');

    console.log(`Captured ${deduped.length} total events; ${middleSchool.length} Middle School events.`);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
