import { LivePipeline } from "../../../components/live-workspace";
import { WorkspaceShell } from "../../../components/workspace-shell";

export default function PipelinePage() {
  return <WorkspaceShell active="Pipeline"><LivePipeline /></WorkspaceShell>;
}
