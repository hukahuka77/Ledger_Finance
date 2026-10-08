import type { Metadata } from "next";
import { Suspense } from "react";
import { RecurringView } from "@/components/recurring/recurring-view";

export const metadata: Metadata = { title: "Recurring" };

export default function RecurringPage() {
  return (
    <Suspense>
      <RecurringView />
    </Suspense>
  );
}
