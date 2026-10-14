import AccountsView from "@/features/admin/ui/accounts-view";
import StaffOnly from "./staff-only";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <StaffOnly>{() => <AccountsView />}</StaffOnly>;
}
