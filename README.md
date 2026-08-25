# 7070 Calendar Monitor

Automatically captures the public 7070 Athletics PushPress calendar with a real Chromium browser and refreshes it every hour with GitHub Actions.

## Live data

- Full calendar: `data/calendar.json`
- Middle School only: `data/middle-school.json`

Raw URLs:

- `https://raw.githubusercontent.com/akruther-ai/7070-calendar-monitor/main/data/calendar.json`
- `https://raw.githubusercontent.com/akruther-ai/7070-calendar-monitor/main/data/middle-school.json`

The Middle School feed includes any event whose title contains `Middle School` (case-insensitive), including items such as Middle School Skills, IPT Middle School, Upper Middle School Skills, and Shot Doctor - Middle School.

## How it works

The workflow launches Playwright/Chromium, opens the public 7070 PushPress calendar, and captures the calendar application's own successful `GetPublicCalendarItems` network responses. It does not store a PushPress login, private credentials, or authorization token.

The workflow runs hourly and commits new JSON only when the captured output changes.
