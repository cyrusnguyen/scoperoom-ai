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

export async function resolveProfile(database: PrismaClient, identity: ProfileIdentity) {
  return database.userProfile.upsert({
    where: { authUserId: identity.authUserId },
    create: { authUserId: identity.authUserId, displayName: normalizedDisplayName(identity.displayName) },
    update: { displayName: normalizedDisplayName(identity.displayName) },
    select: { id: true, displayName: true },
  });
}
