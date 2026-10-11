import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

function signingKey() {
  const configured = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (process.env.NODE_ENV === "production" && (!configured || configured.length < 32)) throw new Error("WEBHOOK_ENCRYPTION_KEY must be configured with at least 32 characters in production");
  return scryptSync(configured ?? "local-development-webhook-encryption-key", "northstar-webhook-v1", 32);
}

export function encryptWebhookSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", signingKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptWebhookSecret(value: string) {
  const [version, iv, tag, ciphertext] = value.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted webhook secret");
  const decipher = createDecipheriv("aes-256-gcm", signingKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function webhookSignature(secret: string, timestamp: number, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function ipv4IsPublic(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === undefined || b === undefined || c === undefined) return false;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

function addressIsPublic(address: string) {
  const family = isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("::ffff:")) return false;
  const firstSegment = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return firstSegment >= 0x2000 && firstSegment <= 0x3fff && !normalized.startsWith("2001:db8:") && !normalized.startsWith("2001:0:") && !normalized.startsWith("2001:10:") && !normalized.startsWith("2001:20:") && firstSegment !== 0x2002;
}

async function withinWebhookDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 8_000): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Webhook timeout must be an integer between 1 and 30000 milliseconds.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Webhook request timed out.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}

async function resolveWebhookDestination(value: string, signal: AbortSignal) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Webhook URL must be an absolute HTTPS URL."); }
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash) throw new Error("Webhook URL must use HTTPS on port 443 and cannot contain credentials or a fragment.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("Webhook destinations must be public internet hosts.");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  // OS DNS lookup cannot be cancelled; never open a socket if it finishes after our deadline.
  signal.throwIfAborted();
  if (addresses.length === 0 || addresses.some(({ address }) => !addressIsPublic(address))) throw new Error("Webhook destinations must resolve only to public internet addresses.");
  return { url, address: addresses[0]!.address, family: isIP(addresses[0]!.address) };
}

export async function validateWebhookDestination(value: string) {
  return withinWebhookDeadline((signal) => resolveWebhookDestination(value, signal));
}

export async function sendSignedWebhook(input: { url: string; secret: string; eventId: string; eventType: string; payload: unknown; timeoutMs?: number }) {
  return withinWebhookDeadline(async (signal) => {
    const destination = await resolveWebhookDestination(input.url, signal);
    const body = JSON.stringify(input.payload);
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = webhookSignature(input.secret, timestamp, body);
    return new Promise<{ statusCode: number }>((resolve, reject) => {
      const request = httpsRequest(destination.url, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "Northstar-Webhooks/1.0",
          "X-Northstar-Event": input.eventType,
          "X-Northstar-Delivery": input.eventId,
          "X-Northstar-Signature": `t=${timestamp},v1=${signature}`
        },
        servername: destination.url.hostname.replace(/^\[|\]$/g, ""),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: destination.address, family: destination.family }]);
          else callback(null, destination.address, destination.family);
        }
      }, (response) => {
        const statusCode = response.statusCode ?? 0;
        // Only the status is needed. Do not retain sockets for an unbounded receiver body.
        response.destroy();
        if (statusCode >= 200 && statusCode < 300) resolve({ statusCode });
        else reject(Object.assign(new Error(`Webhook endpoint returned HTTP ${statusCode}.`), { statusCode }));
      });
      request.on("error", reject);
      request.end(body);
    });
  }, input.timeoutMs);
}

export function verifyWebhookSignature(input: { secret: string; timestamp: number; body: string; signature: string; now?: number }) {
  if (Math.abs(Math.floor((input.now ?? Date.now()) / 1_000) - input.timestamp) > 300) return false;
  const expected = Buffer.from(webhookSignature(input.secret, input.timestamp, input.body), "hex");
  let actual: Buffer;
  try { actual = Buffer.from(input.signature, "hex"); } catch { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
