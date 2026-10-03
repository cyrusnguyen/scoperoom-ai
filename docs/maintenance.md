# Local maintenance

From the isolated local stack, load its explicit environment settings and run a dry sweep:

```powershell
foreach ($taskLine in (Get-Content .env.stage51.local)) {
  $taskParts = $taskLine.Split('=', 2)
  [Environment]::SetEnvironmentVariable($taskParts[0], $taskParts[1], 'Process')
}
node --experimental-strip-types scripts/maintenance/cleanup-transient.ts --dry-run
```

The command only reports bounded counts by default. Use `--apply` only after the guarded local target has been verified; `--batch-size` accepts 1 through 100.

Each sweep handles at most 100 rows in each category, using the database clock. The sweep also drops AI run capture and result bodies seven days after a run became terminal (never an applied run's) and marks an unused result `EXPIRED`; its counts are `expiredAiResults` and `clearedAiBodies`. The scheduled worker runs the same sweep every minute through a restricted function: see [AI setup](ai-setup.md). Repeat `--apply` until the counts reach zero: READY previews expire at 24 hours, discarded bodies are eligible for the next sweep immediately, APPLIED bodies clear seven days after application, and receipts expire at 30 days. A locked preview is skipped and handled by a later sweep. Already EXPIRED rows with retained bodies are cleared too.

Preview identities are never removed by this sweep. Across every project, one actor may retain at most 1,000 preview rows, 10 retained bodies, 8 MiB of PostgreSQL JSONB text for bodies, and 20 successful new previews in the preceding hour. One project may retain at most 2,000 rows, 25 bodies, 16 MiB of body text, and 60 successful new previews in the preceding hour. A row exactly one hour old is outside the rolling window. Cleanup can free body capacity, but never identity-row capacity. These are successful-creation admission limits; the separate hosted request-rate gate remains required before exposure.

Cleanup retains APPLIED actor/project/draft identity, format version, payload/preview hashes, resulting flow ID, mapping and result revisions. Authorized recovery does not depend on the imported flow still existing or on a retained upload body/receipt. Inspection checks current flow/node/edge capacity and persisted JSONB byte sizes without reserving space; Apply must still validate the complete appended document/layout and current capacity.
