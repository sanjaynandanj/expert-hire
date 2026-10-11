import type { AssessmentType, Prisma } from "../generated/client/client";

type RoundSource = {
  id: string; title: string; type: AssessmentType; durationMinutes: number;
  proctoringEnabled: boolean; desktopRequired: boolean; difficulty: string;
  promotionScore: number | null; rejectionScore: number | null; questions: Prisma.JsonValue;
  job: { id: string; title: string; description: string; requirements: Array<{ name: string; weight: number }> };
};
export type AssessmentConfiguration = {
  version: 1;
  round: Omit<RoundSource, "job">;
  job: RoundSource["job"];
};

// Freeze the existing written-session fallback prompts too; otherwise an empty
// authored question list would keep depending on mutable browser template code.
const fallbackQuestions = [
  { id: "q1", label: "Tell us about a distributed service you made more reliable. What failed, and what did you change?" },
  { id: "q2", label: "A queue is building faster than workers can process it. Walk through how you would diagnose and stabilize the system." },
  { id: "q3", label: "Describe a technical decision you changed after another person challenged it." }
];

export function snapshotAssessmentConfiguration(round: RoundSource): AssessmentConfiguration {
  return { version: 1, round: {
    id: round.id, title: round.title, type: round.type, durationMinutes: round.durationMinutes,
    proctoringEnabled: round.proctoringEnabled, desktopRequired: round.desktopRequired,
    difficulty: round.difficulty, promotionScore: round.promotionScore, rejectionScore: round.rejectionScore,
    questions: structuredClone(Array.isArray(round.questions) && round.questions.length === 0 ? fallbackQuestions : round.questions)
  }, job: { id: round.job.id, title: round.job.title, description: round.job.description,
    requirements: round.job.requirements.map(({ name, weight }) => ({ name, weight })) } };
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const types = ["RESUME_SCREEN", "AI_INTERVIEW", "HUMAN_INTERVIEW", "CODING_TEST", "PROMPT_ASSESSMENT"];
export function resolveAssessmentConfiguration(assessment: { configuration: unknown; round: RoundSource }): AssessmentConfiguration {
  if (assessment.configuration === null || assessment.configuration === undefined) return snapshotAssessmentConfiguration(assessment.round);
  const value = assessment.configuration;
  if (!object(value) || value.version !== 1 || !object(value.round) || !object(value.job)) throw new Error("Invalid stored assessment configuration.");
  const round = value.round, job = value.job;
  if (typeof round.id !== "string" || round.id !== assessment.round.id || typeof round.title !== "string" || typeof round.type !== "string" || !types.includes(round.type)
    || typeof round.durationMinutes !== "number" || !Number.isInteger(round.durationMinutes) || round.durationMinutes < 0 || round.durationMinutes > 240
    || typeof round.proctoringEnabled !== "boolean" || typeof round.desktopRequired !== "boolean" || typeof round.difficulty !== "string"
    || !Array.isArray(round.questions) || ![round.promotionScore, round.rejectionScore].every((score) => score === null || typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= 100)
    || typeof job.id !== "string" || job.id !== assessment.round.job.id || typeof job.title !== "string" || typeof job.description !== "string" || !Array.isArray(job.requirements)
    || !job.requirements.every((item) => object(item) && typeof item.name === "string" && typeof item.weight === "number" && Number.isInteger(item.weight) && item.weight > 0 && item.weight <= 100)) throw new Error("Invalid stored assessment configuration.");
  // Only server-generated, validated configuration is consumed. Malformed stored
  // snapshots must not fall back to a changed round and bypass coding guards.
  return value as unknown as AssessmentConfiguration;
}
