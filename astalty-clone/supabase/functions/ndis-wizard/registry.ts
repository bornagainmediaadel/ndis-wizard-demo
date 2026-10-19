// Registry agents (one job each). Rules run on CSV inputs; /live/:key fills those inputs from ShiftCare.
import { Scrubber } from "./scrub.ts";
import { checkNote } from "./penny.ts";
import { addDays, daysBetween, hm, parseCsv, PRICES, round2 } from "./util.ts";
import REG from "./registry.json" with { type: "json" };

export const REGISTRY: any[] = REG as any[];
export type RegItem = {
  agent: string; agent_name: string; approver_role: string; title: string; severity: "high" | "medium" | "low";
  tags: string[]; draft: string; details: Record<string, unknown>;
};
type Ctx = { today: string; now: string; org: string };
type Out = { summary: string; items: RegItem[] };

const first = (tok: string) => (tok.endsWith("_FIRST]") ? tok : tok.replace("]", "_FIRST]"));
const list = (v: string) => String(v || "").split(/[;|]/).map((x) => x.trim()).filter(Boolean);
const yes = (v: string) => /^(y|yes|true|1)$/i.test(String(v || "").trim());

function mk(key: string, sc: Scrubber, p: Omit<RegItem, "agent" | "agent_name" | "approver_role">): RegItem {
  const a = REGISTRY.find((r) => r.key === key)!;
  return { agent: key, agent_name: a.name, approver_role: a.approver, ...p, draft: sc.text(p.draft), tags: p.tags.map((t) => sc.text(t)), title: sc.text(p.title) };
}

// ---------- Rory: shift cover ----------
function rory(inp: Record<string, string>, sc: Scrubber): Out {
  const vac = parseCsv(inp.vacant), staff = parseCsv(inp.staff);
  const items: RegItem[] = [];
  for (const v of vac) {
    const ctok = sc.person(v.client, "CLIENT");
    const needs = list(v.needs).map((x) => x.toLowerCase());
    const pref = list(v.preferred_staff).map((x) => x.toLowerCase());
    const s0 = hm(v.start)!, e0 = hm(v.end)!;
    const ok: { name: string; phone: string; pref: boolean; note: string }[] = [], skipped: string[] = [];
    for (const s of staff) {
      const stok = sc.person(s.staff, "STAFF");
      if (list(s.do_not_send).some((n) => n.toLowerCase() === String(v.client).toLowerCase())) { skipped.push(`${stok}: on the do-not-send list`); continue; }
      const busy = list(s.already_rostered).some((w) => {
        const m = /(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})/.exec(w);
        return m && m[1] === v.date && hm(m[2])! < e0 && hm(m[3])! > s0;
      });
      if (busy) { skipped.push(`${stok}: already rostered`); continue; }
      const windows = list(s.available);
      let note = "";
      if (windows.length) {
        const fits = windows.some((w) => {
          const m = /(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})/.exec(w);
          return m && m[1] === v.date && hm(m[2])! <= s0 && hm(m[3])! >= e0;
        });
        if (!fits) { skipped.push(`${stok}: not available`); continue; }
      } else note = "availability not recorded";
      const quals = list(s.quals).map((x) => x.toLowerCase());
      const missing = needs.filter((n) => !quals.includes(n));
      if (missing.length) { skipped.push(`${stok}: missing ${missing.join(", ")}`); continue; }
      ok.push({ name: s.staff, phone: s.phone, pref: pref.includes(String(s.staff).toLowerCase()), note });
    }
    ok.sort((a, b) => Number(b.pref) - Number(a.pref));
    const top = ok[0];
    const short = ok.map((o) => sc.person(o.name, "STAFF"));
    const draft = top
      ? `Shortlist for ${ctok}: ${short.join(", ")}\nSkipped: ${skipped.join("; ") || "none"}\n\nDraft SMS to ${sc.person(top.name, "STAFF")} (${top.phone || "no mobile on file"}):\nHi ${first(sc.person(top.name, "STAFF"))}, a shift is open: ${v.date} ${v.start} to ${v.end}${v.location ? ` in ${v.location}` : ""}. Reply YES to take it. First yes is confirmed by the office.`
      : `No one suits ${ctok} on ${v.date} ${v.start} to ${v.end}.\nSkipped: ${skipped.join("; ") || "no staff supplied"}\n\nEscalate to the rostering coordinator to find cover.`;
    items.push(mk("rory", sc, {
      title: `${v.shift_id} · ${v.date} ${v.start}–${v.end} · ${ok.length} suited`, severity: ok.length ? "medium" : "high",
      tags: ok.map((o, i) => `${i + 1}. ${sc.person(o.name, "STAFF")}${o.pref ? " (preferred)" : ""}${o.note ? ` (${o.note})` : ""}`),
      draft, details: { shift_id: v.shift_id, shortlist: ok.map((o) => o.name) },
    }));
  }
  return { summary: `${vac.length} vacant shift(s) checked against ${staff.length} staff.`, items };
}

