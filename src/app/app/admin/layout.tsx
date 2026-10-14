import Link from "next/link";
import type { ReactNode } from "react";
import "@/features/shell/ui/shell.css";
import "@/features/admin/ui/admin.css";

// Staff screens sit outside the project shell: a plain page with its own scroll, using the shell's controls and tokens.
export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="app-shell admin-shell">
    <nav className="admin-nav" aria-label="Staff">
      <Link className="button quiet small" href="/app">Back to projects</Link>
      <Link className="button quiet small" href="/app/admin">Accounts</Link>
    </nav>
    <main id="admin-main" className="admin-main">{children}</main>
  </div>;
}
