import { describe, expect, it } from "vitest";
import { resolveAssessmentConfiguration, snapshotAssessmentConfiguration } from "./assessment-configuration";

function source() {
  return { id: "round", title: "Original round", type: "AI_INTERVIEW" as const, durationMinutes: 20,
    proctoringEnabled: false, desktopRequired: false, difficulty: "MEDIUM", promotionScore: 70, rejectionScore: null,
    questions: [{ id: "original", label: "Original prompt" }],
    job: { id: "job", title: "Original role", description: "Original description", requirements: [{ name: "Original criterion", weight: 100 }] } };
}
describe("assessment configuration snapshots", () => {
  it("copies question and rubric data without retaining live references", () => {
    const round = source();
    const snapshot = snapshotAssessmentConfiguration(round);
    round.questions[0]!.label = "Edited prompt";
    round.job.requirements[0]!.name = "Edited criterion";
    expect(snapshot.round.questions).toEqual([{ id: "original", label: "Original prompt" }]);
    expect(snapshot.job.requirements).toEqual([{ name: "Original criterion", weight: 100 }]);
  });
  it("uses the invitation snapshot rather than later live edits", () => {
    const round = source();
    const snapshot = snapshotAssessmentConfiguration(round);
    expect(resolveAssessmentConfiguration({ configuration: snapshot, round: { ...round, type: "CODING_TEST", title: "Changed" } })).toEqual(snapshot);
  });
  it("does not replace a stored coding guard with a later non-coding round", () => {
    const round = source();
    const snapshot = snapshotAssessmentConfiguration({ ...round, type: "CODING_TEST" });
    expect(resolveAssessmentConfiguration({ configuration: snapshot, round }).round.type).toBe("CODING_TEST");
  });
  it("supports legacy records without pretending their history was frozen", () => {
    const round = source();
    expect(resolveAssessmentConfiguration({ configuration: null, round })).toEqual(snapshotAssessmentConfiguration(round));
  });
  it("materializes fallback questions so empty plans do not depend on browser changes", () => {
    const snapshot = snapshotAssessmentConfiguration({ ...source(), questions: [] });
    expect(snapshot.round.questions).toHaveLength(3);
    expect(snapshot.round.questions).toMatchObject([{ id: "q1" }, { id: "q2" }, { id: "q3" }]);
  });
  it.each([{}, { version: 2 }, { ...snapshotAssessmentConfiguration(source()), round: { type: "AI_INTERVIEW" } }])("rejects malformed snapshots instead of using live data", (configuration) => {
    expect(() => resolveAssessmentConfiguration({ configuration, round: source() })).toThrow(/Invalid stored/);
  });
});