// ---------- Sunny: sign-ins and missing notes ----------
function sunny(inp: Record<string, string>, sc: Scrubber, ctx: Ctx): Out {
  const rows = parseCsv(inp.shifts);
  const now = (inp.now || ctx.now).trim();
  const [nd, nt] = now.split(/\s+/);
  const nowMin = (d: string, t: string) => daysBetween(nd, d) * 1440 + (hm(t) ?? 0) - (hm(nt) ?? 0); // minutes from now
  const items: RegItem[] = [];
  for (const r of rows) {
    const stok = sc.person(r.staff, "STAFF"), ctok = sc.person(r.client, "CLIENT");
    const sinceStart = -nowMin(r.date, r.start), sinceEnd = -nowMin(r.date, r.end);
    const tags: string[] = [];
    let sev: RegItem["severity"] = "low", msg = "";
    if (!r.clocked_in && sinceStart >= 15) {
      sev = sinceStart >= 30 ? "high" : "medium";
      tags.push(`no sign-in ${sinceStart} min after start`);
      if (sinceStart >= 30) tags.push("on-call coordinator told");
      msg = `Hi ${first(stok)}, ShiftCare shows no sign-in for your ${r.start} shift with ${first(ctok)} today. Are you on your way? Please clock in or call the office.`;
    } else if (r.clocked_in && (hm(r.clocked_in)! - hm(r.start)!) > 10) {
      tags.push(`signed in ${hm(r.clocked_in)! - hm(r.start)!} min late`);
      sev = "low";
      msg = `Hi ${first(stok)}, you signed in at ${r.clocked_in} for the ${r.start} shift with ${first(ctok)}. If something held you up, please add a short note so the office knows.`;
    }
    if (sinceEnd > 0 && !yes(r.note_submitted) && (r.clocked_in || sinceStart < 15)) {
      tags.push("finished, no progress note");
      if (sev === "low") sev = "medium";
      msg = (msg ? msg + "\n\n" : "") + `Hi ${first(stok)}, the progress note for your ${r.date} ${r.start} shift with ${first(ctok)} hasn't come through yet. Please submit it in ShiftCare today.`;
    }
    if (!tags.length) continue;
    items.push(mk("sunny", sc, {
      title: `${r.shift_id} · ${r.date} ${r.start}–${r.end} · ${stok}`, severity: sev, tags,
      draft: `Draft SMS to ${stok} (${r.phone || "no mobile on file"}):\n${msg}`, details: { shift_id: r.shift_id },
    }));
  }
  return { summary: `${rows.length} shift(s) checked at ${now}. ${items.length} need a nudge.`, items };
}

