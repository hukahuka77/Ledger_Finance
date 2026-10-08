import type { Metadata } from "next";
import { ConnectionsView } from "@/components/settings/connections-view";

export const metadata: Metadata = { title: "Bank connections" };

export default function ConnectionsPage() {
  return <ConnectionsView />;
}
