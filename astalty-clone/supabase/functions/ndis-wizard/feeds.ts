// Live feeds: pull from the ShiftCare v3 API and shape the data for each agent.
import { BudgetError, ShiftCare, pool, staffName, clientName } from "./shiftcare.ts";
import type { Line, Shift } from "./clancy.ts";
import type { Doc } from "./cleo.ts";
import { addDays, adlDate, adlTime, round2, toCsv } from "./util.ts";

export async function people(sc: ShiftCare) {
  const [staff, clients] = await Promise.all([sc.all("/staff", "staff"), sc.all("/clients", "clients")]);
  return {
    staff, clients,
    staffById: new Map(staff.map((s: any) => [String(s.id), s])),
    clientById: new Map(clients.map((c: any) => [String(c.id), c])),
  };
}

// ---------- Penny ----------
export async function notesList(sc: ShiftCare, opts: { from?: string; to?: string; limit?: number } = {}) {
  const rows = await sc.all("/progress_notes", "progress_notes", {
    created_from: opts.from, created_to: opts.to, sort_by: "created_at", sort_type: "desc",
  }, 5);
  return rows.slice(0, opts.limit ?? 200).map(noteShape);
}
export function noteShape(n: any) {
  return {
    id: String(n.id), category: n.category, message: n.message, shift_id: n.shift_id ? String(n.shift_id) : null,
    shift_date: n.shift_date ? adlDate(n.shift_date) : null, client: clientName(n.client), staff: staffName(n.staff),
    client_id: n.client?.id ? String(n.client.id) : null, staff_id: n.staff?.id ? String(n.staff.id) : null, created_at: n.created_at,
  };
}
export async function noteById(sc: ShiftCare, id: string) {
  const n: any = await sc.get(`/progress_notes/${encodeURIComponent(id)}`);
  const note = noteShape(n?.progress_note ?? n);
  let shift: any = null;
  if (note.shift_id) {
    try { shift = await sc.get(`/shifts/${note.shift_id}`); } catch (e) { if (e instanceof BudgetError) throw e; shift = null; }
  }
  return { note, shift: shift ? { start: adlTime(shift.start_at), end: adlTime(shift.end_at), date: adlDate(shift.start_at) } : null };
}

// ---------- Clancy ----------
export async function invoiceFeed(sc: ShiftCare, refs: string[] | "all") {
  const invoices: any[] = await sc.all("/invoices", "invoices");
  const { clientById, staffById } = await people(sc);
  const wanted = refs === "all" ? invoices.filter((i) => !/void/i.test(i.status)) :
    invoices.filter((i) => refs.some((r) => r.toLowerCase() === String(i.reference_number).toLowerCase() || r === String(i.id)));
  const toLine = (inv: any, it: any): Line => ({
    invoice: inv.reference_number || `#${inv.id}`, invoice_id: String(inv.id), invoice_status: inv.status,
    line_id: String(it.id), shift_id: it.shift_id ? String(it.shift_id) : "",
    client: clientName(clientById.get(String(inv.client_id))) || `client ${inv.client_id}`,
    support_item: it.reference_no || it.pricebook_external_id || "", category: it.category || "Hours", date: "",
    hours: Number(it.quantity) || 0, unit_price: Number(it.rate) || 0, amount: Number(it.amount) || 0,
  });
  const allLines: Line[] = invoices.flatMap((inv) => (inv.invoice_items || []).map((it: any) => toLine(inv, it)));
  const lines = allLines.filter((l) => wanted.some((w) => String(w.id) === l.invoice_id));
  const shiftRows = await sc.shiftsByIds(lines.map((l) => l.shift_id));
  const dates = [...new Set(shiftRows.map((s) => adlDate(s.start_at)))].sort();
  const shifts = new Map<string, Shift>();
  for (const s of shiftRows) {
    shifts.set(String(s.id), {
      shift_id: String(s.id), date: adlDate(s.start_at), start: adlTime(s.start_at), end: adlTime(s.end_at),
      client: (s.clients || []).map((c: any) => clientName(c)).join(", "), staff: (s.staff || []).map((x: any) => x.name).join(", "),
      worked: [], has_timesheet: false, kms: Number(s.km) || 0, cancelled: !!s.cancelled_at,
    });
  }
  // day-by-day timesheet pulls (see ShiftCare.timesheets)
  const ts = dates.length ? await sc.timesheets(dates[0], dates[dates.length - 1]).then((all) => all) : [];
  for (const t of ts) {
    const sh = shifts.get(String(t.shift_id));
    if (!sh || !t.clockin_at || !t.clockout_at) continue;
    const brk = (t.items || []).reduce((a: number, i: any) => a + (Number(i.break_minutes) || 0), 0);
    const mins = (Date.parse(t.clockout_at) - Date.parse(t.clockin_at)) / 60000 - brk;
    sh.worked.push({ staff: staffName(staffById.get(String(t.staff_id))) || `staff ${t.staff_id}`, clock_in: adlTime(t.clockin_at), clock_out: adlTime(t.clockout_at), hours: round2(mins / 60) });
    sh.has_timesheet = true;
  }
  for (const l of lines) l.date = shifts.get(l.shift_id)?.date || "";
  return {
    lines, allLines, shifts,
    invoices: wanted.map((i) => ({ id: String(i.id), ref: i.reference_number, status: i.status, total: i.total_amount })),
    timesheets: ts.length, days: dates.length,
    invoiceOptions: invoices.map((i) => ({ id: String(i.id), ref: i.reference_number, status: i.status, client: clientName(clientById.get(String(i.client_id))), total: i.total_amount, items: (i.invoice_items || []).length })),
  };
}

