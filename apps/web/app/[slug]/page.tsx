import { ArrowRight, CheckCircle2 } from "lucide-react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../../components/marketing";

const pages: Record<string, { eyebrow: string; title: string; intro: string; points: string[]; color: string }> = {
  employers: { eyebrow: "For employers", title: "Run every round on one honest rubric.", intro: "Move from role definition to evidence-backed decision without losing context between tools.", points: ["Weighted role requirements", "Five assessment modes", "One pipeline and report"], color: "var(--mint)" },
  staffing: { eyebrow: "For staffing teams", title: "Every client, separate. Every outcome, connected.", intro: "Operate isolated client workspaces, branded delivery, commercial terms, and recruiter performance from one agency account.", points: ["Client-level data isolation", "Fees and guarantees", "Share-ready evidence"], color: "var(--sky)" },
  universities: { eyebrow: "For universities", title: "Turn placement readiness into something you can act on.", intro: "Give students targeted practice and give placement teams the operating system for drives, offers, and joining outcomes.", points: ["Cohort readiness", "Placement drive ERP", "Branch and outcome analytics"], color: "var(--mint)" },
  candidates: { eyebrow: "For candidates", title: "Get useful feedback before the real decision.", intro: "Practice interviews, code, resumes, prompts, and pitches against the work you actually want to do.", points: ["Role-specific practice", "Evidence behind every score", "One readiness history"], color: "var(--coral)" },
  pricing: { eyebrow: "Simple usage", title: "Pay for evidence produced, not seats occupied.", intro: "One shared workspace balance across screening, interviews, coding, and prompt assessments. Local demos never charge a card.", points: ["Unlimited collaborators", "Clear credit ledger", "Campus licensing available"], color: "var(--mint)" },
  security: { eyebrow: "Trust center", title: "Isolation, consent, and human judgment by design.", intro: "Tenant-scoped access, auditable actions, expiring links, and advisory-only AI are architectural requirements—not policy footnotes.", points: ["Role-based access", "Evidence and consent records", "Human review required"], color: "var(--sky)" },
  developers: { eyebrow: "Developer platform", title: "Put accountable assessment inside your product.", intro: "A versioned API, secure launch links, idempotent writes, signed webhooks, and a deterministic sandbox for local development.", points: ["OpenAPI-first REST", "Test and live environments", "Embeddable candidate journeys"], color: "var(--mint)" },
  contact: { eyebrow: "Start a conversation", title: "Bring one role, cohort, or client workflow.", intro: "We will map it into Northstar and show you where evidence can replace manual reconciliation.", points: ["Product walkthrough", "Architecture review", "Implementation planning"], color: "var(--coral)" }
};

export function generateStaticParams() { return Object.keys(pages).map((slug) => ({ slug })); }

export default async function MarketingDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = pages[slug];
  if (!page) notFound();
  return <><SiteHeader /><main><section className="hero" style={{ minHeight: 680, background: `radial-gradient(circle at 80% 30%, ${page.color}, transparent 31%), var(--cream)` }}><div className="container" style={{ paddingBlock: 115 }}><span className="eyebrow">{page.eyebrow}</span><h1 className="display" style={{ maxWidth: 950, margin: "22px 0", fontSize: "clamp(4rem, 8vw, 7.4rem)" }}>{page.title}</h1><p className="hero-copy">{page.intro}</p><div className="hero-actions"><Link href="/workspace" className="button button-primary">Explore the product <ArrowRight size={16} /></Link><Link href="/contact" className="button button-light">Talk to us</Link></div></div></section><section className="section"><div className="container"><div className="section-head"><div><span className="eyebrow">What it changes</span><h2 className="display">From activity to accountable progress.</h2></div><p className="muted">The product keeps each decision attached to the criteria and evidence that shaped it, while permissions keep every workspace in its lane.</p></div><div className="feature-grid">{page.points.map((point, index) => <article className="card feature-card" key={point}><div className="feature-icon"><CheckCircle2 size={21} /></div><div><span className="eyebrow muted">0{index + 1}</span><h3>{point}</h3><p>Designed as a working part of the operating model, with clear ownership and audit history.</p></div></article>)}</div></div></section></main><SiteFooter /></>;
}
