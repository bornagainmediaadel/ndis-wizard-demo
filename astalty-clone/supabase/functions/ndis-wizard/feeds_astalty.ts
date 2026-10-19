// Live feeds from Astalty (the clone or the real API: only ASTALTY_API_BASE and the token change).
// Same exports and shapes as feeds.ts so the agents, scrubber and review queue do not change.
// Only fields, filters and sorts that Astalty's published API reference documents are used here.
import { BudgetError, ShiftCare, pool } from "./shiftcare.ts";
import type { Line, Shift } from "./clancy.ts";
import type { Doc } from "./cleo.ts";
import { addDays, adlDate, adlTime, round2, toCsv } from "./util.ts";

const V = "/public/v1";
const money = (cents: unknown) => round2(Number(cents || 0) / 100);
const pname = (p: any) => p?.full_name || p?.name || [p?.first_name, p?.last_name].filter(Boolean).join(" ");
const uname = (u: any) => u?.name || [u?.first_name, u?.last_name].filter(Boolean).join(" ");
const CRITICAL = /screening|first aid|cpr|manual handling|medication|driver|licen[cs]e|wwcc|working with children/i;
const day = (iso: string | null | undefined) => (iso ? adlDate(iso) : "");

export async function people(sc: ShiftCare) {
  const [staff, clients] = await Promise.all([
    sc.all(`${V}/users`, "data", {}),
    sc.all(`${V}/participants`, "data", { "filter[status]": "active,archived" }),
  ]);
  return {
    staff, clients,
    staffById: new Map(staff.map((s: any) => [String(s.id), s])),
    clientById: new Map(clients.map((c: any) => [String(c.id), c])),
  };
}
const activeClients = (clients: any[]) => clients.filter((c) => c.status === "active");

