// Clancy: invoice / claim lines vs shifts and timesheets.
// One rule engine, two feeds: live ShiftCare (invoices + shifts + day-by-day timesheets) or CSV.
import { PRICES, dayType, familyCode, hm, round2 } from "./util.ts";

export type Line = {
  invoice: string; invoice_id?: string; line_id: string; shift_id: string; client: string;
  support_item: string; category: string; date: string; hours: number; unit_price: number; amount: number;
  invoice_status?: string;
};
export type Shift = {
  shift_id: string; client: string; staff: string; date: string;
  start: string | null; end: string | null;            // rostered, Adelaide HH:MM
  worked: { staff: string; clock_in: string | null; clock_out: string | null; hours: number }[];
  has_timesheet: boolean; kms: number; cancelled?: boolean;
};
export type Exception = {
  invoice: string; line_id: string; shift_id: string; code: string; title: string; detail: string; impact: number;
  client: string; staff?: string; date: string;
};

const TITLES: Record<string, string> = {
  duplicate: "Duplicate line",
  already_invoiced: "Shift already billed on another invoice",
  no_timesheet: "Billed shift has no timesheet",
  time: "Billed time doesn't match worked time",
  rate_cap: "Unit price above the price limit",
  loading: "Wrong day or time loading",
  missing_km: "Kilometres travelled not claimed",
  unknown_item: "Support item not in the price table",
  no_shift: "Line points to a shift that can't be found",
};

export function checkLines(lines: Line[], shifts: Map<string, Shift>, allLines: Line[] = lines): Exception[] {
  const out: Exception[] = [];
  const ex = (l: Line, code: string, detail: string, impact: number, staff?: string): Exception => ({
    invoice: l.invoice, line_id: l.line_id, shift_id: l.shift_id, code, title: TITLES[code], detail,
    impact: round2(impact), client: l.client, staff, date: l.date,
  });

  // duplicates inside one invoice: same shift + item + hours + date (the repeat line is skipped
  // for every other check). The same shift billed on another live invoice is reported as
  // "already_invoiced" and the line is still checked.
  const seen = new Map<string, Line>();
  for (const l of lines) {
    if (l.category !== "Hours" && l.category !== "") continue;
    const k = `${l.invoice}|${l.shift_id}|${l.support_item}|${l.hours}|${l.date}`;
    const first = seen.get(k);
    if (!first) { seen.set(k, l); continue; }
    out.push(ex(l, "duplicate", `Same shift, item, date and hours as line ${first.line_id}.`, -l.amount));
    (l as any)._dup = true;
  }
  for (const l of lines) {
    if ((l as any)._dup || !l.shift_id) continue;
    const other = allLines.find((x) => x.shift_id === l.shift_id && x.invoice !== l.invoice && x.support_item === l.support_item &&
      !/draft|void|cancel/i.test(x.invoice_status || ""));
    if (other) out.push(ex(l, "already_invoiced", `Shift ${l.shift_id} is already billed on ${other.invoice} (${other.invoice_status || "issued"}) line ${other.line_id}.`, -l.amount));
  }

  for (const l of lines) {
    if ((l as any)._dup) continue;
    const s = shifts.get(l.shift_id);
    const price = PRICES[l.support_item];
    const isHours = (l.category || "Hours") === "Hours" && (!price || price.unit === "H");
    if (!s) {
      if (l.shift_id) out.push(ex(l, "no_shift", `Shift ${l.shift_id} was not found in ShiftCare.`, 0));
    } else if (isHours) {
      const staff = s.staff;
      if (!s.has_timesheet) {
        out.push(ex(l, "no_timesheet",
          `Billed ${l.hours}h but there is no timesheet (no clock-in or clock-out) for this shift${s.start ? `, rostered ${s.start} to ${s.end}` : ""}. Check the worker attended before claiming.`,
          -l.amount, staff));
      } else {
        const worked = Math.max(...s.worked.map((w) => w.hours));
        if (Math.abs(worked - l.hours) > 0.01) {
          const w = s.worked.find((x) => x.hours === worked)!;
          out.push(ex(l, "time", `Billed ${l.hours}h, clocked ${round2(worked)}h (${w.clock_in} to ${w.clock_out}).`,
            (worked - l.hours) * l.unit_price, staff));
        }
      }
      // loading / day type
      if (price?.family) {
        const w = s.worked[0];
        const dt = dayType(s.date || l.date, (w?.clock_in) || s.start, (w?.clock_out) || s.end);
        if (dt.when !== price.when) {
          const want = familyCode(price.family, dt.when);
          if (want) {
            const billedHours = s.has_timesheet ? Math.min(l.hours, Math.max(...s.worked.map((x) => x.hours))) : l.hours;
            out.push(ex(l, "loading",
              `Billed as ${price.label} but ${dt.why}. Expected ${want} (${PRICES[want].label}, limit $${PRICES[want].cap.toFixed(2)}).`,
              (PRICES[want].cap - l.unit_price) * billedHours, staff));
          }
        }
      }
      if (s.kms > 0 && !allLines.some((x) => x.shift_id === l.shift_id && /km|kilomet|transport|01_799/i.test(x.category + " " + x.support_item))) {
        out.push(ex(l, "missing_km", `${s.kms} km recorded on the shift but no kilometre line was billed.`, 0, staff));
      }
    }
    if (price) {
      if (l.unit_price > price.cap + 0.005) {
        out.push(ex(l, "rate_cap", `Unit price $${l.unit_price.toFixed(2)} is above the $${price.cap.toFixed(2)} limit for ${l.support_item} (${price.label}).`,
          (price.cap - l.unit_price) * l.hours));
      }
    } else if (l.support_item && isHours) {
      out.push(ex(l, "unknown_item", `${l.support_item} is not in the sample price table, so the price limit could not be checked.`, 0));
    }
  }
  return out;
}

// ---- CSV feed ----
export function linesFromCsv(rows: Record<string, string>[]): Line[] {
  return rows.map((r) => ({
    invoice: r.invoice, line_id: r.line_id, shift_id: r.shift_id, client: r.client, support_item: r.support_item,
    category: PRICES[r.support_item]?.unit === "K" ? "KM" : "Hours", date: r.date, hours: Number(r.hours) || 0, unit_price: Number(r.unit_price) || 0, amount: Number(r.amount) || 0,
  }));
}
export function shiftsFromCsv(rows: Record<string, string>[]): Map<string, Shift> {
  const m = new Map<string, Shift>();
  for (const r of rows) {
    const ci = r.clock_in || null, co = r.clock_out || null;
    const a = hm(ci || ""), b = hm(co || "");
    const has = a != null && b != null;
    m.set(r.shift_id, {
      shift_id: r.shift_id, client: r.client, staff: r.staff, date: r.date, start: ci, end: co,
      worked: has ? [{ staff: r.staff, clock_in: ci, clock_out: co, hours: round2(((b! - a! + 1440) % 1440) / 60) }] : [],
      has_timesheet: has, kms: Number(r.kms) || 0,
    });
  }
  return m;
}
