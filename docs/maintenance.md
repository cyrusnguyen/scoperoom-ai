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
