import type { ReactNode } from "react";
import "@/features/shell/ui/shell.css";
import "@/features/admin/ui/admin.css";

// Staff screens sit outside the project shell: a plain page with its own scroll, using the shell's controls and tokens.
export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="app-shell admin-shell"><main id="admin-main" className="admin-main">{children}</main></div>;
}
