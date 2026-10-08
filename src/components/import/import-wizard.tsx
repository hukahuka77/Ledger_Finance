"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, FileUp, Upload } from "lucide-react";
import Link from "next/link";
import Papa from "papaparse";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, Select } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { formatMediumDate, todayISO } from "@/lib/dates";
import { ACCOUNT_TYPE_OPTIONS, ACCOUNT_TYPE_SINGULAR, type AccountType } from "@/lib/domain";
import { reportError } from "@/lib/errors";
import {
  APP_FIELDS,
  accountKeyOf,
  clean,
  detectMapping,
  fingerprintRows,
  guessAccountType,
  guessSignConvention,
  normalizeRows,
  type AppField,
  type ColumnMapping,
  type ImportOptions,
  type NormalizedRow,
} from "@/lib/import/csv";
import { detectDuplicates, runImport, type AccountPlan, type CategoryPlan, type ImportResult, type RowState } from "@/lib/import/run-import";
import { formatLedgerAmount } from "@/lib/money";
import { useAccounts, useCategoryIndex } from "@/lib/queries/reference";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100_000;
const STEPS = ["Upload", "Map columns", "Accounts", "Categories", "Review", "Import"] as const;

type Parsed = { filename: string; size: number; headers: string[]; records: Record<string, string>[] };

