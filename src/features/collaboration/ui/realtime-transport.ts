import type { PeerMessage, PresenceState } from "../contracts/messages.ts";

// The application-owned Realtime boundary (Stage 04.3). The status controller and the live session import only this file and the
// message types: no SDK client or channel crosses it. `src/client/realtime.ts` implements it with the Supabase SDK. One factory,
// not a plug-in framework.
export type LiveState = "connecting" | "subscribed" | "degraded";
export interface LiveConnection {
  /** Fire and forget on `collab`: nothing is queued or retried, and a REST fallback is never used. */
  sendPeer(message: PeerMessage): void;
  trackPresence(state: PresenceState): void;
  dispose(): Promise<void>;
}
export interface RealtimeTransport {
  /**
   * Two private channels (`events`, `collab`) for one project and epoch. `subscribed` only when both are SUBSCRIBED; `degraded` on an
   * error, timeout or close of either, or when the credential is gone. Callbacks carry untrusted data until the message parsers.
   */
  connect(scope: { projectId: string; epoch: string; topics: { events: string; collab: string } }, handlers: {
    state(value: LiveState): void;
    hint(value: unknown): void;
    peer(value: unknown): void;
    presence(values: unknown[]): void;
  }): LiveConnection;
}
