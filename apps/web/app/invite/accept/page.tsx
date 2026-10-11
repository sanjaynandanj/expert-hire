import { AccountActionForm } from "../../../components/account-action-form";

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <AccountActionForm mode="invite" token={token ?? ""} />;
}
