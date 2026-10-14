import "server-only";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getMe } from "@/features/access/server/me";
import type { StaffRole } from "@/features/admin/contracts/admin";
import AuthCard from "@/features/access/ui/auth-card";
import { classifyIdentity } from "@/server/web/identity";
import { requireVerifiedUser } from "@/server/web/require-user";

/**
 * Gates a staff page on the server before anything renders: a signed-in account without a staff role gets the app's not-found page
 * (the same answer the API gives), so no staff screen or data is ever sent to it. An outage is never read as "not staff" or as staff.
 */
export default async function StaffOnly({ children }: { children: (role: StaffRole, viewerId: string) => ReactNode }) {
  const user = await requireVerifiedUser();
  const identity = user ? classifyIdentity({ user, error: null }) : null;
  const me = identity?.kind === "user" ? await getMe(identity.user).catch(() => undefined) : undefined;
  const platformRole = me?.platformRole;
  if (platformRole === undefined) {
    return <AuthCard title="ScopeRoom is temporarily unavailable" description="We could not confirm your access. Try again when the service is available.">
      <form method="get" className="login-form"><button type="submit">Retry</button></form>
    </AuthCard>;
  }
  if (!platformRole) notFound();
  return children(platformRole, me!.profile.id);
}
