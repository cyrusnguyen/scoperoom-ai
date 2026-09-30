import { randomUUID } from "node:crypto";
import { expect, test as base, type Browser, type BrowserContext, type Page } from "@playwright/test";
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
