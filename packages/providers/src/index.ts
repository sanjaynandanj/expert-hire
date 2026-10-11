import { calculateWeightedScore, type CriterionScore } from "@northstar/domain";
export { enqueuePersistedJobs, enqueuePersistedWebhooks } from "./webhook-queue";
export { createReadinessProbe } from "./readiness";
export { decryptWebhookSecret, encryptWebhookSecret, sendSignedWebhook, validateWebhookDestination, verifyWebhookSignature, webhookSignature } from "./webhooks";
export { authorizeMetrics, metricsContentType, OperationsMetrics, readMetricsToken, type WorkerTask, type WorkerOutcome } from "./operations-metrics";

export type EvaluationCriterion = { name: string; weight: number; description?: string };
export type EvaluationInput = {
  assessmentId: string;
  jobDescription: string;
  response: string;
  criteria: readonly EvaluationCriterion[];
};
export type EvaluationEvidence = CriterionScore & { rationale: string; evidence: string };
export type EvaluationResult = { overallScore: number; summary: string; evidence: EvaluationEvidence[]; advisoryOnly: true; provider: string };

export interface EvaluationProvider {
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}

export interface TranscriptionProvider {
  transcribe(input: { mediaUrl: string; language: string }): Promise<{ text: string; speakers: Array<{ speaker: string; text: string; startMs: number }> }>;
}

export interface SpeechProvider {
  synthesize(input: { text: string; voice: string; language: string }): Promise<{ audioUrl: string; durationMs: number }>;
}

export interface ObjectStorageProvider {
  createUploadUrl(input: { key: string; contentType: string; maxBytes: number }): Promise<{ url: string; expiresAt: Date }>;
  createReadUrl(key: string): Promise<{ url: string; expiresAt: Date }>;
}

export interface BillingProvider {
  createCheckout(input: { accountId: string; productCode: string; successUrl: string; cancelUrl: string }): Promise<{ checkoutUrl: string }>;
  readSubscription(accountId: string): Promise<{ status: "TRIAL" | "ACTIVE" | "PAST_DUE" | "CANCELLED"; plan: string }>;
}

function stableNumber(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function excerpt(response: string, keyword: string) {
  const normalized = response.replace(/\s+/g, " ").trim();
  const index = normalized.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) return normalized.slice(0, 180) || "No response evidence was submitted.";
  return normalized.slice(Math.max(0, index - 45), Math.min(normalized.length, index + keyword.length + 110));
}

export class LocalEvaluationProvider implements EvaluationProvider {
  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    if (input.criteria.length === 0) throw new Error("Evaluation criteria are required");
    const responseWords = new Set(input.response.toLowerCase().split(/\W+/).filter(Boolean));
    const evidence = input.criteria.map((criterion) => {
      const keywords = criterion.name.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
      const matches = keywords.filter((keyword) => responseWords.has(keyword)).length;
      const coverage = keywords.length ? matches / keywords.length : 0;
      const base = 54 + Math.round(coverage * 24);
      const deterministicVariation = stableNumber(`${input.assessmentId}:${criterion.name}`) % 17;
      const score = Math.min(96, base + deterministicVariation);
      return {
        name: criterion.name,
        weight: criterion.weight,
        score,
        rationale: matches ? `The response addressed ${matches} rubric signal${matches === 1 ? "" : "s"} and supplied reviewable context.` : "The response offered indirect evidence; a reviewer should probe this criterion.",
        evidence: excerpt(input.response, keywords[0] ?? criterion.name)
      };
    });
    const overallScore = calculateWeightedScore(evidence);
    return {
      overallScore,
      summary: overallScore >= 80 ? "Strong evidence across the weighted rubric. Human review is still required." : overallScore >= 65 ? "Mixed but useful evidence. Review the lower-weighted criteria before deciding." : "The submitted evidence leaves important rubric gaps for a human reviewer to explore.",
      evidence,
      advisoryOnly: true,
      provider: "local-deterministic-v1"
    };
  }
}

export class LocalBillingProvider implements BillingProvider {
  async createCheckout(input: { accountId: string; productCode: string; successUrl: string; cancelUrl: string }) {
    const reference = stableNumber(`${input.accountId}:${input.productCode}`);
    return { checkoutUrl: `${input.successUrl}?local_checkout=${reference}` };
  }

  async readSubscription(_accountId: string) {
    return { status: "TRIAL" as const, plan: "LOCAL_DEMO" };
  }
}
