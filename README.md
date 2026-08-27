# 7070 Calendar Monitor

Monitors the public 7070 Athletics PushPress calendar and sends GitHub issue notifications for Middle School registration windows. It does not create Google Calendar events or write to any external calendar.

## Alert strategy

- About 30 hours before the first registration opening on a local `America/Denver` day, the monitor creates one `UPCOMING` issue containing every known opening on that day.
- When each registration window is actually due to open, the monitor creates a separate live confirmation issue.
- Classes opening at the same instant are grouped into one live issue.
- A live check more than 15 minutes late is clearly labeled `LATE`. If a class
  first appears after its calculated opening is already more than a day old,
  it is labeled `NEWLY DISCOVERED` and says registration may already be open
  instead of presenting a misleading multi-day delay in minutes.
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

- Registration watchers are offered twelve redundant, off-peak seed times per hour. If a known opening is within the next 12 hours, the allocated runner immediately queues one successor and stays active for up to 5 hours 15 minutes. Successors repeat that guard until the opening is inside a runner window, then sleep to each exact opening.
- A human/code push uses a one-time 24-hour lead and propagates it to successors. This bootstraps the next day's guard immediately after deploying an incident fix instead of waiting for the damaged scheduler to resume; ordinary scheduled seeds retain the lower 12-hour lead.
- Playwright refreshes 21 days of the live calendar every 15 minutes using the Chrome installation on GitHub's pinned `ubuntu-24.04` runner.
- The watcher is the only workflow that writes registration state. Calendar refreshes have a separate single-pending concurrency queue, so a long-lived watcher cannot block fresh calendar snapshots and the two workflows cannot race on alert state.
- While a watcher is active, new watcher starts share a single-pending queue. The running window is preserved and the newest pending run replaces an obsolete pending run.
- Self-dispatch uses the workflow's repository-scoped `GITHUB_TOKEN` with `actions: write`. Transient dispatch failures are retried immediately and every five minutes while the guard is active; ending a guard without a successor fails the job so health reporting can alert.
- Dependencies are lockfile-installed with `npm ci`, Actions are pinned to full commit SHAs, and weekly Dependabot checks cover npm and GitHub Actions.

GitHub documents scheduled Actions as best-effort: scheduled runs can be delayed or dropped during high load. The 12-hour active-plus-pending guard removes dependence on new schedule events during the actual registration window, while the advance daily digest provides the schedule well beforehand. Both paths remain in GitHub, so this repository does not claim an independent external delivery channel.

## Reliability protections

- Alert state stores both PushPress UUID and start time. A reschedule under the same UUID is treated as a new schedule.
- Advance issues carry machine-readable UUID/start-time markers. If issue creation succeeds but the state commit fails, the next run recovers state from the issue instead of sending a duplicate.
- If a manual catch-up issue is recovered, the Actions bot adds one marker-backed confirmation comment. This restores the mobile-notification path that a user-authored self-assignment may not produce, without repeating the comment after a lost state push.
- If a class in an advance digest is rescheduled or removed before opening, the stale digest is closed and rebuilt from the current feed.
- Alert state older than 90 days is pruned, and completed issues are automatically closed to keep searches bounded.
- The scraper refuses to overwrite the last-known-good feed when coverage is empty, gapped, stalled, malformed, unexpectedly sparse, or below 50% of the prior population. It also rejects conflicting UUID reuse and validates current/future Middle School results.
- Health reporting runs as a separate `always()` job, so a watcher or scraper failure/timeout can create one assigned `7070 MONITOR DEGRADED` issue. A successful later run closes it.
- The test suite covers normal timing, DST changes, leap/year boundaries, feed validation, daily digest grouping, lost-state recovery, exact-time watcher wakeups, live confirmation, issue closure, and scraper fail-closed checks.

GitHub's scheduler itself cannot report a run that was never started. Redundant seeds, the 12-hour pre-armed guard chain, the 5-hour-15-minute runner window, and the advance digest are the repository-only mitigations for that platform-level limitation. See the [August 26 incident analysis](docs/incidents/2026-08-26-actions-outage.md) for the production failure that motivated the guard chain.

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
