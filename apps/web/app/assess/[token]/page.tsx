import { AssessmentRoom } from "../../../components/assessment-room";

export default async function AssessmentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AssessmentRoom token={token} />;
}