// ---------- Lenny: timesheets vs roster vs award (SAMPLE SCHADS rules) ----------
function lenny(inp: Record<string, string>, sc: Scrubber): Out {
  const roster = parseCsv(inp.roster), ts = parseCsv(inp.timesheets);
  const tsBy = new Map(ts.map((t) => [t.shift_id, t]));
  const items: RegItem[] = [];
  const mins = (a: string, b: string) => ((hm(b)! - hm(a)! + 1440) % 1440);
  for (const r of roster) {
    const t = tsBy.get(r.shift_id), stok = sc.person(r.staff, "STAFF");
    const flags: string[] = [];
    if (!t || !t.clock_in) flags.push("no timesheet");
    else {
      const d = mins(t.clock_in, t.clock_out) - mins(r.start, r.end);
      if (Math.abs(d) >= 15) flags.push(`worked ${d > 0 ? "+" : ""}${d} min vs roster (${t.clock_in}–${t.clock_out} vs ${r.start}–${r.end})`);
    }
    const len = t?.clock_in ? mins(t.clock_in, t.clock_out) : mins(r.start, r.end);
    if (len > 600) flags.push(`${round2(len / 60)}h shift: over 10 hours, check overtime`);
    if (flags.length) items.push(mk("lenny", sc, {
      title: `${r.shift_id} · ${stok} · ${r.date}`, severity: flags.some((f) => /no timesheet|over 10/.test(f)) ? "medium" : "low",
      tags: flags, draft: `${stok}, ${r.date} ${r.start}–${r.end}:\n- ${flags.join("\n- ")}\n\nPayroll to confirm before the pay run. SAMPLE SCHADS rules: check the award.`, details: { shift_id: r.shift_id },
    }));
  }
  // broken shifts and rest breaks per worker
  const by = new Map<string, Record<string, string>[]>();
  for (const r of roster) by.set(r.staff, [...(by.get(r.staff) || []), r]);
  for (const [name, rs] of by) {
    rs.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const stok = sc.person(name, "STAFF");
    for (let i = 1; i < rs.length; i++) {
      const a = rs[i - 1], b = rs[i];
      const gap = daysBetween(a.date, b.date) * 1440 + hm(b.start)! - hm(a.end)!;
      if (a.date === b.date && gap > 0) {
        items.push(mk("lenny", sc, { title: `${stok} · ${a.date} · broken shift`, severity: "low", tags: ["broken shift allowance"],
          draft: `${stok} worked ${a.start}–${a.end} and ${b.start}–${b.end} on ${a.date} (${a.shift_id}, ${b.shift_id}). This is a broken shift: add the broken shift allowance. SAMPLE SCHADS rule.`, details: { shifts: [a.shift_id, b.shift_id] } }));
      } else if (a.date !== b.date && gap < 600) {
        items.push(mk("lenny", sc, { title: `${stok} · ${b.date} · short break`, severity: "medium", tags: [`${round2(gap / 60)}h between shifts`],
          draft: `${stok} had only ${round2(gap / 60)}h between ${a.shift_id} (ends ${a.date} ${a.end}) and ${b.shift_id} (starts ${b.date} ${b.start}). Under 10 hours: check the overtime rate applies. SAMPLE SCHADS rule.`, details: { shifts: [a.shift_id, b.shift_id] } }));
      }
    }
  }
  return { summary: `${roster.length} rostered shift(s) compared with ${ts.length} timesheet(s).`, items };
}

// ---------- Indy: incident report draft ----------
function indy(inp: Record<string, string>, sc: Scrubber): Out {
  const ptok = sc.person(inp.participant, "CLIENT"), stok = sc.person(inp.staff, "STAFF");
  const text = String(inp.text || "");
  const flags = checkNote(text).filter((f) => ["restrictive_practice", "incident", "not_escalated"].includes(f.code));
  const rp = flags.some((f) => f.code === "restrictive_practice");
  const serious = /hospital|ambulance|fracture|broken|unconscious|stitches|death|died|sexual|abuse|neglect|assault/i.test(text);
  const clock = rp ? "Unauthorised restrictive practice: notify the NDIS Commission within 5 business days (24 hours if it caused harm)." : serious ? "Possible serious injury, abuse or neglect: notify the NDIS Commission within 24 hours." : "May not be reportable to the NDIS Commission: record it internally and review.";
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pick = (re: RegExp) => sentences.filter((s) => re.test(s)).join(" ") || "Not stated. Ask the worker.";
  const draft = `INCIDENT REPORT DRAFT\nParticipant: ${ptok}\nWorker: ${stok}\n\n1. What happened\n${text}\n\n2. Injuries\n${pick(/bruis|injur|cut|bleed|head|pain|swell/i)}\n\n3. Immediate response and first aid\n${pick(/ice|first aid|applied|called|ambulance|calm/i)}\n\n4. Who was notified\n${pick(/called|rang|told|notified|mum|dad|family|guardian/i)}\n\n5. Possible restrictive practice\n${rp ? "Yes: " + flags.find((f) => f.code === "restrictive_practice")!.evidence : "None described."}\n\n6. Reportable?\n${clock}\n\nA person decides and lodges. Nothing has been lodged.`;
  return { summary: `Incident draft prepared. ${clock}`, items: [mk("indy", sc, {
    title: `Incident draft · ${ptok}`, severity: rp || serious || flags.length ? "high" : "medium",
    tags: [...flags.map((f) => f.title), rp ? "5 business days" : serious ? "24 hours" : "internal"], draft, details: { reportable: rp || serious },
  })] };
}

