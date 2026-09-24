import "./blank-workspace.css";
import WorkspaceHome from "./workspace-home";

export default function BlankWorkspace({ signOut }: { signOut: () => Promise<void> }) {
  return <WorkspaceHome signOut={signOut} />;
}