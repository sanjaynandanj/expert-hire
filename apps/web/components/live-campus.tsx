"use client";

import { AlertTriangle, Award, Building2, CheckCircle2, GraduationCap, LoaderCircle, TrendingUp, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type Drive = {
  id: string;
  title: string;
  status: string;
  applyBy: string;
  openings: number;
  minCgpa: number | null;
  eligibleBranches: string[];
  company: { name: string };
  applications: Array<{ id: string; status: string; offer: { id: string; status: string; ctc: string | number; currency: string } | null; student: { registrationNo: string; user: { name: string } } }>;
};
type SeasonOption = { id: string; name: string; active: boolean };
type CompanyOption = { id: string; name: string };
type Student = {
  id: string;
  registrationNo: string;
  branch: string;
  cgpa: number | null;
  graduationYear: number;
  blacklisted: boolean;
  placed: boolean;
  user: { name: string; email: string };
  applications: Array<{ id: string; status: string; drive: { title: string } }>;
};
type Overview = { season: { name: string; academicYear: string } | null; students: number; activeDrives: number; applications: number; placed: number; placementRate: number };
type Eligibility = { eligible: boolean; reasons: string[] };

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function campusRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const organizationId = window.localStorage.getItem("northstar.organizationId");
  if (!organizationId) throw new Error("Sign in with a university workspace to load placement data.");
  const response = await fetch(`${apiUrl}/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Organization-Id": organizationId, ...init?.headers }
  });
  const result = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = result && typeof result === "object" && "error" in result ? result.error?.message : null;
    throw new Error(message ?? "Placement data could not be loaded.");
  }
  return result as T;
}

export function LiveCampus() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [selectedStudent, setSelectedStudent] = useState("");
  const [eligibility, setEligibility] = useState<Record<string, Eligibility>>({});
  const [loading, setLoading] = useState(true);
  const [pendingDrive, setPendingDrive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [seasons, setSeasons] = useState<SeasonOption[]>([]);
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [creatingDrive, setCreatingDrive] = useState(false);
  const [drivePending, setDrivePending] = useState(false);
  const [offerFor, setOfferFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summary, driveList, studentList, config] = await Promise.all([
        campusRequest<Overview>("/placements/overview"),
        campusRequest<{ data: Drive[] }>("/placements/drives"),
        campusRequest<{ data: Student[] }>("/placements/students"),
        campusRequest<{ seasons: SeasonOption[]; companies: CompanyOption[] }>("/placements/config")
      ]);
      setOverview(summary);
      setDrives(driveList.data);
      setStudents(studentList.data);
      setSeasons(config.seasons);
      setCompanies(config.companies);
      setSelectedStudent((current) => current || studentList.data[0]?.id || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Placement workspace could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!selectedStudent) return;
    let active = true;
    void Promise.all(drives.filter((drive) => drive.status === "PUBLISHED").map(async (drive) => {
      try {
        const result = await campusRequest<{ eligibility: Eligibility }>(`/placements/drives/${encodeURIComponent(drive.id)}/eligibility/${encodeURIComponent(selectedStudent)}`);
        if (active) setEligibility((current) => ({ ...current, [drive.id]: result.eligibility }));
      } catch {
        if (active) setEligibility((current) => ({ ...current, [drive.id]: { eligible: false, reasons: ["Eligibility could not be checked"] } }));
      }
    }));
    return () => { active = false; };
  }, [drives, selectedStudent]);

  async function apply(drive: Drive) {
    if (!selectedStudent) return;
    setPendingDrive(drive.id);
    setError(null);
    setNotice(null);
    try {
      await campusRequest("/placements/applications", {
        method: "POST",
        body: JSON.stringify({ driveId: drive.id, studentId: selectedStudent })
      });
      setNotice("Application recorded and included in the season audit history.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Application could not be recorded.");
    } finally {
      setPendingDrive(null);
    }
  }

  async function createDrive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setDrivePending(true);
    setError(null);
    setNotice(null);
    try {
      const applyByDate = String(form.get("applyBy"));
      await campusRequest("/placements/drives", {
        method: "POST",
        body: JSON.stringify({
          seasonId: form.get("seasonId"), companyId: form.get("companyId"), title: form.get("title"),
          description: form.get("description"), jobType: form.get("jobType"),
          locations: String(form.get("locations")).split(",").map((value) => value.trim()).filter(Boolean),
          applyBy: new Date(`${applyByDate}T23:59:59.000Z`).toISOString(),
          openings: Number(form.get("openings")), ctcMin: Number(form.get("ctcMin")) || null,
          ctcMax: Number(form.get("ctcMax")) || null, currency: form.get("currency"),
          eligibleBranches: String(form.get("eligibleBranches")).split(",").map((value) => value.trim()).filter(Boolean),
          minCgpa: form.get("minCgpa") ? Number(form.get("minCgpa")) : null
        })
      });
      setCreatingDrive(false);
      setNotice("Drive saved as Draft. Review it and publish when it is ready.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Placement drive could not be saved.");
    } finally {
      setDrivePending(false);
    }
  }

  async function updateDriveStatus(driveId: string, status: "PROPOSED" | "PUBLISHED" | "CLOSED") {
    setError(null);
    try {
      await campusRequest(`/placements/drives/${encodeURIComponent(driveId)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh();
      setNotice(`Drive status changed to ${status.toLowerCase()}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Drive status could not be changed.");
    }
  }

  async function updateApplicationStatus(applicationId: string, status: string) {
    setError(null);
    try {
      await campusRequest(`/placements/applications/${encodeURIComponent(applicationId)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Application status could not be changed.");
    }
  }

  async function issueOffer(event: FormEvent<HTMLFormElement>, applicationId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    try {
      await campusRequest("/placements/offers", { method: "POST", body: JSON.stringify({ applicationId, ctc: Number(form.get("ctc")), currency: form.get("currency"), joiningDate: form.get("joiningDate") ? new Date(`${String(form.get("joiningDate"))}T00:00:00.000Z`).toISOString() : undefined }) });
      setOfferFor(null);
      setNotice("Offer issued and recorded in the student's placement history.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Offer could not be issued.");
    }
  }

  async function updateOfferStatus(offerId: string, status: string) {
    setError(null);
    try {
      await campusRequest(`/placements/offers/${encodeURIComponent(offerId)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setNotice(`Offer outcome recorded: ${status.toLowerCase()}.`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Offer outcome could not be saved.");
    }
  }

  const chosen = students.find((student) => student.id === selectedStudent);

  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>{overview?.season?.name ?? "Campus placements"}</p><h1>Placement readiness</h1><span className="muted">Readiness, participation, live drives, and explainable eligibility.</span></div><div style={{ display: "flex", gap: 10, alignItems: "center" }}><span className="tag"><CheckCircle2 size={13} /> {loading ? "Refreshing…" : "Live university data"}</span><button className="button button-primary" onClick={() => setCreatingDrive((value) => !value)} disabled={!seasons.some((season) => season.active) || companies.length === 0}>{creatingDrive ? "Close" : "Create drive"}</button></div></div>
    {error && <div className="notice form-error"><AlertTriangle size={18} /><span role="alert">{error}</span></div>}
    {notice && <div className="notice"><CheckCircle2 size={18} /><span role="status">{notice}</span></div>}
    {creatingDrive && <form className="card panel workspace-form" onSubmit={createDrive}><div className="panel-head"><div><h2>New placement drive</h2><span className="muted" style={{ fontSize: 12 }}>New drives start as drafts and cannot receive applications until published.</span></div></div><div className="form-grid"><label className="field"><span>Season</span><select className="input" name="seasonId" required>{seasons.filter((season) => season.active).map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></label><label className="field"><span>Company</span><select className="input" name="companyId" required>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label><div className="field"><label htmlFor="drive-title">Role title</label><input className="input" id="drive-title" name="title" minLength={3} required /></div><label className="field"><span>Job type</span><select className="input" name="jobType"><option value="FULL_TIME">Full time</option><option value="INTERNSHIP">Internship</option><option value="CONTRACT">Contract</option></select></label><div className="field"><label htmlFor="drive-locations">Locations (comma separated)</label><input className="input" id="drive-locations" name="locations" placeholder="Bengaluru, Remote" required /></div><div className="field"><label htmlFor="drive-branches">Eligible branches (comma separated)</label><input className="input" id="drive-branches" name="eligibleBranches" placeholder="CSE, ECE" /></div><div className="field"><label htmlFor="drive-deadline">Apply by</label><input className="input" id="drive-deadline" name="applyBy" type="date" min={new Date().toISOString().slice(0, 10)} defaultValue={new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)} required /></div><div className="field"><label htmlFor="drive-openings">Openings</label><input className="input" id="drive-openings" name="openings" type="number" min="1" defaultValue="1" required /></div><div className="field"><label htmlFor="drive-ctc-min">Minimum CTC</label><input className="input" id="drive-ctc-min" name="ctcMin" type="number" min="0" step="1000" /></div><div className="field"><label htmlFor="drive-ctc-max">Maximum CTC</label><input className="input" id="drive-ctc-max" name="ctcMax" type="number" min="0" step="1000" /></div><label className="field"><span>Currency</span><select className="input" name="currency"><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option></select></label><div className="field"><label htmlFor="drive-min-cgpa">Minimum CGPA</label><input className="input" id="drive-min-cgpa" name="minCgpa" type="number" min="0" max="10" step="0.01" /></div><div className="field form-wide"><label htmlFor="drive-description">Role description</label><textarea className="input form-textarea" id="drive-description" name="description" minLength={30} required /></div></div><button className="button button-primary" disabled={drivePending}>{drivePending ? "Saving…" : "Save draft drive"}</button></form>}
    <section className="stats-grid">{[
      ["Students", overview?.students ?? "—", "Registered profiles", UsersRound],
      ["Placement rate", overview ? `${overview.placementRate}%` : "—", `${overview?.placed ?? 0} placed`, Award],
      ["Active drives", overview?.activeDrives ?? "—", "Published this season", Building2],
      ["Applications", overview?.applications ?? "—", overview?.season?.academicYear ?? "Current season", TrendingUp]
    ].map(([label, value, delta, Icon]) => { const I = Icon as typeof GraduationCap; return <article className="card stat-card" key={label as string}><div className="stat-top"><div className="stat-icon"><I size={18} /></div><span className="delta">{delta as string}</span></div><div className="metric">{value as string | number}</div><div className="muted" style={{ fontSize: 13 }}>{label as string}</div></article>; })}</section>
    <section className="card panel campus-toolbar"><div><h2>Check placement eligibility</h2><span className="muted" style={{ fontSize: 12 }}>Rules are evaluated by the API for the selected student.</span></div><label className="field"><span>Student</span><select className="input" value={selectedStudent} onChange={(event) => setSelectedStudent(event.target.value)}>{students.map((student) => <option key={student.id} value={student.id}>{student.user.name} · {student.registrationNo}</option>)}</select></label></section>
    <section className="card panel"><div className="panel-head"><div><h2>Published placement drives</h2><span className="muted" style={{ fontSize: 12 }}>{chosen ? `Previewing ${chosen.user.name} · ${chosen.branch}${chosen.cgpa === null ? "" : ` · CGPA ${chosen.cgpa}`}` : "Select a student to preview eligibility"}</span></div><span className="tag">{drives.length} drives</span></div>{loading ? <div className="loading-row"><LoaderCircle className="spin" size={19} /> Loading placement data…</div> : <div className="drive-list">{drives.filter((drive) => drive.status === "PUBLISHED").map((drive) => {
      const result = eligibility[drive.id];
      const alreadyApplied = chosen?.applications.some((application) => application.drive.title === drive.title);
      return <article className="drive-row" key={drive.id}><div className="stat-icon"><Building2 size={18} /></div><div className="drive-main"><strong>{drive.title}</strong><span className="muted">{drive.company.name} · {drive.openings} openings · apply by {new Date(drive.applyBy).toLocaleDateString()}</span><span className="muted">{drive.eligibleBranches.length ? `Branches: ${drive.eligibleBranches.join(", ")}` : "All branches"}{drive.minCgpa === null ? "" : ` · minimum CGPA ${drive.minCgpa}`}</span>{result && !result.eligible && <span className="eligibility-reasons"><AlertTriangle size={14} />{result.reasons.join(" · ")}</span>}</div><div className="drive-action">{alreadyApplied ? <span className="tag">Applied</span> : <button className="button button-primary" disabled={!result?.eligible || pendingDrive === drive.id || !chosen} onClick={() => void apply(drive)}>{pendingDrive === drive.id ? "Applying…" : result?.eligible ? "Apply student" : "Not eligible"}</button>}</div></article>;
    })}{!drives.some((drive) => drive.status === "PUBLISHED") && <p className="muted">No published drives are open for applications yet.</p>}</div>}</section>
    <section className="card panel"><div className="panel-head"><div><h2>Student roster</h2><span className="muted" style={{ fontSize: 12 }}>Profile data is limited to this university tenant.</span></div></div><div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Student</th><th>Registration</th><th>Branch</th><th>CGPA</th><th>Offers</th><th>Profile</th></tr></thead><tbody>{students.map((student) => <tr key={student.id}><td><strong>{student.user.name}</strong><div className="muted" style={{ fontSize: 11 }}>{student.user.email}</div></td><td>{student.registrationNo}</td><td>{student.branch}</td><td>{student.cgpa ?? "—"}</td><td>{student.applications.filter((application) => ["ACCEPTED", "OFFERED"].includes(application.status)).length}</td><td><span className="tag">{student.placed ? "Placed" : student.blacklisted ? "Restricted" : "Active"}</span></td></tr>)}</tbody></table></div></section>
    <section className="card panel"><div className="panel-head"><div><h2>Drive lifecycle and offers</h2><span className="muted" style={{ fontSize: 12 }}>Review applications, issue offers, and record outcomes.</span></div></div>{drives.map((drive) => <article className="evidence-row" key={drive.id}><div className="evidence-heading"><strong>{drive.title} · {drive.company.name}</strong><select aria-label={`Change ${drive.title} drive status`} className="input" value={drive.status} onChange={(event) => void updateDriveStatus(drive.id, event.target.value as "PROPOSED" | "PUBLISHED" | "CLOSED")} disabled={drive.status === "CLOSED"}><option value={drive.status}>{drive.status}</option>{(drive.status === "DRAFT" ? ["PROPOSED", "PUBLISHED"] : drive.status === "PROPOSED" ? ["DRAFT", "PUBLISHED"] : drive.status === "PUBLISHED" ? ["CLOSED"] : []).map((status) => <option key={status} value={status}>{status}</option>)}</select></div>{drive.applications.length ? drive.applications.map((application) => <div key={application.id} className="application-review-row"><div><strong>{application.student.user.name}</strong><span className="muted">{application.student.registrationNo} · {application.status}</span></div>{application.offer ? <label className="field"><span>Offer · {application.offer.currency} {Number(application.offer.ctc).toLocaleString()}</span><select className="input" aria-label={`Change ${application.student.user.name} offer outcome`} value={application.offer.status} onChange={(event) => void updateOfferStatus(application.offer!.id, event.target.value)}>{[application.offer.status, ...(application.offer.status === "ROLLED" ? ["ACCEPTED", "DECLINED", "REVOKED"] : application.offer.status === "ACCEPTED" ? ["JOINED", "DEFERRED", "RENEGED"] : application.offer.status === "DEFERRED" ? ["ACCEPTED", "DECLINED", "RENEGED"] : [])].map((status) => <option key={status} value={status}>{status}</option>)}</select></label> : application.status === "INTERVIEWING" ? offerFor === application.id ? <form className="form-grid" onSubmit={(event) => void issueOffer(event, application.id)}><div className="field"><label htmlFor={`offer-ctc-${application.id}`}>Annual CTC</label><input className="input" id={`offer-ctc-${application.id}`} name="ctc" type="number" min="1" required /></div><div className="field"><label htmlFor={`offer-date-${application.id}`}>Joining date</label><input className="input" id={`offer-date-${application.id}`} name="joiningDate" type="date" /></div><div className="field"><label htmlFor={`offer-currency-${application.id}`}>Currency</label><select className="input" id={`offer-currency-${application.id}`} name="currency"><option>INR</option><option>USD</option><option>EUR</option></select></div><button className="button button-primary">Issue offer</button></form> : <button className="button button-light" onClick={() => setOfferFor(application.id)}>Issue offer</button> : <label className="field"><span>Application status</span><select className="input" value={application.status} aria-label={`Change ${application.student.user.name} application status`} onChange={(event) => void updateApplicationStatus(application.id, event.target.value)}><option value={application.status}>{application.status}</option>{(application.status === "APPLIED" ? ["SHORTLISTED", "REJECTED", "WITHDRAWN"] : application.status === "SHORTLISTED" ? ["INTERVIEWING", "REJECTED", "WITHDRAWN"] : []).map((status) => <option key={status} value={status}>{status}</option>)}</select></label>}</div>) : <p className="muted">No applications recorded yet.</p>}</article>)}</section>
  </>;
}
