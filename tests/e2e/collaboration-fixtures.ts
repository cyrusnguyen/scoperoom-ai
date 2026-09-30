import { randomUUID } from "node:crypto";
import { expect, test as base, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";
import { statusDelay } from "../../src/features/collaboration/ui/project-sync.ts";
import { adminClient, appUrl, cleanupUsers, createProjectViaApi, entitle, openDatabase, signIn } from "./support";
import { closeStudioContext } from "./studio-fixtures";

export type Collaboration = {
  ownerPage: Page;
  editorPage: Page;
  projectId: string;
  /** The owner changes the editor's role through the real members API. */
  setEditorRole(role: "VIEWER" | "REVIEWER" | "EDITOR"): Promise<void>;
  /** The owner removes the editor through the real members API. */
  removeEditor(): Promise<void>;
};

const write = (): { Origin: string; "Idempotency-Key": string } => ({ Origin: appUrl, "Idempotency-Key": randomUUID() });

/**
 * A disposable owner and an admitted EDITOR, each in their own browser context with auth held in memory, joined through the
 * real project and invitation APIs. Nothing is shared with other tests, so a test may revoke or downgrade the editor. Both
 * contexts are closed (and their requests allowed to settle) before the receipts, projects and accounts are deleted.
 */
export const test = base.extend<{ collaboration: Collaboration }>({
  collaboration: [async ({ browser }: { browser: Browser }, runFixture) => {
    const admin = adminClient();
    const database = await openDatabase();
    const users: string[] = [];
    const contexts: BrowserContext[] = [];
    try {
      const [ownerContext, editorContext] = [await browser.newContext({ baseURL: appUrl }), await browser.newContext({ baseURL: appUrl })];
      contexts.push(ownerContext, editorContext);
      const [ownerPage, editorPage] = [await ownerContext.newPage(), await editorContext.newPage()];
      const owner = await signIn(ownerPage, admin, users, "Collab owner");
      const editor = await signIn(editorPage, admin, users, "Collab editor");
      await entitle(database, owner.authUserId);
      await entitle(database, editor.authUserId); // the editor may own a second project (project-switch case)
      const projectId = await createProjectViaApi(ownerPage, "Collaboration project");
      const issued = await ownerPage.request.post(`/api/projects/${projectId}/invitations`, { headers: write(), data: { verifiedEmail: editor.email, role: "EDITOR" } });
      expect(issued.status()).toBe(201);
      const token = (await issued.json() as { url: string }).url.split("/").at(-1);
      const accepted = await editorPage.request.post("/api/invitations/accept", { headers: write(), data: { token } });
      expect(accepted.status()).toBe(201);
      const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [editor.authUserId]);
      const editorProfileId = profile!.id;
      const editorMember = async () => {
        const { members } = await (await ownerPage.request.get(`/api/projects/${projectId}/members`)).json() as { members: { profileId: string; version: number }[] };
        return members.find((member) => member.profileId === editorProfileId)!;
      };
      await runFixture({
        ownerPage, editorPage, projectId,
        async setEditorRole(role) {
          const member = await editorMember();
          expect((await ownerPage.request.patch(`/api/projects/${projectId}/members/${editorProfileId}`, { headers: write(), data: { role, expectedMemberVersion: member.version } })).status()).toBe(200);
        },
        async removeEditor() {
          const member = await editorMember();
          expect((await ownerPage.request.delete(`/api/projects/${projectId}/members/${editorProfileId}`, { headers: write(), data: { expectedMemberVersion: member.version } })).status()).toBe(200);
        },
      });
    } finally {
      try {
        for (const context of contexts) await closeStudioContext(context);
        await cleanupUsers(database, admin, users);
      } finally { await database.end(); }
    }
  }, { timeout: 90_000 }],
});

/** The longest healthy status-poll delay (10 s plus 10% jitter): a frozen page clock run this far has certainly started its next poll. */
export const POLL_DEADLINE = statusDelay(0, 1);

/**
 * Runs a page's frozen clock in short slices until its next status read starts, at most the longest healthy poll delay.
 * Slicing stops the clock right there: a dirty edit's 10 s autosave (a timer on the same clock) never gets to send before
 * the poll it is meant to meet. A page that pinned its jitter to the minimum (`Math.random = () => 0`) is due after 9 s.
 */
