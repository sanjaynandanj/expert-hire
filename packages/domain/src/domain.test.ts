import { describe, expect, it } from "vitest";
import { applyCreditMovement, calculateWeightedScore, canTransitionAssessment, checkPlacementEligibility, hasPermission, jobSchema } from "./index";

describe("assessment transitions", () => {
  it("allows the normal processing path", () => {
    expect(canTransitionAssessment("PENDING", "SCHEDULED")).toBe(true);
    expect(canTransitionAssessment("PROCESSING", "COMPLETED")).toBe(true);
  });

  it("does not allow an integrity flag to make a hiring decision", () => {
    expect(canTransitionAssessment("IN_PROGRESS", "REJECTED")).toBe(false);
  });
});

describe("job validation", () => {
  it("requires meaningful scoring input", () => {
    const result = jobSchema.safeParse({
      title: "Platform engineer",
      description: "too short",
      requirements: []
    });
    expect(result.success).toBe(false);
  });
});

describe("permissions", () => {
  it("keeps recruiter access away from billing and member administration", () => {
    expect(hasPermission("RECRUITER", "candidate.manage")).toBe(true);
    expect(hasPermission("RECRUITER", "billing.manage")).toBe(false);
    expect(hasPermission("RECRUITER", "member.manage")).toBe(false);
  });

  it("gives viewers read access only", () => {
    expect(hasPermission("VIEWER", "report.read")).toBe(true);
    expect(hasPermission("VIEWER", "job.create")).toBe(false);
  });
});

describe("evidence scoring", () => {
  it("honours the configured criterion weights", () => {
    expect(calculateWeightedScore([
      { name: "Systems", score: 90, weight: 80 },
      { name: "Communication", score: 50, weight: 20 }
    ])).toBe(82);
  });

  it("rejects an empty or zero-weight rubric", () => {
    expect(() => calculateWeightedScore([])).toThrow("At least one");
    expect(() => calculateWeightedScore([{ name: "Unused", score: 90, weight: 0 }])).toThrow("carry weight");
  });
});

describe("credit ledger rules", () => {
  it("prevents spending more than the available balance", () => {
    expect(applyCreditMovement(10, -5)).toBe(5);
    expect(() => applyCreditMovement(2, -3)).toThrow("Insufficient credits");
  });
});

describe("placement eligibility", () => {
  const drive = { eligibleBranches: ["CSE", "ECE"], minCgpa: 7, allowPlaced: true, ctcMax: 2_000_000 };
  const policy = { offerCap: 2, upgradeMultiple: 1.5 };

  it("accepts an eligible unplaced student", () => {
    expect(checkPlacementEligibility({ branch: "CSE", cgpa: 8.2, blacklisted: false, placed: false, acceptedOffers: 0, currentCtc: null }, drive, policy)).toEqual({ eligible: true, reasons: [] });
  });

  it("explains every policy failure rather than returning a bare false", () => {
    const result = checkPlacementEligibility({ branch: "Mechanical", cgpa: 6.4, blacklisted: true, placed: true, acceptedOffers: 2, currentCtc: 1_800_000 }, drive, policy);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("Branch is not eligible");
    expect(result.reasons).toContain("Offer cap has been reached");
    expect(result.reasons).toContain("Drive does not meet the placement upgrade threshold");
  });
});
