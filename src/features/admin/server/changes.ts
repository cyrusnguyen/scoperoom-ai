import { randomUUID } from "node:crypto";
import type { Prisma } from "../../../../prisma/generated/client.ts";
import { validateEntitlementInput, validateRoleInput, type EntitlementInput, type RoleInput } from "../contracts/admin.ts";
import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { checkReceipt, findReceipt, lockActor, profileFor, requestHash, saveReceipt, withDatabase, WRITE_TIMEOUT_MS, type Transaction } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { staffError } from "./staff-error.ts";

type Change = { profileId: string; version: number } & Record<string, unknown>;

function stored(value: Prisma.JsonValue): Change {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { version?: unknown }).version !== "number") throw new ProjectError("UNAVAILABLE");
  return value as Change;
}

/**
 * The shared skeleton for a staff write. The web runtime has no table grants: the SECURITY DEFINER function checks the actor's role and
 * version and writes the change with its audit row in this transaction (READ COMMITTED: it takes its own locks and re-checks under them).
 * The actor is exclusive-locked first, so two requests with one key serialise and the second replays instead of conflicting.
 * A conflict answers with the version now current, read after the failed transaction ended.
 */
async function staffWrite(identity: ProjectIdentity, target: string, key: string, operation: string, hash: string,
  versionOf: "entitlement_version" | "role_version", call: (tx: Transaction, actorId: string, requestId: string) => Promise<Prisma.JsonValue>) {
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    try {
      return await database.$transaction(async (tx) => {
        await lockActor(tx, profile.id, identity.authUserId, true);
        const receipt = await findReceipt(tx, profile.id, "USER", profile.id, key);
        if (receipt) {
          checkReceipt(receipt, operation, hash);
          // A receipt is only a lookup of the caller's own earlier result: they must still be staff to see it. An Admin who demoted
          // themselves to Moderator still recovers that change's stored success; only a new role change needs the Admin role.
          const [current] = await tx.$queryRaw<Array<{ role: string | null }>>`SELECT app.staff_role(${profile.id}::uuid) AS role`;
          if (!current?.role) throw new ProjectError("NOT_FOUND");
          return { ...stored(receipt.result), replayed: true };
        }
        const value = stored(await call(tx, profile.id, randomUUID()));
        await saveReceipt(tx, profile.id, "USER", profile.id, key, operation, hash, value as Prisma.InputJsonValue);
        return { ...value, replayed: false };
      }, { timeout: WRITE_TIMEOUT_MS }); // an entitlement change waits on the owner capacity lock
    } catch (error) {
      const mapped = staffError(error);
      if (mapped.code !== "CONFLICT" || mapped.details) throw mapped;
      // Version conflict: tell the caller which version to retry with. Best effort; a failure keeps the plain conflict.
      const current = await database.$queryRaw<Array<{ detail: { account: Record<string, number> } }>>`SELECT app.admin_account_detail(${profile.id}::uuid, ${target}::uuid) AS detail`.catch(() => []);
      const currentVersion = current[0]?.detail.account[versionOf];
      throw new ProjectError("CONFLICT", typeof currentVersion === "number" ? { currentVersion } : undefined);
    }
  });
}

/** Sets or resets an account's limits. Admin or Moderator. Idempotent per Idempotency-Key; `expectedVersion` is the version the editor loaded (0 when none). */
export async function setEntitlement(identity: ProjectIdentity, profileId: string, input: unknown) {
  if (!uuid.test(profileId)) throw new ProjectError("NOT_FOUND");
  let v: EntitlementInput;
  try { v = validateEntitlementInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const target = profileId.toLowerCase();
  const operation = "ADMIN_SET_ENTITLEMENT_V1";
  const { key, ...body } = v;
  const hash = requestHash(operation, { profileId: target, ...body });
  const limits = v.reset ? null : v;
  return staffWrite(identity, target, key, operation, hash, "entitlement_version", async (tx, actorId, requestId) => {
    const [row] = await tx.$queryRaw<Array<{ result: Prisma.JsonValue }>>`
      SELECT app.admin_set_entitlement(${actorId}::uuid, ${target}::uuid, ${limits?.maxOwnedProjects ?? null}::integer, ${limits?.aiTotalRuns ?? null}::integer,
        ${limits?.aiDailyRuns ?? null}::integer, ${limits?.expiresAt ?? null}::timestamptz, ${limits?.blocked ?? false}::boolean, ${v.reset}::boolean,
        ${v.reason}::text, ${v.expectedVersion}::integer, ${requestId}::uuid) AS result`;
    return row!.result;
  });
}

/** Grants, changes or revokes (role null) a staff role. Admin only. */
export async function setRole(identity: ProjectIdentity, profileId: string, input: unknown) {
  if (!uuid.test(profileId)) throw new ProjectError("NOT_FOUND");
  let v: RoleInput;
  try { v = validateRoleInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const target = profileId.toLowerCase();
  const operation = "ADMIN_SET_ROLE_V1";
  const { key, ...body } = v;
  const hash = requestHash(operation, { profileId: target, ...body });
  return staffWrite(identity, target, key, operation, hash, "role_version", async (tx, actorId, requestId) => {
    const [row] = await tx.$queryRaw<Array<{ result: Prisma.JsonValue }>>`
      SELECT app.admin_set_role(${actorId}::uuid, ${target}::uuid, ${v.role}::text, ${v.reason}::text, ${v.expectedVersion}::integer, ${requestId}::uuid) AS result`;
    return row!.result;
  });
}
