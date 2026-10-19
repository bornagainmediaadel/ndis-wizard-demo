// Shared helpers: Adelaide time, CSV, ids, NDIS sample price table, SA public holidays.
export const TZ = "Australia/Adelaide";

export function adlDate(d: Date | string = new Date()): string {
  const x = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
}
export function adlTime(d: Date | string): string {
  const x = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(x);
}
export function addDays(ymd: string, n: number): string {
  const x = new Date(ymd + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const hm = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export function newId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return prefix + "-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function token(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Minimal RFC4180-ish CSV parser (quotes, commas, CRLF).
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  const s = String(text || "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase());
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}
export function toCsv(rows: Record<string, unknown>[], cols: string[]): string {
  const cell = (v: unknown) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

// SAMPLE price table. Values mirror the clone's indicative price_items; they are NOT the
// official NDIS Pricing Arrangements. Real ShiftCare has no price-limit endpoint, so the
// Wizard keeps its own table.
export type Price = { label: string; cap: number; when: string; unit: "H" | "E" | "K"; family?: string };
export const PRICES: Record<string, Price> = {
  "01_011_0107_1_1": { label: "Assistance with self-care, weekday daytime", cap: 70.23, when: "weekday", unit: "H", family: "selfcare" },
  "01_015_0107_1_1": { label: "Assistance with self-care, weekday evening", cap: 77.38, when: "evening", unit: "H", family: "selfcare" },
  "01_002_0107_1_1": { label: "Assistance with self-care, weekday night", cap: 78.81, when: "night", unit: "H", family: "selfcare" },
  "01_013_0107_1_1": { label: "Assistance with self-care, Saturday", cap: 98.83, when: "saturday", unit: "H", family: "selfcare" },
  "01_014_0107_1_1": { label: "Assistance with self-care, Sunday", cap: 127.43, when: "sunday", unit: "H", family: "selfcare" },
  "01_012_0107_1_1": { label: "Assistance with self-care, public holiday", cap: 156.03, when: "public_holiday", unit: "H", family: "selfcare" },
  "04_104_0125_6_1": { label: "Access community, social and rec activities, weekday daytime", cap: 70.23, when: "weekday", unit: "H" },
  "01_010_0107_1_1": { label: "Night-time sleepover (per night)", cap: 297.6, when: "night", unit: "E" },
  "07_002_0106_8_3": { label: "Support coordination level 2", cap: 100.14, when: "weekday", unit: "H" },
  "01_799_0107_1_1": { label: "Provider travel, non-labour costs (per km)", cap: 0.99, when: "km", unit: "K" },
};
export const PRICE_LABEL = "SAMPLE price table (indicative clone values, not the official NDIS Pricing Arrangements)";
export function familyCode(family: string, when: string): string | null {
  for (const [k, v] of Object.entries(PRICES)) if (v.family === family && v.when === when) return k;
  return null;
}

// South Australian public holidays 2026 (plus early 2027). Part-day holidays (Christmas Eve,
// New Year's Eve from 7pm) are treated as full days for this SAMPLE check.
export const SA_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "New Year's Day", "2026-01-26": "Australia Day", "2026-03-09": "Adelaide Cup Day",
  "2026-04-03": "Good Friday", "2026-04-04": "Easter Saturday", "2026-04-05": "Easter Sunday", "2026-04-06": "Easter Monday",
  "2026-04-25": "Anzac Day", "2026-06-08": "King's Birthday", "2026-10-05": "Labour Day",
  "2026-12-25": "Christmas Day", "2026-12-26": "Proclamation Day", "2026-12-28": "Proclamation Day (additional)",
  "2027-01-01": "New Year's Day", "2027-01-26": "Australia Day",
};

// Which day type applies to a shift that starts at `date startHHMM` and ends at endHHMM.
export function dayType(date: string, start: string | null, end: string | null): { when: string; why: string } {
  if (SA_HOLIDAYS[date]) return { when: "public_holiday", why: `${date} is ${SA_HOLIDAYS[date]} (SA public holiday)` };
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  if (dow === 6) return { when: "saturday", why: `${date} is a Saturday` };
  if (dow === 0) return { when: "sunday", why: `${date} is a Sunday` };
  const s = hm(start || ""), e = hm(end || "");
  if (s != null && s < 6 * 60) return { when: "night", why: `starts before 6am (${start})` };
  if (e != null && s != null && e < s) return { when: "night", why: `finishes after midnight (${end})` };
  if (e != null && e > 20 * 60) return { when: "evening", why: `finishes after 8pm (${end})` };
  return { when: "weekday", why: "weekday daytime" };
}

export function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-wizard-session, authorization, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
