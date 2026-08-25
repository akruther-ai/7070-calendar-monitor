# 7070 Calendar Monitor

Automatically captures the public 7070 Athletics PushPress calendar with a real Chromium browser and monitors Middle School registration openings with GitHub Actions.

## Live data

- Full calendar: `data/calendar.json`
- Middle School only: `data/middle-school.json`

Raw URLs:

- `https://raw.githubusercontent.com/akruther-ai/7070-calendar-monitor/main/data/calendar.json`
- `https://raw.githubusercontent.com/akruther-ai/7070-calendar-monitor/main/data/middle-school.json`

The Middle School feed includes any event whose title contains `Middle School` (case-insensitive), including items such as Middle School Skills, IPT Middle School, Upper Middle School Skills, and Shot Doctor - Middle School.

## How it works

- The live PushPress calendar is refreshed every 15 minutes with Playwright/Chromium.
- The lightweight registration checker runs every 5 minutes and also runs immediately whenever `data/middle-school.json` changes.
- Registration opening is calculated as exactly 7 calendar days before each class at the same America/Denver wall-clock time.
- When registration opens, GitHub Actions creates an issue assigned to and @mentioning `akruther-ai`, which drives GitHub Mobile push notifications.
- Classes that open at the same instant are grouped into one issue.
- Alert state is persisted only when an opening is actually processed, avoiding noisy 5-minute commits.

The scraper captures the public calendar application's successful `GetPublicCalendarItems` network responses. It does not store a PushPress login, private credentials, or authorization token.
