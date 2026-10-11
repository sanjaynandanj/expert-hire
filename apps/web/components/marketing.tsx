import { brand } from "@northstar/brand";
import { ArrowRight, Code2, GraduationCap, ShieldCheck, Sparkles, UsersRound } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "./brand-mark";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container site-header-inner">
        <Link href="/" aria-label="Northstar home"><BrandMark /></Link>
        <nav className="site-nav" aria-label="Main navigation">
          <Link href="/employers">Employers</Link>
          <Link href="/staffing">Staffing</Link>
          <Link href="/universities">Universities</Link>
          <Link href="/candidates">Candidates</Link>
          <Link href="/pricing">Pricing</Link>
        </nav>
        <div style={{ display: "flex", gap: 10 }}>
          <Link className="button button-light" href="/login">Sign in</Link>
          <Link className="button button-primary" href="/workspace">Explore demo <ArrowRight size={16} /></Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div><BrandMark /><p style={{ color: "#a9beb4", maxWidth: 350, lineHeight: 1.7 }}>{brand.description}</p></div>
          <div><h3>Platform</h3><Link href="/employers">Employers</Link><Link href="/staffing">Staffing teams</Link><Link href="/universities">Universities</Link><Link href="/candidates">Candidates</Link></div>
          <div><h3>Build</h3><Link href="/developers">Developer API</Link><Link href="/security">Security</Link><Link href="/pricing">Pricing</Link></div>
          <div><h3>Company</h3><Link href="/contact">Talk to us</Link><Link href="/login">Sign in</Link><Link href="/workspace">Product demo</Link></div>
        </div>
        <div className="footer-note"><span>© 2026 Northstar Talent OS</span><span>{brand.notice}</span></div>
      </div>
    </footer>
  );
}

export function HomePage() {
  return <>
    <SiteHeader />
    <main>
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <span className="tag"><Sparkles size={14} /> Evidence over instinct</span>
            <h1 className="display">See the whole person. Make the better call.</h1>
            <p className="hero-copy">Northstar brings hiring, assessment, candidate preparation, and campus placements into one accountable system—where every signal has evidence behind it.</p>
            <div className="hero-actions"><Link className="button button-primary" href="/workspace">Open the live product <ArrowRight size={17} /></Link><Link className="button button-light" href="/contact">Book a walkthrough</Link></div>
          </div>
          <div className="signal-board" aria-label="Illustration of connected candidate evidence">
            <div className="orb" />
            <div className="signal-card one"><span className="eyebrow muted">Candidate signal</span><div style={{ display: "flex", justifyContent: "space-between", alignItems: "end", marginTop: 12 }}><strong style={{ fontSize: 20 }}>Maya Chen</strong><span className="metric">84</span></div><div className="mini-bars"><div className="mini-bar"><span style={{ width: "92%" }} /></div><div className="mini-bar"><span style={{ width: "78%" }} /></div><div className="mini-bar"><span style={{ width: "86%" }} /></div></div></div>
            <div className="signal-card two"><span className="tag">Strong evidence</span><h3 style={{ marginBottom: 8 }}>Systems thinking</h3><p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>Connected the queueing trade-off to a production incident and explained the recovery path.</p></div>
            <div className="signal-card three"><span className="eyebrow">Readiness moved</span><div className="metric" style={{ marginTop: 10 }}>+14 pts</div><p style={{ marginBottom: 0 }}>after three focused practice rounds</p></div>
          </div>
        </div>
      </section>
      <div className="logo-strip"><div className="container logo-strip-inner"><span className="eyebrow">One evidence layer for</span><strong>Product teams</strong><strong>Search firms</strong><strong>Placement cells</strong><strong>People preparing</strong></div></div>
      <section className="section">
        <div className="container">
          <div className="section-head"><div><span className="eyebrow">Built around the decision</span><h2 className="display">A clearer line from potential to proof.</h2></div><p className="muted">Northstar keeps the job, the rubric, the conversation, the work, and the reviewer’s judgment together. Less reconciliation. More clarity.</p></div>
          <div className="feature-grid">
            <article className="card feature-card"><div className="feature-icon"><UsersRound size={21} /></div><div><h3>Run hiring end to end</h3><p>Roles, sourcing, multi-round workflows, pipeline, interviews, evidence-backed reports, and placements.</p></div></article>
            <article className="card feature-card"><div className="feature-icon"><GraduationCap size={21} /></div><div><h3>Prepare an entire campus</h3><p>Readiness tools for every student and a placement ERP for every drive, offer, and joining outcome.</p></div></article>
            <article className="card feature-card"><div className="feature-icon"><Code2 size={21} /></div><div><h3>Measure work, not keywords</h3><p>Structured interviews, role-specific evidence, and transparent weighted scoring. Coding tasks unlock when isolated execution is configured.</p></div></article>
          </div>
        </div>
      </section>
      <section className="section" style={{ background: "var(--cream)" }}><div className="container"><div className="section-head"><div><span className="eyebrow">Trust is product work</span><h2 className="display">AI advises. People decide.</h2></div><div><ShieldCheck size={38} style={{ marginBottom: 18 }} /><p className="muted">Every score stays attached to the words, code, and criteria behind it. Integrity signals create a review queue—not an automatic verdict.</p></div></div></div></section>
    </main>
    <SiteFooter />
  </>;
}