/** Participant notes, newest first; stops paging once a page is older than `from`. */
async function notesFor(sc: ShiftCare, clients: any[], opts: { source?: string; from?: string; to?: string; maxPages?: number }) {
  const out: any[] = [];
  await pool(clients, 6, async (c: any) => {
    for (let page = 1; page <= (opts.maxPages ?? 3); page++) {
      const body: any = await sc.get(`${V}/participants/${c.id}/notes`, { "filter[source]": opts.source, "page[size]": 100, "page[number]": page });
      const rows: any[] = body?.data ?? [];
      for (const n of rows) out.push({ ...n, _participant: c });
      const oldest = rows.length ? rows.reduce((a, b) => (String(a.created_at) < String(b.created_at) ? a : b)).created_at : null;
      if (!rows.length || page >= Number(body?.meta?.last_page ?? 1) || (opts.from && oldest && day(oldest) < opts.from)) break;
    }
  });
  return out
    .filter((n) => (!opts.from || day(n.created_at) >= opts.from) && (!opts.to || day(n.created_at) <= opts.to))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// ---------- Penny ----------
export async function notesList(sc: ShiftCare, opts: { from?: string; to?: string; limit?: number } = {}) {
  const { clients } = await people(sc);
  const rows = await notesFor(sc, activeClients(clients), { source: "support", from: opts.from, to: opts.to, maxPages: opts.from ? 3 : 1 });
  return rows.slice(0, opts.limit ?? 200).map(noteShape);
}
export function noteShape(n: any) {
  const p = n._participant;
  return {
    id: `${p?.id ?? ""}:${n.id}`, category: n.source_type || "note", message: n.content, shift_id: n.source?.id ? String(n.source.id) : null,
    shift_date: n.created_at ? adlDate(n.created_at) : null, client: pname(p), staff: uname(n.author),
    client_id: p?.id ? String(p.id) : null, staff_id: n.author?.id ? String(n.author.id) : null, created_at: n.created_at,
  };
}
export async function noteById(sc: ShiftCare, id: string) {
  const [pid, nid] = id.includes(":") ? id.split(":") : ["", id];
  if (!pid) throw new Error(`Astalty notes are addressed as <participant id>:<note id>; got ${id}.`);
  const participant = (await sc.get(`${V}/participants/${pid}`))?.data;
  const rows = await sc.all(`${V}/participants/${pid}/notes`, "data", {}, 10);
  const hit = rows.find((n: any) => String(n.id) === nid);
  if (!hit) throw new Error(`Note ${id} was not found in Astalty.`);
  const note = noteShape({ ...hit, _participant: participant });
  let shift: any = null;
  if (note.shift_id && hit.source_type === "support") {
    try { shift = (await sc.get(`${V}/supports/${note.shift_id}`))?.data; } catch (e) { if (e instanceof BudgetError) throw e; shift = null; }
  }
  if (shift) note.shift_date = adlDate(shift.start_time);
  return { note, shift: shift ? { start: adlTime(shift.start_time), end: adlTime(shift.end_time), date: adlDate(shift.start_time) } : null };
}

// ---------- Clancy ----------
function supportToShift(s: any): Shift {
  const worked: Shift["worked"] = [];
  const shifts: any[] = s.shifts || [];
  for (const sh of shifts) {
    if (!sh.clock_in_at || !sh.clock_out_at) continue;
    const brk = (sh.breaks || []).filter((b: any) => !b.is_paid).reduce((a: number, b: any) => a + (Number(b.duration) || 0), 0);
    const mins = (Date.parse(sh.clock_out_at) - Date.parse(sh.clock_in_at)) / 60000 - brk;
    worked.push({ staff: uname(sh.user), clock_in: adlTime(sh.clock_in_at), clock_out: adlTime(sh.clock_out_at), hours: round2(mins / 60) });
  }
  return {
    shift_id: String(s.id), date: adlDate(s.start_time), start: adlTime(s.start_time), end: adlTime(s.end_time),
    client: pname(s.participant), staff: shifts.map((sh) => uname(sh.user)).filter(Boolean).join(", "),
    worked, has_timesheet: shifts.some((sh) => sh.clock_in_at),
    kms: (s.travels || []).reduce((a: number, t: any) => a + (Number(t.actual_distance ?? t.distance) || 0), 0),
    cancelled: shifts.length > 0 && shifts.every((sh) => /cancel/i.test(sh.status || "")),
  };
}
/** Invoice charges expose the charge item's reference, not its NDIS number; map ids to numbers once. */
async function chargeItemNumbers(sc: ShiftCare) {
  const items = await sc.all(`${V}/charge-items`, "data", { "filter[status]": "all" });
  return new Map(items.map((i: any) => [String(i.id), i]));
}
export async function invoiceFeed(sc: ShiftCare, refs: string[] | "all") {
  const [invoices, { clientById }, items] = await Promise.all([sc.all(`${V}/invoices`, "data", {}), people(sc), chargeItemNumbers(sc)]);
  const wanted = refs === "all" ? invoices : invoices.filter((i: any) => refs.some((r) => r.toLowerCase() === String(i.number).toLowerCase() || r === String(i.id)));
  const toLine = (inv: any, ch: any): Line => {
    const item = items.get(String(ch.charge_item?.id));
    return {
      invoice: inv.number, invoice_id: String(inv.id), invoice_status: undefined,
      line_id: String(ch.id), shift_id: ch.support?.id ? String(ch.support.id) : "",
      client: pname(clientById.get(String(inv.participant?.id))) || `participant ${inv.participant?.id}`,
      support_item: item?.number || ch.charge_item?.reference || "", category: item?.unit === "KM" ? "KM" : "Hours", date: day(ch.date),
      hours: Number(ch.quantity) || 0, unit_price: money(ch.unit_cost), amount: money(ch.total_cost),
    };
  };
  const allLines: Line[] = invoices.flatMap((inv: any) => (inv.charges || []).map((ch: any) => toLine(inv, ch)));
  const lines = allLines.filter((l) => wanted.some((w: any) => String(w.id) === l.invoice_id));
  const dates = [...new Set(lines.map((l) => l.date).filter(Boolean))].sort();
  const shifts = new Map<string, Shift>();
  if (dates.length) {
    const sups = await sc.all(`${V}/supports`, "data", { "filter[start_after]": dates[0], "filter[start_before]": dates[dates.length - 1], sort: "start_time" });
    for (const s of sups) shifts.set(String(s.id), supportToShift(s));
  }
  return {
    lines, allLines, shifts,
    invoices: wanted.map((i: any) => ({ id: String(i.id), ref: i.number, status: "", total: money(i.total) })),
    timesheets: [...shifts.values()].filter((s) => s.has_timesheet).length, days: dates.length,
    invoiceOptions: invoices.map((i: any) => ({ id: String(i.id), ref: i.number, status: i.management_type, client: pname(clientById.get(String(i.participant?.id))), total: money(i.total), items: (i.charges || []).length })),
  };
}

// ---------- Cleo ----------
export async function expiryFeed(sc: ShiftCare) {
  const [{ staffById, clientById }, userRecords, participantRecords] = await Promise.all([
    people(sc), sc.all(`${V}/user-records`, "data", {}), sc.all(`${V}/participant-records`, "data", {}),
  ]);
  const docs: Doc[] = [];
  for (const r of userRecords) {
    if (!r.expiry_date) continue;
    const u = staffById.get(String(r.user?.id));
    if (u && u.status === "deactivated") continue;
    const name = r.name || r.record_type?.name || "Record";
    docs.push({ person_type: "staff", person: uname(r.user) || uname(u), email: u?.email, phone: null, document: name, expiry_date: day(r.expiry_date), roster_critical: CRITICAL.test(name), source_id: `user_record:${r.id}` });
  }
  for (const r of participantRecords) {
    if (!r.expiry_date) continue;
    const c = clientById.get(String(r.participant?.id));
    if (c && c.status !== "active") continue;
    docs.push({ person_type: "participant", person: pname(r.participant) || pname(c), email: c?.email, phone: c?.mobile || c?.phone, document: r.name || r.record_type?.name || "Record", expiry_date: day(r.expiry_date), source_id: `participant_record:${r.id}` });
  }
  return docs;
}

// ---------- Registry live inputs ----------
const QTAGS: [RegExp, string][] = [[/screening/i, "screening"], [/first aid/i, "first_aid"], [/cpr/i, "cpr"], [/medication/i, "medication"], [/manual handling/i, "manual_handling"], [/driver/i, "driver"]];
export async function liveInputs(sc: ShiftCare, key: string, today: string, now: string): Promise<Record<string, string>> {
  if (key === "rory") {
    const to = addDays(today, 7);
    const [sups, { staff }, records] = await Promise.all([
      sc.all(`${V}/supports`, "data", { "filter[start_after]": today, "filter[start_before]": to, sort: "start_time" }),
      people(sc), sc.all(`${V}/user-records`, "data", {}),
    ]);
    const live = sups.filter((s: any) => !supportToShift(s).cancelled);
    const vacant = live.filter((s: any) => !(s.shifts || []).some((sh: any) => sh.user));
    const rostered = new Map<string, string[]>();
    for (const s of live) for (const sh of s.shifts || []) if (sh.user) rostered.set(String(sh.user.id), [...(rostered.get(String(sh.user.id)) || []), `${adlDate(s.start_time)} ${adlTime(s.start_time)}-${adlTime(s.end_time)}`]);
    const tags = new Map<string, string[]>();
    for (const r of records) {
      if (r.expiry_date && day(r.expiry_date) < today) continue;
      const id = String(r.user?.id), t = tags.get(id) || [], name = r.name || r.record_type?.name || "";
      for (const [re, tag] of QTAGS) if (re.test(name) && !t.includes(tag)) t.push(tag);
      tags.set(id, t);
    }
    const workers = staff.filter((s: any) => s.status === "active");
    return {
      vacant: toCsv(vacant.map((s: any) => ({ shift_id: s.id, client: pname(s.participant) || "No participant", date: adlDate(s.start_time), start: adlTime(s.start_time), end: adlTime(s.end_time), location: s.site?.name || s.address_state || "", needs: "screening", preferred_staff: "" })), ["shift_id", "client", "date", "start", "end", "location", "needs", "preferred_staff"]),
      staff: toCsv(workers.map((s: any) => ({ staff: uname(s), phone: "", available: "", do_not_send: "", quals: (tags.get(String(s.id)) || []).join(";"), already_rostered: (rostered.get(String(s.id)) || []).join(";") })), ["staff", "phone", "available", "do_not_send", "quals", "already_rostered"]),
    };
  }
  if (key === "sunny" || key === "lenny") {
    const from = key === "sunny" ? addDays(today, -1) : addDays(today, -7);
    const to = key === "sunny" ? today : addDays(today, -1);
    const [sups, { clients }] = await Promise.all([
      sc.all(`${V}/supports`, "data", { "filter[start_after]": from, "filter[start_before]": to, sort: "start_time" }), people(sc),
    ]);
    const rows: any[] = [];
    for (const s of sups.filter((x: any) => !supportToShift(x).cancelled)) for (const sh of s.shifts || []) if (sh.user && !/cancel/i.test(sh.status || "")) rows.push({ s, sh });
    if (key === "lenny") {
      return {
        roster: toCsv(rows.map(({ s, sh }) => ({ shift_id: s.id, staff: uname(sh.user), date: adlDate(s.start_time), start: adlTime(s.start_time), end: adlTime(s.end_time) })), ["shift_id", "staff", "date", "start", "end"]),
        timesheets: toCsv(rows.filter((r) => r.sh.clock_in_at).map(({ s, sh }) => ({ shift_id: s.id, staff: uname(sh.user), date: adlDate(s.start_time), clock_in: adlTime(sh.clock_in_at), clock_out: sh.clock_out_at ? adlTime(sh.clock_out_at) : "", kms: (s.travels || []).reduce((a: number, t: any) => a + (Number(t.actual_distance ?? t.distance) || 0), 0), allowances: "" })), ["shift_id", "staff", "date", "clock_in", "clock_out", "kms", "allowances"]),
      };
    }
    const notes = await notesFor(sc, activeClients(clients), { source: "support", from, maxPages: 1 });
    const noted = new Set(notes.map((n: any) => String(n.source?.id)));
    return {
      shifts: toCsv(rows.map(({ s, sh }) => ({
        shift_id: s.id, client: pname(s.participant), staff: uname(sh.user), phone: "",
        date: adlDate(s.start_time), start: adlTime(s.start_time), end: adlTime(s.end_time),
        clocked_in: sh.clock_in_at ? adlTime(sh.clock_in_at) : "", note_submitted: noted.has(String(s.id)) ? "yes" : "no",
      })), ["shift_id", "client", "staff", "phone", "date", "start", "end", "clocked_in", "note_submitted"]),
      now,
    };
  }
  if (key === "wizard") {
    const { clients } = await people(sc);
    const notes = await notesFor(sc, activeClients(clients), { from: addDays(today, -28), to: today, maxPages: 3 });
    return { notes: toCsv(notes.map((n: any) => ({ date: adlDate(n.created_at), participant: pname(n._participant), note: n.content })), ["date", "participant", "note"]) };
  }
  if (key === "archie") {
    const [{ clients }, records, sigs] = await Promise.all([people(sc), sc.all(`${V}/participant-records`, "data", {}), sc.all(`${V}/signature-requests`, "data", {})]);
    const rows: any[] = [];
    await pool(activeClients(clients), 6, async (c: any) => {
      const [goals, risks]: any[] = await Promise.all([
        sc.all(`${V}/participants/${c.id}/goals`, "data", {}, 2).catch((e) => { if (e instanceof BudgetError) throw e; return []; }),
        sc.all(`${V}/participants/${c.id}/risks`, "data", {}, 2).catch((e) => { if (e instanceof BudgetError) throw e; return []; }),
      ]);
      const mine = records.filter((r: any) => String(r.participant?.id) === String(c.id));
      const nameOf = (r: any) => r.name || r.record_type?.name || "";
      const find = (re: RegExp) => mine.find((r: any) => re.test(nameOf(r)));
      const valid = (r: any) => r && (!r.expiry_date || day(r.expiry_date) >= today);
      const sa = find(/service agreement/i), consent = find(/consent/i), bsp = find(/behaviour/i), plan = find(/ndis plan/i);
      const unsigned = sigs.some((s: any) => String(s.owner?.id) === String(c.id) && /agreement/i.test(s.title || "") && !/completed|signed/i.test(s.status || ""));
      const reviewed = risks.map((r: any) => day(r.last_reviewed_at)).filter(Boolean).sort().pop() || "";
      rows.push({
        participant: pname(c), service_agreement_signed: valid(sa) && !unsigned ? "yes" : "no", risk_assessment_date: reviewed,
        support_plan_review_date: day(plan?.issue_date), consent_on_file: valid(consent) ? "yes" : "no",
        bsp_required: bsp || risks.some((r: any) => r.risk_to === "staff") ? "yes" : "no", bsp_on_file: bsp ? "yes" : "",
        emergency_plan: "", goals_recorded: goals.length ? "yes" : "no",
      });
    });
    return { files: toCsv(rows, ["participant", "service_agreement_signed", "risk_assessment_date", "support_plan_review_date", "consent_on_file", "bsp_required", "bsp_on_file", "emergency_plan", "goals_recorded"]) };
  }
  if (key === "indy") {
    const body: any = await sc.get(`${V}/incidents`, { "page[size]": 50 });
    const inc = (body?.data || []).find((i: any) => !/closed|resolved|complete/i.test(i.status || "")) || (body?.data || [])[0];
    if (!inc) return {};
    return { text: `${inc.reference}, ${adlDate(inc.time)} ${adlTime(inc.time)}. ${inc.details}`, participant: "", staff: "" };
  }
  throw new Error(`${key} has no Astalty feed yet. Paste or upload the CSV instead.`);
}

// ---------- Hey Wizard context ----------
export async function heyContext(sc: ShiftCare, intent: string, today: string) {
  if (intent === "expiries") return { kind: "expiries", rows: await expiryFeed(sc) };
  if (intent === "invoices") {
    const [inv, { clientById }] = await Promise.all([sc.all(`${V}/invoices`, "data", {}), people(sc)]);
    // Astalty's invoice resource carries no payment state, so only the due date can be judged.
    return { kind: "invoices", rows: inv.map((i: any) => ({ ref: i.number, status: day(i.due_date) < today ? "overdue" : "unpaid", client: pname(clientById.get(String(i.participant?.id))), total: money(i.total), balance: money(i.total), due: day(i.due_date) })) };
  }
  if (intent === "shifts") {
    const sups = await sc.all(`${V}/supports`, "data", { "filter[start_after]": today, "filter[start_before]": addDays(today, 1), sort: "start_time" });
    return { kind: "shifts", rows: sups.filter((s: any) => !supportToShift(s).cancelled).map((s: any) => ({ id: s.id, date: adlDate(s.start_time), start: adlTime(s.start_time), end: adlTime(s.end_time), clients: [pname(s.participant)].filter(Boolean), staff: (s.shifts || []).map((sh: any) => uname(sh.user)).filter(Boolean), vacant: !(s.shifts || []).some((sh: any) => sh.user) })) };
  }
  if (intent === "incidents") {
    const rows: any[] = await sc.all(`${V}/incidents`, "data", {});
    return { kind: "incidents", rows: rows.map((i: any) => ({ id: i.reference, title: i.type, status: i.status, priority: i.severity, client: "", created: i.created_at, ndis_report_status: i.reportable === "yes" ? (i.reportable_type ? "reportable" : "reportable, type missing") : "not reportable" })) };
  }
  if (intent === "notes") return { kind: "notes", rows: (await notesList(sc, { limit: 30 })) };
  return { kind: "none", rows: [] };
}
