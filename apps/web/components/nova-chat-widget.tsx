"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircleMore, X, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NovaAssistant } from "./nova-assistant";

/** Root-layout placement keeps the conversation mounted during workspace navigation. */
export function NovaChatWidget() {
  const pathname = usePathname();
  const workspace = pathname === "/workspace" || pathname.startsWith("/workspace/");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [started, setStarted] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function syncOrganization() {
      setOrganizationId(workspace ? localStorage.getItem("northstar.organizationId") : null);
    }
    syncOrganization();
    window.addEventListener("storage", syncOrganization);
    return () => window.removeEventListener("storage", syncOrganization);
  }, [pathname, workspace]);
  useEffect(() => { if (open) closeButton.current?.focus(); }, [open]);
  function close() { setOpen(false); launcher.current?.focus(); }
  return <div className="nova-widget">
    <section id="nova-chat-panel" className={`nova-chat-panel${expanded ? " nova-chat-panel-expanded" : ""}`} aria-label="Nova chat" hidden={!open} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header className="nova-chat-header"><div><strong>Nova</strong><span>Your recruitment assistant</span></div><div className="nova-chat-actions"><button type="button" aria-label={expanded ? "Shrink Nova chat" : "Expand Nova chat"} title={expanded ? "Shrink chat" : "Expand chat"} onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button><button ref={closeButton} type="button" aria-label="Minimize Nova chat" onClick={close}><X size={20} /></button></div></header>
      <div className="nova-chat-body nova-chat-body-conversation">
        {started && workspace && organizationId ? <NovaAssistant key={organizationId} /> : <div className="nova-chat-welcome"><MessageCircleMore size={32} /><h2>Hi, I’m Nova.</h2><p>I can review assessment evidence and prepare invitations for the candidates you choose. You approve every invitation.</p><p>Sign in to your recruiter workspace to get started. Access depends on your workspace permissions.</p><Link className="button button-primary" href="/login">Sign in to use Nova</Link></div>}
      </div>
    </section>
    <button ref={launcher} className="nova-chat-launcher" type="button" aria-label={open ? "Minimize Nova chat" : "Open Nova chat"} aria-expanded={open} aria-controls="nova-chat-panel" onClick={() => { if (open) close(); else { setStarted(true); setOpen(true); } }}><MessageCircleMore size={22} aria-hidden="true" /><span>Nova</span></button>
  </div>;
}
