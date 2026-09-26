import { getDatabase } from "../../../server/db.ts";
import { entitlementActive } from "../../projects/server/access.ts";
import { resolveProfile } from "./profile.ts";

export async function getMe(identity: { authUserId: string; displayName: string }) {
  const database = await getDatabase();
  const profile = await resolveProfile(database, identity);
  const entitlement = await database.pilotEntitlement.findUnique({ where: { profileId: profile.id }, select: { active: true, expiresAt: true, revokedAt: true, maxOwnedProjects: true } });
  const active = Boolean(entitlement && entitlementActive(entitlement));
  return { profile, entitlement: { active, maxOwnedProjects: active ? entitlement!.maxOwnedProjects : 0 } };
}
