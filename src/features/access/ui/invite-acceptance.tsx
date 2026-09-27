"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiMutate, sessionEnded } from "@/client/api";
import type { ProjectMemberRole } from "@/features/projects/contracts/invitation";

type Acceptance = { projectId: string; role: ProjectMemberRole; replayed: boolean };

export default function InviteAcceptance({ token, signOut }: { token: string; signOut: () => Promise<void> }) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<"loading" | "uncertain" | "denied">("loading");
  const [message, setMessage] = useState("Checking this invitation…");
  const accept = useCallback(async () => {
    setState("loading");
    setMessage("Checking this invitation…");
    const result = await apiMutate<Acceptance>("/api/invitations/accept", key, { token });
    if (result.ok) { router.replace(`/app/projects/${result.data.projectId}`); return; }
    // An ended session signs in again and comes back to this invitation (the same continuation the page's own redirect uses).
    if (sessionEnded(result, `/login?continue=${encodeURIComponent(`/invite/${token}`)}`)) return;
    setState(result.uncertain ? "uncertain" : "denied");
    setMessage(result.uncertain ? "We could not confirm access. Retry uses the same invitation request." : result.message);
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
