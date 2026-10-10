import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import "@/features/shell/ui/shell.css";
import "@/features/studio/ui/studio.css";
import "@/features/shell/ui/flow-dialog.css";
import "@/features/proposals/ui/ai.css";
import "@/features/scope/ui/specs.css";
import "@/features/reviews/ui/review.css";
import { signOut } from "@/features/access/server/actions";
import ProjectShell from "@/features/shell/ui/project-shell";
import { PageAccessBoundary } from "@/features/access/ui/page-access";
import AuthCard from "@/features/access/ui/auth-card";

// One shell for /app and /app/projects/[projectId]. It stays mounted across project switches, so the sidebar
// and the per-project UI store survive while each project's editor and panel subtree remounts.
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <PageAccessBoundary shell={<ProjectShell signOut={signOut}>{null}</ProjectShell>} unavailable={
    <AuthCard title="ScopeRoom is temporarily unavailable" description="We could not confirm your access. Try again when the service is available.">
      <form method="get" className="login-form"><button type="submit">Retry</button></form>
    </AuthCard>
  }>{children}</PageAccessBoundary>;
}
