import { SignJWT, jwtVerify } from "jose";

const issuer = "northstar-api";
const audience = "northstar-web";

function key() {
  const configuredSecret = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!configuredSecret || configuredSecret.length < 32)) {
    throw new Error("SESSION_SECRET must be configured with at least 32 characters in production");
  }
  const secret = configuredSecret ?? "local-development-secret-change-me";
  return new TextEncoder().encode(secret);
}

export type SessionIdentity = { userId: string; sessionId: string };

export async function createSessionToken(userId: string, sessionId: string, expiresAt: Date): Promise<string> {
  return new SignJWT({ purpose: "session" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(sessionId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
    .sign(key());
}

export async function readSessionToken(token: string): Promise<SessionIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { issuer, audience });
    return payload.purpose === "session" && payload.sub && payload.jti ? { userId: payload.sub, sessionId: payload.jti } : null;
  } catch {
    return null;
  }
}
