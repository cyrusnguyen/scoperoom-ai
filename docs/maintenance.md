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

Each sweep handles at most 100 rows in each category, using the database clock. Repeat `--apply` until the counts reach zero: READY previews expire at 24 hours, discarded bodies clear immediately, APPLIED bodies clear seven days after application, and receipts expire at 30 days. A locked preview is skipped and handled by a later sweep. Already EXPIRED rows with retained bodies are cleared too.

Cleanup retains APPLIED actor/project/draft identity, format version, payload/preview hashes, resulting flow ID, mapping and result revisions. Authorized recovery does not depend on the imported flow still existing or on a retained upload body/receipt. Inspection checks current flow/node/edge capacity and persisted JSONB byte sizes without reserving space; Apply must still validate the complete appended document/layout and current capacity.
