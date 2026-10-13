import { after } from "next/server";
import { workerRequestAllowed } from "@/server/worker-service";
import { runScheduled } from "@/worker/maintenance";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Called by Supabase pg_cron. 404 unless authorized; otherwise 202, then one bounded sweep after the response. */
export async function POST(request: Request) {
  if (!workerRequestAllowed(request.headers.get("authorization"))) return new Response(null, { status: 404 });
  after(() => runScheduled("repair"));
  return new Response(null, { status: 202 });
}
