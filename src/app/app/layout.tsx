import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import "@/features/shell/ui/shell.css";
import "@/features/studio/ui/studio.css";
import { signOut } from "@/features/access/server/actions";
import ProjectShell from "@/features/shell/ui/project-shell";

// One shell for /app and /app/projects/[projectId]. It stays mounted across project switches, so the sidebar
// and the per-project UI store survive while each project's editor and panel subtree remounts.
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <ProjectShell signOut={signOut}>{children}</ProjectShell>;
}