// ---------- Chase: incident follow-up ----------
function chase(inp: Record<string, string>, sc: Scrubber, ctx: Ctx): Out {
  const rows = parseCsv(inp.actions).filter((r) => !yes(r.done));
  const items: RegItem[] = [];
  for (const r of rows) {
    const days = daysBetween(ctx.today, r.due);
    if (days > 3) continue;
    const otok = sc.person(r.owner, "STAFF"), ptok = sc.person(r.participant, "CLIENT");
    const state = days < 0 ? `overdue by ${-days} day${days === -1 ? "" : "s"}` : days === 0 ? "due today" : `due in ${days} day${days === 1 ? "" : "s"}`;
    items.push(mk("chase", sc, {
      title: `${r.incident_id} · ${r.action}`, severity: days < 0 ? "high" : "medium", tags: [state, otok],
      draft: `To: ${otok} (${r.owner_email})\nSubject: ${r.incident_id} action ${state}\n\nHi ${first(otok)},\n\nThe action "${r.action}" for ${ptok} (${r.incident_id}) is ${state} (${r.due}). Can you complete it or let me know what's blocking it?\n\nThanks,\n${ctx.org} quality`,
      details: { incident_id: r.incident_id, due: r.due },
    }));
  }
  return { summary: `${rows.length} open action(s). ${items.length} overdue or due within 3 days.`, items };
}

// ---------- Archie: Practice Standards evidence gaps ----------
function archie(inp: Record<string, string>, sc: Scrubber, ctx: Ctx): Out {
  const rows = parseCsv(inp.files), items: RegItem[] = [];
  const old = (d: string) => !d || daysBetween(d, ctx.today) > 365;
  for (const r of rows) {
    const ptok = sc.person(r.participant, "CLIENT"), gaps: string[] = [];
    if (!yes(r.service_agreement_signed)) gaps.push("No signed service agreement");
    if (!yes(r.consent_on_file)) gaps.push("No consent on file");
    if (old(r.risk_assessment_date)) gaps.push(`Risk assessment ${r.risk_assessment_date ? "older than 12 months (" + r.risk_assessment_date + ")" : "missing"}`);
    if (old(r.support_plan_review_date)) gaps.push(`Support plan review ${r.support_plan_review_date ? "older than 12 months (" + r.support_plan_review_date + ")" : "missing"}`);
    if (yes(r.bsp_required) && !yes(r.bsp_on_file)) gaps.push("Behaviour support plan required but not on file");
    if (!yes(r.emergency_plan)) gaps.push("No emergency and disaster plan");
    if (!yes(r.goals_recorded)) gaps.push("Goals not recorded");
    if (!gaps.length) continue;
    items.push(mk("archie", sc, {
      title: `${ptok} · ${gaps.length} evidence gap${gaps.length > 1 ? "s" : ""}`, severity: gaps.some((g) => /agreement|consent|Behaviour/.test(g)) ? "high" : "medium",
      tags: gaps, draft: `Auditor view for ${ptok}:\n- ${gaps.join("\n- ")}\n\nFix these before the next NDIS Practice Standards audit.`, details: { gaps },
    }));
  }
  return { summary: `${rows.length} participant file(s) checked. ${items.length} with gaps.`, items };
}

