import type { Metadata } from "next";
import { RecurringDetail } from "@/components/recurring/recurring-detail";

export const metadata: Metadata = { title: "Recurring item" };

export default async function RecurringItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecurringDetail id={id} />;
}
