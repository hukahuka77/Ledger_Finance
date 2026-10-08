import type { Metadata } from "next";
import Link from "next/link";
import { ImportWizard } from "@/components/import/import-wizard";
import { Page, PageHeader, SectionHeading } from "@/components/layout/app-shell";
import { ImportHistory } from "@/components/settings/import-history";

export const metadata: Metadata = { title: "Import" };

export default function ImportPage() {
  return (
    <Page>
      <p className="mb-2 text-[13px] text-ink-3">
        <Link href="/settings" className="hover:text-ink-2">
          Settings
        </Link>{" "}
        / Import
      </p>
      <PageHeader
        title="Import transactions"
        subtitle="Upload a CSV, map it to your accounts and categories, and review duplicates before anything is saved."
      />
      <ImportWizard />
      <div className="mt-12">
        <SectionHeading>Import history</SectionHeading>
        <ImportHistory />
      </div>
    </Page>
  );
}
