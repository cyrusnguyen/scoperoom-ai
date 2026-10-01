import { verifyTarget } from "../db/guard.mjs";
import { cleanupTransient } from "../../src/server/maintenance/cleanup-transient.ts";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");
const value = process.argv.indexOf("--batch-size");
const batchSize = value < 0 ? 100 : Number(process.argv[value + 1]);
if ((apply && dryRun) || process.argv.some((argument, index) => argument === "--batch-size" && (index === process.argv.length - 1 || !Number.isSafeInteger(batchSize)))) {
  throw new Error("Use --apply or the default/--dry-run mode, with --batch-size 1..100.");
}
await verifyTarget();
console.log(JSON.stringify(await cleanupTransient({ dryRun: !apply, batchSize })));