// ---------- Sage: service agreements ----------
function sage(inp: Record<string, string>, sc: Scrubber, ctx: Ctx): Out {
  const rows = parseCsv(inp.plans), items: RegItem[] = [];
  for (const r of rows) {
    const ptok = sc.person(r.participant, "CLIENT");
    const ntok = r.nominee ? sc.person(r.nominee, "PERSON") : "";
    const weeks = Math.max(0, daysBetween(ctx.today > r.plan_start ? ctx.today : r.plan_start, r.plan_end)) / 7;
    const rate = Number(r.rate), hrs = Number(r.hours_per_week), budget = Number(r.core_budget);
    const est = round2(rate * hrs * weeks);
    const cap = PRICES[r.support_item]?.cap;
    const flags: string[] = [];
    const endDays = daysBetween(ctx.today, r.agreement_end);
    if (endDays <= 60) flags.push(`agreement ends in ${endDays} days (${r.agreement_end})`);
    if (r.agreement_end > r.plan_end) flags.push("agreement runs past the plan end");
    if (est > budget) flags.push(`estimated $${est.toFixed(2)} is over the $${budget.toFixed(2)} core budget`);
    if (cap && rate > cap) flags.push(`rate $${rate} is above the $${cap} limit`);
    items.push(mk("sage", sc, {
      title: `${ptok} · schedule of supports`, severity: flags.length ? "medium" : "low", tags: flags.length ? flags : ["ready for signature"],
      draft: `SERVICE AGREEMENT DRAFT: schedule of supports\nParticipant: ${ptok} (NDIS ${r.ndis_number})${ntok ? `\nNominee: ${ntok}` : ""}\nPlan: ${r.plan_start} to ${r.plan_end}\n\n${r.support_item} ${PRICES[r.support_item]?.label || ""}\n${hrs} h/week x $${rate.toFixed(2)} x ${round2(weeks)} weeks = $${est.toFixed(2)} (core budget $${budget.toFixed(2)})\n\n${flags.length ? "Check: " + flags.join("; ") : "No issues found."}\n\nA coordinator approves before it goes for signature.`,
      details: { estimate: est },
    }));
  }
  return { summary: `${rows.length} plan(s). ${items.filter((i) => i.severity !== "low").length} need attention.`, items };
}

