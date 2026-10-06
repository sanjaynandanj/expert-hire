import { describe, expect, it } from "vitest";
import { createSessionToken, readSessionToken } from "./auth";

describe("session tokens", () => {
  it("round-trips the user identity", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const token = await createSessionToken("user_demo", "session_demo", expiresAt);
    await expect(readSessionToken(token)).resolves.toEqual({ userId: "user_demo", sessionId: "session_demo" });
  });

  it("rejects tampered input", async () => {
    await expect(readSessionToken("not-a-token")).resolves.toBeNull();
  });

  it("rejects expired signed sessions", async () => {
    const token = await createSessionToken("user_demo", "session_expired", new Date(Date.now() - 1_000));
    await expect(readSessionToken(token)).resolves.toBeNull();
  });
});
