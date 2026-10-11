import Link from "next/link";
import { BrandMark } from "../../components/brand-mark";
import { LoginForm } from "../../components/login-form";

export default function LoginPage() {
  return <main className="login-page"><section className="login-story"><Link href="/" style={{ color: "white" }}><BrandMark /></Link><blockquote>“A hiring decision should be explainable long after the meeting ends.”</blockquote><p style={{ color: "#a9beb4" }}>Northstar · Evidence-led talent decisions</p></section><section className="login-form-wrap"><div><Link href="/" style={{ display: "inline-block", marginBottom: 42 }}><BrandMark /></Link><LoginForm /><Link className="login-recovery-link" href="/login/forgot-password">Forgot your password?</Link><p className="muted" style={{ fontSize: 13, textAlign: "center", marginTop: 14 }}>New here? <Link href="/register" style={{ textDecoration: "underline" }}>Create a workspace</Link></p></div></section></main>;
}
