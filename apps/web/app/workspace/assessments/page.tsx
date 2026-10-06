import { WorkspaceShell } from "../../../components/workspace-shell";
import { LiveAssessments } from "../../../components/live-assessments";

export default function AssessmentsPage() {
  return <WorkspaceShell active="Assessments"><LiveAssessments /></WorkspaceShell>;
}