// ---------- Cleo ----------
export async function expiryFeed(sc: ShiftCare) {
  const [{ staff, clients }, qualsBody] = await Promise.all([people(sc), sc.get("/qualifications")]);
  const quals = new Map(((qualsBody as any)?.qualifications || []).map((q: any) => [String(q.id), q]));
  const docs: Doc[] = [];
  await pool(staff.filter((s: any) => !s.archived_at), 6, async (s: any) => {
    const rows: any = await sc.get(`/staffs/${s.id}/qualifications`);
    for (const q of (Array.isArray(rows) ? rows : rows?.qualifications || [])) {
      if (!q.expires_at) continue;
      const def: any = quals.get(String(q.qualification_id));
      docs.push({
        person_type: "staff", person: staffName(s), email: s.email, phone: s.mobile_number || s.phone_number,
        document: def?.name || `Qualification ${q.qualification_id}`, expiry_date: adlDate(q.expires_at),
        roster_critical: def ? !!(def.require_for_all_carers || /screening|first aid|cpr|manual|medication|driver/i.test(def.name)) : undefined,
        source_id: `staff_qualification:${q.id}`,
      });
    }
  });
  await pool(clients.filter((c: any) => (c.client_status || "active") === "active"), 6, async (c: any) => {
    const body: any = await sc.get(`/clients/${c.id}/documents`, { per_page: 100 });
    for (const d of body?.documents || []) {
      if (d.no_expiration || !d.expires_at || d.archived) continue;
      docs.push({
        person_type: "participant", person: clientName(c), email: c.email, phone: c.mobile_number || c.phone_number,
        document: d.document_type || "Document", expiry_date: String(d.expires_at).slice(0, 10), source_id: `client_document:${d.id}`,
      });
    }
  });
  return docs;
}

