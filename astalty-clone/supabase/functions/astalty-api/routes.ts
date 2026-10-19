// Astalty clone · route handlers for /public/v1
import { ApiError, attribute, csv, Ctx, db, emit, filter, invalid, iso, listOf, must, need, notFound, one, oneOf, paging, parseWhen, pick, q, run, sortOf, TZ, todayIn } from "./lib.ts";
import * as S from "./shapes.ts";
import { matchSpec, serialize, specOps, validate } from "./serialize.ts";

type Handler = (c: Ctx) => Promise<unknown>;
export const ROUTES: { method: string; re: RegExp; keys: string[]; fn: Handler; pattern: string }[] = [];
function route(method: string, pattern: string, fn: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
  ROUTES.push({ method, re, keys, fn, pattern });
}
const V = "/public/v1";
const UUID = /^[0-9a-f-]{36}$/i;
const idOf = (c: Ctx, k: string, what: string) => { const v = c.params[k]; if (!UUID.test(v)) throw notFound(what, v); return v; };

// participant base select used by list/show
const P_SELECT = "*, ast_plan_managers(id,name,invoice_email), ast_users!ast_participants_primary_coordinator_id_fkey(id,first_name,last_name,email)";

async function participantExtras(rows: any[], full: boolean) {
  const ids = rows.map((r) => r.id);
  const [tags, checkins] = await Promise.all([S.tagsFor(ids), S.latestCheckins(ids)]);
  if (!full) return rows.map((p) => S.participant(p, { tags: tags.get(p.id) ?? [], latest_checkin: checkins.get(p.id) ?? null }));
  const today = todayIn();
  const out = [];
  for (const p of rows) {
    const [alerts, plan] = await Promise.all([
      db.from("ast_participant_alerts").select("*").eq("participant_id", p.id).order("created_at"),
      db.from("ast_ndis_plans").select("*").eq("participant_id", p.id).lte("start", today).gte("end", today).order("start", { ascending: false }).limit(1).maybeSingle(),
    ]);
    out.push(S.participant(p, {
      tags: tags.get(p.id) ?? [], latest_checkin: checkins.get(p.id) ?? null,
      primary_coordinator: S.coordinator(p.ast_users), plan_manager: S.planManager(p.ast_plan_managers),
      current_ndis_plan: plan.data ? S.ndisPlan(plan.data) : null, alerts: (must(alerts) as any[]).map(S.alert),
    }));
  }
  return out;
}
async function getParticipant(id: string) {
  const p = await one("ast_participants", id, P_SELECT, "Participant");
  return { data: (await participantExtras([p], true))[0] };
}
async function participantMustExist(id: string) { if (!UUID.test(id)) throw notFound("Participant"); const r = must(await db.from("ast_participants").select("id").eq("id", id).maybeSingle()); if (!r) throw notFound("Participant"); }

// ---------------------------------------------------------------- app
route("GET", `${V}/app/status`, async () => ({ data: { down_for_maintenance: false } }));

