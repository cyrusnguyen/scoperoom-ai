"use client";

import { useRef, useState } from "react";
import { apiMutate, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import { refusalText } from "@/features/sources/ui/limit-text";
import { settleSpecsRequest, startSpecsRequest, type SpecsRequest, type SpecsUi } from "@/features/shell/ui/project-ui";
import { useStudio } from "@/features/studio/ui/studio-context";

const UNCONFIRMED = (label: string) => `We couldn’t confirm “${label}”. Retry sends the same request.`;

/**
 * Sends one Specs write; the store keeps an unresolved request until its own key settles (PR 07b adds draft writes).
 * `onSaved` runs for every committed request, also when its panel was closed or its project left meanwhile, so it may only use store-bound setters.
 */
export function useSpecsWrite(ui: SpecsUi, update: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void, onSaved?: (request: SpecsRequest, data: unknown) => void) {
  const { beforeWrite, fence, invalidate, revalidate } = useSync();
  const { projectId } = useStudio();
  const sending = useRef(false); // synchronous guard against double clicks within this mount
  const [busy, setBusy] = useState(false);
  const settle = (key: string, outcome: "saved" | "uncertain" | "refused", message: string) => update((specs) => settleSpecsRequest(specs, key, outcome, message));

  async function run(request: SpecsRequest, retry: boolean): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    try {
      const authority = await beforeWrite();
      // Nothing was sent: a first attempt is simply not saved; a retry stays unresolved with its key.
      if (authority.kind !== "current") { settle(request.key, retry ? "uncertain" : "refused", authority.kind === "unavailable" ? "Not saved. We couldn’t reach ScopeRoom." : "Checking your access…"); return false; }
      if (!retry && (authority.status.status !== "ACTIVE" || (authority.status.role !== "OWNER" && authority.status.role !== "EDITOR"))) { settle(request.key, "refused", "Not saved. This project is read-only now."); return false; }
      // The same lifecycle fence as the Studio and AI writes: a project switch, account change or replaced generation ends this invocation.
      const live = fence(authority.generation);
      if (!live()) { settle(request.key, retry ? "uncertain" : "refused", "The project changed. Nothing was sent."); return false; }
      const result = await apiMutate<unknown>(`/api/projects/${projectId}/${request.path}`, request.key, request.body, request.method);
      if (!live()) {
        // A late response for a project the person left: record it for that project only, with no session, sync or navigation effects.
        // `settle` writes the old project's own store slice; a 401 or lost response stays unresolved there for an exact Retry.
        const outcome = result.ok ? "saved" : result.uncertain || result.status === 401 ? "uncertain" : "refused";
        if (result.ok) onSaved?.(request, result.data);
        settle(request.key, outcome, result.ok ? `${request.label}: saved.` : outcome === "uncertain" ? UNCONFIRMED(request.label) : refusalText(result));
        return result.ok;
      }
      if (sessionEnded(result)) return false;
      if (result.ok) { onSaved?.(request, result.data); settle(request.key, "saved", `${request.label}: saved.`); void revalidate("manual"); return true; }
      if (result.uncertain) { invalidate(); settle(request.key, "uncertain", UNCONFIRMED(request.label)); return false; }
      settle(request.key, "refused", refusalText(result));
      if (result.status === 409) void revalidate("manual"); // someone else saved first: read the current heads
      return false;
    } finally { sending.current = false; setBusy(false); }
  }

  return {
    busy,
    send: (method: "POST" | "PATCH", path: string, body: Record<string, unknown>, label: string) => {
      if (ui.pending || sending.current) { update(() => ({ message: "Retry the unconfirmed save first." })); return Promise.resolve(false); }
      const request = { key: crypto.randomUUID(), method, path, body, label };
      update((specs) => startSpecsRequest(specs, request) ?? {});
      return run(request, false);
    },
    retry: () => (ui.pending ? run(ui.pending, true) : Promise.resolve(false)),
  };
}
