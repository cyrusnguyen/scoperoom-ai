import type { PrismaClient } from "../../../../prisma/generated/client.ts";

type ProfileIdentity = {
  authUserId: string;
  displayName: string;
};

function normalizedDisplayName(value: string) {
  const displayName = value.normalize("NFC").trim();
  if (!displayName || Array.from(displayName).length > 120) throw new Error("Invalid trusted display name.");
  return displayName;
}

const profileSelect = { id: true, displayName: true } as const;

/** Resolves or creates the profile. The name is captured once: Auth metadata is user-editable, so later requests never rewrite it. */
export async function resolveProfile(database: PrismaClient, identity: ProfileIdentity) {
  const existing = await database.userProfile.findUnique({ where: { authUserId: identity.authUserId }, select: profileSelect });
  if (existing) return existing;
  try {
    return await database.userProfile.create({ data: { authUserId: identity.authUserId, displayName: normalizedDisplayName(identity.displayName) }, select: profileSelect });
  } catch (error) {
    const created = await database.userProfile.findUnique({ where: { authUserId: identity.authUserId }, select: profileSelect });
    if (created) return created;
    throw error;
  }
}
