import { getDatabase } from "../../../server/db.ts";
import { ownerPlan } from "../../projects/server/access.ts";
import { resolveProfile } from "./profile.ts";

export async function getMe(identity: { authUserId: string; displayName: string }) {
  const database = await getDatabase();
  const profile = await resolveProfile(database, identity);
  const plan = await ownerPlan(database, profile.id);
  return { profile, entitlement: { active: plan.allowed, maxOwnedProjects: plan.maxOwnedProjects } };
}
