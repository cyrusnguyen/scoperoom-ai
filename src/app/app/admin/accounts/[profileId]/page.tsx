import AccountDetail from "@/features/admin/ui/account-detail";
import StaffOnly from "../../staff-only";

export const dynamic = "force-dynamic";

export default async function AdminAccountPage({ params }: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await params;
  return <StaffOnly>{(role, viewerId) => <AccountDetail profileId={profileId} role={role} viewerId={viewerId} />}</StaffOnly>;
}
