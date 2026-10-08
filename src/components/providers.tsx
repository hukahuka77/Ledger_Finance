"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { Toaster } from "sonner";
import { ConfirmProvider } from "@/components/ui/dialog";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 },
          mutations: { retry: 0 },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ConfirmProvider>{children}</ConfirmProvider>
      <Toaster
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "!bg-surface !border !border-line !text-ink !shadow-[0_6px_24px_-8px_rgba(60,50,40,0.2)] !rounded-lg !font-sans",
            description: "!text-ink-2",
            error: "!text-brick",
          },
        }}
      />
    </QueryClientProvider>
  );
}