// ---------------------------------------------------------------- participants
route("GET", `${V}/participants`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_participants").select(P_SELECT, { count: "exact" });
  const status = csv(filter(c, "status")); if (status) qb = qb.in("status", status);
  const phone = filter(c, "phone"); if (phone) qb = qb.ilike("phone", `%${phone}%`);
  const mobile = filter(c, "mobile"); if (mobile) qb = qb.ilike("mobile", `%${mobile}%`);
  const cn = filter(c, "contact_number"); if (cn) qb = qb.or(`phone.ilike.%${cn}%,mobile.ilike.%${cn}%`);
  const search = filter(c, "search"); if (search) qb = qb.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,preferred_name.ilike.%${search}%,ndis_number.ilike.%${search}%`);
  const anyTags = csv(filter(c, "tags:any") || filter(c, "tags")), allTags = csv(filter(c, "tags:all"));
  if (anyTags || allTags) {
    const links = must(await db.from("ast_participant_tag_links").select("participant_id,tag_id").in("tag_id", anyTags ?? allTags!)) as any[];
    const counts = new Map<string, number>();
    for (const l of links) counts.set(l.participant_id, (counts.get(l.participant_id) ?? 0) + 1);
    const ids = [...counts.entries()].filter(([, n]) => anyTags ? n > 0 : n >= allTags!.length).map(([id]) => id);
    qb = qb.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }
  const [col, asc] = sortOf(c, { last_name: "last_name", first_name: "first_name", created_at: "created_at", dob: "dob" }, "last_name");
  const { rows, total } = await run(qb.order(col, { ascending: asc }).order("id"), p);
  return listOf(await participantExtras(rows, false), total, p, ["last_name", "first_name", "created_at", "dob"]);
});
route("POST", `${V}/participants`, async (c) => {
  need(c.body, ["first_name", "last_name"]);
  oneOf(c.body, "sex", ["another_term", "female", "male"]); oneOf(c.body, "gender", ["female", "male", "non_binary", "other", "prefer_not_to_say"]);
  const row = pick(c.body, ["first_name", "middle_name", "last_name", "preferred_name", "dob", "sex", "gender", "email", "mobile", "phone", "language", "ethnicity", "medicare", "pronouns", "external_id", "ndis_number", "commencement_date", "primary_diagnosis", "secondary_diagnosis", "is_ndis_number_exempt", "invoice_email", "preferred_contact_method"]);
  if (row.ndis_number != null) row.ndis_number = String(row.ndis_number);
  if (c.body.primary_coordinator?.id) row.primary_coordinator_id = c.body.primary_coordinator.id;
  if (c.body.plan_manager?.id) row.plan_manager_id = c.body.plan_manager.id;
  const ins = must(await db.from("ast_participants").insert(row).select("id").single()) as any;
  await attribute(c, [ins.id]);
  const out = await getParticipant(ins.id);
  await emit("participant.created", out.data);
  return out;
});
route("GET", `${V}/participants/:participant`, async (c) => getParticipant(idOf(c, "participant", "Participant")));
route("PUT", `${V}/participants/:participant`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id);
  oneOf(c.body, "sex", ["another_term", "female", "male"]); oneOf(c.body, "gender", ["female", "male", "non_binary", "other", "prefer_not_to_say"]);
  const row = pick(c.body, ["first_name", "middle_name", "last_name", "preferred_name", "dob", "sex", "gender", "email", "mobile", "phone", "language", "ethnicity", "medicare", "pronouns", "external_id", "ndis_number", "commencement_date", "primary_diagnosis", "secondary_diagnosis", "is_ndis_number_exempt", "invoice_email", "preferred_contact_method", "exit_date", "exit_reason", "exit_details", "checkin_period"]);
  if (row.ndis_number != null) row.ndis_number = String(row.ndis_number);
  if (c.body.primary_coordinator !== undefined) row.primary_coordinator_id = c.body.primary_coordinator?.id ?? null;
  if (c.body.plan_manager !== undefined) row.plan_manager_id = c.body.plan_manager?.id ?? null;
  if (Object.keys(row).length) must(await db.from("ast_participants").update(row).eq("id", id));
  await attribute(c, [id]);
  const out = await getParticipant(id);
  await emit("participant.updated", out.data);
  return out;
});
route("POST", `${V}/participants/:participant/archive`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id);
  must(await db.from("ast_participants").update({ status: "archived", archived_at: new Date().toISOString(), exit_date: c.body?.exit_date ?? todayIn(), exit_reason: c.body?.exit_reason ?? null, exit_details: c.body?.exit_details ?? null }).eq("id", id));
  await attribute(c, [id]); return getParticipant(id);
});
route("POST", `${V}/participants/:participant/unarchive`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id);
  must(await db.from("ast_participants").update({ status: "active", archived_at: null, exit_date: null, exit_reason: null, exit_details: null }).eq("id", id));
  await attribute(c, [id]); return getParticipant(id);
});
route("GET", `${V}/participants/:participant/addresses`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  const { rows, total } = await run(db.from("ast_participant_addresses").select("*", { count: "exact" }).eq("participant_id", id).order("id"), p);
  return listOf(rows.map(S.address), total, p);
});
route("GET", `${V}/participants/:participant/contacts`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  const { rows, total } = await run(db.from("ast_participant_contacts").select("*, ast_contacts(*)", { count: "exact" }).eq("participant_id", id).order("contact_id"), p);
  return listOf(rows.map((r: any) => ({ contact: S.contact(r.ast_contacts), relationship: r.relationship, starred: r.starred, consent: r.consent, details: r.details, visible_to_support_workers: r.visible_to_support_workers })), total, p);
});
async function documentsFor(c: Ctx, type: string, id: string) {
  const p = paging(c);
  const { rows, total } = await run(db.from("ast_documents").select("*, ast_document_categories(id,name)", { count: "exact" }).eq("documentable_type", type).eq("documentable_id", id).order("created_at", { ascending: false }), p);
  return listOf(rows.map(S.document), total, p);
}
async function addDocument(c: Ctx, type: string, id: string) {
  need(c.body, ["name"]);
  const nm = String(c.body.name);
  const ext = (c.body.file_extension || nm.split(".").pop() || "pdf").toLowerCase();
  const row = { documentable_type: type, documentable_id: id, name: nm, file_extension: ext, category_id: c.body.document_category?.id ?? c.body.document_category_id ?? null, size_bytes: c.body.size ?? null };
  const d = must(await db.from("ast_documents").insert(row).select("*, ast_document_categories(id,name)").single());
  await attribute(c, [(d as any).id]);
  return { data: S.document(d) };
}
route("GET", `${V}/participants/:participant/documents`, async (c) => { const id = idOf(c, "participant", "Participant"); await participantMustExist(id); return documentsFor(c, "participant", id); });
route("POST", `${V}/participants/:participant/documents`, async (c) => { const id = idOf(c, "participant", "Participant"); await participantMustExist(id); return addDocument(c, "participant", id); });
route("GET", `${V}/participants/:participant/goals`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  const { rows, total } = await run(db.from("ast_goals").select("*", { count: "exact" }).eq("participant_id", id).order("created_at"), p);
  return listOf(rows.map(S.goal), total, p);
});
route("POST", `${V}/participants/:participant/goals`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id);
  need(c.body, ["name"]); oneOf(c.body, "status", ["achieved", "in_progress", "unattainable"]); oneOf(c.body, "goal_type", ["long_term", "medium_term", "short_term"]);
  const row = { participant_id: id, ...pick(c.body, ["name", "description", "status", "goal_type", "barriers", "achievement_strategy"]) };
  const g = must(await db.from("ast_goals").insert(row).select().single()) as any;
  if (Array.isArray(c.body.plans) && c.body.plans.length) must(await db.from("ast_goal_plans").insert(c.body.plans.map((x: any) => ({ goal_id: g.id, plan_id: x.id }))));
  await attribute(c, [g.id]);
  return { data: S.goal(g) };
});
route("GET", `${V}/participants/:participant/information-items`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  const { rows, total } = await run(db.from("ast_participant_information_items").select("*, ast_participant_information_item_defs(*)", { count: "exact" }).eq("participant_id", id).order("created_at"), p);
  return listOf(rows.map(S.infoItem), total, p);
});
route("PUT", `${V}/participants/:participant/information-items`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id);
  const defId = c.body?.participant_information_item?.id ?? c.body?.definition?.id ?? c.body?.id;
  if (!defId) throw invalid({ participant_information_item: ["The participant information item field is required."] });
  const row = must(await db.from("ast_participant_information_items").upsert({ participant_id: id, def_id: defId, detail: c.body.detail ?? null, updated_at: new Date().toISOString() }, { onConflict: "participant_id,def_id" }).select("*, ast_participant_information_item_defs(*)").single());
  await attribute(c, [(row as any).id]);
  return { data: S.infoItem(row) };
});
route("GET", `${V}/participants/:participant/ndis-plans`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  const { rows, total } = await run(db.from("ast_ndis_plans").select("*", { count: "exact" }).eq("participant_id", id).order("start", { ascending: false }), p);
  return listOf(rows.map(S.ndisPlan), total, p);
});
route("GET", `${V}/participants/:participant/notes`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  let qb = db.from("ast_notes").select("*, ast_users(id,first_name,last_name,email)", { count: "exact" }).eq("notable_type", "participant").eq("notable_id", id);
  const src = filter(c, "source"); if (src) { oneOf({ source: src }, "source", ["profile", "support", "task"]); qb = qb.eq("source_type", src); }
  const search = filter(c, "search"); if (search) qb = qb.ilike("content", `%${search}%`);
  const after = filter(c, "created_after"); if (after) qb = qb.gte("created_at", parseWhen(after, "filter.created_after"));
  const before = filter(c, "created_before"); if (before) qb = qb.lte("created_at", parseWhen(before, "filter.created_before"));
  const { rows, total } = await run(qb.order("created_at", { ascending: false }), p);
  return listOf(rows.map(S.note), total, p, ["created_at"]);
});
route("POST", `${V}/participants/:participant/notes`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id);
  need(c.body, ["content"]); oneOf(c.body, "checkin_type", ["email", "face to face", "phone", "sms", "teleconsult"]);
  const row = { notable_type: "participant", notable_id: id, content: c.body.content, checkin_type: c.body.checkin_type ?? null, author_id: c.body.author?.id ?? null, source_type: "profile" };
  const n = must(await db.from("ast_notes").insert(row).select("*, ast_users(id,first_name,last_name,email)").single());
  await attribute(c, [(n as any).id]);
  return { data: S.note(n) };
});
route("GET", `${V}/participants/:participant/current-services`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c); const today = todayIn();
  const { rows, total } = await run(db.from("ast_services").select(SVC_SELECT, { count: "exact" }).eq("participant_id", id).lte("start", today).gte("end", today).order("name"), p);
  return listOf(await serviceRows(rows), total, p);
});
route("GET", `${V}/participants/:participant/budgets`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  const { rows, total } = await run(db.from("ast_budgets").select("*", { count: "exact" }).eq("participant_id", id).order("start", { ascending: false }), p);
  return listOf(rows.map(S.budget), total, p);
});
route("GET", `${V}/participants/:participant/risks`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  const { rows, total } = await run(db.from("ast_participant_risks").select("*, ast_participant_risk_controls(*)", { count: "exact" }).eq("participant_id", id).order("created_at"), p);
  return listOf(rows.map(S.risk), total, p);
});
route("POST", `${V}/participants/:participant/risks`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id);
  need(c.body, ["title", "description", "likelihood", "consequence", "residual_likelihood", "risk_to", "status", "review_frequency"]);
  oneOf(c.body, "risk_to", ["business", "others", "participant", "staff"]); oneOf(c.body, "review_frequency", ["annually", "monthly", "quarterly", "six-monthly", "weekly"]);
  const months: Record<string, number> = { weekly: 0, monthly: 1, quarterly: 3, "six-monthly": 6, annually: 12 };
  const next = new Date(); if (c.body.review_frequency === "weekly") next.setDate(next.getDate() + 7); else next.setMonth(next.getMonth() + months[c.body.review_frequency]);
  const row = { participant_id: id, ...pick(c.body, ["title", "description", "likelihood", "consequence", "residual_likelihood", "risk_to", "status", "review_frequency", "risk_management_type", "visible_to_support_workers"]), last_reviewed_at: todayIn(), next_review_at: next.toISOString().slice(0, 10) };
  const r = must(await db.from("ast_participant_risks").insert(row).select().single()) as any;
  if (Array.isArray(c.body.controls) && c.body.controls.length) must(await db.from("ast_participant_risk_controls").insert(c.body.controls.map((x: any) => ({ risk_id: r.id, title: x.title, description: x.description ?? null }))));
  await attribute(c, [r.id]);
  return { data: S.risk(await one("ast_participant_risks", r.id, "*, ast_participant_risk_controls(*)", "Risk")) };
});
route("GET", `${V}/participants/:participant/public-holiday-groups`, async (c) => {
  const id = idOf(c, "participant", "Participant"); await participantMustExist(id); const p = paging(c);
  const { rows, total } = await run(db.from("ast_public_holiday_groups").select("*", { count: "exact" }).order("name"), p);
  return listOf(rows.map((g: any) => ({ id: g.id, name: g.name })), total, p);
});
route("GET", `${V}/risks/:risk`, async (c) => ({ data: S.risk(await one("ast_participant_risks", idOf(c, "risk", "Risk"), "*, ast_participant_risk_controls(*)", "Risk")) }));
route("PUT", `${V}/risks/:risk`, async (c) => {
  const id = idOf(c, "risk", "Risk"); await one("ast_participant_risks", id, "id", "Risk");
  const row = pick(c.body, ["title", "description", "likelihood", "consequence", "residual_likelihood", "risk_to", "status", "review_frequency", "risk_management_type", "visible_to_support_workers", "last_reviewed_at", "next_review_at"]);
  if (Object.keys(row).length) must(await db.from("ast_participant_risks").update(row).eq("id", id));
  await attribute(c, [id]);
  return { data: S.risk(await one("ast_participant_risks", id, "*, ast_participant_risk_controls(*)", "Risk")) };
});
route("POST", `${V}/risks/:risk/controls`, async (c) => {
  const id = idOf(c, "risk", "Risk"); await one("ast_participant_risks", id, "id", "Risk"); need(c.body, ["title"]);
  const r = must(await db.from("ast_participant_risk_controls").insert({ risk_id: id, title: c.body.title, description: c.body.description ?? null }).select().single());
  await attribute(c, [(r as any).id]); return { data: S.control(r) };
});
route("PUT", `${V}/controls/:control`, async (c) => {
  const id = idOf(c, "control", "Control"); await one("ast_participant_risk_controls", id, "id", "Control");
  must(await db.from("ast_participant_risk_controls").update(pick(c.body, ["title", "description"])).eq("id", id)); await attribute(c, [id]);
  return { data: S.control(await one("ast_participant_risk_controls", id)) };
});
route("DELETE", `${V}/controls/:control`, async (c) => {
  const id = idOf(c, "control", "Control"); await one("ast_participant_risk_controls", id, "id", "Control");
  must(await db.from("ast_participant_risk_controls").delete().eq("id", id)); await attribute(c, [id]); return null;
});

// ---------------------------------------------------------------- goals
route("GET", `${V}/goals/:goal`, async (c) => ({ data: S.goal(await one("ast_goals", idOf(c, "goal", "Goal"), "*", "Goal")) }));
route("GET", `${V}/goals/:goal/supports`, async (c) => {
  const g = await one("ast_goals", idOf(c, "goal", "Goal"), "*", "Goal") as any; const p = paging(c);
  const { rows, total } = await run(db.from("ast_supports").select(SUP_SELECT, { count: "exact" }).eq("participant_id", g.participant_id).order("start_time", { ascending: false }), p);
  return listOf(rows.map(S.support), total, p);
});
route("GET", `${V}/goals/:goal/tasks`, async (c) => {
  const id = idOf(c, "goal", "Goal"); await one("ast_goals", id, "id", "Goal"); const p = paging(c);
  const links = must(await db.from("ast_task_goals").select("task_id").eq("goal_id", id)) as any[];
  const ids = links.map((l) => l.task_id);
  if (!ids.length) return listOf([], 0, p);
  const { rows, total } = await run(db.from("ast_tasks").select(TASK_SELECT, { count: "exact" }).in("id", ids).order("start_time", { ascending: false }), p);
  return listOf(rows.map((t: any) => S.task(t)), total, p);
});

// ---------------------------------------------------------------- notes
route("PUT", `${V}/notes/:note`, async (c) => {
  const id = idOf(c, "note", "Note"); await one("ast_notes", id, "id", "Note"); need(c.body, ["content"]);
  must(await db.from("ast_notes").update({ content: c.body.content, checkin_type: c.body.checkin_type ?? null }).eq("id", id)); await attribute(c, [id]);
  return { data: S.note(await one("ast_notes", id, "*, ast_users(id,first_name,last_name,email)", "Note")) };
});
route("GET", `${V}/notes/:note/documents`, async (c) => { const id = idOf(c, "note", "Note"); await one("ast_notes", id, "id", "Note"); return documentsFor(c, "note", id); });
route("POST", `${V}/notes/:note/documents`, async (c) => { const id = idOf(c, "note", "Note"); await one("ast_notes", id, "id", "Note"); return addDocument(c, "note", id); });
route("GET", `${V}/note-templates`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_note_templates").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map((t: any) => ({ id: t.id, name: t.name, content: t.content, usage: t.usage, created_at: iso(t.created_at) })), total, p); });
route("POST", `${V}/note-templates`, async (c) => { need(c.body, ["name", "content"]); const t = must(await db.from("ast_note_templates").insert(pick(c.body, ["name", "content", "usage"])).select().single()) as any; await attribute(c, [t.id]); return { data: { id: t.id, name: t.name, content: t.content, usage: t.usage, created_at: iso(t.created_at) } }; });
route("GET", `${V}/note-templates/:noteTemplate`, async (c) => { const t = await one("ast_note_templates", idOf(c, "noteTemplate", "NoteTemplate"), "*", "NoteTemplate") as any; return { data: { id: t.id, name: t.name, content: t.content, usage: t.usage, created_at: iso(t.created_at) } }; });
route("PUT", `${V}/note-templates/:noteTemplate`, async (c) => { const id = idOf(c, "noteTemplate", "NoteTemplate"); await one("ast_note_templates", id, "id", "NoteTemplate"); must(await db.from("ast_note_templates").update(pick(c.body, ["name", "content", "usage"])).eq("id", id)); await attribute(c, [id]); const t = await one("ast_note_templates", id) as any; return { data: { id: t.id, name: t.name, content: t.content, usage: t.usage, created_at: iso(t.created_at) } }; });

// ---------------------------------------------------------------- plans, budgets, services
route("GET", `${V}/ndis-plans/:plan`, async (c) => ({ data: S.ndisPlan(await one("ast_ndis_plans", idOf(c, "plan", "NdisPlan"), "*", "NdisPlan")) }));
route("GET", `${V}/ndis-plans/:plan/budgets`, async (c) => {
  const id = idOf(c, "plan", "NdisPlan"); await one("ast_ndis_plans", id, "id", "NdisPlan"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_plan_budgets").select("*, ast_support_categories(*)", { count: "exact" }).eq("plan_id", id).order("support_category"), p);
  return listOf(rows.map(S.planBudget), total, p);
});
route("GET", `${V}/ndis-plans/:plan/implementations`, async (c) => {
  const id = idOf(c, "plan", "NdisPlan"); await one("ast_ndis_plans", id, "id", "NdisPlan"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_plan_implementations").select("*, ast_plan_budgets(id, ast_support_categories(*))", { count: "exact" }).eq("plan_id", id).order("description"), p);
  return listOf(rows.map(S.implementation), total, p);
});
const SVC_SELECT = "*, ast_participants(id,first_name,last_name), ast_ndis_plans(id,start,end), ast_support_categories(*), ast_users(id,first_name,last_name,email)";
/** Service rows with their charge items and charge item sets, as every service listing publishes them. */
async function serviceRows(rows: any[]) {
  const ids = rows.map((s) => s.id);
  if (!ids.length) return [];
  const [items, sets] = await Promise.all([
    db.from("ast_service_charge_items").select("service_id, ast_charge_items(*)").in("service_id", ids),
    db.from("ast_service_charge_item_sets").select("service_id, ast_charge_item_sets(*)").in("service_id", ids),
  ]);
  const ci = new Map<string, any[]>(), cs = new Map<string, any[]>();
  for (const r of must(items) as any[]) { if (!ci.has(r.service_id)) ci.set(r.service_id, []); ci.get(r.service_id)!.push(S.chargeItem(r.ast_charge_items)); }
  for (const r of must(sets) as any[]) { if (!cs.has(r.service_id)) cs.set(r.service_id, []); cs.get(r.service_id)!.push(S.chargeItemSet(r.ast_charge_item_sets)); }
  return rows.map((s) => S.service(s, { charge_items: ci.get(s.id) ?? [], charge_item_sets: cs.get(s.id) ?? [] }));
}
async function serviceFull(id: string) {
  const s = await one("ast_services", id, SVC_SELECT, "PlanService") as any;
  return { data: (await serviceRows([s]))[0] };
}
route("POST", `${V}/ndis-plans/:plan/services`, async (c) => {
  const planId = idOf(c, "plan", "NdisPlan"); const plan = await one("ast_ndis_plans", planId, "*", "NdisPlan") as any;
  need(c.body, ["name", "amount", "support_category", "management_type", "type"]);
  oneOf(c.body, "management_type", ["ndia", "plan", "self"], false); oneOf(c.body, "type", ["scheduled_service", "unscheduled_service"], false);
  const cat = String(c.body.support_category).match(/^\d{2}/)?.[0] ?? null;
  const row = { plan_id: planId, participant_id: plan.participant_id, name: c.body.name, amount: Math.round(Number(c.body.amount)), management_type: c.body.management_type, type: c.body.type, support_category: cat,
    service_coordinator_id: c.body.service_coordinator?.id ?? null, start: c.body.start ?? plan.start, end: c.body.end ?? plan.end, has_funding_schedule: !!c.body.has_funding_schedule, reconciled_amount: c.body.reconciled_amount ?? null, reconciled_date: c.body.reconciled_date ?? null };
  const s = must(await db.from("ast_services").insert(row).select("id").single()) as any;
  if (Array.isArray(c.body.charge_items) && c.body.charge_items.length) must(await db.from("ast_service_charge_items").insert(c.body.charge_items.map((x: any) => ({ service_id: s.id, charge_item_id: x.id }))));
  const sets = [...(c.body.charge_item_sets ?? []), ...(c.body.charge_item_set?.id ? [c.body.charge_item_set] : [])];
  if (sets.length) must(await db.from("ast_service_charge_item_sets").insert(sets.map((x: any) => ({ service_id: s.id, set_id: x.id }))));
  await attribute(c, [s.id]);
  return serviceFull(s.id);
});
route("GET", `${V}/services`, async (c) => {
  const p = paging(c); const today = todayIn();
  let qb = db.from("ast_services").select(SVC_SELECT, { count: "exact" });
  const search = filter(c, "search"); if (search) qb = qb.ilike("name", `%${search}%`);
  const parts = csv(filter(c, "participant")); if (parts) qb = qb.in("participant_id", parts);
  const coords = csv(filter(c, "service_coordinator")); if (coords) qb = qb.in("service_coordinator_id", coords);
  const mts = csv(filter(c, "management_type")); if (mts) qb = qb.in("management_type", mts);
  const st = csv(filter(c, "status"));
  if (st) {
    const ors: string[] = [];
    if (st.includes("current") || st.includes("active")) ors.push(`and(start.lte.${today},end.gte.${today})`);
    if (st.includes("upcoming")) ors.push(`start.gt.${today}`);
    if (st.includes("expired")) ors.push(`end.lt.${today}`);
    if (ors.length) qb = qb.or(ors.join(","));
  }
  const [col, asc] = sortOf(c, { name: "name", start: "start", end: "end", amount: "amount", created_at: "created_at" }, "name");
  const { rows, total } = await run(qb.order(col, { ascending: asc }).order("id"), p);
  return listOf(await serviceRows(rows), total, p, ["name", "start", "end", "amount", "created_at"]);
});
route("GET", `${V}/services/:service`, async (c) => serviceFull(idOf(c, "service", "PlanService")));
route("GET", `${V}/budgets/:budget`, async (c) => ({ data: S.budget(await one("ast_budgets", idOf(c, "budget", "Budget"), "*", "Budget")) }));
route("GET", `${V}/budgets/:budget/items`, async (c) => {
  const id = idOf(c, "budget", "Budget"); await one("ast_budgets", id, "id", "Budget"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_budget_items").select("*, ast_charge_items(id,name,reference)", { count: "exact" }).eq("budget_id", id).order("name"), p);
  return listOf(rows.map(S.budgetItem), total, p);
});
route("GET", `${V}/budgets/:budget/periods`, async (c) => {
  const id = idOf(c, "budget", "Budget"); await one("ast_budgets", id, "id", "Budget"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_budget_periods").select("*", { count: "exact" }).eq("budget_id", id).order("start"), p);
  return listOf(rows.map(S.budgetPeriod), total, p);
});
route("GET", `${V}/charge-items`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_charge_items").select("*", { count: "exact" });
  const search = filter(c, "search"); if (search) qb = qb.or(`name.ilike.%${search}%,reference.ilike.%${search}%,number.ilike.%${search}%`);
  const st = filter(c, "status") || "active";
  if (st === "active") qb = qb.is("archived_at", null); else if (st === "archived") qb = qb.not("archived_at", "is", null);
  const [col, asc] = sortOf(c, { number: "number", name: "name", price: "price", reference: "reference" }, "number");
  const { rows, total } = await run(qb.order(col, { ascending: asc }).order("id"), p);
  return listOf(rows.map(S.chargeItem), total, p, ["number", "name", "price", "reference"]);
});
route("GET", `${V}/charge-item-sets`, async (c) => {
  const p = paging(c);
  const { rows, total } = await run(db.from("ast_charge_item_sets").select("*", { count: "exact" }).order("name"), p);
  return listOf(rows.map(S.chargeItemSet), total, p);
});

// ---------------------------------------------------------------- supports, shifts, group supports
const SUP_SELECT = "*, ast_participants(id,first_name,last_name), ast_sites(id,name), ast_shifts(*, ast_users(id,first_name,last_name), ast_shift_breaks(*)), ast_travels(*, ast_users(id,first_name,last_name))";
function dateWindow(c: Ctx, qb: any, col: string) {
  const a = filter(c, "start_after"); if (a) qb = qb.gte(col, parseWhen(/^\d{4}-\d{2}-\d{2}$/.test(a) ? `${a}T00:00:00+09:30` : a, "filter.start_after"));
  const b = filter(c, "start_before"); if (b) qb = qb.lte(col, parseWhen(/^\d{4}-\d{2}-\d{2}$/.test(b) ? `${b}T23:59:59+10:30` : b, "filter.start_before"));
  return qb;
}
route("GET", `${V}/supports`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_supports").select(SUP_SELECT, { count: "exact" });
  qb = dateWindow(c, qb, "start_time");
  const parts = csv(filter(c, "participant")); if (parts) qb = qb.in("participant_id", parts);
  const st = csv(filter(c, "status")); if (st) qb = qb.in("status", st);
  const [col, asc] = sortOf(c, { start_time: "start_time", end_time: "end_time", created_at: "created_at" }, "start_time");
  const { rows, total } = await run(qb.order(col, { ascending: asc }).order("id"), p);
  return listOf(rows.map(S.support), total, p, ["start_time", "end_time", "created_at"]);
});
route("GET", `${V}/supports/:support`, async (c) => ({ data: S.support(await one("ast_supports", idOf(c, "support", "Support"), SUP_SELECT, "Support")) }));
const SHIFT_SELECT = "*, ast_users(id,first_name,last_name), ast_shift_breaks(*), ast_supports(*, ast_participants(id,first_name,last_name), ast_sites(id,name))";
route("GET", `${V}/shifts`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_shifts").select(SHIFT_SELECT, { count: "exact" });
  qb = dateWindow(c, qb, "start_time");
  const users = csv(filter(c, "user")); if (users) qb = qb.in("user_id", users);
  const st = csv(filter(c, "status")); if (st) qb = qb.in("status", st);
  const [col, asc] = sortOf(c, { start_time: "start_time", end_time: "end_time", created_at: "created_at" }, "start_time");
  const { rows, total } = await run(qb.order(col, { ascending: asc }).order("id"), p);
  return listOf(rows.map((s: any) => S.shift(s)), total, p, ["start_time", "end_time", "created_at"]);
});
route("GET", `${V}/shifts/:shift`, async (c) => ({ data: S.shift(await one("ast_shifts", idOf(c, "shift", "Shift"), SHIFT_SELECT, "Shift")) }));
route("GET", `${V}/group-supports`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_group_supports").select("*, ast_sites(id,name)", { count: "exact" });
  qb = dateWindow(c, qb, "start_time");
  const { rows, total } = await run(qb.order("start_time"), p);
  return listOf(rows.map((g: any) => ({ id: g.id, name: g.name, details: g.details, start_time: iso(g.start_time, g.timezone), end_time: iso(g.end_time, g.timezone), timezone: g.timezone, is_sleepover: g.is_sleepover, site: g.ast_sites ? { id: g.ast_sites.id, name: g.ast_sites.name } : null, participants: [], shifts: [], supports: [], travels: [] })), total, p, ["start_time"]);
});
route("GET", `${V}/group-supports/:groupSupport`, async (c) => { const g = await one("ast_group_supports", idOf(c, "groupSupport", "GroupSupport"), "*, ast_sites(id,name)", "GroupSupport") as any; return { data: { id: g.id, name: g.name, details: g.details, start_time: iso(g.start_time, g.timezone), end_time: iso(g.end_time, g.timezone), timezone: g.timezone, is_sleepover: g.is_sleepover, site: g.ast_sites ? { id: g.ast_sites.id, name: g.ast_sites.name } : null, participants: [], shifts: [], supports: [], travels: [] } }; });

// ---------------------------------------------------------------- tasks
const TASK_SELECT = "*, ast_participants(id,first_name,last_name), ast_users(id,first_name,last_name,email)";
async function taskFull(id: string) {
  const t = await one("ast_tasks", id, TASK_SELECT, "Task") as any;
  const [charges, goals, docs] = await Promise.all([
    db.from("ast_charges").select("*, ast_charge_items(*)").eq("task_id", id).order("is_primary", { ascending: false }),
    db.from("ast_task_goals").select("ast_goals(id,name,status)").eq("task_id", id),
    db.from("ast_documents").select("*, ast_document_categories(id,name)").eq("documentable_type", "task").eq("documentable_id", id),
  ]);
  return { data: S.task(t, { charges: (must(charges) as any[]).map(S.taskCharge), goals: (must(goals) as any[]).map((g) => ({ id: g.ast_goals.id, name: g.ast_goals.name, status: g.ast_goals.status })), documents: (must(docs) as any[]).map(S.document) }) };
}
route("GET", `${V}/tasks`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_tasks").select(TASK_SELECT, { count: "exact" });
  const parts = csv(filter(c, "participant")); if (parts) qb = qb.in("participant_id", parts);
  const users = csv(filter(c, "user")); if (users) qb = qb.in("user_id", users);
  const comp = filter(c, "completed"); if (comp !== null) qb = qb.eq("completed", comp === "true" || comp === "1");
  qb = dateWindow(c, qb, "start_time");
  const [col, asc] = sortOf(c, { start_time: "start_time", created_at: "created_at", title: "title" }, "-start_time");
  const { rows, total } = await run(qb.order(col, { ascending: asc }).order("id"), p);
  return listOf(rows.map((t: any) => S.task(t)), total, p, ["start_time", "created_at", "title"]);
});
route("POST", `${V}/tasks`, async (c) => {
  need(c.body, ["name", "start_time", "billable", "completed", "user"]);
  if (!c.body.user?.id) throw invalid({ "user.id": ["The user.id field is required."] });
  const row = { title: c.body.name, start_time: parseWhen(c.body.start_time, "start_time"), duration: Number(c.body.duration ?? 0), billable: !!c.body.billable, completed: !!c.body.completed, user_id: c.body.user.id, participant_id: c.body.participant?.id ?? null };
  const t = must(await db.from("ast_tasks").insert(row).select("id").single()) as any;
  const charges: any[] = [];
  const addCharge = async (itemId: string, qty: number, primary: boolean, claim: string | null) => {
    if (!row.participant_id) return;
    const ci = await one("ast_charge_items", itemId, "*", "ChargeItem") as any;
    const svc = must(await db.from("ast_services").select("id").eq("participant_id", row.participant_id).eq("support_category", ci.support_category).lte("start", row.start_time.slice(0, 10)).gte("end", row.start_time.slice(0, 10)).limit(1).maybeSingle()) as any;
    charges.push({ participant_id: row.participant_id, charge_item_id: ci.id, service_id: svc?.id ?? null, source: "task", task_id: t.id, date: row.start_time.slice(0, 10), quantity: qty, unit_cost: ci.price, total_cost: Math.round(qty * ci.price), claim_type: claim, is_primary: primary, status: "uninvoiced" });
  };
  if (row.billable && c.body.primary_charge_item?.id) await addCharge(c.body.primary_charge_item.id, Math.round((row.duration / 60) * 100) / 100, true, null);
  for (const a of c.body.additional_charges ?? []) if (a?.charge_item?.id) await addCharge(a.charge_item.id, Number(a.quantity), false, a.claim_type ?? null);
  if (charges.length) must(await db.from("ast_charges").insert(charges));
  if (c.body.note) must(await db.from("ast_notes").insert({ notable_type: "task", notable_id: t.id, author_id: row.user_id, content: c.body.note, source_type: "task", source_id: t.id }));
  if (c.body.note && row.participant_id) must(await db.from("ast_notes").insert({ notable_type: "participant", notable_id: row.participant_id, author_id: row.user_id, content: c.body.note, source_type: "task", source_id: t.id }));
  await attribute(c, [t.id]);
  const out = await taskFull(t.id);
  await emit("task.created", out.data);
  return out;
});
route("GET", `${V}/tasks/:task`, async (c) => taskFull(idOf(c, "task", "Task")));
route("PUT", `${V}/tasks/:task`, async (c) => {
  const id = idOf(c, "task", "Task"); await one("ast_tasks", id, "id", "Task");
  const row: Record<string, unknown> = pick(c.body, ["billable", "duration", "completed"]);
  if (c.body.name !== undefined) row.title = c.body.name;
  if (c.body.start_time !== undefined) row.start_time = parseWhen(c.body.start_time, "start_time");
  if (Object.keys(row).length) must(await db.from("ast_tasks").update(row).eq("id", id));
  await attribute(c, [id]); return taskFull(id);
});
route("DELETE", `${V}/tasks/:task`, async (c) => {
  const id = idOf(c, "task", "Task"); await one("ast_tasks", id, "id", "Task");
  const inv = must(await db.from("ast_charges").select("id").eq("task_id", id).not("invoice_id", "is", null).limit(1)) as any[];
  if (inv.length) throw new ApiError(409, "This task has invoiced charges and cannot be deleted.");
  must(await db.from("ast_charges").delete().eq("task_id", id));
  must(await db.from("ast_notes").delete().eq("notable_type", "task").eq("notable_id", id));
  must(await db.from("ast_tasks").delete().eq("id", id));
  await attribute(c, [id]); return null;
});
route("GET", `${V}/tasks/:task/charges`, async (c) => {
  const id = idOf(c, "task", "Task"); await one("ast_tasks", id, "id", "Task"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_charges").select("*, ast_charge_items(*)", { count: "exact" }).eq("task_id", id).order("is_primary", { ascending: false }), p);
  return listOf(rows.map(S.taskCharge), total, p);
});
route("GET", `${V}/tasks/:task/documents`, async (c) => { const id = idOf(c, "task", "Task"); await one("ast_tasks", id, "id", "Task"); return documentsFor(c, "task", id); });
route("POST", `${V}/tasks/:task/documents`, async (c) => { const id = idOf(c, "task", "Task"); await one("ast_tasks", id, "id", "Task"); return addDocument(c, "task", id); });
route("POST", `${V}/tasks/:task/notes`, async (c) => {
  const id = idOf(c, "task", "Task"); const t = await one("ast_tasks", id, "*", "Task") as any; need(c.body, ["content"]);
  const n = must(await db.from("ast_notes").insert({ notable_type: "task", notable_id: id, author_id: c.body.author?.id ?? t.user_id, content: c.body.content, checkin_type: c.body.checkin_type ?? null, source_type: "task", source_id: id }).select("*, ast_users(id,first_name,last_name,email)").single()) as any;
  if (t.participant_id) must(await db.from("ast_notes").insert({ notable_type: "participant", notable_id: t.participant_id, author_id: n.author_id, content: c.body.content, checkin_type: c.body.checkin_type ?? null, source_type: "task", source_id: id }));
  await attribute(c, [n.id]);
  return { data: { id: n.id, content: n.content, checkin_type: n.checkin_type, created_at: iso(n.created_at), author: n.ast_users ? { id: n.ast_users.id } : null } };
});

// ---------------------------------------------------------------- invoices and batches
async function invoiceFull(id: string) {
  const i = await one("ast_invoices", id, "*", "Invoice") as any;
  const [charges, pays] = await Promise.all([
    db.from("ast_charges").select("*, ast_charge_items(id,name,reference)").eq("invoice_id", id).order("date").order("created_at"),
    db.from("ast_invoice_payment_allocations").select("*").eq("invoice_id", id).order("payment_date"),
  ]);
  const paid = (must(pays) as any[]).reduce((s, p) => s + Number(p.amount), 0);
  return { data: S.invoice(i, { charges: (must(charges) as any[]).map(S.invoiceCharge), payment_allocations: (must(pays) as any[]).map((p) => ({ id: p.id, amount: Number(p.amount), payment_date: p.payment_date, reference: p.reference, created_at: iso(p.created_at) })), amount_paid: paid, balance: Number(i.total) - paid }) };
}
route("GET", `${V}/invoices`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_invoices").select("*", { count: "exact" });
  const parts = csv(filter(c, "participant")); if (parts) qb = qb.in("participant_id", parts);
  const st = csv(filter(c, "status")); if (st) qb = qb.in("status", st);
  const mts = csv(filter(c, "management_type")); if (mts) qb = qb.in("management_type", mts);
  const batch = filter(c, "invoice_batch"); if (batch) qb = qb.eq("batch_id", batch);
  const after = filter(c, "date_after"); if (after) qb = qb.gte("date", after);
  const before = filter(c, "date_before"); if (before) qb = qb.lte("date", before);
  const { rows, total } = await run(qb.order("date", { ascending: false }).order("number"), p);
  return listOf(await invoiceRows(rows), total, p);
});
/** Invoice rows with their charges embedded, as the invoice listings publish them. */
async function invoiceRows(rows: any[]) {
  const ids = rows.map((i: any) => i.id);
  const charges = ids.length ? must(await db.from("ast_charges").select("*, ast_charge_items(id,name,reference)").in("invoice_id", ids).order("date").order("created_at")) as any[] : [];
  const by = new Map<string, any[]>();
  for (const ch of charges) { if (!by.has(ch.invoice_id)) by.set(ch.invoice_id, []); by.get(ch.invoice_id)!.push(S.invoiceCharge(ch)); }
  return rows.map((i: any) => S.invoice(i, { charges: by.get(i.id) ?? [] }));
}
route("GET", `${V}/invoices/:invoice`, async (c) => invoiceFull(idOf(c, "invoice", "Invoice")));
route("POST", `${V}/invoices/:invoice/payment-allocations`, async (c) => {
  const id = idOf(c, "invoice", "Invoice"); const inv = await one("ast_invoices", id, "*", "Invoice") as any;
  need(c.body, ["amount", "payment_date"]);
  if (inv.status === "voided") throw invalid({ invoice: ["A voided invoice cannot receive payments."] });
  const amount = Math.round(Number(c.body.amount)); if (!(amount >= 0)) throw invalid({ amount: ["The amount must be an integer number of cents."] });
  const pay = must(await db.from("ast_invoice_payment_allocations").insert({ invoice_id: id, amount, payment_date: String(c.body.payment_date).slice(0, 10), reference: c.body.reference ?? null }).select().single()) as any;
  const pays = must(await db.from("ast_invoice_payment_allocations").select("amount").eq("invoice_id", id)) as any[];
  const paid = pays.reduce((s, p) => s + Number(p.amount), 0);
  const status = paid >= Number(inv.total) ? "paid" : paid > 0 ? "part_paid" : inv.status;
  must(await db.from("ast_invoices").update({ status }).eq("id", id));
  if (status === "paid") must(await db.from("ast_charges").update({ status: "paid" }).eq("invoice_id", id));
  await attribute(c, [id, pay.id]);
  return invoiceFull(id);
});
route("POST", `${V}/invoices/:invoice/void`, async (c) => {
  const id = idOf(c, "invoice", "Invoice"); const inv = await one("ast_invoices", id, "*", "Invoice") as any;
  if (inv.status === "voided") throw invalid({ invoice: ["The invoice is already voided."] });
  must(await db.from("ast_invoices").update({ status: "voided", voided_at: new Date().toISOString(), voided_reason: c.body?.voided_reason ?? null }).eq("id", id));
  must(await db.from("ast_charges").update({ invoice_id: null, status: "uninvoiced" }).eq("invoice_id", id));
  await attribute(c, [id]);
  return invoiceFull(id);
});
route("GET", `${V}/invoice-batches`, async (c) => {
  const p = paging(c);
  const { rows, total } = await run(db.from("ast_invoice_batches").select("*", { count: "exact" }).order("created_at", { ascending: false }), p);
  return listOf(rows.map(S.invoiceBatch), total, p);
});
route("POST", `${V}/invoice-batches`, async (c) => {
  need(c.body, ["start", "end"]);
  const start = String(c.body.start).slice(0, 10), end = String(c.body.end).slice(0, 10);
  if (end < start) throw invalid({ end: ["The end must be a date after or equal to start."] });
  const mts: string[] = Array.isArray(c.body.management_types) && c.body.management_types.length ? c.body.management_types : ["ndia", "plan", "self"];
  const parts: string[] | null = Array.isArray(c.body.participants) && c.body.participants.length ? c.body.participants.map((x: any) => x.id) : null;
  const seq = must(await db.from("ast_invoice_batches").select("id", { count: "exact", head: true })) as any;
  const ref = `BATCH-${todayIn().slice(0, 7).replace("-", "")}-${String(((seq as any)?.count ?? 0) + 1).padStart(3, "0")}`;
  const b = must(await db.from("ast_invoice_batches").insert({ reference: ref, status: "draft", start, end, charge_type: c.body.charge_type ?? null, management_types: mts }).select().single()) as any;
  // draft invoices: one per participant + management type, from uninvoiced charges with a service
  let qb = db.from("ast_charges").select("*, ast_services!inner(id,management_type)").is("invoice_id", null).gte("date", start).lte("date", end).in("ast_services.management_type", mts);
  if (c.body.charge_type) qb = qb.eq("source", c.body.charge_type);
  if (parts) qb = qb.in("participant_id", parts);
  const charges = must(await qb) as any[];
  const groups = new Map<string, any[]>();
  for (const ch of charges) { const k = `${ch.participant_id}|${ch.ast_services.management_type}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(ch); }
  const last = must(await db.from("ast_invoices").select("number").order("number", { ascending: false }).limit(1).maybeSingle()) as any;
  let n = Number((last?.number || "INV-2026-0100").split("-").pop()) + 1;
  const ids: string[] = [b.id];
  for (const [k, list] of groups) {
    const [participant_id, mt] = k.split("|");
    const pm = mt === "plan" ? (await one("ast_participants", participant_id, "plan_manager_id") as any).plan_manager_id : null;
    const total = list.reduce((s, ch) => s + Number(ch.total_cost), 0);
    const inv = must(await db.from("ast_invoices").insert({ number: `INV-2026-${String(n++).padStart(4, "0")}`, participant_id, plan_manager_id: pm, batch_id: b.id, management_type: mt, date: todayIn(), due_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10), total, status: "draft" }).select("id").single()) as any;
    must(await db.from("ast_charges").update({ invoice_id: inv.id, status: "invoiced" }).in("id", list.map((ch) => ch.id)));
    ids.push(inv.id);
  }
  await attribute(c, ids);
  const out = { data: S.invoiceBatch(b) };
  await emit("invoice_batch.created", out.data);
  return out;
});
route("POST", `${V}/invoice-batches/:invoiceBatch/finalise`, async (c) => {
  const id = idOf(c, "invoiceBatch", "InvoiceBatch"); const b = await one("ast_invoice_batches", id, "*", "InvoiceBatch") as any;
  if (b.status !== "draft") throw invalid({ invoice_batch: ["Only draft batches can be finalised."] });
  oneOf(c.body, "invoice_sending_behaviour", ["do_not_send_automatically", "send_automatically"]);
  const behaviour = c.body?.invoice_sending_behaviour ?? "do_not_send_automatically";
  must(await db.from("ast_invoice_batches").update({ status: "finalised", finalised_at: new Date().toISOString(), invoice_sending_behaviour: behaviour }).eq("id", id));
  must(await db.from("ast_invoices").update({ status: "issued", sent_at: behaviour === "send_automatically" ? new Date().toISOString() : null }).eq("batch_id", id).eq("status", "draft"));
  await attribute(c, [id]);
  const out = { data: S.invoiceBatch(await one("ast_invoice_batches", id)) };
  await emit("invoice_batch.finalised", out.data);
  return out;
});
route("GET", `${V}/invoice-batches/:invoiceBatch/invoices`, async (c) => {
  const id = idOf(c, "invoiceBatch", "InvoiceBatch"); await one("ast_invoice_batches", id, "id", "InvoiceBatch"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_invoices").select("*", { count: "exact" }).eq("batch_id", id).order("number"), p);
  return listOf(await invoiceRows(rows), total, p);
});

// ---------------------------------------------------------------- quality: incidents, feedback, referrals
route("GET", `${V}/incidents`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_incidents").select("*, ast_participants(id,first_name,last_name), ast_users(id,first_name,last_name)", { count: "exact" });
  const st = csv(filter(c, "status")); if (st) qb = qb.in("status", st);
  const parts = csv(filter(c, "participant")); if (parts) qb = qb.in("participant_id", parts);
  const { rows, total } = await run(qb.order("time", { ascending: false }), p);
  return listOf(rows.map(S.incident), total, p, ["time"]);
});
route("GET", `${V}/incidents/:incident`, async (c) => ({ data: S.incident(await one("ast_incidents", idOf(c, "incident", "Incident"), "*, ast_participants(id,first_name,last_name), ast_users(id,first_name,last_name)", "Incident")) }));
route("GET", `${V}/feedback`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_feedback").select("*, ast_participants(id,first_name,last_name)", { count: "exact" });
  const st = csv(filter(c, "status")); if (st) qb = qb.in("status", st);
  const ty = csv(filter(c, "feedback_type")); if (ty) qb = qb.in("feedback_type", ty);
  const { rows, total } = await run(qb.order("created_at", { ascending: false }), p);
  return listOf(rows.map(S.feedback), total, p);
});
route("GET", `${V}/feedback/:feedback`, async (c) => ({ data: S.feedback(await one("ast_feedback", idOf(c, "feedback", "Feedback"), "*, ast_participants(id,first_name,last_name)", "Feedback")) }));
route("GET", `${V}/referrals`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_referrals").select("*", { count: "exact" });
  const st = csv(filter(c, "status")); if (st) qb = qb.in("status", st);
  const { rows, total } = await run(qb.order("created_at", { ascending: false }), p);
  return listOf(rows.map(S.referral), total, p);
});
route("GET", `${V}/referrals/:referral`, async (c) => ({ data: S.referral(await one("ast_referrals", idOf(c, "referral", "Referral"), "*", "Referral")) }));