export function ImportWizard() {
  const [step, setStep] = useState(0);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [options, setOptions] = useState<ImportOptions>({
    signConvention: "negative_is_outflow",
    dateFormat: "auto",
    defaultAccountLabel: "",
    reviewedBefore: "",
  });
  const [accountPlans, setAccountPlans] = useState<AccountPlan[]>([]);
  const [categoryPlans, setCategoryPlans] = useState<CategoryPlan[]>([]);
  const [rowStates, setRowStates] = useState<RowState[] | null>(null);
  const [createRecurring, setCreateRecurring] = useState(true);
  const [progress, setProgress] = useState<{ stage: string; done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useAccounts();
  const cats = useCategoryIndex();
  const qc = useQueryClient();

  const rows: NormalizedRow[] = useMemo(() => (parsed ? normalizeRows(parsed.records, mapping, options) : []), [parsed, mapping, options]);

  // ---------------------------------------------------------------- step 1
  const onFile = (file: File) => {
    if (file.size > MAX_BYTES) return reportError({ code: "22023", message: "That file is larger than 25 MB." }, "File too large");
    if (!/\.(csv|txt)$/i.test(file.name) && file.type && !/csv|text/.test(file.type)) {
      return reportError({ code: "22023", message: "Please choose a .csv file." }, "Unsupported file");
    }
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => clean(h, 100),
      complete: (res) => {
        const headers = (res.meta.fields ?? []).filter(Boolean);
        if (!headers.length || !res.data.length) {
          reportError({ code: "22023", message: "No rows found. Is the first line a header row?" }, "Empty CSV");
          return;
        }
        if (res.data.length > MAX_ROWS) {
          reportError({ code: "22023", message: `Files are limited to ${MAX_ROWS.toLocaleString()} rows.` }, "Too many rows");
          return;
        }
        const m = detectMapping(headers);
        setParsed({ filename: file.name, size: file.size, headers, records: res.data });
        setMapping(m);
        setOptions((o) => ({ ...o, signConvention: guessSignConvention(res.data, m) }));
        setRowStates(null);
        setResult(null);
        setStep(1);
      },
      error: (err) => reportError(err, "Could not read that CSV file."),
    });
  };

  // ---------------------------------------------------------------- step 2 → 3
  const mappingValid = Boolean(mapping.date && mapping.merchant && (mapping.amount || mapping.outflow || mapping.inflow));

  const buildAccountPlans = () => {
    const groups = new Map<string, AccountPlan>();
    for (const r of rows) {
      if (r.errors.length) continue;
      const g = groups.get(r.accountKey);
      if (g) g.rows++;
      else
        groups.set(r.accountKey, {
          key: r.accountKey,
          name: r.accountName,
          mask: r.accountMask,
          rows: 1,
          target: { kind: "new", name: r.accountName, type: guessAccountType(r.accountName), lastFour: r.accountMask },
        });
    }
    const existing = accounts ?? [];
    const plans = [...groups.values()].sort((a, b) => b.rows - a.rows);
    plans.forEach((p) => {
      const prev = accountPlans.find((x) => x.key === p.key);
      if (prev) p.target = prev.target;
      else {
        const hit =
          existing.find((a) => accountKeyOf(a.name, a.last_four ?? "") === p.key) ??
          existing.find((a) => a.name.toLowerCase() === p.name.toLowerCase() && (!p.mask || !a.last_four || a.last_four === p.mask));
        if (hit) p.target = { kind: "existing", id: hit.id };
      }
    });
    setAccountPlans(plans);
  };

  const buildCategoryPlans = () => {
    const groups = new Map<string, CategoryPlan>();
    for (const r of rows) {
      if (r.errors.length || !r.categoryKey) continue;
      const g = groups.get(r.categoryKey);
      if (g) g.rows++;
      else groups.set(r.categoryKey, { key: r.categoryKey, name: r.categoryName, parent: r.parentName, rows: 1, target: { kind: "new" } });
    }
    const plans = [...groups.values()].sort((a, b) => a.parent.localeCompare(b.parent) || b.rows - a.rows);
    plans.forEach((p) => {
      const prev = categoryPlans.find((x) => x.key === p.key);
      if (prev) {
        p.target = prev.target;
        return;
      }
      const name = p.name.toLowerCase();
      const parent = p.parent ? cats.parents.find((c) => c.name.toLowerCase() === p.parent.toLowerCase()) : undefined;
      const hit =
        (parent && cats.childrenOf(parent.id).find((c) => c.name.toLowerCase() === name)) ||
        (!p.parent && cats.parents.find((c) => c.name.toLowerCase() === name)) ||
        (cats.all.filter((c) => c.name.toLowerCase() === name).length === 1 ? cats.all.find((c) => c.name.toLowerCase() === name) : undefined);
      if (hit) p.target = { kind: "existing", id: hit.id };
    });
    setCategoryPlans(plans);
  };

  // ---------------------------------------------------------------- step 4 → 5
  const prepareReview = async () => {
    setBusy(true);
    try {
      const hashes = await fingerprintRows(rows);
      const existingByKey = new Map<string, string>();
      accountPlans.forEach((p) => p.target.kind === "existing" && existingByKey.set(p.key, p.target.id));
      const states = await detectDuplicates(
        rows.map((row, i) => ({ row, hash: hashes[i] })),
        existingByKey,
      );
      setRowStates(states);
      setStep(4);
    } catch (e) {
      reportError(e, "Could not check for duplicates.");
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!parsed || !rowStates) return;
    setBusy(true);
    setStep(5);
    try {
      const res = await runImport(
        {
          filename: parsed.filename,
          fileSize: parsed.size,
          mapping,
          options,
          accounts: accountPlans,
          categories: categoryPlans,
          rows: rowStates,
          createRecurring: createRecurring && Boolean(mapping.recurring),
        },
        accounts ?? [],
        cats.all,
        (stage, done, total) => setProgress({ stage, done, total }),
      );
      setResult(res);
      qc.invalidateQueries();
    } catch (e) {
      reportError(e, "Import stopped partway. Anything already saved is listed in Import history and can be undone there.");
      setStep(4);
      qc.invalidateQueries();
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const reset = () => {
    setStep(0);
    setParsed(null);
    setRowStates(null);
    setResult(null);
    setAccountPlans([]);
    setCategoryPlans([]);
  };

  return (
    <div>
      <ol className="mb-6 flex flex-wrap items-center gap-x-1 gap-y-2 text-[12.5px]">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-1">
            <span
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5",
                i === step ? "bg-accent-soft font-medium text-accent" : i < step ? "text-ink-2" : "text-ink-3",
              )}
            >
              {i < step ? <Check className="size-3" /> : <span className="tabular">{i + 1}</span>}
              {s}
            </span>
            {i < STEPS.length - 1 ? <span className="text-ink-3">·</span> : null}
          </li>
        ))}
      </ol>

      {step === 0 ? <UploadStep onFile={onFile} /> : null}

      {step === 1 && parsed ? (
        <MapStep
          parsed={parsed}
          mapping={mapping}
          setMapping={setMapping}
          options={options}
          setOptions={setOptions}
          rows={rows}
          hasAccountColumn={Boolean(mapping.account)}
        >
          <StepNav
            onBack={reset}
            backLabel="Choose another file"
            onNext={() => {
              buildAccountPlans();
              setStep(2);
            }}
            nextDisabled={!mappingValid || rows.every((r) => r.errors.length)}
          />
        </MapStep>
      ) : null}

      {step === 2 ? (
        <AccountsStep plans={accountPlans} setPlans={setAccountPlans}>
          <StepNav
            onBack={() => setStep(1)}
            onNext={() => {
              buildCategoryPlans();
              setStep(3);
            }}
            nextDisabled={hasAccountConflicts(accountPlans)}
          />
        </AccountsStep>
      ) : null}

      {step === 3 ? (
        <CategoriesStep plans={categoryPlans} setPlans={setCategoryPlans}>
          <StepNav onBack={() => setStep(2)} onNext={prepareReview} nextLabel={busy ? "Checking duplicates…" : "Check for duplicates"} nextDisabled={busy} />
        </CategoriesStep>
      ) : null}

      {step === 4 && rowStates ? (
        <ReviewStep
          states={rowStates}
          setStates={setRowStates}
          options={options}
          setOptions={setOptions}
          hasRecurring={Boolean(mapping.recurring)}
          createRecurring={createRecurring}
          setCreateRecurring={setCreateRecurring}
        >
          <StepNav
            onBack={() => setStep(3)}
            onNext={doImport}
            nextLabel={`Import ${rowStates.filter((r) => r.decision === "import").length.toLocaleString()} transactions`}
            nextDisabled={busy || !rowStates.some((r) => r.decision === "import")}
          />
        </ReviewStep>
      ) : null}

      {step === 5 ? (
        result ? (
          <DoneStep result={result} onAgain={reset} />
        ) : (
          <div className="rounded-lg border border-line bg-surface p-8">
            <p className="font-serif text-lg">Importing…</p>
            <p className="mt-1 text-sm text-ink-2">{progress?.stage ?? "Starting"}</p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-line-soft">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${progress && progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 5}%` }}
              />
            </div>
            {progress?.total && progress.total > 1 ? (
              <p className="tabular mt-2 text-[12px] text-ink-3">
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
              </p>
            ) : null}
            <p className="mt-4 text-[12px] text-ink-3">Keep this tab open until the import finishes.</p>
          </div>
        )
      ) : null}
    </div>
  );
}

