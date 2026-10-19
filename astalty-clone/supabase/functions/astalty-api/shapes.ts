// Astalty clone · resource shapes (match the public OpenAPI resources as closely as the replica's data allows)
import { cents, dateOnly, db, initials, iso, must, name, todayIn } from "./lib.ts";

// Reference objects carry a superset of the fields the various *Resource references declare; the
// spec-driven serializer keeps only the ones each endpoint publishes.
export const userRef = (u: any) => u ? { id: u.id, name: name(u), first_name: u.first_name, last_name: u.last_name, email: u.email ?? null } : null;
export const participantRef = (p: any) => p ? { id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" "), full_name: [p.first_name, p.last_name].filter(Boolean).join(" "), first_name: p.first_name, last_name: p.last_name } : null;

export function participant(p: any, extra: Record<string, unknown> = {}) {
  return {
    id: p.id, initials: initials(p), full_name: [p.first_name, p.last_name].filter(Boolean).join(" "),
    first_name: p.first_name, middle_name: p.middle_name, last_name: p.last_name, preferred_name: p.preferred_name,
    dob: dateOnly(p.dob), phone: p.phone, mobile: p.mobile, email: p.email, status: p.status,
    primary_diagnosis: p.primary_diagnosis, secondary_diagnosis: p.secondary_diagnosis, pronouns: p.pronouns, gender: p.gender, sex: p.sex,
    language: p.language, ethnicity: p.ethnicity, ndis_number: p.ndis_number, external_id: p.external_id, medicare: p.medicare, centrelink: p.centrelink,
    invoice_email: p.invoice_email, commencement_date: dateOnly(p.commencement_date), exit_date: dateOnly(p.exit_date), exit_reason: p.exit_reason, exit_details: p.exit_details,
    is_ndis_number_exempt: !!p.is_ndis_number_exempt, preferred_contact_method: p.preferred_contact_method, created_at: iso(p.created_at), checkin_period: p.checkin_period,
    ...extra,
  };
}
export const tag = (t: any) => ({ id: t.id, name: t.name, colour: t.colour });
export const alert = (a: any) => ({ id: a.id, title: a.title, content: a.content, type: a.type, visible_to_support_workers: a.visible_to_support_workers, visible_when_scheduling: a.visible_when_scheduling, created_at: iso(a.created_at) });
export const address = (a: any) => ({
  id: a.id, type: a.type, label: a.label, address_1: a.address_1, address_2: a.address_2, address_3: a.address_3, suburb: a.suburb, state: a.state, postcode: a.postcode,
  country: a.country, lat: a.lat, lng: a.lng, traditional_place_name: a.traditional_place_name, details: a.details,
  formatted: [a.address_1, a.address_2, a.address_3, a.suburb, [a.state, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", "),
});
export const coordinator = (u: any) => u ? { id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email } : null;
export const planManager = (m: any) => m ? { id: m.id, name: m.name, invoice_email: m.invoice_email } : null;
export const ndisPlan = (p: any) => ({ id: p.id, start: dateOnly(p.start), end: dateOnly(p.end), is_pace: p.is_pace, total_funded_supports: cents(p.total_funded_supports) });
export const supportCategory = (c: any) => c ? { name: c.name, prefix: c.prefix, group: c.group } : null;
export const planBudget = (b: any) => ({ id: b.id, amount: cents(b.amount), management_type: b.management_type, stated: b.stated, description: b.description, support_category: supportCategory(b.ast_support_categories) });
export const implementation = (i: any) => ({
  id: i.id, status: i.status, amount: i.amount == null ? null : cents(i.amount), frequency: i.frequency, description: i.description, implemented_at: dateOnly(i.implemented_at), is_internal: i.is_internal,
  plan_budget: i.ast_plan_budgets ? { id: i.ast_plan_budgets.id, support_category: supportCategory(i.ast_plan_budgets.ast_support_categories) } : null,
  service_provider: i.provider_name ? { type: i.provider_type, id: i.provider_id, name: i.provider_name } : null,
});
export function serviceStatus(s: any, today = todayIn()) {
  const st = dateOnly(s.start)!, en = dateOnly(s.end)!;
  return today < st ? "upcoming" : today > en ? "expired" : "current";
}
export const chargeItem = (c: any) => ({ id: c.id, number: c.number, reference: c.reference, name: c.name, price: c.price, unit: c.unit, gst_code: c.gst_code, default_claim_type: c.default_claim_type, archived_at: iso(c.archived_at) });
export const chargeItemSet = (s: any) => ({ id: s.id, name: s.name, reference: s.reference, charge_rate_pattern: s.charge_rate_pattern, gst_code: s.gst_code, archived_at: iso(s.archived_at) });
export function service(s: any, extra: Record<string, unknown> = {}) {
  return {
    id: s.id, name: s.name, amount: cents(s.amount), management_type: s.management_type, type: s.type, status: serviceStatus(s), start: dateOnly(s.start), end: dateOnly(s.end),
    participant: s.ast_participants ? { id: s.ast_participants.id, full_name: name(s.ast_participants) } : undefined,
    plan: s.ast_ndis_plans ? { id: s.ast_ndis_plans.id, start: dateOnly(s.ast_ndis_plans.start), end: dateOnly(s.ast_ndis_plans.end) } : undefined,
    support_category: supportCategory(s.ast_support_categories),
    service_coordinator: coordinator(s.ast_users),
    ...extra,
  };
}
export const budget = (b: any) => ({ id: b.id, name: b.name, description: b.description, type: b.type, start: dateOnly(b.start), end: dateOnly(b.end), total: cents(b.total), has_funding_schedule: b.has_funding_schedule, archived_at: iso(b.archived_at), created_at: iso(b.created_at) });
export const budgetItem = (i: any) => ({
  id: i.id, name: i.name, description: i.description, number: i.number, price: i.price, unit_price: i.unit_price, ratio_numerator: i.ratio_numerator, ratio_denominator: i.ratio_denominator,
  quantity: Number(i.quantity), unit: i.unit, period: i.period, total: cents(i.total), start: dateOnly(i.start), end: dateOnly(i.end),
  charge_item: i.ast_charge_items ? { id: i.ast_charge_items.id, name: i.ast_charge_items.name, reference: i.ast_charge_items.reference } : null,
});
export const budgetPeriod = (p: any) => ({ id: p.id, start: dateOnly(p.start), end: dateOnly(p.end), amount: cents(p.amount) });
export const goal = (g: any) => ({ id: g.id, name: g.name, description: g.description, status: g.status, goal_type: g.goal_type, barriers: g.barriers, achievement_strategy: g.achievement_strategy, achieved_at: iso(g.achieved_at), archived_at: iso(g.archived_at), created_at: iso(g.created_at) });
export const note = (n: any) => ({
  id: n.id, content: n.content, checkin_type: n.checkin_type, created_at: iso(n.created_at), source_type: n.source_type,
  source: n.source_id ? { id: n.source_id, type: n.source_type } : null,
  author: n.ast_users ? { id: n.ast_users.id, name: name(n.ast_users) } : null,
});
export const breakOf = (b: any) => ({ id: b.id, type: b.type, duration: b.duration, is_paid: b.is_paid });
export const travel = (t: any) => ({
  id: t.id, travel_anchor: t.travel_anchor, details: t.details, distance: t.distance, duration: t.duration, approved_distance: t.approved_distance, approved_duration: t.approved_duration,
  odometer_start: t.odometer_start, odometer_end: t.odometer_end, actual_start_time: iso(t.actual_start_time), actual_end_time: iso(t.actual_end_time), actual_distance: t.actual_distance, actual_duration: t.actual_duration,
  was_not_travelled: t.was_not_travelled, is_unscheduled: t.is_unscheduled, group_travel_id: t.group_travel_id, shared_with_count: t.shared_with_count,
  user: userRef(t.ast_users), participants: t.participants ?? [],
});
export function shift(s: any, extra: Record<string, unknown> = {}) {
  const tz = s.timezone || "Australia/Adelaide";
  return {
    id: s.id, event_type: s.event_type, name: s.name, start_time: iso(s.start_time, tz), end_time: iso(s.end_time, tz), timezone: tz, status: s.status,
    clock_in_at: iso(s.clock_in_at, tz), clock_out_at: iso(s.clock_out_at, tz), user: userRef(s.ast_users),
    support: s.ast_supports ? supportBrief(s.ast_supports) : null, group_support: s.group_support_id ? { id: s.group_support_id } : null, internal_event: null,
    breaks: (s.ast_shift_breaks || []).map(breakOf), ...extra,
  };
}
export function supportBrief(s: any) {
  const tz = s.timezone || "Australia/Adelaide";
  return {
    id: s.id, start_time: iso(s.start_time, tz), end_time: iso(s.end_time, tz), timezone: tz, details: s.details, status: s.status, support_type: s.support_type, cancellation_type: s.cancellation_type,
    is_sleepover: s.is_sleepover, sleepover_starts_at: iso(s.sleepover_starts_at, tz), sleepover_ends_at: iso(s.sleepover_ends_at, tz), is_part_of_group_support: !!s.group_support_id, address_state: s.address_state,
    participant: participantRef(s.ast_participants), site: s.ast_sites ? { id: s.ast_sites.id, name: s.ast_sites.name } : null, group_support: s.group_support_id ? { id: s.group_support_id } : null,
    service: s.service_id ? { id: s.service_id } : null,
  };
}
export function support(s: any) {
  return {
    ...supportBrief(s),
    shifts: (s.ast_shifts || []).map((x: any) => shift({ ...x, ast_supports: null })),
    travels: (s.ast_travels || []).map((t: any) => travel({ ...t, participants: [participantRef(s.ast_participants)] })),
  };
}
export const task = (t: any, extra: Record<string, unknown> = {}) => ({
  id: t.id, title: t.title, start_time: iso(t.start_time), duration: t.duration, billable: t.billable, completed: t.completed,
  participant: participantRef(t.ast_participants), user: t.ast_users ? { id: t.ast_users.id, name: name(t.ast_users), email: t.ast_users.email } : null, ...extra,
});
const chargeStatus = (s: string) => s === "uninvoiced" ? "pending" : s;
export const taskCharge = (c: any) => ({
  id: c.id, date: dateOnly(c.date), quantity: c.quantity == null ? null : Number(c.quantity), unit_cost: c.unit_cost, total_cost: cents(c.total_cost), status: chargeStatus(c.status), is_primary: c.is_primary, source: c.source,
  charge_item: c.ast_charge_items ? chargeItem(c.ast_charge_items) : null, invoice: c.invoice_id ? { id: c.invoice_id } : null,
});
export const invoiceCharge = (c: any) => ({
  id: c.id, date: dateOnly(c.date), quantity: c.quantity == null ? null : Number(c.quantity), unit_cost: c.unit_cost, total_cost: cents(c.total_cost), claim_type: c.claim_type, claim_reference: c.claim_reference,
  cancellation_reason: c.cancellation_reason, charge_item: c.ast_charge_items ? { id: c.ast_charge_items.id, name: c.ast_charge_items.name, reference: c.ast_charge_items.reference } : null,
  support: c.support_id ? { id: c.support_id } : null, task: c.task_id ? { id: c.task_id } : null,
});
export const invoice = (i: any, extra: Record<string, unknown> = {}) => ({
  id: i.id, number: i.number, date: dateOnly(i.date), due_date: dateOnly(i.due_date), total: cents(i.total), management_type: i.management_type, status: i.status,
  participant: { id: i.participant_id }, plan_manager: i.plan_manager_id ? { id: i.plan_manager_id } : null, invoice_batch: i.batch_id ? { id: i.batch_id } : null,
  voided_at: iso(i.voided_at), voided_reason: i.voided_reason, sent_at: iso(i.sent_at), created_at: iso(i.created_at), ...extra,
});
export const invoiceBatch = (b: any) => ({ id: b.id, reference: b.reference, status: b.status, invoice_sending_behaviour: b.invoice_sending_behaviour, start: dateOnly(b.start), end: dateOnly(b.end), finalised_at: iso(b.finalised_at), created_at: iso(b.created_at) });
export const incident = (i: any) => ({
  id: i.id, reference: i.reference, type: i.type, severity: i.severity, status: i.status, reportable: i.reportable, reportable_type: i.reportable_type, time: iso(i.time), details: i.details,
  follow_up_details: i.follow_up_details, completed_at: iso(i.completed_at), created_at: iso(i.created_at), form_submission: null,
  participant: participantRef(i.ast_participants), reported_by: userRef(i.ast_users),
});
export const feedback = (f: any) => ({
  id: f.id, reference: f.reference, feedback_type: f.feedback_type, sentiment: f.sentiment, status: f.status, subject_name: f.subject_name, complainant_name: f.complainant_name, complainant_email: f.complainant_email,
  complainant_phone: f.complainant_phone, details: f.details, follow_up_details: f.follow_up_details, archived_at: iso(f.archived_at), created_at: iso(f.created_at), updated_at: iso(f.updated_at), participant: participantRef(f.ast_participants),
  assignee: null, form_submission: null,
});
export const referral = (r: any) => ({ id: r.id, reference: r.reference, participant_name: r.participant_name, status: r.status, details: r.details, form_submission: null, archived_at: iso(r.archived_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at) });
export const user = (u: any, extra: Record<string, unknown> = {}) => ({ id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email, employment_title: u.employment_title, status: u.status, type: u.type, role: u.role, mobile: u.mobile, employment_basis: u.employment_basis, ...extra });
export function recordStatus(r: any, today = todayIn()) {
  const e = dateOnly(r.expiry_date);
  if (!e) return "current";
  if (e < today) return "expired";
  const soon = new Date(today); soon.setDate(soon.getDate() + 30);
  return e <= soon.toISOString().slice(0, 10) ? "expiring" : "current";
}
export const userRecord = (r: any) => ({ id: r.id, name: r.name ?? r.ast_user_record_types?.name, reference: r.reference, issue_date: dateOnly(r.issue_date), expiry_date: dateOnly(r.expiry_date), status: recordStatus(r), created_at: iso(r.created_at), user: userRef(r.ast_users), record_type: r.ast_user_record_types ? { id: r.ast_user_record_types.id, name: r.ast_user_record_types.name, expires: r.ast_user_record_types.expires } : null });
export const participantRecord = (r: any) => ({ id: r.id, name: r.name ?? r.ast_participant_record_types?.name, reference: r.reference, issue_date: dateOnly(r.issue_date), expiry_date: dateOnly(r.expiry_date), status: recordStatus(r), created_at: iso(r.created_at), participant: participantRef(r.ast_participants), record_type: r.ast_participant_record_types ? { id: r.ast_participant_record_types.id, name: r.ast_participant_record_types.name } : null });
export const recordType = (t: any) => ({ id: t.id, name: t.name, expires: t.expires, requires_documents: t.requires_documents, created_at: iso(t.created_at) });
export function riskLevel(score: number) { return score >= 16 ? "catastrophic" : score >= 10 ? "high" : score >= 5 ? "moderate" : "low"; }
export const risk = (r: any) => ({
  id: r.id, title: r.title, description: r.description, likelihood: r.likelihood, consequence: r.consequence, residual_likelihood: r.residual_likelihood,
  inherent_risk: { score: r.likelihood * r.consequence, level: riskLevel(r.likelihood * r.consequence) }, residual_risk: { score: r.residual_likelihood * r.consequence, level: riskLevel(r.residual_likelihood * r.consequence) },
  risk_to: r.risk_to, status: r.status, review_frequency: r.review_frequency, risk_management_type: r.risk_management_type, visible_to_support_workers: r.visible_to_support_workers,
  last_reviewed_at: dateOnly(r.last_reviewed_at), next_review_at: dateOnly(r.next_review_at), archived_at: iso(r.archived_at), created_at: iso(r.created_at),
  controls: (r.ast_participant_risk_controls || []).map(control),
});
export const control = (c: any) => ({ id: c.id, title: c.title, description: c.description, created_at: iso(c.created_at) });
export const document = (d: any) => ({ id: d.id, name: d.name, file_extension: d.file_extension, created_at: iso(d.created_at), categories: d.ast_document_categories ? [{ id: d.ast_document_categories.id, name: d.ast_document_categories.name }] : [] });
export const documentCategory = (c: any) => ({ id: c.id, name: c.name, archived_at: iso(c.archived_at), created_at: iso(c.created_at) });
export const contact = (c: any) => ({ id: c.id, full_name: name(c) || "", first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, mobile: c.mobile, dob: dateOnly(c.dob), gender: c.gender, occupation: c.occupation, description: c.description, preferred_contact_method: c.preferred_contact_method, organisation: c.organisation_id ? { id: c.organisation_id } : null, archived_at: iso(c.archived_at), created_at: iso(c.created_at) });
export const organisation = (o: any) => ({ id: o.id, name: o.name, type: o.type, abn: o.abn, email: o.email, phone: o.phone, website: o.website, description: o.description, ndis_registered: o.ndis_registered, registration_number: o.registration_number });
export const site = (s: any) => ({ id: s.id, name: s.name, type: s.type, description: s.description, capacity: s.capacity, default_support_type: s.default_support_type, archived_at: iso(s.archived_at), created_at: iso(s.created_at), address: s.address_1 ? { address_1: s.address_1, suburb: s.suburb, state: s.state, postcode: s.postcode, formatted: [s.address_1, s.suburb, [s.state, s.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") } : null, site_manager: userRef(s.ast_users), tags: [] });
export const signatureRequest = (s: any) => ({ id: s.id, title: s.title, platform: s.platform, status: s.status, is_test: s.is_test, expires_at: iso(s.expires_at), created_at: iso(s.created_at), owner: s.participant_id ? { type: "participant", id: s.participant_id, name: s.ast_participants ? name(s.ast_participants) : null } : null, requested_by: userRef(s.ast_users) });
export const form = (f: any) => ({ id: f.id, name: f.name, type: f.type, created_at: iso(f.created_at) });
export const formSubmission = (s: any) => ({ id: s.id, submitted_at: iso(s.submitted_at), submitted_url: null, archived_at: iso(s.archived_at), created_at: iso(s.created_at), form: s.ast_forms ? form(s.ast_forms) : null, fields: s.fields || [] });
export const publicHoliday = (h: any) => ({ id: h.id, name: h.name, date: dateOnly(h.date), state: h.state, timezone: h.timezone, start_time: iso(new Date(`${dateOnly(h.date)}T00:00:00+09:30`), h.timezone), end_time: iso(new Date(`${dateOnly(h.date)}T23:59:59+09:30`), h.timezone), custom: h.custom, public_holiday_groups: [], excluded_public_holiday_groups: [] });
export const webhook = (w: any) => ({ id: w.id, description: w.description, url: w.url, event_types: w.event_types, is_enabled: w.is_enabled, signing_secret: w.signing_secret, archived_at: iso(w.archived_at), created_at: iso(w.created_at) });
export const exportRow = (e: any) => ({ id: e.id, name: e.name, export_type: e.export_type, export_reason: e.export_reason, status: e.status, failed_reason: e.failed_reason, last_downloaded_at: iso(e.last_downloaded_at), created_at: iso(e.created_at) });
export const infoItem = (i: any) => ({ id: i.id, detail: i.detail, created_at: iso(i.created_at), updated_at: iso(i.updated_at), definition: i.ast_participant_information_item_defs ? infoDef(i.ast_participant_information_item_defs) : null });
export const infoDef = (d: any) => ({ id: d.id, name: d.name, required: d.required, documents_allowed: d.documents_allowed, visible_to_support_workers: d.visible_to_support_workers });

export async function latestCheckins(ids: string[]) {
  if (!ids.length) return new Map<string, any>();
  const rows = must(await db.from("ast_participant_checkins").select("participant_id,type,date").in("participant_id", ids).order("date", { ascending: false })) as any[];
  const m = new Map<string, any>();
  for (const r of rows) if (!m.has(r.participant_id)) m.set(r.participant_id, { type: r.type, date: iso(r.date) });
  return m;
}
export async function tagsFor(ids: string[]) {
  if (!ids.length) return new Map<string, any[]>();
  const rows = must(await db.from("ast_participant_tag_links").select("participant_id, ast_participant_tags(id,name,colour)").in("participant_id", ids)) as any[];
  const m = new Map<string, any[]>();
  for (const r of rows) { if (!m.has(r.participant_id)) m.set(r.participant_id, []); m.get(r.participant_id)!.push(tag(r.ast_participant_tags)); }
  return m;
}
