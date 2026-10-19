// Cleo: document and qualification expiry buckets + reminder drafts.
import { daysBetween } from "./util.ts";

export type Doc = {
  person_type: "staff" | "participant"; person: string; email?: string | null; phone?: string | null;
  document: string; expiry_date: string; roster_critical?: boolean; source_id?: string;
};
export type ExpiryResult = Doc & { days: number; bucket: string; channel: string; do_not_roster: boolean };

const CRITICAL = /screening|first aid|cpr|manual handling|medication|driver|licen[cs]e|insurance|police|wwcc|working with children|covid|vaccin/i;

export function bucketOf(days: number): string | null {
  if (days < 0) return "expired";
  if (days <= 30) return "30 days";
  if (days <= 60) return "60 days";
  if (days <= 90) return "90 days";
  return null;
}

export function assess(docs: Doc[], today: string) {
  const items: ExpiryResult[] = [], not_due: ExpiryResult[] = [];
  for (const d of docs) {
    if (!d.expiry_date) continue;
    const days = daysBetween(today, d.expiry_date.slice(0, 10));
    const bucket = bucketOf(days);
    const channel = d.email ? "email" : d.phone ? "sms" : "phone call (no email or mobile on file)";
    const critical = d.roster_critical ?? CRITICAL.test(d.document);
    const r: ExpiryResult = { ...d, days, bucket: bucket || "not due", channel, do_not_roster: d.person_type === "staff" && days < 0 && critical };
    (bucket ? items : not_due).push(r);
  }
  items.sort((a, b) => a.days - b.days);
  return { items, not_due };
}

/** Draft written with tokens only: `who` is the first-name token, never the real name. */
export function draft(r: ExpiryResult, who: string, org: string): string {
  const when = r.days < 0
    ? `expired ${-r.days} day${r.days === -1 ? "" : "s"} ago (${r.expiry_date})`
    : r.days === 0 ? `expires today (${r.expiry_date})` : `expires in ${r.days} day${r.days === 1 ? "" : "s"} (${r.expiry_date})`;
  if (r.channel === "sms") {
    return r.days < 0
      ? `Hi ${who}, your ${r.document} ${when}. Please renew it and send us the new copy as soon as you can. ${org}`
      : `Hi ${who}, your ${r.document} ${when}. Please renew it and send us the new copy before then. ${org}`;
  }
  const subject = r.days < 0 ? `Your ${r.document} has expired` : `Your ${r.document} ${when}`;
  const ask = r.days < 0
    ? `Please renew it now and upload the new copy to ShiftCare (or reply to this email with it).`
    : `Please renew it and upload the new copy to ShiftCare (or reply to this email with it) before it lapses.`;
  const roster = r.person_type === "staff" && (r.do_not_roster || r.days <= 30)
    ? (r.days < 0
      ? " Until we have a current copy we can't roster you on shifts that need it."
      : " Until we have a current copy we may not be able to roster you on shifts that need it.")
    : "";
  const body = r.person_type === "participant"
    ? `Our records show your ${r.document} ${when}. Please contact us so we can arrange the update together. If someone helps you manage your plan, feel free to pass this on to them.`
    : `Our records show your ${r.document} ${when}. ${ask}${roster}`;
  return `${subject}\n\nHi ${who},\n\n${body}\n\nThanks,\n${org} compliance`;
}
