import { useRef, useState } from "react";
import { apiMutate, sessionEnded } from "@/client/api";

export const REASON_MAX = 500;
export const CONFLICT_MESSAGE = "Someone changed this account. Reload to see the latest.";
/** Characters as the server counts them (code points), after trimming. */
export const reasonLength = (reason: string) => [...reason.trim()].length;

/**
 * One staff write with the app's retry rule: an uncertain result keeps the Idempotency-Key so Retry replays the same request
 * (the editor locks its fields meanwhile); a certain refusal drops it so the next attempt is new. `onSaved` runs after a success
 * and the editor stays busy until it settles, so a second save cannot go out against the version it is about to replace.
 */
export function useChange(onSaved: () => Promise<void>) {
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);

  async function send(url: string, method: "PATCH" | "PUT", body: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    setConflict(false);
    const result = await apiMutate(url, key.current, body, method);
    if (sessionEnded(result)) return false;
    if (result.ok) {
      key.current = null;
      setUncertain(false);
      await onSaved();
      setBusy(false);
      return true;
    }
    setBusy(false);
    setUncertain(result.uncertain);
    if (result.uncertain) { setError("We could not confirm this change. Retry uses the same request."); return false; }
    key.current = null;
    // Staff writes answer 404 only to a caller who is no longer staff (accounts are never deleted), including a retry of their own
    // self-revocation: leave the staff screen for the workspace, where the server gate decides what they see.
    if (result.status === 404) { window.location.assign("/app"); return false; }
    if (result.code === "CONFLICT") setConflict(true); else setError(result.message);
    return false;
  }
  return { busy, error, uncertain, conflict, send };
}
