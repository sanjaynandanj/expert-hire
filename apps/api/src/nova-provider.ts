import { z } from "zod";

export type NovaFrame = { kind: "user"; text: string } | { kind: "model"; output: Record<string, unknown>[]; calls?: NovaModelCall[]; text?: string } | { kind: "tool"; id: string; result: string };
export type NovaModelCall = { id: string; name: string; arguments: string };
export type NovaModelTurn = { output: Record<string, unknown>[]; calls: NovaModelCall[]; text: string };
export type NovaModelTool = { name: string; description: string; parameters: Record<string, unknown> };
export interface NovaModelProvider {
  identity?: { protocol: string; model: string };
  turn(input: { instructions: string; frames: NovaFrame[]; tools: NovaModelTool[]; signal?: AbortSignal }): Promise<NovaModelTurn>;
}
export class NovaProviderError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) { super(code); }
}
type Configuration = { protocol: "responses" | "chat-completions"; baseUrl: string; model: string; key: string; ollamaLocal: boolean };
function configuration(): Configuration | null {
  const { NOVA_PROVIDER: protocol, NOVA_BASE_URL: baseUrl, NOVA_MODEL: model, NOVA_API_KEY: key } = process.env;
  if (!protocol || !baseUrl || !model || !key) return null;
  if (!["responses", "chat-completions"].includes(protocol)) throw new NovaProviderError("nova_configuration_invalid");
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const ollamaLocal = process.env.NOVA_COMPATIBILITY === "ollama-local";
  if ((process.env.NOVA_COMPATIBILITY && !ollamaLocal) || (ollamaLocal && (!local || protocol !== "chat-completions"))) throw new NovaProviderError("nova_configuration_invalid");
  if ((url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) throw new NovaProviderError("nova_configuration_invalid");
  return { protocol: protocol as Configuration["protocol"], baseUrl: url.href.replace(/\/$/, ""), model, key, ollamaLocal };
}
export function novaAvailability() {
  try {
    const config = configuration();
    return config ? { configured: true, protocol: config.protocol, model: config.model, reason: null } : { configured: false, protocol: null, model: null, reason: "Nova is unavailable. Configure NOVA_PROVIDER, NOVA_BASE_URL, NOVA_MODEL and NOVA_API_KEY on the API server. No demo model is substituted." };
  } catch { return { configured: false, protocol: null, model: null, reason: "Nova's model configuration is invalid. Check the server-side provider settings." }; }
}
const recordSchema = z.record(z.string(), z.unknown());
const callSchema = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(80), arguments: z.string().max(20_000) });

/** Configuration selects a protocol, not a paid vendor/model. Never auto-fallback to mocks. */
export function createNovaProvider(): NovaModelProvider {
  let config: Configuration | null;
  try { config = configuration(); } catch { throw new NovaProviderError("nova_configuration_invalid"); }
  if (!config) throw new NovaProviderError("nova_provider_unavailable");
  const selected = config;
  return { identity: { protocol: selected.protocol, model: selected.model }, async turn(input) {
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(input.signal ? [input.signal] : [])]);
    const responseProtocol = selected.protocol === "responses";
    const history = input.frames.flatMap<Record<string, unknown>>((frame) => frame.kind === "user" ? [{ role: "user", content: frame.text }] : frame.kind === "model" ? frame.output : [responseProtocol ? { type: "function_call_output", call_id: frame.id, output: frame.result } : { role: "tool", tool_call_id: frame.id, content: frame.result }]);
    const tools = input.tools.map((tool) => responseProtocol ? { type: "function", ...tool, strict: false } : { type: "function", function: { ...tool, strict: false } });
    const toolSettings = tools.length ? { tools, parallel_tool_calls: false } : {};
    const body = responseProtocol
      ? { model: selected.model, instructions: input.instructions, input: history, ...toolSettings, store: false, max_output_tokens: 3000 }
      : { model: selected.model, messages: [{ role: "system", content: input.instructions }, ...history], ...toolSettings, store: false, ...(selected.ollamaLocal ? { max_tokens: 3000, reasoning_effort: "none", temperature: 0 } : { max_completion_tokens: 3000 }) };
    let response: Response;
    try {
      response = await fetch(`${selected.baseUrl}/${responseProtocol ? "responses" : "chat/completions"}`, { method: "POST", redirect: "error", signal, headers: { Authorization: `Bearer ${selected.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch { throw new NovaProviderError(input.signal?.aborted ? "nova_cancelled" : "nova_provider_network_error", !input.signal?.aborted); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NovaProviderError(response.status === 429 ? "nova_provider_rate_limited" : "nova_provider_request_failed", response.status === 429 || response.status >= 500);
    }
    let value: unknown;
    try {
      if (!response.body) throw new Error("empty response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 512_000) { await reader.cancel(); throw new Error("response limit"); }
        chunks.push(chunk.value);
      }
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { throw new NovaProviderError("nova_provider_invalid_response"); }
    try {
      const object = recordSchema.parse(value);
      const output = responseProtocol ? z.array(recordSchema).max(50).parse(object.output) : [recordSchema.parse(recordSchema.parse(z.array(recordSchema).parse(object.choices)[0]).message)];
      const calls: NovaModelCall[] = [];
      const texts: string[] = [];
      if (responseProtocol) {
        if (object.status !== "completed") throw new Error("incomplete response");
        for (const item of output) {
          if (item.type === "function_call") calls.push(callSchema.parse({ id: item.call_id, name: item.name, arguments: item.arguments }));
          if (item.type === "message") for (const content of z.array(recordSchema).parse(item.content)) if (content.type === "output_text") texts.push(z.string().parse(content.text));
        }
      } else {
        const message = output[0]!;
        const choice = z.array(recordSchema).parse(object.choices)[0]!;
        if (!["stop", "tool_calls"].includes(String(choice.finish_reason))) throw new Error("incomplete response");
        for (const item of z.array(recordSchema).nullish().parse(message.tool_calls) ?? []) {
          if (item.type !== "function") throw new Error("unsupported tool");
          const fn = recordSchema.parse(item.function);
          calls.push(callSchema.parse({ id: item.id, name: fn.name, arguments: fn.arguments }));
        }
        if (typeof message.content === "string") texts.push(message.content);
      }
      if (calls.length > 8 || new Set(calls.map((call) => call.id)).size !== calls.length) throw new Error("tool limit");
      return { output, calls, text: texts.join("\n") };
    } catch { throw new NovaProviderError("nova_provider_invalid_response"); }
  } };
}