// ---------- Val: file and find documents ----------
const DOCTYPES: [RegExp, string, string][] = [
  [/first ?aid|hltaid011/i, "First Aid certificate", "Qualifications"], [/cpr|hltaid009/i, "CPR certificate", "Qualifications"],
  [/screening|wwc|police/i, "NDIS Worker Screening", "Qualifications"], [/driver'?s? ?licen[cs]e|licen[cs]e/i, "Driver licence", "Qualifications"],
  [/insurance/i, "Car insurance", "Qualifications"], [/service agreement/i, "Service agreement", "Agreements"],
  [/ndis plan|\bplan\b/i, "NDIS plan", "Plans"], [/behaviour support/i, "Behaviour support plan", "Plans"], [/consent/i, "Consent form", "Agreements"],
];
function val(inp: Record<string, string>, sc: Scrubber): Out {
  const rows = parseCsv(inp.files), items: RegItem[] = [];
  for (const r of rows) {
    const f = r.filename;
    const t = DOCTYPES.find(([re]) => re.test(f));
    const nm = /^(?:scan_\d+\s+)?([A-Z][a-z]+(?:\s(?:O'|Mc)?[A-Z][a-z]+)+)/.exec(f.replace(/^scan_\d+\s+/, ""));
    let exp = /(\d{4}-\d{2}-\d{2})/.exec(f)?.[1] || null;
    const dmy = /(\d{2})-(\d{2})-(\d{4})/.exec(f);
    if (!exp && dmy) exp = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    const who = nm ? nm[1] : null;
    const placed = !!(t && who);
    const owner = who ? sc.person(who, "PERSON") : "";
    sc.person(r.uploaded_by, "PERSON");
    const folder = placed ? `${t![2] === "Qualifications" ? "Staff" : "Participants"}/${owner}/${t![2]}` : "Needs a person";
    items.push(mk("val", sc, {
      title: placed ? `${t![1]} · ${owner}` : `Can't place ${f}`, severity: placed ? "low" : "medium",
      tags: [t ? t[1] : "type unknown", who ? owner : "owner unknown", exp ? `expires ${exp}` : "no expiry in name"],
      draft: `${f}\nType: ${t ? t[1] : "unknown"}\nBelongs to: ${who ? owner : "unknown"}\nExpiry: ${exp || "not in file name"}\nFile to: ${folder}${placed ? "" : "\n\nA person needs to open this file and place it."}`,
      details: { filename: f, folder, expiry: exp },
    }));
  }
  return { summary: `${rows.length} file(s). ${items.filter((i) => i.severity === "low").length} placed, ${items.filter((i) => i.severity !== "low").length} need a person.`, items };
}

// ---------- Wizard: behaviour trends ----------
const SIGNALS: [string, RegExp][] = [
  ["escalation", /escalat|aggress|hit out|hitting|yell|scream|threw|kick/i], ["refusal", /refus/i],
  ["poor sleep", /poor sleep|didn't sleep|did not sleep|awake (?:all|most)|unsettled night/i], ["low mood", /low mood|tearful|crying|withdrawn|sad\b|flat/i],
];
function wizard(inp: Record<string, string>, sc: Scrubber, ctx: Ctx, extra?: { pending?: number }): Out {
  const rows = parseCsv(inp.notes), items: RegItem[] = [];
  const by = new Map<string, Record<string, string>[]>();
  for (const r of rows) by.set(r.participant, [...(by.get(r.participant) || []), r]);
  for (const [p, rs] of by) {
    const ptok = sc.person(p, "CLIENT");
    const weeks = [0, 0, 0, 0], hits: string[] = [];
    for (const r of rs) {
      const age = daysBetween(r.date, ctx.today);
      if (age < 0 || age >= 28) continue;
      const w = 3 - Math.floor(age / 7);
      const s = SIGNALS.filter(([, re]) => re.test(r.note)).map(([n]) => n);
      weeks[w] += s.length;
      if (s.length) hits.push(`${r.date}: ${r.note} [${s.join(", ")}]`);
    }
    const rising = weeks[2] + weeks[3] > weeks[0] + weeks[1] && weeks[3] >= 2;
    if (!rising) continue;
    items.push(mk("wizard", sc, {
      title: `${ptok} · signals rising`, severity: weeks[3] >= 4 ? "high" : "medium", tags: [`weekly signals: ${weeks.join(" → ")}`],
      draft: `${ptok}: behaviour signals per week over the last 4 weeks: ${weeks.join(", ")}.\n\nNotes behind it:\n${hits.join("\n")}\n\nA flag is a reason to look, never a diagnosis.`, details: { weeks },
    }));
  }
  const brief = `7am brief: ${extra?.pending ?? 0} item(s) waiting in the review queue. ${items.length} participant(s) with rising signals.`;
  return { summary: brief, items };
}

// ---------- Leads & recruitment ----------
function leads(inp: Record<string, string>, sc: Scrubber, ctx: Ctx): Out {
  const rows = parseCsv(inp.pipeline), items: RegItem[] = [];
  for (const r of rows) {
    const tok = sc.person(r.name, "PERSON");
    const since = daysBetween(r.last_contact, ctx.today);
    const missing = list(r.missing);
    const stage = r.stage.toLowerCase();
    let step = "Reply and book a call";
    if (r.kind === "enquiry") step = /intake/.test(stage) ? "Confirm the intake call" : /new/.test(stage) ? "Reply today and offer an intake call" : "Follow up";
    else step = /appl/.test(stage) ? "Screen and book an interview" : /interview/.test(stage) ? "Chase missing documents and references" : "Follow up";
    if (missing.length) step += `; ask for ${missing.join(", ")}`;
    items.push(mk("leads", sc, {
      title: `${r.kind === "enquiry" ? "Enquiry" : "Applicant"} · ${tok} · ${r.stage}`, severity: since >= 7 ? "high" : "low",
      tags: [since >= 7 ? `no contact for ${since} days` : `last contact ${since} day(s) ago`, step],
      draft: `To: ${tok} (${r.email})\n\nHi ${first(tok)},\n\n${r.kind === "enquiry"
        ? `Thanks for getting in touch with ${ctx.org}. ${/intake/.test(stage) ? "Just confirming our intake call." : "We'd love to have a quick chat about the support you're after. What day suits you for a 20 minute call?"}${missing.length ? ` Before we talk, could you send through your ${missing.join(" and ")}?` : ""}`
        : `Thanks for applying to ${ctx.org}. ${/interview/.test(stage) ? `To finish your application we still need your ${missing.join(" and ") || "references"}.` : "We'd like to book a short interview. What times suit you this week?"}`}\n\nThanks,\n${ctx.org}`,
      details: { next_step: step },
    }));
  }
  return { summary: `${rows.length} in the pipeline. ${items.filter((i) => i.severity === "high").length} with no contact for 7+ days.`, items };
}

export function runRegistry(key: string, inputs: Record<string, string>, ctx: Ctx, extra?: { pending?: number }): Out & { scrubber: Scrubber } {
  const sc = new Scrubber();
  const fns: Record<string, (i: Record<string, string>, s: Scrubber, c: Ctx, e?: any) => Out> = { rory, sunny, lenny, indy, chase, archie, sage, val, wizard, leads };
  const fn = fns[key];
  if (!fn) throw new Error(`Unknown agent ${key}`);
  const r = fn(inputs, sc, ctx, extra);
  return { ...r, scrubber: sc };
}
export { addDays };
