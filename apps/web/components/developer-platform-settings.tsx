"use client";

import { useEffect, useState, type FormEvent } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const scopes = ["jobs:read", "candidates:read", "candidates:write"] as const;
const events = ["candidate.created", "candidate.updated", "candidate_job.created", "candidate_job.stage_changed", "assessment.completed", "meeting.created", "placement.application.created"] as const;
type ApiKey = { id: string; name: string; prefix: string; environment: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
type Webhook = { id: string; url: string; events: string[]; active: boolean; createdAt: string; _count: { deliveries: number } };
type Delivery = { id: string; eventType: string; status: string; attemptCount: number; lastStatusCode: number | null; lastError: string | null; deliveredAt: string | null; createdAt: string };

export function DeveloperPlatformSettings() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["candidate.created"]);
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["jobs:read", "candidates:write"]);
  const [createdSecret, setCreatedSecret] = useState<{ label: string; value: string } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const organizationId = window.localStorage.getItem("northstar.organizationId");
    if (!organizationId) throw new Error("Select a workspace before configuring developer access.");
    const response = await fetch(`${apiUrl}/v1${path}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", "X-Organization-Id": organizationId, ...init?.headers } });
    if (response.status === 204) return undefined as T;
    const body = await response.json() as T | { error?: { message?: string } };
    if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? body.error?.message ?? "Request failed." : "Request failed.");
    return body as T;
  }

  async function refresh() {
    try {
      const [keyList, webhookList] = await Promise.all([request<ApiKey[]>("/api-keys"), request<Webhook[]>("/webhooks")]);
      setKeys(keyList); setWebhooks(webhookList); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Developer settings could not be loaded."); }
  }
  useEffect(() => { void refresh(); }, []);

  function toggle(value: string, current: string[], update: (next: string[]) => void) {
    update(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setMessage("");
    try {
      const form = new FormData(event.currentTarget);
      const key = await request<ApiKey & { secret: string }>("/api-keys", { method: "POST", body: JSON.stringify({ name: form.get("keyName"), environment: form.get("keyEnvironment"), scopes: selectedScopes }) });
      setCreatedSecret({ label: `API key · ${key.name}`, value: key.secret }); setMessage("Copy this secret now. It cannot be viewed again."); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "API key could not be created."); }
    finally { setPending(false); }
  }

  async function createWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; setPending(true); setError(""); setMessage("");
    try {
      const form = new FormData(formElement);
      const endpoint = await request<Webhook & { secret: string }>("/webhooks", { method: "POST", body: JSON.stringify({ url: form.get("webhookUrl"), events: selectedEvents }) });
      setCreatedSecret({ label: `Webhook signing secret · ${endpoint.url}`, value: endpoint.secret }); setMessage("Copy this signing secret now. It cannot be viewed again."); formElement.reset(); setSelectedEvents(["candidate.created"]); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Webhook endpoint could not be created."); }
    finally { setPending(false); }
  }

  async function revokeKey(key: ApiKey) {
    try { await request(`/api-keys/${key.id}`, { method: "DELETE" }); setMessage(`Revoked ${key.name}.`); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "API key could not be revoked."); }
  }

  async function disableWebhook(endpoint: Webhook) {
    try { await request(`/webhooks/${endpoint.id}`, { method: "DELETE" }); setMessage("Webhook endpoint disabled."); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Webhook could not be disabled."); }
  }

  async function loadDeliveries(endpoint: Webhook) {
    try { const result = await request<Delivery[]>(`/webhooks/${endpoint.id}/deliveries`); setDeliveries((current) => ({ ...current, [endpoint.id]: result })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Delivery history could not be loaded."); }
  }

  async function replay(delivery: Delivery, endpoint: Webhook) {
    try { await request(`/webhooks/deliveries/${delivery.id}/replay`, { method: "POST", body: "{}" }); setMessage("Delivery queued for replay."); await loadDeliveries(endpoint); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Delivery could not be replayed."); }
  }

  return <section className="card panel" style={{ marginTop: 20 }}>
    <div className="panel-head"><div><h2>Developer access</h2><p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>Scoped API keys and signed event delivery.</p></div><span className="tag">Workspace</span></div>
    {error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status" className="notice account-notice">{message}</p>}
    {createdSecret && <div className="notice account-notice"><div style={{ minWidth: 0, flex: 1 }}><strong>{createdSecret.label}</strong><p className="muted" style={{ margin: "6px 0", fontSize: 12 }}>Shown once. Store it in a secret manager and close this panel when copied.</p><code className="secret-value">{createdSecret.value}</code></div><button className="button button-light" type="button" onClick={() => { void navigator.clipboard.writeText(createdSecret.value); setMessage("Secret copied to clipboard."); }}>Copy</button><button className="button button-light" type="button" onClick={() => setCreatedSecret(null)}>Close</button></div>}
    <div className="developer-grid">
      <form className="developer-form" onSubmit={createKey}><h3>Create API key</h3><label className="field"><span>Name</span><input className="input" name="keyName" minLength={2} maxLength={80} required /></label><label className="field"><span>Environment</span><select className="input" name="keyEnvironment"><option value="test">Test</option><option value="live">Live</option></select></label><fieldset className="scope-list"><legend>Scopes</legend>{scopes.map((scope) => <label key={scope}><input type="checkbox" checked={selectedScopes.includes(scope)} onChange={() => toggle(scope, selectedScopes, setSelectedScopes)} /> {scope}</label>)}</fieldset><button className="button button-primary" disabled={pending || selectedScopes.length === 0}>Create key</button></form>
      <form className="developer-form" onSubmit={createWebhook}><h3>Add webhook</h3><label className="field"><span>HTTPS endpoint</span><input className="input" name="webhookUrl" type="url" placeholder="https://example.com/hooks/northstar" required /></label><fieldset className="scope-list"><legend>Subscribed events</legend>{events.map((eventName) => <label key={eventName}><input type="checkbox" checked={selectedEvents.includes(eventName)} onChange={() => toggle(eventName, selectedEvents, setSelectedEvents)} /> {eventName}</label>)}</fieldset><button className="button button-primary" disabled={pending || selectedEvents.length === 0}>Create webhook</button></form>
    </div>
    <h3 className="developer-subhead">API keys</h3>{keys.length === 0 ? <p className="muted">No API keys yet.</p> : keys.map((key) => <article className="developer-row" key={key.id}><div><strong>{key.name}</strong><div className="muted">{key.prefix}… · {key.environment} · {key.scopes.join(", ")} · {key.revokedAt ? "Revoked" : key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}` : "Never used"}</div></div>{!key.revokedAt && <button className="button button-light" type="button" onClick={() => void revokeKey(key)}>Revoke</button>}</article>)}
    <h3 className="developer-subhead">Webhooks</h3>{webhooks.length === 0 ? <p className="muted">No endpoints configured.</p> : webhooks.map((endpoint) => <article className="developer-row developer-webhook" key={endpoint.id}><div><strong>{endpoint.url}</strong><div className="muted">{endpoint.events.join(", ")} · {endpoint._count.deliveries} deliveries · {endpoint.active ? "Active" : "Disabled"}</div></div><div className="developer-actions"><button className="button button-light" type="button" onClick={() => void loadDeliveries(endpoint)}>Deliveries</button>{endpoint.active && <button className="button button-light" type="button" onClick={() => void disableWebhook(endpoint)}>Disable</button>}</div>{deliveries[endpoint.id]?.map((delivery) => <div className="developer-delivery" key={delivery.id}><span><strong>{delivery.eventType}</strong> · {delivery.status} · {delivery.attemptCount} attempts{delivery.lastStatusCode ? ` · HTTP ${delivery.lastStatusCode}` : ""}{delivery.lastError ? ` · ${delivery.lastError}` : ""}</span>{delivery.status === "FAILED" && endpoint.active && <button className="button button-light" type="button" onClick={() => void replay(delivery, endpoint)}>Replay</button>}</div>)}</article>)}
  </section>;
}
