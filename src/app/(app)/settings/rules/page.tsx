import type { Metadata } from "next";
import { RulesView } from "@/components/settings/rules-view";

export const metadata: Metadata = { title: "Rules" };

export default function RulesPage() {
  return <RulesView />;
}
