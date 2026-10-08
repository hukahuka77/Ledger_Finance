"use client";

import { Download, Ellipsis, ImageDown } from "lucide-react";
import { useRef } from "react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { reportError } from "@/lib/errors";
import { downloadBlob, downloadCsv } from "@/lib/export";

type CsvRows = Record<string, string | number | null | undefined>[];

/** A report section: title, optional controls, and a menu to save it as a PNG or its data as CSV. */
export function ReportSection({
  title,
  subtitle,
  controls,
  fileName,
  csv,
  className,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  controls?: React.ReactNode;
  /** File name stem for downloads, e.g. "money-flow-2026-09". */
  fileName: string;
  csv?: () => CsvRows;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);

  const savePng = async () => {
    if (!ref.current) return;
    try {
      const { toBlob } = await import("html-to-image");
      const blob = await toBlob(ref.current, {
        backgroundColor: "#fbfaf7",
        pixelRatio: 2,
        filter: (node) => !(node instanceof HTMLElement && node.dataset.exportHide !== undefined),
      });
      if (blob) downloadBlob(blob, `${fileName}.png`);
    } catch (e) {
      reportError(e, "Could not save the chart as an image.");
    }
  };

  return (
    <section ref={ref} className={cn("min-w-0 break-inside-avoid rounded-lg border border-line bg-surface p-4 sm:p-5", className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-medium text-ink">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p> : null}
        </div>
        <div className="flex items-center gap-2" data-export-hide>
          {controls ? <div className="print:hidden">{controls}</div> : null}
          <Menu>
            <MenuTrigger
              aria-label={`Export ${title}`}
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink print:hidden"
            >
              <Ellipsis className="size-4" />
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={savePng}>
                <ImageDown /> Save as image (PNG)
              </MenuItem>
              {csv ? (
                <MenuItem onSelect={() => downloadCsv(`${fileName}.csv`, csv())}>
                  <Download /> Download data (CSV)
                </MenuItem>
              ) : null}
            </MenuContent>
          </Menu>
        </div>
      </div>
      {children}
    </section>
  );
}
