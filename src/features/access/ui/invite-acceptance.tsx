"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Acceptance = { projectId: string; role: "EDITOR" | "REVIEWER" | "VIEWER"; replayed: boolean };
type ErrorBody = { error?: { message?: string } };

async function problem(response: Response) {
  try { return (await response.json() as ErrorBody).error?.message; } catch { return undefined; }
}

export default function InviteAcceptance({ token, signOut }: { token: string; signOut: () => Promise<void> }) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<"loading" | "uncertain" | "denied">("loading");
  const [message, setMessage] = useState("Checking this invitation…");
  const accept = useCallback(async () => {
    setState("loading");
    setMessage("Checking this invitation…");
    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        if (response.status >= 500) {
          setState("uncertain");
          setMessage("We could not confirm access. Retry uses the same invitation request.");
        } else {
          setState("denied");
          setMessage((await problem(response)) ?? "This invitation is unavailable for this account.");
        }
        return;
      }
      const accepted = await response.json() as Acceptance;
      router.replace(`/app/projects/${accepted.projectId}`);
    } catch {
      setState("uncertain");
      setMessage("We could not confirm access. Retry uses the same invitation request.");
    }
  }, [key, router, token]);

  useEffect(() => { const timer = window.setTimeout(() => { void accept(); }, 0); return () => window.clearTimeout(timer); }, [accept]); // The key is deliberately held for an uncertain retry.

  return (
    <main className="invite-page">
      <section className="invite-card" aria-live="polite">
        <span className="small-label">SCOPEROOM INVITATION</span>
        <h1>Open a shared project</h1>
        <p>{message}</p>
        {state === "uncertain" && <button type="button" onClick={() => void accept()}>Retry invitation</button>}
        {state === "denied" && <form action={signOut}><input type="hidden" name="continue" value={`/invite/${token}`} /><button type="submit">Use another account</button></form>}
      </section>
    </main>
  );
}