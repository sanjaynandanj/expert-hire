import { z } from "zod";

export const workspaceTypes = ["EMPLOYER", "AGENCY", "UNIVERSITY"] as const;
export const roles = [
  "PLATFORM_ADMIN",
  "OWNER",
  "ADMIN",
  "HIRING_MANAGER",
  "RECRUITER",
  "INTERVIEWER",
  "PLACEMENT_COORDINATOR",
  "VIEWER",
  "STUDENT",
  "CANDIDATE"
] as const;

export const assessmentTypes = [
  "RESUME_SCREEN",
  "AI_INTERVIEW",
  "HUMAN_INTERVIEW",
  "CODING_TEST",
  "PROMPT_ASSESSMENT"
] as const;

export const assessmentStatuses = [
  "PENDING",
  "SCHEDULED",
  "IN_PROGRESS",
  "PROCESSING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "SHORTLISTED",
  "REJECTED"
] as const;

export const jobSchema = z.object({
  title: z.string().trim().min(2).max(120),
  location: z.string().trim().max(120).optional(),
  description: z.string().trim().min(100).max(20_000),
  language: z.string().trim().min(2).max(40).default("English"),
  workflowEnabled: z.boolean().default(false),
  requirements: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        weight: z.number().int().min(0).max(100)
      })
    )
    .min(1)
});

export const assessmentTransitionSchema = z.object({
  from: z.enum(assessmentStatuses),
  to: z.enum(assessmentStatuses)
});

const transitions: Record<(typeof assessmentStatuses)[number], readonly string[]> = {
  PENDING: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["PROCESSING", "CANCELLED", "FAILED"],
  PROCESSING: ["COMPLETED", "FAILED"],
  COMPLETED: ["SHORTLISTED", "REJECTED"],
  CANCELLED: [],
  FAILED: ["PENDING"],
  SHORTLISTED: ["REJECTED"],
  REJECTED: ["SHORTLISTED"]
};

export function canTransitionAssessment(from: string, to: string): boolean {
  return (transitions[from as keyof typeof transitions] ?? []).includes(to);
}

export type JobInput = z.infer<typeof jobSchema>;
export type AssessmentType = (typeof assessmentTypes)[number];
export type AssessmentStatus = (typeof assessmentStatuses)[number];

export const permissions = [
  "job.read",
  "job.create",
  "job.manage",
  "candidate.read",
  "candidate.manage",
  "assessment.review",
  "report.read",
  "placement.manage",
  "university.manage",
  "billing.read",
  "billing.manage",
  "member.manage",
  "settings.manage"
] as const;

export type Role = (typeof roles)[number];
export type Permission = (typeof permissions)[number];

const permissionMatrix: Record<Role, readonly Permission[]> = {
  PLATFORM_ADMIN: permissions,
  OWNER: permissions,
  ADMIN: permissions.filter((permission) => permission !== "billing.manage"),
  HIRING_MANAGER: ["job.read", "job.create", "job.manage", "candidate.read", "candidate.manage", "assessment.review", "report.read", "billing.read"],
  RECRUITER: ["job.read", "job.create", "candidate.read", "candidate.manage", "assessment.review", "report.read"],
  INTERVIEWER: ["job.read", "candidate.read", "assessment.review", "report.read"],
  PLACEMENT_COORDINATOR: ["candidate.read", "report.read", "placement.manage", "university.manage"],
  VIEWER: ["job.read", "candidate.read", "report.read"],
  STUDENT: [],
  CANDIDATE: []
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return permissionMatrix[role].includes(permission);
}

export type CriterionScore = {
  name: string;
  score: number;
  weight: number;
};

export function calculateWeightedScore(criteria: readonly CriterionScore[]): number {
  if (criteria.length === 0) throw new Error("At least one scored criterion is required");
  const invalid = criteria.some(({ score, weight }) => score < 0 || score > 100 || weight < 0 || weight > 100);
  if (invalid) throw new Error("Scores and weights must be between 0 and 100");
  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (totalWeight === 0) throw new Error("At least one criterion must carry weight");
  return Math.round(criteria.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / totalWeight);
}

export const creditCosts: Record<AssessmentType, number> = {
  RESUME_SCREEN: 1,
  HUMAN_INTERVIEW: 2,
  CODING_TEST: 3,
  PROMPT_ASSESSMENT: 3,
  AI_INTERVIEW: 5
};

export function applyCreditMovement(balance: number, amount: number): number {
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(amount)) throw new Error("Credit movements must be whole numbers");
  const next = balance + amount;
  if (next < 0) throw new Error("Insufficient credits");
  return next;
}

export type PlacementStudent = {
  branch: string;
  cgpa: number | null;
  blacklisted: boolean;
  placed: boolean;
  acceptedOffers: number;
  currentCtc: number | null;
};

export type PlacementDriveRule = {
  eligibleBranches: readonly string[];
  minCgpa: number | null;
  allowPlaced: boolean;
  ctcMax: number | null;
};

export type PlacementPolicy = {
  offerCap: number;
  upgradeMultiple: number | null;
};

export function checkPlacementEligibility(student: PlacementStudent, drive: PlacementDriveRule, policy: PlacementPolicy) {
  const reasons: string[] = [];
  if (student.blacklisted) reasons.push("Student access is restricted");
  if (drive.eligibleBranches.length > 0 && !drive.eligibleBranches.includes(student.branch)) reasons.push("Branch is not eligible");
  if (drive.minCgpa !== null && (student.cgpa === null || student.cgpa < drive.minCgpa)) reasons.push("CGPA is below the drive minimum");
  if (student.acceptedOffers >= policy.offerCap) reasons.push("Offer cap has been reached");
  if (student.placed && !drive.allowPlaced) reasons.push("Drive does not accept already placed students");
  if (student.placed && drive.allowPlaced && policy.upgradeMultiple !== null && student.currentCtc !== null && drive.ctcMax !== null && drive.ctcMax < student.currentCtc * policy.upgradeMultiple) {
    reasons.push("Drive does not meet the placement upgrade threshold");
  }
  return { eligible: reasons.length === 0, reasons };
}
