import { Activity, BarChart3, BriefcaseBusiness, Building2, CalendarDays, CircleDollarSign, FileCheck2, GraduationCap, LayoutDashboard, MessageCircleMore, Settings, ShieldCheck, UsersRound } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "./brand-mark";
import { WorkspaceIdentity } from "./workspace-identity";

const groups = [
  { label: "Overview", links: [{ href: "/workspace", name: "Dashboard", icon: LayoutDashboard }] },
  { label: "Recruiting", links: [{ href: "/workspace/pipeline", name: "Pipeline", icon: Activity }, { href: "/workspace/jobs", name: "Jobs", icon: BriefcaseBusiness }, { href: "/workspace/candidates", name: "Candidates", icon: UsersRound }, { href: "/workspace/assessments", name: "Assessments", icon: FileCheck2 }, { href: "/workspace/meetings", name: "Meetings", icon: CalendarDays }] },
  { label: "Operations", links: [{ href: "/workspace/clients", name: "Clients", icon: Building2 }, { href: "/workspace/placements", name: "Placements", icon: CircleDollarSign }, { href: "/workspace/analytics", name: "Analytics", icon: BarChart3 }] },
  { label: "Workspace", links: [{ href: "/workspace/copilot", name: "Ask Nova", icon: MessageCircleMore }, { href: "/workspace/university", name: "Campus", icon: GraduationCap }, { href: "/workspace/settings", name: "Settings", icon: Settings }] }
];

export function WorkspaceShell({ children, active = "Dashboard" }: { children: React.ReactNode; active?: string }) {
  return <div className="workspace-shell">
    <aside className="sidebar">
      <Link href="/" aria-label="Northstar home"><BrandMark /></Link>
      <nav aria-label="Workspace navigation">
        {groups.map((group) => <div key={group.label}><div className="nav-label">{group.label}</div>{group.links.map(({ href, name, icon: Icon }) => <Link key={href} aria-label={name} className={`side-link ${name === active ? "active" : ""}`} href={href}><Icon size={18} /><span>{name}</span></Link>)}</div>)}
      </nav>
      <WorkspaceIdentity variant="user" />
    </aside>
    <section className="workspace-main">
      <header className="topbar"><WorkspaceIdentity /><ShieldCheck size={19} /></header>
      <main className="workspace-content">{children}</main>
    </section>
  </div>;
}
