import { ArrowRight, CheckCircle2, CircleDot, Clock3 } from "lucide-react";
import { notFound } from "next/navigation";
import { LiveAnalytics, LiveCandidates, LiveClients, LiveMeetings } from "../../../components/live-workspace";
import { WorkspaceShell } from "../../../components/workspace-shell";

const sections: Record<string, { title: string; eyebrow: string; description: string; active: string; items: Array<[string, string, string]> }> = {
  candidates: { title: "Talent pool", eyebrow: "Recruiting", description: "People, evidence, ownership, and every role they are connected to.", active: "Candidates", items: [["Maya Chen", "Platform engineering · 84 evidence score", "Review"], ["Lina Alvarez", "Data analytics · 91 evidence score", "Shortlisted"], ["Theo Nwosu", "Product design · 78 evidence score", "Interview"]] },
  meetings: { title: "Meetings", eyebrow: "Recruiting", description: "Upcoming panels, instant rooms, and calls captured by the interview copilot.", active: "Meetings", items: [["Platform engineering panel", "Tomorrow · 10:30 · 3 attendees", "Confirmed"], ["Product portfolio review", "Tomorrow · 14:00 · 2 attendees", "Awaiting response"], ["Data analyst debrief", "Friday · 11:00 · 4 attendees", "Confirmed"]] },
  clients: { title: "Clients", eyebrow: "Agency operations", description: "Isolated workspaces, commercial terms, roles, and delivery health.", active: "Clients", items: [["Aster Labs", "Active · 4 open roles · 18% fee", "Healthy"], ["Kindred Cloud", "Briefing · 2 proposed roles · flat fee", "Setup"], ["Morrow Finance", "Active · 3 open roles · 90 day guarantee", "Healthy"]] },
  placements: { title: "Placements", eyebrow: "Commercial outcomes", description: "Fees, guarantees, starts, and recruiter attribution from the same pipeline.", active: "Placements", items: [["Maya Chen · Aster Labs", "$18,400 fee · starts 2 Nov", "Pending"], ["Jules Park · Morrow Finance", "$14,100 fee · started 18 Sep", "Received"], ["Aiko Tan · Aster Labs", "$16,800 fee · starts 12 Oct", "Invoiced"]] },
  analytics: { title: "Analytics", eyebrow: "Workspace intelligence", description: "Activity, conversion, quality, and outcomes without stitching spreadsheets.", active: "Analytics", items: [["Interview completion", "176 of 214 invitations completed", "82%"], ["Shortlist conversion", "43 of 82 reviewed candidates", "52%"], ["Offer acceptance", "16 of 19 offers accepted", "84%"]] },
  copilot: { title: "Ask Nova", eyebrow: "Recruiter copilot", description: "Explore your workspace in plain language. Writes always ask for confirmation.", active: "Ask Nova", items: [["Create a role draft", "Describe the role or attach a job description", "Draft only"], ["Rank a shortlist", "Compare completed evidence against the rubric", "Read-only"], ["Schedule interviews", "Find a time and prepare invitations", "Confirmation required"]] },
  settings: { title: "Workspace settings", eyebrow: "Administration", description: "Members, pipeline stages, branding, integrations, API access, and audit history.", active: "Settings", items: [["Members and roles", "12 active members · 2 invitations pending", "Manage"], ["Pipeline configuration", "7 stages · last changed 8 days ago", "Configure"], ["Security and audit", "MFA optional · 248 events this month", "Review"]] }
};

export default async function WorkspaceSection({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const config = sections[section];
  if (!config) notFound();
  if (section === "candidates") return <WorkspaceShell active="Candidates"><LiveCandidates /></WorkspaceShell>;
  if (section === "clients") return <WorkspaceShell active="Clients"><LiveClients /></WorkspaceShell>;
  if (section === "meetings") return <WorkspaceShell active="Meetings"><LiveMeetings /></WorkspaceShell>;
  if (section === "analytics") return <WorkspaceShell active="Analytics"><LiveAnalytics /></WorkspaceShell>;
  return <WorkspaceShell active={config.active}><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>{config.eyebrow}</p><h1>{config.title}</h1><span className="muted">{config.description}</span></div><button className="button button-primary">Create new <ArrowRight size={16} /></button></div><section className="card panel"><div className="panel-head"><h2>Current workspace</h2><span className="tag"><CircleDot size={13} /> Live demo data</span></div>{config.items.map(([title, subtitle, status], index) => <div key={title} style={{ display: "grid", gridTemplateColumns: "42px 1fr auto", gap: 13, alignItems: "center", padding: "17px 4px", borderTop: "1px solid var(--line)" }}><div className="stat-icon">{index === 1 ? <Clock3 size={17} /> : <CheckCircle2 size={17} />}</div><div><strong>{title}</strong><div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{subtitle}</div></div><span className="tag">{status}</span></div>)}</section></WorkspaceShell>;
}