// ---------- Registry live inputs ----------
const QTAGS: [RegExp, string][] = [[/screening/i, "screening"], [/first aid/i, "first_aid"], [/cpr/i, "cpr"], [/medication/i, "medication"], [/manual handling/i, "manual_handling"], [/driver/i, "driver"]];
export async function liveInputs(sc: ShiftCare, key: string, today: string, now: string): Promise<Record<string, string>> {
  if (key === "rory") {
    const to = addDays(today, 7);
    const shifts = await sc.all("/shifts", "shifts", { from_date: today, to_date: to, include_clients: true, include_staff: true });
    const live = shifts.filter((s: any) => !s.cancelled_at);
    const vacant = live.filter((s: any) => !(s.staff || []).length);
    const [{ staff }, qb] = await Promise.all([people(sc), sc.get("/qualifications")]);
    const qdefs = new Map(((qb as any)?.qualifications || []).map((q: any) => [String(q.id), q]));
    const rostered = new Map<string, string[]>();
    for (const s of live) for (const w of s.staff || []) rostered.set(String(w.id), [...(rostered.get(String(w.id)) || []), `${adlDate(s.start_at)} ${adlTime(s.start_at)}-${adlTime(s.end_at)}`]);
    const tags = new Map<string, string[]>();
    await pool(staff.filter((s: any) => !s.archived_at), 6, async (s: any) => {
      const q: any = await sc.get(`/staffs/${s.id}/qualifications`);
      const list = (Array.isArray(q) ? q : q?.qualifications || []).filter((x: any) => !x.expires_at || adlDate(x.expires_at) >= today);
      const t: string[] = [];
      for (const x of list) {
        const n = String((qdefs.get(String(x.qualification_id)) as any)?.name || "");
        for (const [re, tag] of QTAGS) if (re.test(n) && !t.includes(tag)) t.push(tag);
      }
      if (s.gender === "female") t.push("female");
      tags.set(String(s.id), t);
    });
    return {
      vacant: toCsv(vacant.map((s: any) => ({
        shift_id: s.id, client: (s.clients || []).map((c: any) => clientName(c)).join(" & ") || "No client",
        date: adlDate(s.start_at), start: adlTime(s.start_at), end: adlTime(s.end_at), location: s.suburb_address || (s.address || "").split(",").slice(-1)[0]?.trim() || "",
        needs: "screening", preferred_staff: "",
      })), ["shift_id", "client", "date", "start", "end", "location", "needs", "preferred_staff"]),
      staff: toCsv(staff.filter((s: any) => !s.archived_at).map((s: any) => ({
        staff: staffName(s), phone: s.mobile_number || "", available: "", do_not_send: "",
        quals: (tags.get(String(s.id)) || []).join(";"), already_rostered: (rostered.get(String(s.id)) || []).join(";"),
      })), ["staff", "phone", "available", "do_not_send", "quals", "already_rostered"]),
    };
  }
  if (key === "sunny" || key === "lenny") {
    const from = key === "sunny" ? addDays(today, -1) : addDays(today, -7);
    const to = key === "sunny" ? today : addDays(today, -1);
    const [shifts, ts, { staffById }] = await Promise.all([
      sc.all("/shifts", "shifts", { from_date: from, to_date: to, include_clients: true, include_staff: true }),
      sc.timesheets(from, to), people(sc),
    ]);
    const tsBy = new Map<string, any>();
    for (const t of ts) tsBy.set(`${t.shift_id}|${t.staff_id}`, t);
    const rows: any[] = [];
    for (const s of shifts.filter((x: any) => !x.cancelled_at)) for (const w of s.staff || []) rows.push({ s, w, t: tsBy.get(`${s.id}|${w.id}`) });
    if (key === "lenny") {
      return {
        roster: toCsv(rows.map(({ s, w }) => ({ shift_id: s.id, staff: w.name, date: adlDate(s.start_at), start: adlTime(s.start_at), end: adlTime(s.end_at) })), ["shift_id", "staff", "date", "start", "end"]),
        timesheets: toCsv(rows.filter((r) => r.t?.clockin_at).map(({ s, w, t }) => ({ shift_id: s.id, staff: w.name, date: adlDate(s.start_at), clock_in: adlTime(t.clockin_at), clock_out: t.clockout_at ? adlTime(t.clockout_at) : "", kms: s.km || 0, allowances: "" })), ["shift_id", "staff", "date", "clock_in", "clock_out", "kms", "allowances"]),
      };
    }
    const notes = await sc.all("/progress_notes", "progress_notes", { shift_date_from: from, shift_date_to: to }, 5);
    const noted = new Set(notes.map((n: any) => `${n.shift_id}|${n.staff?.id}`));
    return {
      shifts: toCsv(rows.map(({ s, w, t }) => ({
        shift_id: s.id, client: (s.clients || []).map((c: any) => clientName(c)).join(" & "), staff: w.name,
        phone: staffById.get(String(w.id))?.mobile_number || "", date: adlDate(s.start_at), start: adlTime(s.start_at), end: adlTime(s.end_at),
        clocked_in: t?.clockin_at ? adlTime(t.clockin_at) : "", note_submitted: noted.has(`${s.id}|${w.id}`) ? "yes" : "no",
      })), ["shift_id", "client", "staff", "phone", "date", "start", "end", "clocked_in", "note_submitted"]),
      now,
    };
  }
  if (key === "wizard") {
    const notes = await sc.all("/progress_notes", "progress_notes", { created_from: addDays(today, -28), created_to: today }, 10);
    return { notes: toCsv(notes.map((n: any) => ({ date: n.shift_date ? adlDate(n.shift_date) : adlDate(n.created_at), participant: clientName(n.client), note: n.message })), ["date", "participant", "note"]) };
  }
  if (key === "archie") {
    const { clients } = await people(sc);
    const rows: any[] = [];
    await pool(clients.filter((c: any) => (c.client_status || "active") === "active"), 6, async (c: any) => {
      const [docs, goals]: any[] = await Promise.all([
        sc.get(`/clients/${c.id}/documents`, { per_page: 100 }),
        sc.get(`/clients/${c.id}/goals`).catch((e) => { if (e instanceof BudgetError) throw e; return null; }),
      ]);
      const ds: any[] = docs?.documents || [];
      const find = (re: RegExp) => ds.find((d) => re.test(d.document_type || "") && !d.archived);
      const valid = (d: any) => d && (d.no_expiration || !d.expires_at || String(d.expires_at).slice(0, 10) >= today);
      const dated = (d: any) => (d ? String(d.created_at || "").slice(0, 10) : "");
      const sa = find(/service agreement/i), risk = find(/risk/i), plan = find(/support plan|care plan/i), bsp = find(/behaviour/i), em = find(/emergency/i), cons = find(/consent/i);
      const goalList = goals?.goals ?? goals?.client_goals ?? (Array.isArray(goals) ? goals : null);
      rows.push({
        participant: clientName(c), service_agreement_signed: valid(sa) ? "yes" : "no", risk_assessment_date: dated(risk),
        support_plan_review_date: dated(plan), consent_on_file: cons ? "yes" : "no", bsp_required: bsp ? "yes" : "no", bsp_on_file: bsp ? "yes" : "",
        emergency_plan: em ? "yes" : "no", goals_recorded: goalList && goalList.length ? "yes" : "no",
      });
    });
    return { files: toCsv(rows, ["participant", "service_agreement_signed", "risk_assessment_date", "support_plan_review_date", "consent_on_file", "bsp_required", "bsp_on_file", "emergency_plan", "goals_recorded"]) };
  }
  if (key === "indy") {
    const body: any = await sc.get("/incidents", { per_page: 20 });
    const inc = (body?.incidents || [])[0];
    if (!inc) return {};
    return { text: inc.description || inc.summary || inc.title || "", participant: clientName(inc.client || inc.clients?.[0]) || "", staff: staffName(inc.reported_by || inc.staff || inc.reporter) || "" };
  }
  throw new Error(`${key} has no ShiftCare feed yet. Paste or upload the CSV instead.`);
}

