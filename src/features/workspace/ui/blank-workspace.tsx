import "./blank-workspace.css";
import WorkspaceHome from "./workspace-home";

export default function BlankWorkspace({ signOut, projectId }: { signOut: () => Promise<void>; projectId?: string }) {
  return <WorkspaceHome signOut={signOut} projectId={projectId} />;
}