// ---------------------------------------------------------------- users
route("GET", `${V}/users`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_users").select("*", { count: "exact" });
  const st = csv(filter(c, "status")); if (st) qb = qb.in("status", st);
  const cn = filter(c, "contact_number"); if (cn) qb = qb.or(`phone.ilike.%${cn}%,mobile.ilike.%${cn}%`);
  const et = csv(filter(c, "employment_title")); if (et) qb = qb.or(et.map((t) => `employment_title.ilike.%${t}%`).join(","));
  const ty = csv(filter(c, "type")); if (ty) qb = qb.in("type", ty);
  const [col, asc] = sortOf(c, { last_name: "last_name", first_name: "first_name", created_at: "created_at", email: "email" }, "last_name");
  const { rows, total } = await run(qb.order(col, { ascending: asc }).order("id"), p);
  return listOf(rows.map((u: any) => S.user(u)), total, p, ["last_name", "first_name", "created_at", "email"]);
});
route("POST", `${V}/users`, async (c) => {
  need(c.body, ["first_name", "last_name", "email"]);
  oneOf(c.body, "type", ["auditor", "standard", "support_worker"]); oneOf(c.body, "role", ["admin", "auditor", "manager", "support-worker", "team-member"]); oneOf(c.body, "employment_basis", ["casual", "full_time", "part_time"]);
  const row = { ...pick(c.body, ["first_name", "last_name", "email", "mobile", "phone", "employment_title", "employment_basis", "type", "role"]), status: "invited" };
  const u = must(await db.from("ast_users").insert(row).select().single()) as any;
  await attribute(c, [u.id]); const out = { data: S.user(u) }; await emit("user.invited", out.data); return out;
});
route("GET", `${V}/users/:user`, async (c) => ({ data: S.user(await one("ast_users", idOf(c, "user", "User"), "*", "User")) }));
route("GET", `${V}/users/:user/documents`, async (c) => { const id = idOf(c, "user", "User"); await one("ast_users", id, "id", "User"); return documentsFor(c, "user", id); });
route("POST", `${V}/users/:user/documents`, async (c) => { const id = idOf(c, "user", "User"); await one("ast_users", id, "id", "User"); return addDocument(c, "user", id); });
route("GET", `${V}/users/:user/notes`, async (c) => {
  const id = idOf(c, "user", "User"); await one("ast_users", id, "id", "User"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_notes").select("*, ast_users(id,first_name,last_name,email)", { count: "exact" }).eq("notable_type", "user").eq("notable_id", id).order("created_at", { ascending: false }), p);
  return listOf(rows.map((n: any) => ({ id: n.id, content: n.content, checkin_type: n.checkin_type, created_at: iso(n.created_at), author: n.ast_users ? { id: n.ast_users.id } : null })), total, p);
});
route("POST", `${V}/users/:user/notes`, async (c) => {
  const id = idOf(c, "user", "User"); await one("ast_users", id, "id", "User"); need(c.body, ["content"]);
  const n = must(await db.from("ast_notes").insert({ notable_type: "user", notable_id: id, author_id: c.body.author?.id ?? null, content: c.body.content, checkin_type: c.body.checkin_type ?? null, source_type: "profile" }).select().single()) as any;
  await attribute(c, [n.id]); return { data: { id: n.id, content: n.content, checkin_type: n.checkin_type, created_at: iso(n.created_at), author: n.author_id ? { id: n.author_id } : null } };
});
route("GET", `${V}/users/:user/tasks`, async (c) => {
  const id = idOf(c, "user", "User"); await one("ast_users", id, "id", "User"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_tasks").select(TASK_SELECT, { count: "exact" }).eq("user_id", id).order("start_time", { ascending: false }), p);
  return listOf(rows.map((t: any) => S.task(t)), total, p);
});
route("GET", `${V}/user-record-types`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_user_record_types").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map(S.userRecordType), total, p); });
route("GET", `${V}/user-record-types/:userRecordType`, async (c) => { const t = await one("ast_user_record_types", idOf(c, "userRecordType", "UserRecordType"), "*", "UserRecordType") as any; return { data: S.userRecordType(t) }; });
route("GET", `${V}/user-records`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_user_records").select("*, ast_users(id,first_name,last_name), ast_user_record_types(id,name)", { count: "exact" });
  const users = csv(filter(c, "user")); if (users) qb = qb.in("user_id", users);
  const types = csv(filter(c, "user_record_type")); if (types) qb = qb.in("type_id", types);
  const st = filter(c, "status");
  if (st === "expired") qb = qb.lt("expiry_date", todayIn());
  if (st === "expiring") { const d = new Date(); d.setDate(d.getDate() + 30); qb = qb.gte("expiry_date", todayIn()).lte("expiry_date", d.toISOString().slice(0, 10)); }
  const [col, asc] = sortOf(c, { expiry_date: "expiry_date", created_at: "created_at" }, "expiry_date");
  const { rows, total } = await run(qb.order(col, { ascending: asc, nullsFirst: false }).order("id"), p);
  return listOf(rows.map(S.userRecord), total, p, ["expiry_date", "created_at"]);
});
route("POST", `${V}/user-records`, async (c) => {
  need(c.body, ["user", "user_record_type"]);
  const row = { user_id: c.body.user?.id, type_id: c.body.user_record_type?.id, name: c.body.name ?? null, reference: c.body.reference ?? null, issue_date: c.body.issue_date ?? null, expiry_date: c.body.expiry_date ?? null };
  const r = must(await db.from("ast_user_records").insert(row).select("id").single()) as any; await attribute(c, [r.id]);
  return { data: S.userRecord(await one("ast_user_records", r.id, "*, ast_users(id,first_name,last_name), ast_user_record_types(id,name)")) };
});
route("PUT", `${V}/user-records/:userRecord`, async (c) => {
  const id = idOf(c, "userRecord", "UserRecord"); await one("ast_user_records", id, "id", "UserRecord");
  must(await db.from("ast_user_records").update(pick(c.body, ["name", "reference", "issue_date", "expiry_date"])).eq("id", id)); await attribute(c, [id]);
  return { data: S.userRecord(await one("ast_user_records", id, "*, ast_users(id,first_name,last_name), ast_user_record_types(id,name)")) };
});
route("GET", `${V}/participant-record-types`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_participant_record_types").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map(S.recordType), total, p); });
route("GET", `${V}/participant-record-types/:participantRecordType`, async (c) => ({ data: S.recordType(await one("ast_participant_record_types", idOf(c, "participantRecordType", "ParticipantRecordType"), "*", "ParticipantRecordType")) }));
route("GET", `${V}/participant-records`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_participant_records").select("*, ast_participants(id,first_name,last_name), ast_participant_record_types(id,name)", { count: "exact" });
  const parts = csv(filter(c, "participant")); if (parts) qb = qb.in("participant_id", parts);
  const types = csv(filter(c, "participant_record_type")); if (types) qb = qb.in("type_id", types);
  const st = filter(c, "status"); if (st === "expired") qb = qb.lt("expiry_date", todayIn());
  const { rows, total } = await run(qb.order("expiry_date", { ascending: true, nullsFirst: false }).order("id"), p);
  return listOf(rows.map(S.participantRecord), total, p, ["expiry_date"]);
});
route("POST", `${V}/participant-records`, async (c) => {
  need(c.body, ["participant", "participant_record_type"]);
  const row = { participant_id: c.body.participant?.id, type_id: c.body.participant_record_type?.id, name: c.body.name ?? null, reference: c.body.reference ?? null, issue_date: c.body.issue_date ?? null, expiry_date: c.body.expiry_date ?? null };
  const r = must(await db.from("ast_participant_records").insert(row).select("id").single()) as any; await attribute(c, [r.id]);
  return { data: S.participantRecord(await one("ast_participant_records", r.id, "*, ast_participants(id,first_name,last_name), ast_participant_record_types(id,name)")) };
});
route("PUT", `${V}/participant-records/:participantRecord`, async (c) => {
  const id = idOf(c, "participantRecord", "ParticipantRecord"); await one("ast_participant_records", id, "id", "ParticipantRecord");
  must(await db.from("ast_participant_records").update(pick(c.body, ["name", "reference", "issue_date", "expiry_date"])).eq("id", id)); await attribute(c, [id]);
  return { data: S.participantRecord(await one("ast_participant_records", id, "*, ast_participants(id,first_name,last_name), ast_participant_record_types(id,name)")) };
});
route("GET", `${V}/participant-information-items`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_participant_information_item_defs").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map(S.infoDef), total, p); });
route("POST", `${V}/participant-information-items`, async (c) => { need(c.body, ["name"]); const d = must(await db.from("ast_participant_information_item_defs").insert(pick(c.body, ["name", "required", "documents_allowed", "visible_to_support_workers"])).select().single()) as any; await attribute(c, [d.id]); return { data: S.infoDef(d) }; });
route("GET", `${V}/participant-information-items/:participantInformationItem`, async (c) => ({ data: S.infoDef(await one("ast_participant_information_item_defs", idOf(c, "participantInformationItem", "ParticipantInformationItem"), "*", "ParticipantInformationItem")) }));
route("PUT", `${V}/participant-information-items/:participantInformationItem`, async (c) => { const id = idOf(c, "participantInformationItem", "ParticipantInformationItem"); await one("ast_participant_information_item_defs", id, "id", "ParticipantInformationItem"); must(await db.from("ast_participant_information_item_defs").update(pick(c.body, ["name", "required", "documents_allowed", "visible_to_support_workers"])).eq("id", id)); await attribute(c, [id]); return { data: S.infoDef(await one("ast_participant_information_item_defs", id)) }; });

// ---------------------------------------------------------------- tags (participant tags are real; the other tag families are empty in the replica)
route("GET", `${V}/participant-tags`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_participant_tags").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map(S.tag), total, p); });
route("POST", `${V}/participant-tags`, async (c) => { need(c.body, ["name"]); const t = must(await db.from("ast_participant_tags").insert(pick(c.body, ["name", "colour"])).select().single()) as any; await attribute(c, [t.id]); return { data: S.tag(t) }; });
route("GET", `${V}/participant-tags/:participantTag`, async (c) => ({ data: S.tag(await one("ast_participant_tags", idOf(c, "participantTag", "ParticipantTag"), "*", "ParticipantTag")) }));
route("PUT", `${V}/participant-tags/:participantTag`, async (c) => { const id = idOf(c, "participantTag", "ParticipantTag"); await one("ast_participant_tags", id, "id", "ParticipantTag"); must(await db.from("ast_participant_tags").update(pick(c.body, ["name", "colour"])).eq("id", id)); await attribute(c, [id]); return { data: S.tag(await one("ast_participant_tags", id)) }; });
for (const fam of ["organisation-tags", "plan-manager-tags", "resource-tags", "site-tags"]) {
  route("GET", `${V}/${fam}`, async (c) => listOf([], 0, paging(c)));
  route("GET", `${V}/${fam}/:id`, async () => { throw notFound("Tag"); });
  route("POST", `${V}/${fam}`, async () => { throw new ApiError(501, `${fam} are not enabled in this replica.`); });
  route("PUT", `${V}/${fam}/:id`, async () => { throw notFound("Tag"); });
}
for (const fam of ["site-record-types", "site-records", "candidates", "job-posts", "job-applications"]) {
  route("GET", `${V}/${fam}`, async (c) => listOf([], 0, paging(c)));
  route("GET", `${V}/${fam}/:id`, async () => { throw notFound("Record"); });
  route("POST", `${V}/${fam}`, async () => { throw new ApiError(501, `${fam} are not enabled on this account.`); });
  route("PUT", `${V}/${fam}/:id`, async () => { throw notFound("Record"); });
}

// ---------------------------------------------------------------- contacts, organisations, plan managers, sites
route("GET", `${V}/contacts`, async (c) => {
  const p = paging(c);
  let qb = db.from("ast_contacts").select("*", { count: "exact" }).is("archived_at", null);
  const phone = filter(c, "phone"); if (phone) qb = qb.ilike("phone", `%${phone}%`);
  const mobile = filter(c, "mobile"); if (mobile) qb = qb.ilike("mobile", `%${mobile}%`);
  const cn = filter(c, "contact_number"); if (cn) qb = qb.or(`phone.ilike.%${cn}%,mobile.ilike.%${cn}%`);
  const search = filter(c, "search"); if (search) qb = qb.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
  const { rows, total } = await run(qb.order("last_name").order("first_name"), p);
  return listOf(rows.map(S.contact), total, p);
});
route("POST", `${V}/contacts`, async (c) => { need(c.body, ["first_name"]); const row = pick(c.body, ["first_name", "last_name", "email", "phone", "mobile", "dob", "gender", "occupation", "description", "preferred_contact_method"]); if (c.body.organisation?.id) row.organisation_id = c.body.organisation.id; const r = must(await db.from("ast_contacts").insert(row).select().single()) as any; await attribute(c, [r.id]); return { data: S.contact(r) }; });
route("GET", `${V}/contacts/:contact`, async (c) => ({ data: S.contact(await one("ast_contacts", idOf(c, "contact", "Contact"), "*", "Contact")) }));
route("PUT", `${V}/contacts/:contact`, async (c) => { const id = idOf(c, "contact", "Contact"); await one("ast_contacts", id, "id", "Contact"); const row = pick(c.body, ["first_name", "last_name", "email", "phone", "mobile", "dob", "gender", "occupation", "description", "preferred_contact_method"]); if (c.body.organisation !== undefined) row.organisation_id = c.body.organisation?.id ?? null; if (Object.keys(row).length) must(await db.from("ast_contacts").update(row).eq("id", id)); await attribute(c, [id]); return { data: S.contact(await one("ast_contacts", id)) }; });
route("GET", `${V}/contacts/:contact/documents`, async (c) => { const id = idOf(c, "contact", "Contact"); await one("ast_contacts", id, "id", "Contact"); return documentsFor(c, "contact", id); });
route("POST", `${V}/contacts/:contact/documents`, async (c) => { const id = idOf(c, "contact", "Contact"); await one("ast_contacts", id, "id", "Contact"); return addDocument(c, "contact", id); });
route("GET", `${V}/contacts/:contact/participants`, async (c) => {
  const id = idOf(c, "contact", "Contact"); await one("ast_contacts", id, "id", "Contact"); const p = paging(c);
  const { rows, total } = await run(db.from("ast_participant_contacts").select("*, ast_participants(*)", { count: "exact" }).eq("contact_id", id).order("participant_id"), p);
  return listOf(rows.map((r: any) => ({ participant: S.participant(r.ast_participants), relationship: r.relationship, starred: r.starred, consent: r.consent, details: r.details, visible_to_support_workers: r.visible_to_support_workers })), total, p);
});
route("GET", `${V}/organisations`, async (c) => { const p = paging(c); let qb = db.from("ast_organisations").select("*", { count: "exact" }); const search = filter(c, "search"); if (search) qb = qb.ilike("name", `%${search}%`); const { rows, total } = await run(qb.order("name"), p); return listOf(rows.map(S.organisation), total, p); });
route("POST", `${V}/organisations`, async (c) => { need(c.body, ["name"]); const r = must(await db.from("ast_organisations").insert(pick(c.body, ["name", "type", "abn", "email", "phone", "website", "description", "ndis_registered", "registration_number"])).select().single()) as any; await attribute(c, [r.id]); return { data: S.organisation(r) }; });
route("GET", `${V}/organisations/:organisation`, async (c) => ({ data: S.organisation(await one("ast_organisations", idOf(c, "organisation", "Organisation"), "*", "Organisation")) }));
route("PUT", `${V}/organisations/:organisation`, async (c) => { const id = idOf(c, "organisation", "Organisation"); await one("ast_organisations", id, "id", "Organisation"); must(await db.from("ast_organisations").update(pick(c.body, ["name", "type", "abn", "email", "phone", "website", "description", "ndis_registered", "registration_number"])).eq("id", id)); await attribute(c, [id]); return { data: S.organisation(await one("ast_organisations", id)) }; });
route("GET", `${V}/organisations/:organisation/contacts`, async (c) => { const id = idOf(c, "organisation", "Organisation"); await one("ast_organisations", id, "id", "Organisation"); const p = paging(c); const { rows, total } = await run(db.from("ast_contacts").select("*", { count: "exact" }).eq("organisation_id", id).order("last_name"), p); return listOf(rows.map(S.contact), total, p); });
route("GET", `${V}/organisations/:organisation/documents`, async (c) => { const id = idOf(c, "organisation", "Organisation"); await one("ast_organisations", id, "id", "Organisation"); return documentsFor(c, "organisation", id); });
route("POST", `${V}/organisations/:organisation/documents`, async (c) => { const id = idOf(c, "organisation", "Organisation"); await one("ast_organisations", id, "id", "Organisation"); return addDocument(c, "organisation", id); });
route("GET", `${V}/plan-managers`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_plan_managers").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map(S.planManager), total, p); });
route("POST", `${V}/plan-managers`, async (c) => { need(c.body, ["name"]); const r = must(await db.from("ast_plan_managers").insert(pick(c.body, ["name", "invoice_email", "phone", "abn"])).select().single()) as any; await attribute(c, [r.id]); return { data: S.planManager(r) }; });
route("GET", `${V}/plan-managers/:planManager`, async (c) => ({ data: S.planManager(await one("ast_plan_managers", idOf(c, "planManager", "PlanManager"), "*", "PlanManager")) }));
route("PUT", `${V}/plan-managers/:planManager`, async (c) => { const id = idOf(c, "planManager", "PlanManager"); await one("ast_plan_managers", id, "id", "PlanManager"); must(await db.from("ast_plan_managers").update(pick(c.body, ["name", "invoice_email", "phone", "abn"])).eq("id", id)); await attribute(c, [id]); return { data: S.planManager(await one("ast_plan_managers", id)) }; });
route("GET", `${V}/plan-managers/:planManager/documents`, async (c) => { const id = idOf(c, "planManager", "PlanManager"); await one("ast_plan_managers", id, "id", "PlanManager"); return documentsFor(c, "plan_manager", id); });
route("POST", `${V}/plan-managers/:planManager/documents`, async (c) => { const id = idOf(c, "planManager", "PlanManager"); await one("ast_plan_managers", id, "id", "PlanManager"); return addDocument(c, "plan_manager", id); });
route("GET", `${V}/sites`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_sites").select("*, ast_users(id,first_name,last_name,email)", { count: "exact" }).is("archived_at", null).order("name"), p); return listOf(rows.map(S.site), total, p); });
route("POST", `${V}/sites`, async (c) => { need(c.body, ["name"]); oneOf(c.body, "type", ["other", "sil_house"]); const row = pick(c.body, ["name", "type", "description", "capacity", "default_support_type"]); if (c.body.site_manager?.id) row.site_manager_id = c.body.site_manager.id; if (c.body.address) Object.assign(row, pick(c.body.address, ["address_1", "suburb", "state", "postcode"])); const r = must(await db.from("ast_sites").insert(row).select("id").single()) as any; await attribute(c, [r.id]); return { data: S.site(await one("ast_sites", r.id, "*, ast_users(id,first_name,last_name,email)")) }; });
route("GET", `${V}/sites/:site`, async (c) => ({ data: S.site(await one("ast_sites", idOf(c, "site", "Site"), "*, ast_users(id,first_name,last_name,email)", "Site")) }));
route("PUT", `${V}/sites/:site`, async (c) => { const id = idOf(c, "site", "Site"); await one("ast_sites", id, "id", "Site"); const row = pick(c.body, ["name", "type", "description", "capacity", "default_support_type"]); if (c.body.site_manager !== undefined) row.site_manager_id = c.body.site_manager?.id ?? null; if (c.body.address) Object.assign(row, pick(c.body.address, ["address_1", "suburb", "state", "postcode"])); if (Object.keys(row).length) must(await db.from("ast_sites").update(row).eq("id", id)); await attribute(c, [id]); return { data: S.site(await one("ast_sites", id, "*, ast_users(id,first_name,last_name,email)")) }; });
route("GET", `${V}/sites/:site/documents`, async (c) => { const id = idOf(c, "site", "Site"); await one("ast_sites", id, "id", "Site"); return documentsFor(c, "site", id); });
route("POST", `${V}/sites/:site/documents`, async (c) => { const id = idOf(c, "site", "Site"); await one("ast_sites", id, "id", "Site"); return addDocument(c, "site", id); });
route("GET", `${V}/sites/:site/participants`, async (c) => {
  const id = idOf(c, "site", "Site"); await one("ast_sites", id, "id", "Site"); const p = paging(c);
  const sup = must(await db.from("ast_supports").select("participant_id").eq("site_id", id)) as any[];
  const ids = [...new Set(sup.map((s) => s.participant_id))];
  if (!ids.length) return listOf([], 0, p);
  const { rows, total } = await run(db.from("ast_participants").select("id,first_name,last_name,status", { count: "exact" }).in("id", ids).order("last_name"), p);
  return listOf(rows.map((r: any) => ({ id: r.id, full_name: [r.first_name, r.last_name].filter(Boolean).join(" "), status: r.status })), total, p);
});

// ---------------------------------------------------------------- documents, categories, forms, signatures, misc
route("PUT", `${V}/documents/:document`, async (c) => { const id = idOf(c, "document", "Document"); await one("ast_documents", id, "id", "Document"); const row = pick(c.body, ["name"]); if (c.body.document_category !== undefined) row.category_id = c.body.document_category?.id ?? null; if (Object.keys(row).length) must(await db.from("ast_documents").update(row).eq("id", id)); await attribute(c, [id]); return { data: S.document(await one("ast_documents", id, "*, ast_document_categories(id,name)")) }; });
route("GET", `${V}/documents/:document/download`, async (c) => { const d = await one("ast_documents", idOf(c, "document", "Document"), "*", "Document") as any; return { data: { id: d.id, name: d.name, url: null, message: "The replica stores document metadata only; there is no file to download." } }; });
route("GET", `${V}/document-categories`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_document_categories").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map(S.documentCategory), total, p); });
route("POST", `${V}/document-categories`, async (c) => { need(c.body, ["name"]); const r = must(await db.from("ast_document_categories").insert({ name: c.body.name }).select().single()) as any; await attribute(c, [r.id]); return { data: S.documentCategory(r) }; });
route("GET", `${V}/document-categories/:documentCategory`, async (c) => ({ data: S.documentCategory(await one("ast_document_categories", idOf(c, "documentCategory", "DocumentCategory"), "*", "DocumentCategory")) }));
route("PUT", `${V}/document-categories/:documentCategory`, async (c) => { const id = idOf(c, "documentCategory", "DocumentCategory"); await one("ast_document_categories", id, "id", "DocumentCategory"); must(await db.from("ast_document_categories").update(pick(c.body, ["name"])).eq("id", id)); await attribute(c, [id]); return { data: S.documentCategory(await one("ast_document_categories", id)) }; });
route("GET", `${V}/forms`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_forms").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map(S.form), total, p); });
route("GET", `${V}/form-submissions`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_form_submissions").select("*, ast_forms(*)", { count: "exact" }).order("submitted_at", { ascending: false }), p); return listOf(rows.map(S.formSubmission), total, p); });
route("GET", `${V}/form-submissions/:formSubmission`, async (c) => ({ data: S.formSubmission(await one("ast_form_submissions", idOf(c, "formSubmission", "FormSubmission"), "*, ast_forms(*)", "FormSubmission")) }));
const SIG_SELECT = "*, ast_users(id,first_name,last_name,email), ast_participants(id,first_name,last_name)";
route("GET", `${V}/signature-requests`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_signature_requests").select(SIG_SELECT, { count: "exact" }).order("created_at", { ascending: false }), p); return listOf(rows.map(S.signatureRequest), total, p); });
route("GET", `${V}/signature-requests/:signatureRequest`, async (c) => ({ data: S.signatureRequest(await one("ast_signature_requests", idOf(c, "signatureRequest", "SignatureRequest"), SIG_SELECT, "SignatureRequest")) }));
route("GET", `${V}/public-holidays`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_public_holidays").select("*", { count: "exact" }).order("date"), p); return listOf(rows.map(S.publicHoliday), total, p); });
route("GET", `${V}/public-holiday-groups`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_public_holiday_groups").select("*", { count: "exact" }).order("name"), p); return listOf(rows.map((g: any) => ({ id: g.id, name: g.name })), total, p); });
route("GET", `${V}/exports`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_exports").select("*", { count: "exact" }).order("created_at", { ascending: false }), p); return listOf(rows.map(S.exportRow), total, p); });
route("POST", `${V}/temporary-uploads`, async (c) => ({ data: { id: crypto.randomUUID(), name: c.body?.name ?? "upload", expires_at: iso(new Date(Date.now() + 3600e3)), message: "The replica accepts upload metadata only." } }));

// ---------------------------------------------------------------- webhooks
const EVENT_TYPES = ["candidate.created", "candidate.updated", "feedback.created", "form_submission.created", "incident.created", "invoice_batch.created", "invoice_batch.finalised", "job_application.created", "job_post.closed", "job_post.published", "participant.created", "participant.updated", "referral.created", "task.created", "user.deactivated", "user.invite_accepted", "user.invited", "user.restricted"];
route("GET", `${V}/webhook-event-types`, async () => ({ data: EVENT_TYPES.map((value) => ({ value })) }));
route("GET", `${V}/webhooks`, async (c) => { const p = paging(c); const { rows, total } = await run(db.from("ast_webhooks").select("*", { count: "exact" }).order("created_at"), p); return listOf(rows.map(S.webhook), total, p); });
route("POST", `${V}/webhooks`, async (c) => {
  need(c.body, ["description", "url", "is_enabled", "event_types"]);
  const bad = (c.body.event_types as string[]).filter((t) => !EVENT_TYPES.includes(t)); if (bad.length) throw invalid({ event_types: [`Unknown event types: ${bad.join(", ")}.`] });
  const w = must(await db.from("ast_webhooks").insert({ description: c.body.description, url: c.body.url, is_enabled: !!c.body.is_enabled, event_types: c.body.event_types }).select().single()) as any;
  await attribute(c, [w.id]); return { data: S.webhook(w) };
});
route("GET", `${V}/webhooks/:webhook`, async (c) => ({ data: S.webhook(await one("ast_webhooks", idOf(c, "webhook", "Webhook"), "*", "Webhook")) }));
route("PUT", `${V}/webhooks/:webhook`, async (c) => { const id = idOf(c, "webhook", "Webhook"); await one("ast_webhooks", id, "id", "Webhook"); must(await db.from("ast_webhooks").update(pick(c.body, ["description", "url", "is_enabled", "event_types"])).eq("id", id)); await attribute(c, [id]); return { data: S.webhook(await one("ast_webhooks", id)) }; });
route("POST", `${V}/webhooks/:webhook/archive`, async (c) => { const id = idOf(c, "webhook", "Webhook"); await one("ast_webhooks", id, "id", "Webhook"); must(await db.from("ast_webhooks").update({ archived_at: new Date().toISOString(), is_enabled: false }).eq("id", id)); await attribute(c, [id]); return { data: S.webhook(await one("ast_webhooks", id)) }; });
route("POST", `${V}/webhooks/:webhook/unarchive`, async (c) => { const id = idOf(c, "webhook", "Webhook"); await one("ast_webhooks", id, "id", "Webhook"); must(await db.from("ast_webhooks").update({ archived_at: null }).eq("id", id)); await attribute(c, [id]); return { data: S.webhook(await one("ast_webhooks", id)) }; });

// ---------------------------------------------------------------- replica extras (not part of Astalty's API)
export const PLANTED = [
  { code: "P1", area: "billing", summary: "Alex Marino's Saturday 26 Sep community support was charged at the weekday daytime rate (04_104 @ $70.23 instead of 04_105 @ $98.83)." },
  { code: "P2", area: "billing", summary: "Mia Tran's 24 Sep community support appears twice on her period-2 invoice (duplicate charge)." },
  { code: "P3", area: "billing", summary: "Ethan Kaur's period-2 invoice total is $140.46 (two hours) more than the sum of its charges." },
  { code: "P4", area: "billing", summary: "Jordan Whitfield's 29 Sep afternoon support was charged 4.00 hours for a 2 hour shift." },
  { code: "P5", area: "rostering", summary: "Tom Whittaker's 14 Oct shift with Oliver Petrov is completed and charged but has no clock-out." },
  { code: "P6", area: "agreements", summary: "Sophie Lindqvist's plan and service agreements ended 30 Sep; October supports are charged against the expired agreement." },
  { code: "P7", area: "agreements", summary: "Harper Osei has supports since 30 Sep but no service agreement, so the charges cannot be invoiced; her signature request is still unsigned." },
  { code: "P8", area: "compliance", summary: "Hannah Kowalski's NDIS Worker Screening (15 Sep) and First Aid (30 Aug) have expired; she is still rostered this week and next. Marcus Bell's CPR expires 26 Oct." },
  { code: "P9", area: "notes", summary: "Grace Nguyen's completed shifts in the week of 12 Oct (Ruby, Zara, Ethan) have no progress notes." },
  { code: "P10", area: "notes", summary: "Grace Nguyen's 10 Oct note for Jordan Whitfield is judgemental and has no times, supports or outcomes." },
  { code: "P11", area: "incidents", summary: "INC-2026-014 (Chloe Baptiste fall, 10 Oct) is open, marked reportable with no reportable type and no follow-up after 9 days. Priya's 14 Oct note for Mia Tran describes a slip that was never logged as an incident." },
  { code: "P12", area: "risk", summary: "Alex Marino's pressure injury risk review was due 31 Aug and is overdue." },
  { code: "P13", area: "budgets", summary: "Oliver Petrov's community access agreement is $3,000 and the charges against it exceed that." },
  { code: "P14", area: "travel", summary: "Liam O'Connell claimed 48 km on 10 Oct against 20 km approved; the km charge followed the claim." },
  { code: "P15", area: "consent", summary: "Ruby Delacroix's consent to share information expired 1 Sep and her service agreement signature request expired unsigned." },
  { code: "P16", area: "billing", summary: "Chloe Baptiste is NDIA managed but her period-2 invoice was issued as plan managed with no plan manager." },
  { code: "P17", area: "billing", summary: "Mei Lin Zhao's 13 Oct support coordination task for Oliver Petrov is billable and completed but has no charge." },
  { code: "P18", area: "rostering", summary: "Priya Nair is rostered to two overlapping shifts on Wed 21 Oct (Alex 07:30–10:00 and Isla 09:00–11:00)." },
  { code: "P19", area: "complaints", summary: "Complaint FB-2026-007 from Alex Marino's mother about late workers has been open since 29 Sep with no follow-up." },
];
route("GET", `/_replica/planted`, async () => ({ data: PLANTED }));
route("GET", `/_replica/changes`, async (c) => {
  const p = paging(c, 50);
  let qb = db.from("ast_change_log").select("*", { count: "exact" });
  const since = q(c, "since"); if (since) qb = qb.gte("at", parseWhen(since, "since"));
  const tbl = q(c, "table"); if (tbl) qb = qb.eq("tbl", tbl);
  const { rows, total } = await run(qb.order("at", { ascending: false }).order("id", { ascending: false }), p);
  return listOf(rows.map((r: any) => ({ id: r.id, at: iso(r.at), table: r.tbl.replace(/^ast_/, ""), row_id: r.row_id, op: r.op.toLowerCase(), actor: r.actor, via: r.via, summary: summarise(r), before: r.before, after: r.after })), total, p);
});
function summarise(r: any) {
  const t = r.tbl.replace(/^ast_/, "").replace(/_/g, " ");
  const who = r.actor ? ` by ${r.actor}` : "";
  if (r.op === "INSERT") return `New ${t.replace(/s$/, "")} added${who}.`;
  if (r.op === "DELETE") return `${t.replace(/s$/, "")} removed${who}.`;
  const changed = Object.keys(r.after || {}).filter((k) => JSON.stringify(r.after[k]) !== JSON.stringify(r.before?.[k]));
  return `${t.replace(/s$/, "")} updated${who}: ${changed.map((k) => `${k} ${JSON.stringify(r.before?.[k])} → ${JSON.stringify(r.after[k])}`).join("; ")}`;
}
export { TZ };

// ---------------------------------------------------------------- replica: conformance check against the published schema
route("GET", `/_replica/conformance`, async (c) => {
  const first = async (t: string, where?: (q: any) => any) => { let qb = db.from(t).select("id").limit(1); if (where) qb = where(qb); const r = must(await qb) as any[]; return r[0]?.id as string | undefined; };
  const [pid, sid, shid, iid, tid, gid, bid, plan, svc, uid, rid, inc, fb, ref, sig, batch, site, contact, org, pm, doc, wh] = await Promise.all([
    first("ast_participants"), first("ast_supports", (q) => q.eq("status", "completed")), first("ast_shifts"), first("ast_invoices"), first("ast_tasks"), first("ast_goals"), first("ast_budgets"),
    first("ast_ndis_plans"), first("ast_services"), first("ast_users"), first("ast_participant_risks"), first("ast_incidents"), first("ast_feedback"), first("ast_referrals"), first("ast_signature_requests"),
    first("ast_invoice_batches"), first("ast_sites"), first("ast_contacts"), first("ast_organisations"), first("ast_plan_managers"), first("ast_documents"), first("ast_webhooks"),
  ]);
  const paths = [
    `${V}/app/status`, `${V}/participants?page[size]=5`, `${V}/participants/${pid}`, `${V}/participants/${pid}/addresses`, `${V}/participants/${pid}/contacts`, `${V}/participants/${pid}/documents`,
    `${V}/participants/${pid}/goals`, `${V}/participants/${pid}/information-items`, `${V}/participants/${pid}/ndis-plans`, `${V}/participants/${pid}/notes?page[size]=5`, `${V}/participants/${pid}/current-services`,
    `${V}/participants/${pid}/budgets`, `${V}/participants/${pid}/risks`, `${V}/participants/${pid}/public-holiday-groups`, `${V}/risks/${rid}`, `${V}/goals/${gid}`, `${V}/goals/${gid}/supports?page[size]=3`, `${V}/goals/${gid}/tasks?page[size]=3`,
    `${V}/ndis-plans/${plan}`, `${V}/ndis-plans/${plan}/budgets`, `${V}/ndis-plans/${plan}/implementations`, `${V}/services?page[size]=5`, `${V}/services/${svc}`, `${V}/budgets/${bid}`, `${V}/budgets/${bid}/items`, `${V}/budgets/${bid}/periods`,
    `${V}/charge-items`, `${V}/charge-item-sets`, `${V}/supports?page[size]=5`, `${V}/supports/${sid}`, `${V}/shifts?page[size]=5`, `${V}/shifts/${shid}`, `${V}/group-supports`,
    `${V}/tasks?page[size]=5`, `${V}/tasks/${tid}`, `${V}/tasks/${tid}/charges`, `${V}/tasks/${tid}/documents`, `${V}/invoices?page[size]=5`, `${V}/invoices/${iid}`, `${V}/invoice-batches`, `${V}/invoice-batches/${batch}/invoices?page[size]=3`,
    `${V}/incidents`, `${V}/incidents/${inc}`, `${V}/feedback`, `${V}/feedback/${fb}`, `${V}/referrals`, `${V}/referrals/${ref}`, `${V}/users`, `${V}/users/${uid}`, `${V}/users/${uid}/documents`, `${V}/users/${uid}/notes`, `${V}/users/${uid}/tasks?page[size]=3`,
    `${V}/user-record-types`, `${V}/user-records?page[size]=10`, `${V}/participant-record-types`, `${V}/participant-records?page[size]=10`, `${V}/participant-information-items`, `${V}/participant-tags`,
    `${V}/contacts`, `${V}/contacts/${contact}`, `${V}/contacts/${contact}/participants`, `${V}/organisations`, `${V}/organisations/${org}`, `${V}/organisations/${org}/contacts`, `${V}/plan-managers`, `${V}/plan-managers/${pm}`,
    `${V}/sites`, `${V}/sites/${site}`, `${V}/sites/${site}/participants`, `${V}/documents/${doc}/download`, `${V}/document-categories`, `${V}/forms`, `${V}/form-submissions`, `${V}/signature-requests`, `${V}/signature-requests/${sig}`,
    `${V}/public-holidays`, `${V}/public-holiday-groups`, `${V}/exports`, `${V}/webhook-event-types`, `${V}/webhooks`, `${V}/webhooks/${wh}`, `${V}/note-templates`,
  ];
  const results: any[] = [];
  for (const full of paths) {
    const u = new URL("https://x" + full);
    const hit = matchSpec("GET", u.pathname);
    if (!hit || "allowed" in hit) { results.push({ path: full, error: "no spec operation" }); continue; }
    const h = ROUTES.find((r) => r.method === "GET" && u.pathname.match(r.re));
    if (!h) { results.push({ path: full, error: "not implemented" }); continue; }
    const m = u.pathname.match(h.re)!;
    const params: Record<string, string> = {}; h.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    try {
      const out = await h.fn({ ...c, path: u.pathname, url: u, query: u.searchParams, params, body: {} });
      const ser = serialize(hit.op.okSchema, out);
      const problems = validate(hit.op.okSchema, ser);
      results.push({ path: full, ok: problems.length === 0, problems: problems.slice(0, 12) });
    } catch (e) { results.push({ path: full, error: String((e as Error).message) }); }
  }
  return { checked: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), spec_operations: specOps().length };
});
