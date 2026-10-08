"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { EVENT_TYPE_OPTIONS, type CalendarReminder } from "@/lib/domain";
import { parseMoney } from "@/lib/money";
import { useSaveReminder } from "@/lib/queries/analytics";
import { useAccounts } from "@/lib/queries/reference";

export function ReminderDialog({
  open,
  onOpenChange,
  date,
  reminder,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  date?: string;
  reminder?: CalendarReminder;
}) {
  if (!open) return null;
  return <Inner key={reminder?.id ?? date ?? "new"} onOpenChange={onOpenChange} date={date} reminder={reminder} />;
}

function Inner({ onOpenChange, date, reminder }: { onOpenChange: (o: boolean) => void; date?: string; reminder?: CalendarReminder }) {
  const { data: accounts } = useAccounts();
  const save = useSaveReminder();
  const [title, setTitle] = useState(reminder?.title ?? "");
  const [day, setDay] = useState(reminder?.reminder_date ?? date ?? "");
  const [amount, setAmount] = useState(reminder?.amount != null ? reminder.amount.toFixed(2) : "");
  const [type, setType] = useState(reminder?.event_type ?? "bill");
  const [accountId, setAccountId] = useState(reminder?.account_id ?? "");
  const [notes, setNotes] = useState(reminder?.notes ?? "");
  const amt = amount.trim() ? parseMoney(amount) : null;
  const valid = title.trim() && day && (!amount.trim() || (amt !== null && amt >= 0));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    save.mutate(
      {
        id: reminder?.id,
        values: {
          title: title.trim(),
          reminder_date: day,
          amount: amt === null ? null : Math.abs(amt),
          event_type: type,
          account_id: accountId || null,
          notes: notes.trim() || null,
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange} title={reminder ? "Edit reminder" : "New reminder"} description="A one-off financial reminder on the calendar.">
      <form onSubmit={submit} className="grid grid-cols-2 gap-4">
        <Field label="Title" htmlFor="rem-title" className="col-span-2">
          <Input
            id="rem-title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="e.g. Property tax installment"
          />
        </Field>
        <Field label="Date" htmlFor="rem-date">
          <Input id="rem-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Amount (optional)" htmlFor="rem-amt">
          <Input id="rem-amt" inputMode="decimal" className="tabular" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Type" htmlFor="rem-type">
          <Select id="rem-type" value={type} onChange={(e) => setType(e.target.value)}>
            {EVENT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Account (optional)" htmlFor="rem-acct">
          <Select id="rem-acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">None</option>
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes" htmlFor="rem-notes" className="col-span-2">
          <Textarea id="rem-notes" className="min-h-16" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="col-span-2 flex justify-end gap-2 border-t border-line-soft pt-4">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || save.isPending}>
            {save.isPending ? "Saving…" : reminder ? "Save reminder" : "Add reminder"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
