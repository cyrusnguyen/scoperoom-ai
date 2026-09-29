import { test as base, type Browser, type BrowserContext } from "@playwright/test";
import { adminClient, appUrl, cleanupUsers, cleanupWorkerProjects, entitle, neutralizeStrayOverlays, openDatabase, signIn } from "./support";

type WorkerAccount = { authUserId: string; storageState: Awaited<ReturnType<BrowserContext["storageState"]>>; database: Awaited<ReturnType<typeof openDatabase>> };
type WorkerFixtures = { workerAccount: WorkerAccount };
type TestFixtures = { cleanStudio: void };

async function closeStudioContext(context: BrowserContext) {
  const responses = (await Promise.all(context.pages().map((page) => page.requests())))
    .flatMap((requests) => requests.map((request) => request.response().catch(() => null)));
  await Promise.race([Promise.all(responses), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await context.close();
  // A handler can start just after the request snapshot, especially when a route is cold.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function createWorkerAccount(browser: Browser): Promise<WorkerAccount & { dispose: () => Promise<void> }> {
  const admin = adminClient();
  const database = await openDatabase();
  const users: string[] = [];
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ baseURL: appUrl });
    const page = await context.newPage();
    const { authUserId } = await signIn(page, admin, users, "Studio test owner");
    await entitle(database, authUserId);
    const storageState = await context.storageState();
    await closeStudioContext(context);
    context = undefined;
    return {
      authUserId,
      storageState,
      database,
      dispose: async () => {
        try { await cleanupUsers(database, admin, users); } finally { await database.end(); }
      },
    };
  } catch (error) {
    try {
      if (context) await closeStudioContext(context);
    } finally {
      try { await cleanupUsers(database, admin, users); } finally { await database.end(); }
    }
    throw error;
  }
}

/** One entitled account per worker; Playwright still creates a fresh context for every test. */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  workerAccount: [async ({ browser }, runFixture) => {
    const account = await createWorkerAccount(browser);
    try { await runFixture(account); } finally { await account.dispose(); }
  }, { scope: "worker" }],
  storageState: async ({ workerAccount }, runFixture) => { await runFixture(workerAccount.storageState); },
  cleanStudio: [async ({ context, page, workerAccount }, runFixture) => {
    try {
      await neutralizeStrayOverlays(page);
      await runFixture();
    } finally {
      try { await closeStudioContext(context); } finally { await cleanupWorkerProjects(workerAccount.database, workerAccount.authUserId); }
    }
  }, { auto: true }],
});
