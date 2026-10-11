import Link from "next/link";
import { BrandMark } from "../../components/brand-mark";
import { RegisterForm } from "../../components/register-form";

export default function RegisterPage() {
  return <main className="login-page"><section className="login-story"><Link href="/" style={{ color: "white" }}><BrandMark /></Link><blockquote>“Build a hiring process your whole team can trust.”</blockquote><p style={{ color: "#a9beb4" }}>Northstar · Evidence-led talent decisions</p></section><section className="login-form-wrap"><div><Link href="/" style={{ display: "inline-block", marginBottom: 32 }}><BrandMark /></Link><RegisterForm /></div></section></main>;
}
