import { AccountActionForm } from "../../../components/account-action-form";

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <AccountActionForm mode="verify" token={token ?? ""} />;
}