function hasAccountConflicts(plans: AccountPlan[]) {
  const seen = new Set<string>();
  for (const p of plans) {
    if (p.target.kind !== "new") continue;
    if (!p.target.name.trim()) return true;
    const k = `${p.target.name.trim().toLowerCase()}|${p.target.lastFour}`;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

function StepNav({
  onBack,
  onNext,
  nextLabel = "Continue",
  backLabel = "Back",
  nextDisabled,
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  backLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="mt-6 flex items-center justify-between border-t border-line pt-4">
      <Button variant="quiet" onClick={onBack}>
        <ArrowLeft /> {backLabel}
      </Button>
      <Button variant="primary" onClick={onNext} disabled={nextDisabled}>
        {nextLabel} <ArrowRight />
      </Button>
    </div>
  );
}

function UploadStep({ onFile }: { onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center transition-colors",
        over ? "border-accent bg-accent-soft/50" : "border-[#cfcac0] bg-surface",
      )}
    >
      <FileUp className="size-7 text-ink-3" strokeWidth={1.5} />
      <p className="mt-3 font-serif text-lg">Drop a CSV file here</p>
      <p className="mt-1 max-w-md text-sm text-ink-2">
        Any bank or finance-app export works. You&apos;ll map its columns, accounts and categories before anything is saved.
      </p>
      <Button variant="primary" className="mt-5" onClick={() => input.current?.click()}>
        <Upload /> Choose file
      </Button>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function MapStep({
  parsed,
  mapping,
  setMapping,
  options,
  setOptions,
  rows,
  hasAccountColumn,
  children,
}: {
  parsed: Parsed;
  mapping: ColumnMapping;
  setMapping: (m: ColumnMapping) => void;
  options: ImportOptions;
  setOptions: (o: ImportOptions) => void;
  rows: NormalizedRow[];
  hasAccountColumn: boolean;
  children: React.ReactNode;
}) {
  const errors = rows.filter((r) => r.errors.length).length;
  const sample = rows.slice(0, 6);
  return (
    <div>
      <p className="text-sm text-ink-2">
        <span className="font-medium text-ink">{parsed.filename}</span> · {parsed.records.length.toLocaleString()} rows · {parsed.headers.length} columns
      </p>

      <div className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {(Object.keys(APP_FIELDS) as AppField[]).map((f) => (
          <Field key={f} label={`${APP_FIELDS[f].label}${APP_FIELDS[f].required ? " *" : ""}`} htmlFor={`map-${f}`}>
            <Select id={`map-${f}`} value={mapping[f] ?? ""} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })}>
              <option value="">— Not in file —</option>
              {parsed.headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
      {!mapping.amount && !mapping.outflow && !mapping.inflow ? (
        <p className="mt-2 text-sm text-brick">Map an Amount column, or Outflow/Inflow columns.</p>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="In this file, a purchase of $10 appears as">
          <Segmented
            ariaLabel="Sign convention"
            value={options.signConvention}
            onChange={(v) => setOptions({ ...options, signConvention: v })}
            options={[
              { value: "negative_is_outflow", label: "-10.00" },
              { value: "positive_is_outflow", label: "10.00" },
            ]}
          />
        </Field>
        <Field label="Date format" htmlFor="date-format">
          <Select
            id="date-format"
            value={options.dateFormat}
            onChange={(e) => setOptions({ ...options, dateFormat: e.target.value as ImportOptions["dateFormat"] })}
          >
            <option value="auto">Detect automatically</option>
            <option value="ymd">Year-month-day</option>
            <option value="mdy">Month/day/year</option>
            <option value="dmy">Day/month/year</option>
          </Select>
        </Field>
        {!hasAccountColumn ? (
          <Field label="All rows belong to account" htmlFor="default-account" hint="You can match it to an existing account on the next step.">
            <Input
              id="default-account"
              value={options.defaultAccountLabel}
              placeholder="e.g. Chase Checking"
              onChange={(e) => setOptions({ ...options, defaultAccountLabel: e.target.value })}
            />
          </Field>
        ) : null}
      </div>

      <h3 className="mt-8 mb-2 text-[13px] font-medium text-ink-2">Preview</h3>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead className="bg-sidebar text-left text-[11.5px] tracking-wide text-ink-2 uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Merchant</th>
              <th className="px-3 py-2 font-medium">Account</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {sample.map((r) => (
              <tr key={r.rowNumber} className="border-t border-line-soft">
                <td className="tabular px-3 py-1.5 whitespace-nowrap">{r.date || <span className="text-brick">invalid</span>}</td>
                <td className="max-w-[260px] truncate px-3 py-1.5">{r.merchant}</td>
                <td className="max-w-[180px] truncate px-3 py-1.5 text-ink-2">{r.accountName}</td>
                <td className="max-w-[180px] truncate px-3 py-1.5 text-ink-2">{[r.parentName, r.categoryName].filter(Boolean).join(" › ")}</td>
                <td className={cn("tabular px-3 py-1.5 text-right", r.amount > 0 && "text-sage")}>
                  {r.errors.some((e) => e.includes("amount")) ? <span className="text-brick">invalid</span> : formatLedgerAmount(r.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-ink-3">
        Money out is shown plain; money in is shown with a +.{" "}
        {errors ? <span className="text-brick">{errors.toLocaleString()} rows currently have errors.</span> : null}
      </p>
      {children}
    </div>
  );
}

function AccountsStep({ plans, setPlans, children }: { plans: AccountPlan[]; setPlans: (p: AccountPlan[]) => void; children: React.ReactNode }) {
  const { data: accounts } = useAccounts();
  const update = (key: string, target: AccountPlan["target"]) => setPlans(plans.map((p) => (p.key === key ? { ...p, target } : p)));
  return (
    <div>
      <p className="mb-4 text-sm text-ink-2">
        Match each account in the file to an existing account, or create it. Balances can be set afterwards on the Accounts page.
      </p>
      <div className="divide-y divide-line-soft rounded-md border border-line bg-surface">
        {plans.map((p) => (
          <div key={p.key} className="grid grid-cols-1 items-center gap-3 px-4 py-3 md:grid-cols-[1fr_1.6fr]">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {p.name}
                {p.mask ? <span className="font-normal text-ink-3"> ··{p.mask}</span> : null}
              </p>
              <p className="text-[12px] text-ink-3">{p.rows.toLocaleString()} transactions</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={`Target for ${p.name}`}
                className="w-full sm:w-56"
                value={p.target.kind === "existing" ? p.target.id : "__new"}
                onChange={(e) =>
                  update(
                    p.key,
                    e.target.value === "__new"
                      ? { kind: "new", name: p.name, type: guessAccountType(p.name), lastFour: p.mask }
                      : { kind: "existing", id: e.target.value },
                  )
                }
              >
                <option value="__new">Create new account</option>
                {(accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.last_four ? ` ··${a.last_four}` : ""}
                  </option>
                ))}
              </Select>
              {p.target.kind === "new" ? (
                <>
                  <Input
                    aria-label="New account name"
                    className="w-full sm:w-48"
                    value={p.target.name}
                    maxLength={120}
                    onChange={(e) => update(p.key, { ...(p.target as Extract<AccountPlan["target"], { kind: "new" }>), name: e.target.value })}
                  />
                  <Select
                    aria-label="Account type"
                    className="w-full sm:w-40"
                    value={p.target.type}
                    onChange={(e) => update(p.key, { ...(p.target as Extract<AccountPlan["target"], { kind: "new" }>), type: e.target.value as AccountType })}
                  >
                    {ACCOUNT_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {ACCOUNT_TYPE_SINGULAR[o.value]}
                      </option>
                    ))}
                  </Select>
                </>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {hasAccountConflicts(plans) ? <p className="mt-2 text-sm text-brick">Two new accounts have the same name and last four, or a name is empty.</p> : null}
      {children}
    </div>
  );
}

function CategoriesStep({ plans, setPlans, children }: { plans: CategoryPlan[]; setPlans: (p: CategoryPlan[]) => void; children: React.ReactNode }) {
  const cats = useCategoryIndex();
  const update = (key: string, v: string) =>
    setPlans(
      plans.map((p) =>
        p.key === key ? { ...p, target: v === "__new" ? { kind: "new" } : v === "__none" ? { kind: "none" } : { kind: "existing", id: v } } : p,
      ),
    );
  const setAll = (kind: "new" | "none") => setPlans(plans.map((p) => (p.target.kind === "existing" ? p : { ...p, target: { kind } })));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">
          {plans.length
            ? "Match the file's categories to yours. New ones keep their parent grouping."
            : "This file has no categories — transactions will import as uncategorized."}
        </p>
        {plans.length ? (
          <div className="flex gap-2">
            <Button size="sm" variant="quiet" onClick={() => setAll("new")}>
              Create all unmatched
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setAll("none")}>
              Leave unmatched uncategorized
            </Button>
          </div>
        ) : null}
      </div>
      {plans.length ? (
        <div className="divide-y divide-line-soft rounded-md border border-line bg-surface">
          {plans.map((p) => (
            <div key={p.key} className="grid grid-cols-1 items-center gap-2 px-4 py-2.5 sm:grid-cols-[1fr_260px]">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {p.parent ? <span className="text-ink-3">{p.parent} › </span> : null}
                  <span className="font-medium">{p.name}</span>
                </p>
                <p className="text-[12px] text-ink-3">{p.rows.toLocaleString()} transactions</p>
              </div>
              <Select
                aria-label={`Category for ${p.name}`}
                value={p.target.kind === "existing" ? p.target.id : p.target.kind === "new" ? "__new" : "__none"}
                onChange={(e) => update(p.key, e.target.value)}
              >
                <option value="__new">
                  Create “{p.name}”{p.parent ? ` in ${p.parent}` : ""}
                </option>
                <option value="__none">Leave uncategorized</option>
                {cats.parents.map((parent) => (
                  <optgroup key={parent.id} label={parent.name}>
                    <option value={parent.id}>{parent.name}</option>
                    {cats.childrenOf(parent.id).map((k) => (
                      <option key={k.id} value={k.id}>
                        {parent.name} › {k.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function ReviewStep({
  states,
  setStates,
  options,
  setOptions,
  hasRecurring,
  createRecurring,
  setCreateRecurring,
  children,
}: {
  states: RowState[];
  setStates: (s: RowState[]) => void;
  options: ImportOptions;
  setOptions: (o: ImportOptions) => void;
  hasRecurring: boolean;
  createRecurring: boolean;
  setCreateRecurring: (v: boolean) => void;
  children: React.ReactNode;
}) {
  const errors = states.filter((s) => s.row.errors.length);
  const exact = states.filter((s) => s.dup === "exact");
  const possible = states.filter((s) => s.dup === "possible");
  const ready = states.filter((s) => s.decision === "import");
  const [showErrors, setShowErrors] = useState(false);
  const monthStart = `${todayISO().slice(0, 8)}01`;

  const setDecision = (pred: (s: RowState) => boolean, decision: "import" | "skip") =>
    setStates(states.map((s) => (pred(s) && !s.row.errors.length ? { ...s, decision } : s)));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Ready to import" value={ready.length} />
        <Stat label="Already imported" value={exact.length} />
        <Stat label="Possible duplicates" value={possible.length} tone={possible.length ? "warn" : undefined} />
        <Stat label="Rows with errors" value={errors.length} tone={errors.length ? "bad" : undefined} />
      </div>

      {possible.length ? (
        <div className="rounded-md border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-2.5">
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="size-4 text-ochre" /> Potential duplicates detected
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="quiet" onClick={() => setDecision((s) => s.dup === "possible", "skip")}>
                Skip all
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setDecision((s) => s.dup === "possible", "import")}>
                Import all anyway
              </Button>
            </div>
          </div>
          <div className="max-h-72 divide-y divide-line-soft overflow-y-auto">
            {possible.map((s) => (
              <div key={s.row.rowNumber} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <span className="tabular w-24 shrink-0 text-ink-2">{formatMediumDate(s.row.date)}</span>
                <span className="min-w-0 flex-1 truncate">{s.row.merchant}</span>
                <span className="hidden max-w-[160px] truncate text-ink-3 sm:block">{s.row.accountName}</span>
                <span className="tabular w-24 text-right">{formatLedgerAmount(s.row.amount)}</span>
                <Segmented
                  size="sm"
                  ariaLabel="Decision"
                  value={s.decision}
                  onChange={(d) => setStates(states.map((x) => (x === s ? { ...x, decision: d } : x)))}
                  options={[
                    { value: "skip", label: "Skip" },
                    { value: "import", label: "Import anyway" },
                  ]}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {exact.length ? (
        <p className="text-sm text-ink-2">
          {exact.length.toLocaleString()} rows match transactions from a previous import and will be skipped.{" "}
          <button type="button" className="text-accent hover:underline" onClick={() => setDecision((s) => s.dup === "exact", "import")}>
            Import them anyway
          </button>
        </p>
      ) : null}

      {errors.length ? (
        <div>
          <button type="button" onClick={() => setShowErrors((v) => !v)} className="text-sm text-brick hover:underline">
            {showErrors ? "Hide" : "Show"} {errors.length.toLocaleString()} rows that can&apos;t be imported
          </button>
          {showErrors ? (
            <ul className="mt-2 max-h-56 overflow-y-auto rounded-md border border-line bg-surface text-[12.5px]">
              {errors.slice(0, 500).map((s) => (
                <li key={s.row.rowNumber} className="flex gap-3 border-b border-line-soft px-3 py-1.5 last:border-0">
                  <span className="tabular w-16 shrink-0 text-ink-3">Row {s.row.rowNumber}</span>
                  <span className="min-w-0 flex-1 truncate">{Object.values(s.row.raw).slice(0, 4).join(" · ")}</span>
                  <span className="shrink-0 text-brick">{s.row.errors.join("; ")}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3 rounded-md border border-line bg-surface p-4">
        <p className="text-sm font-medium">Options</p>
        <label className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <Checkbox
            checked={Boolean(options.reviewedBefore)}
            onChange={(v) => setOptions({ ...options, reviewedBefore: v ? monthStart : "" })}
            label="Mark older transactions as reviewed"
          />
          Mark transactions dated before
          <input
            type="date"
            aria-label="Reviewed before date"
            disabled={!options.reviewedBefore}
            value={options.reviewedBefore || monthStart}
            onChange={(e) => setOptions({ ...options, reviewedBefore: e.target.value })}
            className="h-7 rounded-md border border-line bg-paper px-2 text-[13px] disabled:opacity-50"
          />
          as already reviewed
        </label>
        <p className="pl-6 text-[12px] text-ink-3">Everything else imports as unreviewed so you can work through it in the review queue.</p>
        {hasRecurring ? (
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={createRecurring} onChange={setCreateRecurring} label="Create recurring items" />
            Create recurring items from the file&apos;s recurring column (frequency and amount are inferred)
          </label>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" }) {
  return (
    <div className="rounded-md border border-line bg-surface px-4 py-3">
      <p className="text-[12px] text-ink-2">{label}</p>
      <p className={cn("tabular mt-0.5 font-serif text-2xl", tone === "bad" ? "text-brick" : tone === "warn" ? "text-ochre" : "text-ink")}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function DoneStep({ result, onAgain }: { result: ImportResult; onAgain: () => void }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-8">
      <p className="flex items-center gap-2 font-serif text-xl">
        <Check className="size-5 text-sage" /> Import complete
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
        <Summary label="Imported" value={result.imported} />
        <Summary label="Duplicates skipped" value={result.duplicates} />
        <Summary label="Other rows skipped" value={result.skipped} />
        <Summary label="Rows with errors" value={result.errors} />
        <Summary label="Accounts created" value={result.accountsCreated} />
        <Summary label="Categories created" value={result.categoriesCreated} />
        <Summary label="Recurring items created" value={result.recurringCreated} />
        <Summary label="Rule updates" value={result.rulesApplied} />
        <Summary label="Linked to recurring" value={result.recurringLinked} />
      </dl>
      <div className="mt-6 flex flex-wrap gap-2">
        <Link href="/transactions?review=unreviewed">
          <Button variant="primary">Review transactions</Button>
        </Link>
        <Link href="/accounts">
          <Button>Set account balances</Button>
        </Link>
        <Button variant="quiet" onClick={onAgain}>
          Import another file
        </Button>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1">
      <dt className="text-ink-2">{label}</dt>
      <dd className="tabular font-medium">{value.toLocaleString()}</dd>
    </div>
  );
}
