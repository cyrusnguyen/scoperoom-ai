import { getDatabase } from "../../../server/db.ts";
import { accountPlan } from "../../projects/server/plan.ts";
import { resolveProfile } from "./profile.ts";

export async function getMe(identity: { authUserId: string; displayName: string }) {
  const database = await getDatabase();
  const profile = await resolveProfile(database, identity);
  const plan = accountPlan(await database.pilotEntitlement.findUnique({ where: { profileId: profile.id } }));
  return { profile, entitlement: { active: plan.allowed, maxOwnedProjects: plan.maxOwnedProjects } };
}