// ---------- Hey Wizard context ----------
export async function heyContext(sc: ShiftCare, intent: string, today: string) {
  if (intent === "expiries") return { kind: "expiries", rows: await expiryFeed(sc) };
  if (intent === "invoices") {
    const inv: any[] = await sc.all("/invoices", "invoices");
    const { clientById } = await people(sc);
    return { kind: "invoices", rows: inv.map((i) => ({ ref: i.reference_number, status: i.status, client: clientName(clientById.get(String(i.client_id))), total: i.total_amount, balance: i.balance, due: i.due_at })) };
  }
  if (intent === "shifts") {
    const shifts = await sc.all("/shifts", "shifts", { from_date: today, to_date: addDays(today, 1), include_clients: true, include_staff: true });
    return { kind: "shifts", rows: shifts.filter((s: any) => !s.cancelled_at).map((s: any) => ({ id: s.id, date: adlDate(s.start_at), start: adlTime(s.start_at), end: adlTime(s.end_at), clients: (s.clients || []).map((c: any) => clientName(c)), staff: (s.staff || []).map((x: any) => x.name), vacant: !(s.staff || []).length })) };
  }
  if (intent === "incidents") {
    const body: any = await sc.all("/incidents", "incidents");
    return { kind: "incidents", rows: body.map((i: any) => ({ id: i.id, title: i.title || i.category, status: i.status, priority: i.priority, client: clientName(i.client || i.clients?.[0]), created: i.created_at, ndis_report_status: i.ndis_report_status })) };
  }
  if (intent === "notes") return { kind: "notes", rows: (await notesList(sc, { limit: 30 })) };
  return { kind: "none", rows: [] };
}
