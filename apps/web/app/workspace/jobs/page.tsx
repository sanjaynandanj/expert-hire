import { LiveJobs } from "../../../components/live-workspace";
import { WorkspaceShell } from "../../../components/workspace-shell";

export default function JobsPage() {
  return <WorkspaceShell active="Jobs"><LiveJobs /></WorkspaceShell>;
}
