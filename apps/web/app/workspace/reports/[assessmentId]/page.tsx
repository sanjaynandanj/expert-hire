import { LiveAssessmentReport } from "../../../../components/live-assessments";
import { WorkspaceShell } from "../../../../components/workspace-shell";

export default async function AssessmentReportPage({ params }: { params: Promise<{ assessmentId: string }> }) {
  const { assessmentId } = await params;
  return <WorkspaceShell active="Assessments"><LiveAssessmentReport assessmentId={assessmentId} /></WorkspaceShell>;
}
