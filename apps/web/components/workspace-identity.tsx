"use client";

import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";

type Workspace = { organization: { name: string; type: string; creditBalance: number }; membership: { role: string } };
type Session = { user: { name: string }; organizations: Array<{ id: string; name: string; type: string; role: string }> };

export function WorkspaceIdentity({ variant = "organization" }: { variant?: "organization" | "user" }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [name, setName] = useState("Guest");
  const [role, setRole] = useState("");
  const [organizations, setOrganizations] = useState<Session["organizations"]>([]);
  const [organizationId, setOrganizationId] = useState("");

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`${apiUrl}/v1/auth/session`, { credentials: "include" });
        if (!response.ok) return;
        const session = await response.json() as Session;
        if (!active) return;
        setName(session.user.name);
        setOrganizations(session.organizations);
        let selectedId = window.localStorage.getItem("northstar.organizationId") ?? "";
        if (!session.organizations.some((item) => item.id === selectedId)) selectedId = session.organizations[0]?.id ?? "";
        if (selectedId) window.localStorage.setItem("northstar.organizationId", selectedId);
        setOrganizationId(selectedId);
        const selected = session.organizations.find((item) => item.id === selectedId);
        if (selected) setRole(selected.role);
        if (!selectedId) return;
        const workspaceResponse = await fetch(`${apiUrl}/v1/workspace`, {
          credentials: "include",
          headers: { "X-Organization-Id": selectedId }
        });
        if (active && workspaceResponse.ok) setWorkspace(await workspaceResponse.json() as Workspace);
      } catch { /* The demo shell remains available while the API is offline. */ }
    })();
    return () => { active = false; };
  }, []);

  function switchOrganization(nextId: string) {
    if (!organizations.some((organization) => organization.id === nextId)) return;
    window.localStorage.setItem("northstar.organizationId", nextId);
    window.location.reload();
  }

  async function signOut() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
    try { await fetch(`${apiUrl}/v1/auth/logout`, { method: "POST", credentials: "include" }); }
    catch { /* Clear local workspace state even if the API is offline. */ }
    finally {
      window.localStorage.removeItem("northstar.organizationId");
      window.location.assign("/login");
    }
  }

  if (variant === "user") return <div className="workspace-identity-user"><div className="avatar">{name.split(" ").map((part) => part[0]).join("").slice(0, 2) || "?"}</div><div><strong>{name}</strong>{organizations.length > 1 ? <select aria-label="Switch organization" className="identity-switch" value={organizationId} onChange={(event) => switchOrganization(event.target.value)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} · {organization.role}</option>)}</select> : <span>{role || "Workspace member"}</span>}</div>{name !== "Guest" && <button className="identity-signout" type="button" onClick={() => void signOut()} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>}</div>;
  return <div className="workspace-identity-org"><div><strong>{workspace?.organization.name ?? "Northstar workspace"}</strong><span className="tag">{workspace?.organization.type ?? "DEMO"}</span></div><div className="identity-meta"><span>{workspace ? `${workspace.organization.creditBalance.toLocaleString()} credits` : ""}</span></div></div>;
}
