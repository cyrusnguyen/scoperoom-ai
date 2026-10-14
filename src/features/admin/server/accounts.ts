import { ACCOUNT_PAGE_SIZE, decodeAccountCursor, encodeAccountCursor, validateAccountQuery, type AccountView, type AuditView } from "../contracts/admin.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { profileFor, withDatabase, withReadSnapshot, type Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { accountView, auditView, defaultLimits, type SummaryRow } from "./account-view.ts";
import { staffError } from "./staff-error.ts";

async function staffRead<T>(identity: ProjectIdentity, run: (tx: Transaction, actorId: string) => Promise<T>): Promise<T> {
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    try { return await withReadSnapshot(database, (tx) => run(tx, profile.id)); } catch (error) { throw staffError(error); }
  });
}

/** Accounts ordered by (display name, id), searched by display name. Staff only; anyone else gets NOT_FOUND. */
export async function listAccounts(identity: ProjectIdentity, options: { query?: string; cursor?: string }): Promise<{ accounts: AccountView[]; nextCursor: string | null }> {
  let query: string | null, after: [string, string] | null;
  try { query = validateAccountQuery(options.query); after = options.cursor === undefined ? null : decodeAccountCursor(options.cursor); } catch { throw new ProjectError("INVALID_INPUT"); }
  return staffRead(identity, async (tx, actorId) => {
    const rows = await tx.$queryRaw<SummaryRow[]>`
      SELECT * FROM app.admin_list_accounts(${actorId}::uuid, ${query}::text, ${after?.[0] ?? null}::text, ${after?.[1] ?? null}::uuid, ${ACCOUNT_PAGE_SIZE + 1}::integer)`;
    const page = rows.slice(0, ACCOUNT_PAGE_SIZE), last = page.at(-1);
    const now = new Date();
    return { accounts: page.map((row) => accountView(row, now)), nextCursor: rows.length > page.length && last ? encodeAccountCursor(last.display_name, last.profile_id) : null };
  });
}

/** One account with its latest 50 audit entries and the default plan's limits (the editor's start without an override). */
export async function readAccount(identity: ProjectIdentity, profileId: string): Promise<{ account: AccountView; audit: AuditView[]; defaultLimits: AccountView["limits"] }> {
  if (!uuid.test(profileId)) throw new ProjectError("NOT_FOUND");
  return staffRead(identity, async (tx, actorId) => {
    const [row] = await tx.$queryRaw<Array<{ detail: { account: SummaryRow; audit: AuditView[] } }>>`SELECT app.admin_account_detail(${actorId}::uuid, ${profileId.toLowerCase()}::uuid) AS detail`;
    if (!row) throw new ProjectError("UNAVAILABLE");
    return { account: accountView(row.detail.account), audit: row.detail.audit.map(auditView), defaultLimits: defaultLimits() };
  });
}
