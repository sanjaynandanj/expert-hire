import { afterEach, describe, expect, it, vi } from "vitest";
import { createNovaProvider, novaAvailability } from "./nova-provider";

function configured(protocol = "responses") {
  vi.stubEnv("NOVA_COMPATIBILITY", "");
  vi.stubEnv("NOVA_PROVIDER", protocol); vi.stubEnv("NOVA_BASE_URL", "https://provider.example.test/v1"); vi.stubEnv("NOVA_MODEL", "explicit-test-model"); vi.stubEnv("NOVA_API_KEY", "fictional-test-key-never-live");
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("Nova configurable real HTTP adapter (mocked network)", () => {
  it("has no fake fallback or implicit vendor/model when configuration is missing", () => {
    for (const key of ["NOVA_PROVIDER", "NOVA_BASE_URL", "NOVA_MODEL", "NOVA_API_KEY"]) vi.stubEnv(key, "");
    expect(novaAvailability()).toMatchObject({ configured: false });
    expect(() => createNovaProvider()).toThrow("nova_provider_unavailable");
  });
  it.each(["http://untrusted.example/v1", "https://user:secret@provider.example/v1", "https://provider.example/v1?key=secret"])("rejects unsafe configuration %s", (url) => {
    configured(); vi.stubEnv("NOVA_BASE_URL", url);
    expect(novaAvailability().configured).toBe(false);
    expect(() => createNovaProvider()).toThrow("nova_configuration_invalid");
  });
  it("round-trips Responses function calls and reasoning items without provider-side storage", async () => {
    configured();
    const output = [{ type: "reasoning", id: "reasoning-1", summary: [] }, { type: "function_call", call_id: "call-1", name: "list_roles", arguments: "{}" }];
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "completed", output })));
    vi.stubGlobal("fetch", fetch);
    const provider = createNovaProvider();
    const turn = await provider.turn({ instructions: "Fictional policy", frames: [{ kind: "user", text: "List roles" }], tools: [] });
    expect(turn.calls).toEqual([{ id: "call-1", name: "list_roles", arguments: "{}" }]);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }] })));
    await provider.turn({ instructions: "Fictional policy", frames: [{ kind: "model", output: turn.output }, { kind: "tool", id: "call-1", result: "{}" }], tools: [] });
    const body = JSON.parse(fetch.mock.calls[1]![1].body);
    expect(body.store).toBe(false);
    expect(body.input).toEqual([...output, { type: "function_call_output", call_id: "call-1", output: "{}" }]);
    expect(fetch.mock.calls[0]![0]).toBe("https://provider.example.test/v1/responses");
  });
  it("supports explicit chat-completions protocol and validates tool calls", async () => {
    configured("chat-completions");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "list_roles", arguments: "{}" } }] } }] }))));
    expect((await createNovaProvider().turn({ instructions: "Fictional policy", frames: [], tools: [] })).calls).toHaveLength(1);
  });
  it("uses explicitly selected loopback Ollama compatibility without cloud fallback", async () => {
    configured("chat-completions");
    vi.stubEnv("NOVA_COMPATIBILITY", "ollama-local"); vi.stubEnv("NOVA_BASE_URL", "http://127.0.0.1:11434/v1");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done" } }] })));
    vi.stubGlobal("fetch", fetch);
    await createNovaProvider().turn({ instructions: "Policy", frames: [], tools: [] });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ max_tokens: 3000, reasoning_effort: "none", temperature: 0 });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty("max_completion_tokens");
    vi.stubEnv("NOVA_BASE_URL", "https://provider.example.test/v1");
    expect(novaAvailability().configured).toBe(false);
  });
  it("returns only safe retryable error codes, never provider error bodies or credentials", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret upstream stack trace and fictional-test-key-never-live", { status: 429 })));
    await expect(createNovaProvider().turn({ instructions: "Policy", frames: [], tools: [] })).rejects.toMatchObject({ code: "nova_provider_rate_limited", retryable: true, message: "nova_provider_rate_limited" });
  });
  it("rejects malformed, truncated and oversized provider results", async () => {
    configured();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    for (const text of ["not json", JSON.stringify({ status: "incomplete", output: [] }), "x".repeat(512_001)]) {
      fetch.mockResolvedValueOnce(new Response(text));
      await expect(createNovaProvider().turn({ instructions: "Policy", frames: [], tools: [] })).rejects.toMatchObject({ code: "nova_provider_invalid_response", retryable: false });
    }
  });
});
