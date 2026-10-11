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
type SeasonOption = { id: string; name: string; academicYear: string; active: boolean; offerCap: number; upgradeMultiple: number | string | null };
type CompanyOption = { id: string; name: string; tier: string; recruiterName: string | null; recruiterEmail: string | null };
type Student = {
  id: string;
  registrationNo: string;
  branch: string;
  cgpa: number | null;
  graduationYear: number;
  blacklisted: boolean;
  placed: boolean;
  currentCtc: number | string | null;
  currentCtcCurrency: string | null;
  placementSource: string | null;
  profileCorrection: { branch: string; graduationYear: number; cgpa: number | null } | null;
  profileCorrectionAt: string | null;
  user: { name: string; email: string };
  applications: Array<{ id: string; status: string; drive: { title: string } }>;
};
type Overview = { season: { name: string; academicYear: string } | null; students: number; activeDrives: number; applications: number; placed: number; placementRate: number };
type Eligibility = { eligible: boolean; reasons: string[] };
type StudentImportResult = { imported: number; created: number; updated: number; invited: number; students: Array<{ email: string; registrationNo: string; profile: string; actionUrl?: string }>; errors: Array<{ email: string; registrationNo: string; message: string }> };

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

function StudentBulkImport({ onComplete }: { onComplete: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StudentImportResult | null>(null);

  async function importStudents(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const students = JSON.parse(String(form.get("students") ?? "")) as unknown;
      const imported = await campusRequest<StudentImportResult>("/placements/students/import", { method: "POST", body: JSON.stringify({ students }) });
      setResult(imported);
      if (imported.imported) {
        formElement.reset();
        await onComplete();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The roster could not be imported.");
    } finally {
      setPending(false);
    }
  }

  return <form className="card configuration-create" onSubmit={(event) => void importStudents(event)}><h4>Import student roster</h4><p className="muted" style={{ fontSize: 12 }}>Paste a JSON array with name, email, registrationNo, branch, graduationYear, and optional cgpa. New accounts receive an invitation and stay unable to sign in until accepted.</p><div className="field"><label htmlFor="student-import-json">Student rows (up to 500)</label><textarea className="input form-textarea" id="student-import-json" name="students" minLength={2} placeholder={'[{"name":"Asha Rao","email":"asha@example.edu","registrationNo":"CS-2042","branch":"CSE","graduationYear":2027,"cgpa":8.4}]'} required /></div>{error && <p role="alert" className="form-error">{error}</p>}{result && <div role="status" className="notice"><span><strong>{result.imported} profiles processed</strong><br /><small>{result.created} created · {result.updated} updated · {result.invited} invitations sent{result.errors.length ? ` · ${result.errors.length} row issues` : ""}</small></span></div>}{result?.students.map((student) => student.actionUrl && <p key={student.registrationNo} className="muted" style={{ fontSize: 12 }}>{student.registrationNo} · <a href={student.actionUrl}>Open development invitation for {student.email}</a></p>)}{result?.errors.map((row) => <p key={`${row.email}-${row.registrationNo}`} role="alert" className="form-error">{row.registrationNo} · {row.email}: {row.message}</p>)}<button className="button button-primary" disabled={pending}>{pending ? "Importing…" : "Import roster"}</button></form>;
}

function StudentPlacementReconciliation({ students, onComplete }: { students: Student[]; onComplete: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const rows = JSON.parse(String(new FormData(formElement).get("reconciliation"))) as Array<{ registrationNo: string; placed: boolean; currentCtc: number | null; currency: string | null; source: string | null }>;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) throw new Error("Provide between 1 and 500 reconciliation rows.");
      const outcomes: string[] = [];
      for (const row of rows) {
        const student = students.find((item) => item.registrationNo === row.registrationNo);
        if (!student) { outcomes.push(`${row.registrationNo}: student not found`); continue; }
        await campusRequest(`/placements/students/${encodeURIComponent(student.id)}/reconciliation`, { method: "PATCH", body: JSON.stringify({ placed: row.placed, currentCtc: row.placed ? row.currentCtc : null, currency: row.placed ? row.currency : null, source: row.placed ? row.source : null }) });
        outcomes.push(`${row.registrationNo}: reconciled`);
      }
      setMessage(`${outcomes.filter((item) => item.endsWith("reconciled")).length} rows reconciled${outcomes.some((item) => item.endsWith("not found")) ? ` · ${outcomes.filter((item) => item.endsWith("not found")).join("; ")}` : ""}.`);
      formElement.reset();
      await onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Placement reconciliation could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return <form className="card configuration-create" onSubmit={(event) => void reconcile(event)}><h4>Reconcile historical placements</h4><p className="muted" style={{ fontSize: 12 }}>Use verified source data. Reconciled CTC is used by upgrade eligibility rules and each row is audited.</p><div className="field"><label htmlFor="placement-reconciliation-json">Reconciliation rows (JSON)</label><textarea className="input form-textarea" id="placement-reconciliation-json" name="reconciliation" minLength={2} placeholder={'[{"registrationNo":"CS-2042","placed":true,"currentCtc":1200000,"currency":"INR","source":"Employer confirmation, 2026-09-30"}]'} required /></div>{message && <p role="status" className="muted">{message}</p>}{error && <p role="alert" className="form-error">{error}</p>}<button className="button button-primary" disabled={pending || !students.length}>{pending ? "Reconciling…" : "Reconcile records"}</button></form>;
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
  const [managingConfig, setManagingConfig] = useState(false);
  const [configPending, setConfigPending] = useState(false);
  const [reviewingCorrectionId, setReviewingCorrectionId] = useState<string | null>(null);

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

  async function createSeason(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); setConfigPending(true); setError(null);
    try {
      await campusRequest("/placements/seasons", { method: "POST", body: JSON.stringify({ name: form.get("seasonName"), academicYear: form.get("academicYear"), offerCap: Number(form.get("offerCap")), upgradeMultiple: form.get("upgradeMultiple") ? Number(form.get("upgradeMultiple")) : null, active: form.get("active") === "on" }) });
      formElement.reset(); setNotice("Placement season and offer policy saved."); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Season could not be created."); }
    finally { setConfigPending(false); }
  }

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); setConfigPending(true); setError(null);
    try {
      await campusRequest("/placements/companies", { method: "POST", body: JSON.stringify({ name: form.get("companyName"), tier: form.get("companyTier"), recruiterName: form.get("recruiterName") || null, recruiterEmail: form.get("recruiterEmail") || null }) });
      formElement.reset(); setNotice("Placement company added."); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Company could not be created."); }
    finally { setConfigPending(false); }
  }

  async function updateSeason(event: FormEvent<HTMLFormElement>, season: SeasonOption) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setConfigPending(true); setError(null);
    try {
      await campusRequest(`/placements/seasons/${encodeURIComponent(season.id)}`, { method: "PATCH", body: JSON.stringify({ active: form.get("active") === "on", offerCap: Number(form.get("offerCap")), upgradeMultiple: form.get("upgradeMultiple") ? Number(form.get("upgradeMultiple")) : null }) });
      setNotice(`${season.name} policy updated.`); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Season policy could not be updated."); }
    finally { setConfigPending(false); }
  }

  async function updateCompany(event: FormEvent<HTMLFormElement>, company: CompanyOption) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setConfigPending(true); setError(null);
    try {
      await campusRequest(`/placements/companies/${encodeURIComponent(company.id)}`, { method: "PATCH", body: JSON.stringify({ tier: form.get("tier"), recruiterName: form.get("recruiterName") || null, recruiterEmail: form.get("recruiterEmail") || null }) });
      setNotice(`${company.name} contact updated.`); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Company contact could not be updated."); }
    finally { setConfigPending(false); }
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

  async function reviewProfileCorrection(studentId: string, decision: "APPROVE" | "DECLINE") {
    setReviewingCorrectionId(studentId);
    setError(null);
    try {
      await campusRequest(`/placements/students/${encodeURIComponent(studentId)}/profile-correction`, { method: "PATCH", body: JSON.stringify({ decision }) });
      setNotice(decision === "APPROVE" ? "Academic profile correction approved." : "Academic profile correction declined.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Profile correction could not be reviewed.");
    } finally {
      setReviewingCorrectionId(null);
    }
  }

  const chosen = students.find((student) => student.id === selectedStudent);

  return <><div className="page-title"><div><p className="eyebrow muted" style={{ margin: "0 0 8px" }}>{overview?.season?.name ?? "Campus placements"}</p><h1>Placement readiness</h1><span className="muted">Readiness, participation, live drives, and explainable eligibility.</span></div><div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}><span className="tag"><CheckCircle2 size={13} /> {loading ? "Refreshing…" : "Live university data"}</span><button className="button button-light" onClick={() => setManagingConfig((value) => !value)}>{managingConfig ? "Close setup" : "Manage seasons & companies"}</button><button className="button button-primary" onClick={() => setCreatingDrive((value) => !value)} disabled={!seasons.some((season) => season.active) || companies.length === 0}>{creatingDrive ? "Close" : "Create drive"}</button></div></div>
    {error && <div className="notice form-error"><AlertTriangle size={18} /><span role="alert">{error}</span></div>}
    {notice && <div className="notice"><CheckCircle2 size={18} /><span role="status">{notice}</span></div>}
    {managingConfig && <section className="card panel"><div className="panel-head"><div><h2>Season and company setup</h2><span className="muted" style={{ fontSize: 12 }}>Offer caps and upgrade rules are applied by the server during eligibility checks.</span></div></div><StudentBulkImport onComplete={refresh} /><h3>Placement seasons</h3>{seasons.map((season) => <form className="configuration-row" key={season.id} onSubmit={(event) => void updateSeason(event, season)}><strong>{season.name} · {season.academicYear}</strong><label className="field"><span>Student offer cap</span><input className="input" name="offerCap" type="number" min="1" max="20" defaultValue={season.offerCap} required /></label><label className="field"><span>Upgrade multiple</span><input className="input" name="upgradeMultiple" type="number" min="1" max="10" step="0.05" defaultValue={season.upgradeMultiple === null ? "" : Number(season.upgradeMultiple)} placeholder="No threshold" /></label><label className="configuration-active"><input name="active" type="checkbox" defaultChecked={season.active} /> Active season</label><button className="button button-light" disabled={configPending}>Save policy</button></form>)}<form className="card configuration-create" onSubmit={(event) => void createSeason(event)}><h4>Create season</h4><div className="form-grid"><label className="field"><span>Name</span><input className="input" name="seasonName" minLength={3} required /></label><label className="field"><span>Academic year</span><input className="input" name="academicYear" pattern="[0-9]{4}-[0-9]{2}" defaultValue={`${new Date().getFullYear()}-${String((new Date().getFullYear() + 1) % 100).padStart(2, "0")}`} required /></label><label className="field"><span>Student offer cap</span><input className="input" name="offerCap" type="number" min="1" max="20" defaultValue="1" required /></label><label className="field"><span>Upgrade multiple</span><input className="input" name="upgradeMultiple" type="number" min="1" max="10" step="0.05" placeholder="No threshold" /></label></div><label className="configuration-active"><input name="active" type="checkbox" defaultChecked /> Make this the active season</label><button className="button button-primary" disabled={configPending}>Create season</button></form><h3 style={{ marginTop: 28 }}>Placement companies</h3>{companies.map((company) => <form className="configuration-row" key={company.id} onSubmit={(event) => void updateCompany(event, company)}><strong>{company.name}</strong><label className="field"><span>Tier</span><select className="input" name="tier" defaultValue={company.tier}><option>STARTUP</option><option>SME</option><option>ENTERPRISE</option></select></label><label className="field"><span>Recruiter name</span><input className="input" name="recruiterName" defaultValue={company.recruiterName ?? ""} /></label><label className="field"><span>Recruiter email</span><input className="input" name="recruiterEmail" type="email" defaultValue={company.recruiterEmail ?? ""} /></label><button className="button button-light" disabled={configPending}>Save contact</button></form>)}<form className="card configuration-create" onSubmit={(event) => void createCompany(event)}><h4>Add company</h4><div className="form-grid"><label className="field"><span>Company name</span><input className="input" name="companyName" minLength={2} required /></label><label className="field"><span>Tier</span><select className="input" name="companyTier"><option>ENTERPRISE</option><option>SME</option><option>STARTUP</option></select></label><label className="field"><span>Recruiter name</span><input className="input" name="recruiterName" /></label><label className="field"><span>Recruiter email</span><input className="input" name="recruiterEmail" type="email" /></label></div><button className="button button-primary" disabled={configPending}>Add company</button></form></section>}
    {creatingDrive && <form className="card panel workspace-form" onSubmit={createDrive}><div className="panel-head"><div><h2>New placement drive</h2><span className="muted" style={{ fontSize: 12 }}>New drives start as drafts and cannot receive applications until published.</span></div></div><div className="form-grid"><label className="field"><span>Season</span><select className="input" name="seasonId" required>{seasons.filter((season) => season.active).map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}</select></label><label className="field"><span>Company</span><select className="input" name="companyId" required>{companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label><div className="field"><label htmlFor="drive-title">Role title</label><input className="input" id="drive-title" name="title" minLength={3} required /></div><label className="field"><span>Job type</span><select className="input" name="jobType"><option value="FULL_TIME">Full time</option><option value="INTERNSHIP">Internship</option><option value="CONTRACT">Contract</option></select></label><div className="field"><label htmlFor="drive-locations">Locations (comma separated)</label><input className="input" id="drive-locations" name="locations" placeholder="Bengaluru, Remote" required /></div><div className="field"><label htmlFor="drive-branches">Eligible branches (comma separated)</label><input className="input" id="drive-branches" name="eligibleBranches" placeholder="CSE, ECE" /></div><div className="field"><label htmlFor="drive-deadline">Apply by</label><input className="input" id="drive-deadline" name="applyBy" type="date" min={new Date().toISOString().slice(0, 10)} defaultValue={new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)} required /></div><div className="field"><label htmlFor="drive-openings">Openings</label><input className="input" id="drive-openings" name="openings" type="number" min="1" defaultValue="1" required /></div><div className="field"><label htmlFor="drive-ctc-min">Minimum CTC</label><input className="input" id="drive-ctc-min" name="ctcMin" type="number" min="0" step="1000" /></div><div className="field"><label htmlFor="drive-ctc-max">Maximum CTC</label><input className="input" id="drive-ctc-max" name="ctcMax" type="number" min="0" step="1000" /></div><label className="field"><span>Currency</span><select className="input" name="currency"><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option></select></label><div className="field"><label htmlFor="drive-min-cgpa">Minimum CGPA</label><input className="input" id="drive-min-cgpa" name="minCgpa" type="number" min="0" max="10" step="0.01" /></div><div className="field form-wide"><label htmlFor="drive-description">Role description</label><textarea className="input form-textarea" id="drive-description" name="description" minLength={30} required /></div></div><button className="button button-primary" disabled={drivePending}>{drivePending ? "Saving…" : "Save draft drive"}</button></form>}
    {managingConfig && <StudentPlacementReconciliation students={students} onComplete={refresh} />}
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
    <section className="card panel"><div className="panel-head"><div><h2>Student roster</h2><span className="muted" style={{ fontSize: 12 }}>Profile data is limited to this university tenant. Academic corrections require university approval before affecting eligibility.</span></div></div><div style={{ overflowX: "auto" }}><table className="table"><thead><tr><th>Student</th><th>Registration</th><th>Branch</th><th>CGPA</th><th>Offers</th><th>Profile</th></tr></thead><tbody>{students.map((student) => <tr key={student.id}><td><strong>{student.user.name}</strong><div className="muted" style={{ fontSize: 11 }}>{student.user.email}</div>{student.profileCorrection && <div className="configuration-create"><strong>Correction requested</strong><div className="muted" style={{ fontSize: 11 }}>{student.profileCorrection.branch} · class of {student.profileCorrection.graduationYear} · CGPA {student.profileCorrection.cgpa ?? "—"}{student.profileCorrectionAt ? ` · ${new Date(student.profileCorrectionAt).toLocaleDateString()}` : ""}</div><div className="configuration-row-actions"><button className="button button-primary" disabled={reviewingCorrectionId === student.id} onClick={() => void reviewProfileCorrection(student.id, "APPROVE")}>Approve</button><button className="button button-light" disabled={reviewingCorrectionId === student.id} onClick={() => void reviewProfileCorrection(student.id, "DECLINE")}>Decline</button></div></div>}</td><td>{student.registrationNo}</td><td>{student.branch}</td><td>{student.cgpa ?? "—"}</td><td>{student.applications.filter((application) => ["ACCEPTED", "OFFERED"].includes(application.status)).length}</td><td><span className="tag">{student.placed ? "Placed" : student.blacklisted ? "Restricted" : "Active"}</span></td></tr>)}</tbody></table></div></section>
    <section className="card panel"><div className="panel-head"><div><h2>Drive lifecycle and offers</h2><span className="muted" style={{ fontSize: 12 }}>Review applications, issue offers, and record outcomes.</span></div></div>{drives.map((drive) => <article className="evidence-row" key={drive.id}><div className="evidence-heading"><strong>{drive.title} · {drive.company.name}</strong><select aria-label={`Change ${drive.title} drive status`} className="input" value={drive.status} onChange={(event) => void updateDriveStatus(drive.id, event.target.value as "PROPOSED" | "PUBLISHED" | "CLOSED")} disabled={drive.status === "CLOSED"}><option value={drive.status}>{drive.status}</option>{(drive.status === "DRAFT" ? ["PROPOSED", "PUBLISHED"] : drive.status === "PROPOSED" ? ["DRAFT", "PUBLISHED"] : drive.status === "PUBLISHED" ? ["CLOSED"] : []).map((status) => <option key={status} value={status}>{status}</option>)}</select></div>{drive.applications.length ? drive.applications.map((application) => <div key={application.id} className="application-review-row"><div><strong>{application.student.user.name}</strong><span className="muted">{application.student.registrationNo} · {application.status}</span></div>{application.offer ? <label className="field"><span>Offer · {application.offer.currency} {Number(application.offer.ctc).toLocaleString()}</span><select className="input" aria-label={`Change ${application.student.user.name} offer outcome`} value={application.offer.status} onChange={(event) => void updateOfferStatus(application.offer!.id, event.target.value)}>{[application.offer.status, ...(application.offer.status === "ROLLED" ? ["ACCEPTED", "DECLINED", "REVOKED"] : application.offer.status === "ACCEPTED" ? ["JOINED", "DEFERRED", "RENEGED"] : application.offer.status === "DEFERRED" ? ["ACCEPTED", "DECLINED", "RENEGED"] : [])].map((status) => <option key={status} value={status}>{status}</option>)}</select></label> : application.status === "INTERVIEWING" ? offerFor === application.id ? <form className="form-grid" onSubmit={(event) => void issueOffer(event, application.id)}><div className="field"><label htmlFor={`offer-ctc-${application.id}`}>Annual CTC</label><input className="input" id={`offer-ctc-${application.id}`} name="ctc" type="number" min="1" required /></div><div className="field"><label htmlFor={`offer-date-${application.id}`}>Joining date</label><input className="input" id={`offer-date-${application.id}`} name="joiningDate" type="date" /></div><div className="field"><label htmlFor={`offer-currency-${application.id}`}>Currency</label><select className="input" id={`offer-currency-${application.id}`} name="currency"><option>INR</option><option>USD</option><option>EUR</option></select></div><button className="button button-primary">Issue offer</button></form> : <button className="button button-light" onClick={() => setOfferFor(application.id)}>Issue offer</button> : <label className="field"><span>Application status</span><select className="input" value={application.status} aria-label={`Change ${application.student.user.name} application status`} onChange={(event) => void updateApplicationStatus(application.id, event.target.value)}><option value={application.status}>{application.status}</option>{(application.status === "APPLIED" ? ["SHORTLISTED", "REJECTED", "WITHDRAWN"] : application.status === "SHORTLISTED" ? ["INTERVIEWING", "REJECTED", "WITHDRAWN"] : []).map((status) => <option key={status} value={status}>{status}</option>)}</select></label>}</div>) : <p className="muted">No applications recorded yet.</p>}</article>)}</section>
  </>;
}
