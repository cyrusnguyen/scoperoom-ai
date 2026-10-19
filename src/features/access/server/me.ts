import { getDatabase } from "../../../server/db.ts";
import { staffRole } from "../../projects/server/access.ts";
import { accountPlan } from "../../projects/server/plan.ts";
import { resolveProfile } from "./profile.ts";

export async function getMe(identity: { authUserId: string; displayName: string }) {
  const database = await getDatabase();
  const profile = await resolveProfile(database, identity);
  // One staff-role read serves both the plan's staff exemption and the Admin link; it runs beside the entitlement read.
  const [override, platformRole] = await Promise.all([database.pilotEntitlement.findUnique({ where: { profileId: profile.id } }), staffRole(database, profile.id)]);
  const plan = accountPlan(override, new Date(), process.env, platformRole !== null);
  return { profile, entitlement: { active: plan.allowed, maxOwnedProjects: plan.maxOwnedProjects }, platformRole };
}
