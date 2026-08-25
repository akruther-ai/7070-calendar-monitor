# 7070 Calendar Monitor

Monitors the public 7070 Athletics PushPress calendar and sends GitHub issue notifications for Middle School registration windows. It does not create Google Calendar events or write to any external calendar.

## Alert strategy

- About 30 hours before the first registration opening on a local `America/Denver` day, the monitor creates one `UPCOMING` issue containing every known opening on that day.
- When each registration window is actually due to open, the monitor creates a separate live confirmation issue.
- Classes opening at the same instant are grouped into one live issue.
- A live check more than 15 minutes late is clearly labeled `LATE`.
- Issues are assigned to and @mention `akruther-ai`. Notification delivery therefore follows that account's GitHub and GitHub Mobile notification settings.
- A daily advance issue remains open until all of its represented windows have live confirmations. Completed live issues close after 24 hours.

7070 registration is calculated as exactly seven calendar days before the class, at the same Denver wall-clock time. PushPress encodes the local class wall clock with a trailing `Z`; that suffix is intentionally not interpreted as true UTC.

## Live data

- Full monitored calendar: `data/calendar.json`
- Current/future Middle School classes: `data/middle-school.json`

Raw URLs:

- `https://raw.githubusercontent.com/akruther-ai/7070-calendar-monitor/main/data/calendar.json`
- `https://raw.githubusercontent.com/akruther-ai/7070-calendar-monitor/main/data/middle-school.json`

The Middle School feed includes a current/future item when either its title or its PushPress calendar-item type contains `Middle School` (case-insensitive). This covers variations such as Middle School Skills, IPT Middle School, Upper Middle School Skills, and Shot Doctor - Middle School.

## Production architecture

- The lightweight registration checker is scheduled every five minutes.
- Playwright refreshes 21 days of the live calendar every 15 minutes using the Chrome installation on GitHub's pinned `ubuntu-24.04` runner.
- The refresh workflow checks registration both before and after scraping, so the last-known-good feed remains a second execution path.
- Both workflows use one FIFO concurrency queue. This serializes issue/state writes without GitHub's default behavior of replacing an older pending run.
- Dependencies are lockfile-installed with `npm ci`, Actions are pinned to full commit SHAs, and weekly Dependabot checks cover npm and GitHub Actions.

GitHub documents scheduled Actions as best-effort: scheduled runs can be delayed or dropped during high load. The advance daily digest reduces dependence on a single time-critical cron run, while the live issue still confirms when a checker executes at or after opening. Both paths remain in GitHub, so this repository does not claim an independent external delivery channel.

## Reliability protections

- Alert state stores both PushPress UUID and start time. A reschedule under the same UUID is treated as a new schedule.
- Advance issues carry machine-readable UUID/start-time markers. If issue creation succeeds but the state commit fails, the next run recovers state from the issue instead of sending a duplicate.
- If a class in an advance digest is rescheduled or removed before opening, the stale digest is closed and rebuilt from the current feed.
- Alert state older than 90 days is pruned, and completed issues are automatically closed to keep searches bounded.
- The scraper refuses to overwrite the last-known-good feed when coverage is empty, gapped, stalled, malformed, unexpectedly sparse, or below 50% of the prior population. It also rejects conflicting UUID reuse and validates current/future Middle School results.
- Health reporting runs as a separate `always()` job, so a checker or scraper failure/timeout can create one assigned `7070 MONITOR DEGRADED` issue. A successful later run closes it.
- The test suite covers normal timing, DST changes, leap/year boundaries, feed validation, daily digest grouping, lost-state recovery, live confirmation, issue closure, and scraper fail-closed checks.

GitHub's scheduler itself cannot report a run that was never started. The advance digest is the repository-only mitigation for that platform-level limitation.

## Local verification

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

To perform a live scrape with a locally installed Chrome channel:

```sh
npm run scrape
```

The monitor captures only successful public `GetPublicCalendarItems` responses. It stores no PushPress login, private credential, authorization token, or external-calendar data.
