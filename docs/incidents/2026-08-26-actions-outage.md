# August 26, 2026 registration-alert incident

## Impact

No live confirmation issues were created for the Wednesday, September 2 Middle School registration windows at 4:30, 5:30, or 6:30 PM MDT. The advance digest had been created successfully the prior afternoon, but the exact-time GitHub notification path did not execute.

Marker-backed catch-up issues were created as [#12](https://github.com/akruther-ai/7070-calendar-monitor/issues/12), [#13](https://github.com/akruther-ai/7070-calendar-monitor/issues/13), and [#14](https://github.com/akruther-ai/7070-calendar-monitor/issues/14).

## Timeline

- August 25, 21:15 UTC: advance digest [#5](https://github.com/akruther-ai/7070-calendar-monitor/issues/5) recorded all four expected classes and their three distinct opening times.
- August 26, 14:22 UTC: the final registration schedule event created [run 32979933918](https://github.com/akruther-ai/7070-calendar-monitor/actions/runs/32979933918). It completed successfully, but its 5-hour-15-minute window ended at 19:38 UTC, before the first 22:30 UTC opening.
- August 26, 14:28 UTC: the final calendar schedule event created [run 32980451838](https://github.com/akruther-ai/7070-calendar-monitor/actions/runs/32980451838).
- August 26, 15:11–18:01 UTC: GitHub reported a critical [Actions major outage](https://www.githubstatus.com/incidents/y1t7p9fzrlj2), including throttled inbound queues.
- August 26, 18:01–22:30 UTC: no schedule event created a run for either repository workflow, so no watcher entered the exact-time horizon after the reported recovery.
- August 26, 22:30, 23:30, and August 27, 00:30 UTC: the registration windows opened with no live watcher.
- August 26, 22:56–August 27, 00:26 UTC: GitHub reported a second [Actions incident](https://www.githubstatus.com/incidents/kfspvrz14xr0) involving delayed starts and runs that failed to trigger.
- August 27, 01:16 UTC: the missing runs and absent live issues were confirmed.

## Root cause

The direct cause was the absence of any GitHub Actions workflow run during the registration window. No script failed and no notification issue was created, so this was upstream of GitHub Mobile delivery.

The external trigger failure was compounded by four repository design limitations:

1. The watcher queued a successor only when an opening was already inside its 5-hour-15-minute runner horizon. The last successful run was about eight hours before the first opening, so it exited without preserving a pending successor.
2. Four cron expressions improved ordinary scheduler latency but remained one GitHub Actions scheduling failure domain.
3. Health jobs could report a failed run but could not report a schedule event that GitHub never instantiated.
4. Manually created catch-up issues are authored by the assigned user, so GitHub may suppress the self-generated mobile notification even though the issue exists.

## Corrective actions

- Increase off-peak scheduler seed opportunities from four to twelve per hour and activate an active-plus-pending guard chain whenever a known opening is within 12 hours.
- Keep each guard runner alive for up to 5 hours 15 minutes even when the opening is beyond that runner's own horizon; its pre-queued successor continues the chain.
- Retry workflow-dispatch POSTs safely. The single-pending concurrency group collapses ambiguous duplicate dispatches.
- Retry an unavailable successor every five minutes while the guard is active and fail the watcher if the guard ends without one.
- Save marker-recovery state even when the watcher reports a guard-chain failure.
- Add one idempotent Actions-bot recovery comment to manually created catch-up issues so the actual notification path is restored.
- Add deterministic tests for multi-run guard coverage, transient dispatch recovery, and recovery-comment idempotency.

## Residual risk

A GitHub-only implementation cannot create a GitHub issue while the entire GitHub Actions control plane is unavailable, and it cannot detect a schedule event that never becomes a run. The advance digest remains the early warning. The new guard materially reduces exposure by requiring a scheduler seed during the 12 hours before an opening instead of during only the final 5 hours 15 minutes, and by preserving a pending successor before a later outage begins.