export async function poll(page: Page) {
  let started = 0;
  const count = (request: { url(): string }) => { if (/\/status$/.test(new URL(request.url()).pathname)) started++; };
  const answered = page.waitForResponse((response) => /\/status$/.test(new URL(response.url()).pathname));
  page.on("request", count);
  try {
    for (let waited = 0; !started && waited < POLL_DEADLINE; waited += 250) {
      await page.clock.runFor(250);
      await new Promise((resolve) => setTimeout(resolve, 25)); // let the page's request event reach this process
    }
  } finally { page.off("request", count); }
  expect(started, "a status read within the longest poll delay").toBeGreaterThan(0);
  await answered;
}

const textFrame = (message: string | Buffer): unknown[] | null => {
  if (typeof message !== "string") return null;
  try { const frame = JSON.parse(message); return Array.isArray(frame) ? frame : null; } catch { return null; }
};
/** A provider Broadcast frame for an `:events` topic: a JSON frame, or the binary user-broadcast frame (kind 4; topic length at byte 1, topic from byte 5). */
const isEventsBroadcast = (message: string | Buffer) => {
  const frame = textFrame(message);
  if (frame) return frame[3] === "broadcast" && String(frame[2]).endsWith(":events");
  return typeof message !== "string" && message[0] === 4 && message.subarray(5, 5 + message[1]!).toString().endsWith(":events");
};

export type RealtimeWire = {
  /** While set, `events` Broadcast frames the provider delivers are counted and withheld from the page: every hint is lost on a healthy socket. */
  dropEvents: boolean;
  /** Withheld frames so far: proves the provider did deliver the hint, so its absence is the interception. */
  readonly dropped: number;
  /** Sockets the page has opened, refused ones included. */
  readonly connections: number;
  /** Topic of every `phx_join` the page sent (a duplicate channel would repeat one). */
  readonly joins: string[];
  /** `access_token` pushes the page sent on joined channels: how a renewed credential reaches the provider. */
  readonly accessTokens: number;
  /** Heartbeat replies the provider sent. */
  readonly heartbeatReplies: number;
  /** Join replies the provider answered "ok": a rejoin with the renewed credential shows here. */
  readonly joined: number;
  /** Closes every open Realtime socket and refuses new ones until `restore`; HTTP is untouched. */
  cut(): Promise<void>;
  restore(): void;
};

/** Sits on a page's Realtime WebSockets: forwards everything to the real provider, counts what matters and can drop hints or cut the sockets. Call before the page navigates. */
export async function interceptRealtime(page: Page): Promise<RealtimeWire> {
  const open = new Set<{ ws: WebSocketRoute; server: WebSocketRoute }>();
  const state = { dropEvents: false, offline: false, dropped: 0, connections: 0, joins: [] as string[], accessTokens: 0, heartbeatReplies: 0, joined: 0 };
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    state.connections++;
    if (state.offline) { void ws.close({ code: 1011, reason: "test outage" }); return; }
    const server = ws.connectToServer();
    open.add({ ws, server });
    ws.onMessage((message) => {
      const frame = textFrame(message);
      if (frame?.[3] === "phx_join") state.joins.push(String(frame[2]));
      if (frame?.[3] === "access_token") state.accessTokens++;
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = textFrame(message);
      if (frame?.[2] === "phoenix" && frame[3] === "phx_reply") state.heartbeatReplies++;
      if (frame?.[3] === "phx_reply" && frame[0] === frame[1] && (frame[4] as { status?: string } | undefined)?.status === "ok") state.joined++; // a join's ref is its join_ref
      if (state.dropEvents && isEventsBroadcast(message)) { state.dropped++; return; }
      ws.send(message);
    });
  });
  return {
    get dropEvents() { return state.dropEvents; },
    set dropEvents(on: boolean) { state.dropEvents = on; },
    get dropped() { return state.dropped; },
    get connections() { return state.connections; },
    joins: state.joins,
    get accessTokens() { return state.accessTokens; },
    get heartbeatReplies() { return state.heartbeatReplies; },
    get joined() { return state.joined; },
    async cut() {
      state.offline = true;
      const sockets = [...open];
      open.clear();
      await Promise.all(sockets.map(async ({ ws, server }) => { await server.close().catch(() => undefined); await ws.close({ code: 1011, reason: "test outage" }).catch(() => undefined); }));
    },
    restore() { state.offline = false; },
  };
}
