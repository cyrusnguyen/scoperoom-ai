import "server-only";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getMe } from "@/features/access/server/me";
import type { StaffRole } from "@/features/admin/contracts/admin";
import { UnavailableCard } from "@/features/access/ui/auth-card";
import { requireVerifiedUser } from "@/server/web/require-user";

/**
 * Gates a staff page on the server before anything renders: a signed-in account without a staff role gets the app's not-found page
 * (the same answer the API gives), so no staff screen or data is ever sent to it. An outage is never read as "not staff" or as staff.
 */
export default async function StaffOnly({ children }: { children: (role: StaffRole, viewerId: string) => ReactNode }) {
  const user = await requireVerifiedUser();
  const me = user ? await getMe(user).catch(() => undefined) : undefined;
  const platformRole = me?.platformRole;
  if (platformRole === undefined) return <UnavailableCard />;
  if (!platformRole) notFound();
  return children(platformRole, me!.profile.id);
}
