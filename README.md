# 7070 Calendar Monitor

Monitors the public 7070 Athletics PushPress calendar and sends time-critical GitHub Mobile alerts when Middle School registration opens.

## Live data

- Full monitored calendar: `data/calendar.json`
- Current/future Middle School only: `data/middle-school.json`

Raw URLs:

- `https://raw.githubusercontent.com/akruther-ai/7070-calendar-monitor/main/data/calendar.json`
- `https://raw.githubusercontent.com/akruther-ai/7070-calendar-monitor/main/data/middle-school.json`

The Middle School feed includes a current/future item when either its title or its PushPress calendar-item type contains `Middle School` (case-insensitive). This covers items such as Middle School Skills, IPT Middle School, Upper Middle School Skills, and Shot Doctor - Middle School, while also protecting against a future display-title change.

## Production architecture

- The live PushPress calendar is refreshed every 15 minutes with Playwright controlling the Google Chrome already installed on GitHub's pinned `ubuntu-24.04` runner.
- The scraper captures 21 days ahead, which is a two-week safety buffer beyond the seven-day registration window while avoiding unnecessary far-future browser work and data churn.
- The lightweight registration checker runs every 5 minutes.
- The 15-minute refresh workflow checks the last-known-good feed before scraping and checks the fresh feed again immediately afterward, providing a second alert path.
- Both workflows share one concurrency group so issue/state writes cannot race each other.
- Registration opening is calculated as exactly 7 calendar days before each class at the same `America/Denver` wall-clock time. PushPress's trailing `Z` is intentionally treated as part of its local-wall-time encoding rather than as true UTC.
- When registration opens, GitHub Actions creates one issue assigned to and @mentioning `akruther-ai`, which drives redundant GitHub Mobile push signals.
- Classes that open at the same instant are grouped into one issue.
- Alerts delayed by more than 15 minutes are explicitly labeled `LATE` rather than pretending they fired on time.

## Reliability protections

- Alert state stores both the PushPress UUID and start time, so a class rescheduled under the same UUID is treated as a new schedule rather than incorrectly suppressed.
- Each alert issue also carries a machine-readable UUID/start-time marker. Before creating a due alert, the checker scans recent issues for those markers. This prevents a duplicate if GitHub created the issue successfully but the subsequent state commit failed.
- Legacy state entries are migrated automatically and alert state older than 90 days is pruned.
- The scraper refuses to overwrite the last good feed if PushPress returns malformed events, unexpectedly sparse data, reused UUIDs with conflicting start times, or incomplete calendar coverage.
- The scraper validates current/future Middle School results before publishing.
- If the 5-minute checker or 15-minute live refresh fails, the workflow creates a single assigned/mentioned `7070 MONITOR DEGRADED` issue. A later successful run automatically closes the corresponding health issue.
- Calendar/state files are committed only when their meaningful contents actually change.

The scraper captures the public calendar application's successful `GetPublicCalendarItems` network responses. It does not store a PushPress login, private credentials, or authorization token.
