import type { Metadata } from "next";
import { AccountDetail } from "@/components/accounts/account-detail";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AccountDetail id={id} />;
}
