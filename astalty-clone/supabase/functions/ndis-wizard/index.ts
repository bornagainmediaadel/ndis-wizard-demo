// NDIS Wizard agents API (Supabase edge function, Sydney).
// Frontend -> this function -> ShiftCare v3 (HTTP Basic, server-side only).
// Every agent output is a review item: rules first, scrubbed before any model sees it,
// and nothing is sent or written back to ShiftCare without a person approving it.
import { CORS, PRICE_LABEL, PRICES, adlDate, adlTime, json, newId, parseCsv, round2, token } from "./util.ts";
import { Scrubber } from "./scrub.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { BudgetError, ShiftCare, SCError } from "./shiftcare.ts";
import { db, setting } from "./store.ts";
import { checkNote } from "./penny.ts";
import { checkLines, linesFromCsv, shiftsFromCsv } from "./clancy.ts";
import { assess, draft as expiryDraft, type Doc } from "./cleo.ts";
import { REGISTRY, runRegistry } from "./registry.ts";
import * as scFeeds from "./feeds.ts";
import * as astaltyFeeds from "./feeds_astalty.ts";
import { buildPrompt, callClaude, heyPrompt, parseJson, serverModel } from "./ai.ts";

const ORG = "Ability Alliance Care";
type User = { username: string; name: string; role: string };
type Ctx = { user: User; body: any; query: URLSearchParams; params: string[] };

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ---------------- helpers ----------------
type Source = "shiftcare" | "astalty";
type ReqState = { sc?: ShiftCare; resume: boolean; source: Source };
// Which practice-management system this request reads: ShiftCare (default) or the Astalty clone.
const srcOf = () => als.getStore()?.source ?? "shiftcare";
const srcName = () => (srcOf() === "astalty" ? "Astalty" : "ShiftCare");
const F = () => (srcOf() === "astalty" ? astaltyFeeds : scFeeds);
const als = new AsyncLocalStorage<ReqState>();
const CACHE_SECONDS = 180;
async function shiftcare(): Promise<ShiftCare> {
  const st = als.getStore();
  if (st?.sc) return st.sc;
  if (st?.source === "astalty") {
    const base = await setting("ASTALTY_API_BASE"), key = await setting("ASTALTY_API_KEY");
    if (!base || !key) throw new HttpError(503, "Astalty isn't connected. Set ASTALTY_API_BASE and ASTALTY_API_KEY.");
    let preload: Map<string, unknown> | undefined;
    if (st.resume) {
      const since = new Date(Date.now() - CACHE_SECONDS * 1000).toISOString();
      const rows = await db.select("wizard_sc_cache", `fetched_at=gt.${since}&select=url,body`);
      preload = new Map(rows.map((r: any) => [r.url, r.body]));
    }
    const sc = new ShiftCare({ base, apiKey: key, kind: "astalty" }, preload);
    st.sc = sc;
    return sc;
  }
  const base = await setting("SHIFTCARE_API_BASE"), acct = await setting("SHIFTCARE_ACCOUNT_ID"), key = await setting("SHIFTCARE_API_KEY");
  if (!base || !acct || !key) throw new HttpError(503, "ShiftCare isn't connected. Set SHIFTCARE_API_BASE, SHIFTCARE_ACCOUNT_ID and SHIFTCARE_API_KEY.");
  let preload: Map<string, unknown> | undefined;
  if (st?.resume) {
    const since = new Date(Date.now() - CACHE_SECONDS * 1000).toISOString();
    const rows = await db.select("wizard_sc_cache", `fetched_at=gt.${since}&select=url,body`);
    preload = new Map(rows.map((r: any) => [r.url, r.body]));
  }
  const sc = new ShiftCare({ base, accountId: acct, apiKey: key }, preload);
  if (st) st.sc = sc;
  return sc;
}
async function flushCache(st: ReqState) {
  const f = st.sc?.fresh || [];
  if (!f.length) return;
  try { await db.upsert("wizard_sc_cache", f.map(([url, body]) => ({ url, body, fetched_at: new Date().toISOString() }))); } catch (e) { console.error("cache", e); }
}
async function mode(): Promise<string> {
  const m = await serverModel();
  return m ? `AI: Claude (${m}, server) + rules` : "rules + Claude review in claude.ai";
}
const nowAdl = () => `${adlDate()} ${adlTime(new Date())}`;

async function audit(user: User, action: string, agent: string | null, item_id: string | null, detail: unknown) {
  await db.insert("wizard_audit", [{ who: user.username, role: user.role, action, agent, item_id, detail }]);
}

async function queue(user: User, items: any[]): Promise<any[]> {
  if (!items.length) return [];
  const t = new Date().toISOString();
  const md = await mode();
  const full = items.map((it) => ({
    id: newId(it.agent), t, status: "pending", created_by: user.username, created_by_name: user.name, mode: md, ...it,
  }));
  for (const it of full) it.ai_prompt = it.ai_prompt ?? buildPrompt(it.agent === "note" || it.agent === "invoice" || it.agent === "expiry" || it.agent === "hey" ? it.agent : "registry", it.scrubbed_input, it.flags ?? it.exception ?? it.tags ?? null);
  await db.insert("wizard_items", full.map((it) => ({
    id: it.id, agent: it.agent, status: it.status, title: it.title, approver_role: it.approver_role, payload: it, created_by: user.username,
  })));
  await audit(user, `queued ${full.length} item(s)`, full[0].agent, full.length === 1 ? full[0].id : null,
    { ids: full.map((i) => i.id), scrubbed_input: full.map((i) => i.scrubbed_input).join("\n---\n").slice(0, 4000), mode: md });
  // Server-side Claude (only when ANTHROPIC_API_KEY is set; otherwise the claude.ai page does it)
  if (await serverModel()) {
    await Promise.all(full.slice(0, 12).map(async (it) => {
      try {
        const r = await callClaude(it.ai_prompt);
        if (r) await saveAi(user, it, { model: r.model, via: "server", text: r.text });
      } catch (e) { it.ai_error = String((e as Error).message); }
    }));
  }
  return full;
}

async function getItem(id: string) {
  const rows = await db.select("wizard_items", `id=eq.${encodeURIComponent(id)}&select=payload`);
  if (!rows?.length) throw new HttpError(404, "Review item not found.");
  return rows[0].payload;
}
async function putItem(it: any) {
  await db.update("wizard_items", `id=eq.${encodeURIComponent(it.id)}`, {
    status: it.status, payload: it, decided_by: it.decided_by ?? null, decided_role: it.decided_role ?? null,
    decided_at: it.decided_at ?? null, comment: it.comment ?? null, result_note: it.result_note ?? null,
  });
}
async function saveAi(user: User, it: any, ai: { model: string; via: string; text: string }) {
  const parsed = parseJson(ai.text);
  it.ai = { model: ai.model, via: ai.via, at: new Date().toISOString(), summary: parsed?.summary ?? ai.text.slice(0, 800), flags: parsed?.flags ?? [], rewrite: parsed?.rewrite ?? null };
  it.mode = `AI: Claude (${ai.model}${ai.via === "claude.ai" ? ", in claude.ai" : ""}) + rules`;
  await putItem(it);
  await audit(user, "AI review", it.agent, it.id, { model: ai.model, via: ai.via, scrubbed_input: it.scrubbed_input?.slice(0, 2000), extra_flags: it.ai.flags.length });
  return it;
}

function canDecide(user: User, it: any) {
  if (/director|admin/i.test(user.role)) return true;
  const a = String(it.approver_role || "").toLowerCase(), r = user.role.toLowerCase();
  if (a.includes(r) || r.includes(a)) return true;
  if (/who asked/.test(a) && it.created_by === user.username) return true;
  return false;
}

// ---------------- agents ----------------
function noteItem(note: any, shift: { start: string; end: string; date: string } | null, source: string) {
  const sc = new Scrubber();
  sc.person(note.client, "CLIENT");
  sc.person(note.staff, "STAFF");
  const flags = checkNote(note.message);
  const scrubbed = sc.text(note.message);
  return {
    agent: "note", agent_name: "Penny", approver_role: "Team leader", source,
    title: `Progress note ${note.id || "(pasted)"} · ${note.shift_date || "no shift date"}`,
    client: sc.person(note.client, "CLIENT"), staff: sc.person(note.staff, "STAFF"),
    meta: { note_id: note.id || null, shift_id: note.shift_id || null, shift_date: note.shift_date || null, category: note.category || null, shift_times: shift ? `${shift.start}–${shift.end}` : null },
    flags: flags.map((f) => ({ ...f, reason: sc.text(f.reason), suggestion: sc.text(f.suggestion), evidence: f.evidence ? sc.text(f.evidence) : undefined })),
    result: flags.length ? "flagged" : "pass", scrubbed_input: scrubbed, map: sc.map,
  };
}

const routes: Record<string, (c: Ctx) => Promise<unknown>> = {
  "GET /me": async ({ user }) => ({ user: user.username, name: user.name, role: user.role, mode: await mode(), today: adlDate(), org: ORG, source: srcName() }),

  "GET /status": async () => {
    const sc = await shiftcare();
    const t0 = Date.now();
    const areas: any = sc.kind === "astalty" ? await sc.get("/public/v1/participants", { "page[size]": 1 }) : await sc.get("/areas");
    return { connected: true, source: srcName(), base: sc.base.replace(/^(https:\/\/[^.]+)\.[^/]+/, "$1…"), latency_ms: Date.now() - t0, areas: sc.kind === "astalty" ? Number(areas?.meta?.total || 0) : (areas?.areas || []).length, mode: await mode() };
  },

  "GET /registry": async () => REGISTRY.map((r) => ({ ...r, live: ["rory", "sunny", "lenny", "wizard", "archie", "indy"].includes(r.key) })),

  "GET /samples": async () => ({ prices: PRICES, price_label: PRICE_LABEL }),

  // ---- Penny ----
  "GET /notes": async ({ query }) => F().notesList(await shiftcare(), { limit: Number(query.get("limit")) || 60, from: query.get("from") || undefined, to: query.get("to") || undefined }),
  "POST /notes/check": async ({ user, body }) => {
    let note = body.note, shift = null, source = "pasted";
    if (body.note_id) { const r = await F().noteById(await shiftcare(), String(body.note_id)); note = r.note; shift = r.shift; source = srcName(); }
    if (!note?.message) throw new HttpError(400, "Choose a progress note or paste one.");
    const [it] = await queue(user, [noteItem(note, shift, source)]);
    return it;
  },
  "POST /notes/check-batch": async ({ user, body }) => {
    const sc = await shiftcare();
    const ids: string[] = (body.ids || []).slice(0, 25).map(String);
    const rs = await Promise.all(ids.map((id) => F().noteById(sc, id)));
    const items = await queue(user, rs.map((r) => noteItem(r.note, r.shift, srcName())));
    return { checked: items.length, flagged: items.filter((i) => i.flags.length).length, items, api_calls: sc.calls };
  },

  // ---- Clancy ----
  "GET /invoices": async () => (await F().invoiceFeed(await shiftcare(), [])).invoiceOptions,
  "POST /invoice/check": async ({ user, body }) => {
    let lines, shifts, allLines, src: any;
    const sc = (body.invoices_csv ? null : await shiftcare());
    if (sc) {
      const refs = body.refs === "all" ? "all" : (Array.isArray(body.refs) ? body.refs : String(body.refs || "INV-TEST-01").split(/[\s,]+/)).filter(Boolean);
      const f = await F().invoiceFeed(sc, refs);
      if (!f.lines.length) throw new HttpError(404, `No invoice lines found for ${refs === "all" ? "any invoice" : refs.join(", ")}.`);
      ({ lines, shifts, allLines } = f);
      src = { source: srcName(), invoices: f.invoices, timesheets: f.timesheets, days_fetched: f.days, api_calls: sc.calls };
    } else {
      lines = linesFromCsv(parseCsv(body.invoices_csv)); shifts = shiftsFromCsv(parseCsv(body.shifts_csv || "")); allLines = lines;
      src = { source: "CSV upload" };
    }
    const ex = checkLines(lines, shifts, allLines);
    const items = ex.map((e) => {
      const sc2 = new Scrubber();
      sc2.person(e.client, "CLIENT");
      if (e.staff) for (const n of e.staff.split(", ")) sc2.person(n, "STAFF");
      const explanation = sc2.text(`${e.title}: ${e.detail}`);
      return {
        agent: "invoice", agent_name: "Clancy", approver_role: "Finance", source: src.source,
        title: `${e.invoice} line ${e.line_id} · ${e.title}`, exception: { ...e, client: sc2.text(e.client), staff: e.staff ? sc2.text(e.staff) : undefined, detail: sc2.text(e.detail) },
        explanation, impact: e.impact, price_table: "SAMPLE", scrubbed_input: explanation, map: sc2.map,
      };
    });
    const queued = await queue(user, items);
    return {
      ...src, mode: await mode(), lines: lines.length, shifts: shifts.size, exceptions: ex.length,
      net_impact: round2(ex.reduce((a, e) => a + e.impact, 0)),
      by_code: ex.reduce((a: any, e) => ((a[e.code] = (a[e.code] || 0) + 1), a), {}),
      note: `Read-only. No invoice was created or changed in ${srcName()}.`, queued: queued.length, items: queued,
    };
  },

  // ---- Cleo ----
  "POST /expiry/check": async ({ user, body }) => {
    const today = body.today || adlDate();
    let docs: Doc[], source = srcName(), calls = 0;
    if (body.csv) {
      source = "CSV upload";
      docs = parseCsv(body.csv).map((r) => ({ person_type: /part|client/i.test(r.type) ? "participant" : "staff", person: r.person, email: r.email, phone: r.phone, document: r.document, expiry_date: r.expiry_date }));
    } else { const sc = await shiftcare(); docs = await F().expiryFeed(sc); calls = sc.calls; }
    const { items, not_due } = assess(docs, today);
    const out = items.map((r) => {
      const sc = new Scrubber();
      const tok = sc.person(r.person, r.person_type === "staff" ? "STAFF" : "CLIENT");
      const ft = tok.replace("]", "_FIRST]");
      const d = expiryDraft(r, ft, ORG);
      const to = r.email || r.phone || "";
      return {
        agent: "expiry", agent_name: "Cleo", approver_role: "Compliance officer", source,
        title: `${r.document} · ${tok} · ${r.bucket}`, bucket: r.bucket, days: r.days, person_type: r.person_type, person: tok,
        document: r.document, expiry_date: r.expiry_date, channel: r.channel, to_token: to ? sc.text(to) : "", do_not_roster: r.do_not_roster,
        draft: sc.text(d), scrubbed_input: sc.text(d), map: sc.map, source_id: r.source_id,
      };
    });
    const queued = await queue(user, out);
    return { today, source, api_calls: calls, checked: docs.length, queued: queued.length, not_due: not_due.length, items: queued,
      counts: ["expired", "30 days", "60 days", "90 days"].reduce((a: any, k) => ((a[k] = items.filter((i) => i.bucket === k).length), a), {}) };
  },

  // ---- Hey Wizard ----
  "POST /hey": async ({ user, body }) => {
    const q = String(body.q || "").trim();
    if (!q) throw new HttpError(400, "Ask a question first.");
    const intent = /expir|renew|screening|first aid|cpr|licen|document|qualif/i.test(q) ? "expiries"
      : /invoice|owing|overdue|unpaid|paid|bill|claim/i.test(q) ? "invoices"
      : /incident/i.test(q) ? "incidents"
      : /note/i.test(q) ? "notes"
      : /shift|roster|vacant|unfilled|cover|today|tomorrow/i.test(q) ? "shifts"
      : /queue|pending|waiting|approve/i.test(q) ? "queue" : "help";
    const sc = new Scrubber();
    let answer = "", ctxRows: any[] = [], item = null;
    const today = adlDate();
    if (intent === "queue") {
      const rows = await db.select("wizard_items", "status=eq.pending&select=agent,approver_role");
      const by: Record<string, number> = {};
      for (const r of rows) by[r.approver_role] = (by[r.approver_role] || 0) + 1;
      answer = rows.length ? `${rows.length} item(s) are waiting: ${Object.entries(by).map(([k, v]) => `${v} for the ${k}`).join(", ")}.` : "Nothing is waiting in the review queue.";
      ctxRows = Object.entries(by).map(([role, n]) => ({ role, waiting: n }));
    } else if (intent === "help") {
      answer = `I can answer questions about document expiries, invoices, today's and tomorrow's shifts, incidents, progress notes and the review queue, using live ${srcName()} data.`;
    } else {
      const ctx = await F().heyContext(await shiftcare(), intent, today);
      if (intent === "expiries") {
        const { items } = assess(ctx.rows as Doc[], today);
        const soon = items.filter((i) => i.days <= 31);
        for (const r of items) sc.person(r.person, r.person_type === "staff" ? "STAFF" : "CLIENT");
        answer = soon.length
          ? `${soon.length} check(s) need action within a month: ${soon.map((r) => `${sc.text(r.person)}, ${r.document} (${r.days < 0 ? "expired" : r.days + " days"})`).join("; ")}.`
          : "Nothing expires in the next month.";
        ctxRows = items.map((r) => ({ person: sc.text(r.person), type: r.person_type, document: r.document, expiry: r.expiry_date, days: r.days, do_not_roster: r.do_not_roster }));
        const top = soon.find((r) => r.days >= 0) || soon[0];
        if (top) {
          const tok = sc.person(top.person, top.person_type === "staff" ? "STAFF" : "CLIENT");
          const d = expiryDraft(top, tok.replace("]", "_FIRST]"), ORG);
          answer += `\n\nDraft for ${tok}:\n${d}`;
          item = { agent: "hey", agent_name: "Hey Wizard", approver_role: "Staff member who asked", title: `Hey Wizard draft · ${intent}`, severity: "low", tags: [intent], draft: sc.text(d), question: sc.text(q), scrubbed_input: sc.text(d), map: sc.map };
        }
      } else if (intent === "invoices") {
        const rows = (ctx.rows as any[]);
        rows.forEach((r) => sc.person(r.client, "CLIENT"));
        const over = rows.filter((r) => r.status === "overdue"), draft = rows.filter((r) => r.status === "draft");
        const owing = round2(rows.filter((r) => /unpaid|overdue|partial/.test(r.status)).reduce((a, r) => a + Number(r.balance || 0), 0));
        answer = `${rows.length} invoices. $${owing.toFixed(2)} outstanding. ${over.length} overdue${over.length ? ": " + over.map((r) => `${r.ref} (${sc.text(r.client)}, $${Number(r.balance).toFixed(2)})`).join(", ") : ""}. ${draft.length} draft${draft.length ? ": " + draft.map((r) => r.ref).join(", ") : ""}.`;
        ctxRows = rows.map((r) => ({ ...r, client: sc.text(r.client) }));
      } else if (intent === "shifts") {
        const rows = ctx.rows as any[];
        rows.forEach((r) => { r.clients.forEach((c: string) => sc.person(c, "CLIENT")); r.staff.forEach((s: string) => sc.person(s, "STAFF")); });
        const vac = rows.filter((r) => r.vacant);
        answer = `${rows.length} shift(s) today and tomorrow. ${vac.length} unfilled${vac.length ? ": " + vac.map((r) => `${r.date} ${r.start}–${r.end} for ${sc.text(r.clients.join(" & ") || "no client")}`).join("; ") : ""}.`;
        ctxRows = rows.map((r) => sc.deep(r));
      } else if (intent === "incidents") {
        const rows = ctx.rows as any[];
        rows.forEach((r) => sc.person(r.client, "CLIENT"));
        const open = rows.filter((r) => !/closed|resolved/i.test(r.status || ""));
        answer = `${open.length} open incident(s)${open.length ? ": " + open.map((r) => `#${r.id} ${r.title} (${sc.text(r.client)}, ${r.status})`).join("; ") : ""}.`;
        ctxRows = rows.map((r) => sc.deep(r));
      } else if (intent === "notes") {
        const rows = ctx.rows as any[];
        rows.forEach((r) => { sc.person(r.client, "CLIENT"); sc.person(r.staff, "STAFF"); });
        const flagged = rows.map((r) => ({ r, f: checkNote(r.message) })).filter((x) => x.f.some((f) => f.severity === "high"));
        answer = `Of the latest ${rows.length} notes, ${flagged.length} have a high-severity flag${flagged.length ? ": " + flagged.map((x) => `note ${x.r.id} (${sc.text(x.r.client)}: ${x.f.filter((f) => f.severity === "high").map((f) => f.title).join(", ")})`).join("; ") : ""}. Open Penny to review them.`;
        ctxRows = rows.map((r) => ({ id: r.id, date: r.shift_date, client: sc.text(r.client), staff: sc.text(r.staff), note: sc.text(r.message) }));
      }
    }
    let queued = null;
    if (item) [queued] = await queue(user, [item]);
    const md = await mode();
    const out = { intent, mode: md, answer: sc.text(answer), map: sc.map, item: queued, context: ctxRows.slice(0, 80), ai_prompt: heyPrompt(sc.text(q), ctxRows.slice(0, 80), sc.text(answer)) };
    await audit(user, "Hey Wizard question", "hey", queued?.id ?? null, { scrubbed_input: sc.text(q), intent });
    if (await serverModel()) {
      try {
        const r = await callClaude(out.ai_prompt);
        const p = r && parseJson(r.text);
        if (p?.answer) (out as any).ai = { model: r!.model, answer: p.answer, draft: p.draft ?? null };
      } catch { /* rules answer stands */ }
    }
    return out;
  },
  // A draft Claude wrote in the browser (already tokenised) goes to the queue for approval.
  "POST /hey/draft": async ({ user, body }) => {
    const d = body.draft || {};
    if (!d.text) throw new HttpError(400, "No draft text.");
    const sc = new Scrubber();
    const text = sc.text(String(d.text)); // belt and braces: scrub again
    const [it] = await queue(user, [{
      agent: "hey", agent_name: "Hey Wizard", approver_role: "Staff member who asked", title: `Hey Wizard draft (Claude) · ${d.to || ""}`,
      severity: "low", tags: ["Claude draft", d.channel || "email"], draft: text, question: String(body.question || ""), scrubbed_input: text,
      map: { ...(body.map || {}), ...sc.map }, ai_prompt: "",
    }]);
    return it;
  },

  // ---- Registry agents ----
  "GET /live/:key": async ({ params }) => {
    const sc = await shiftcare();
    const inputs = await F().liveInputs(sc, params[0], adlDate(), nowAdl());
    return { key: params[0], inputs, api_calls: sc.calls, source: srcName() };
  },
  "POST /run/:key": async ({ user, body, params }) => {
    const key = params[0];
    const def = REGISTRY.find((r) => r.key === key);
    if (!def) throw new HttpError(404, `No agent called ${key}.`);
    const pending = key === "wizard" ? (await db.select("wizard_items", "status=eq.pending&select=id")).length : 0;
    const r = runRegistry(key, body.inputs || {}, { today: adlDate(), now: nowAdl(), org: ORG }, { pending });
    const items = r.items.map((i) => ({ ...i, source: body.source || "CSV upload", scrubbed_input: i.draft, map: r.scrubber.map, onApprove: def.onApprove }));
    const queued = await queue(user, items);
    return { summary: r.scrubber.text(r.summary), map: r.scrubber.map, mode: await mode(), queued: queued.length, items: queued };
  },

  // ---- Review queue ----
  "GET /queue": async ({ query }) => {
    const st = query.get("status") || "pending", ag = query.get("agent") || "";
    let q = "select=payload&order=created_at.desc&limit=200";
    if (st !== "all") q += `&status=eq.${encodeURIComponent(st)}`;
    if (ag) q += `&agent=eq.${encodeURIComponent(ag)}`;
    return (await db.select("wizard_items", q)).map((r: any) => r.payload);
  },
  "GET /queue/counts": async () => {
    const rows = await db.select("wizard_items", "status=eq.pending&select=agent");
    const by: Record<string, number> = {};
    for (const r of rows) by[r.agent] = (by[r.agent] || 0) + 1;
    return { pending: rows.length, by_agent: by };
  },
  "POST /queue/:id/decide": async ({ user, body, params }) => {
    const it = await getItem(params[0]);
    if (it.status !== "pending") throw new HttpError(409, `Already ${it.status} by ${it.decided_by_name}.`);
    const decision = String(body.decision);
    if (!["approve", "reject", "dismiss"].includes(decision)) throw new HttpError(400, "Decision must be approve, reject or dismiss.");
    if (!canDecide(user, it)) throw new HttpError(403, `This needs the ${it.approver_role}. You're signed in as ${user.role}.`);
    it.status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "dismissed";
    Object.assign(it, { decided_by: user.username, decided_by_name: user.name, decided_role: user.role, decided_at: new Date().toISOString(), comment: String(body.comment || "") });
    if (body.edited) it.edited = String(body.edited);
    if (decision === "approve") {
      if (it.agent === "note" && it.flags?.length) {
        const task = { id: "CU-" + token().slice(0, 8).toUpperCase(), item_id: it.id, name: `Fix progress note ${it.meta?.note_id ?? ""}: ${it.flags.map((f: any) => f.title).join(", ")}`.slice(0, 200), description: it.flags.map((f: any) => `${f.severity.toUpperCase()}: ${f.title}. ${f.suggestion}`).join("\n"), assignee_role: "Support worker", created_by: user.username };
        await db.insert("wizard_clickup", [task]);
        it.clickup_task = task.id;
        it.result_note = "Sample ClickUp task created for the worker. Nothing was changed in ShiftCare.";
      } else if (it.agent === "expiry") { it.sent = true; it.sent_note = it.result_note = `Reminder marked as sent by ${it.channel} (nothing was actually sent).`; }
      else if (it.agent === "invoice") it.result_note = "Exception accepted. Fix the invoice in ShiftCare; nothing was changed automatically.";
      else if (it.agent === "hey") it.result_note = "Draft approved and marked as sent (nothing was actually sent).";
      else {
        const def = REGISTRY.find((r) => r.key === it.agent);
        it.result_note = def?.onApprove || "Approved.";
        if (/ClickUp task/i.test(it.result_note)) {
          const task = { id: "CU-" + token().slice(0, 8).toUpperCase(), item_id: it.id, name: it.title.slice(0, 200), description: String(it.edited || it.draft || "").slice(0, 2000), assignee_role: it.approver_role, created_by: user.username };
          await db.insert("wizard_clickup", [task]);
          it.clickup_task = task.id;
        }
      }
    }
    await putItem(it);
    await audit(user, `${decision}`, it.agent, it.id, { approval: { decision, by: user.name, role: user.role, comment: it.comment }, result: it.result_note, clickup_task: it.clickup_task, scrubbed_input: it.scrubbed_input?.slice(0, 1500) });
    return it;
  },
  "POST /queue/:id/ai": async ({ user, body, params }) => {
    const it = await getItem(params[0]);
    if (!body.text) throw new HttpError(400, "No AI text.");
    return saveAi(user, it, { model: String(body.model || "claude"), via: "claude.ai", text: String(body.text) });
  },
  "POST /queue/:id/ai/server": async ({ user, params }) => {
    const it = await getItem(params[0]);
    const r = await callClaude(it.ai_prompt);
    if (!r) throw new HttpError(503, "No ANTHROPIC_API_KEY on the server. Open the Wizard in claude.ai to use Claude there.");
    return saveAi(user, it, { model: r.model, via: "server", text: r.text });
  },

  "GET /audit": async () => {
    const rows = await db.select("wizard_audit", "select=*&order=t.desc&limit=200");
    const users = await db.select("wizard_users", "select=username,name");
    const nm = Object.fromEntries(users.map((u: any) => [u.username, u.name]));
    return rows.map((r: any) => ({ ...r, name: nm[r.who] || r.who }));
  },
  "GET /clickup": async () => db.select("wizard_clickup", "select=*&order=created_at.desc&limit=200"),
};

// ---------------- auth + dispatch ----------------
async function userFromSession(tok: string | null): Promise<User | null> {
  if (!tok) return null;
  const rows = await db.select("wizard_sessions", `token=eq.${encodeURIComponent(tok)}&expires_at=gt.${new Date().toISOString()}&select=username,wizard_users(name,role)`);
  if (!rows?.length) return null;
  return { username: rows[0].username, name: rows[0].wizard_users.name, role: rows[0].wizard_users.role };
}

async function dispatch(method: string, path: string, body: any, session: string | null, query: URLSearchParams) {
  if (method === "POST" && path === "/login") {
    const rows = await db.rpc("wizard_check_login", { p_user: String(body.username || ""), p_pass: String(body.password || "") });
    if (!rows?.length) return json({ error: "That email and password don't match. Check them and try again." }, 401);
    const tok = token();
    await db.insert("wizard_sessions", [{ token: tok, username: rows[0].username }]);
    const user = rows[0] as User;
    await audit(user, "signed in", null, null, {});
    return json({ token: tok, user: user.username, name: user.name, role: user.role });
  }
  const user = await userFromSession(session);
  if (!user) return json({ error: "Sign in first." }, 401);
  if (method === "POST" && path === "/logout") { await db.del("wizard_sessions", `token=eq.${encodeURIComponent(session!)}`); return json({ ok: true }); }
  for (const [k, fn] of Object.entries(routes)) {
    const [m, pattern] = k.split(" ");
    if (m !== method) continue;
    const re = new RegExp("^" + pattern.replace(/:[a-z]+/g, "([^/]+)") + "$");
    const mt = re.exec(path);
    if (!mt) continue;
    const picked = String(query.get("source") || body?.source_system || (await setting("WIZARD_SOURCE")) || "").toLowerCase();
    const state: ReqState = { resume: !!(body?.__resume || query.get("resume")), source: picked === "astalty" ? "astalty" : "shiftcare" };
    try {
      return await als.run(state, async () => json(await fn({ user, body: body || {}, query, params: mt.slice(1).map(decodeURIComponent) })));
    } catch (e) {
      if (e instanceof BudgetError) return json({ resume: true, retry_after_ms: e.retryAfterMs, fetched: state.sc?.fresh.length ?? 0, message: e.message }, 202);
      const st = e instanceof HttpError ? e.status : e instanceof SCError ? 502 : 500;
      console.error(path, e);
      return json({ error: (e as Error).message }, st);
    } finally {
      await flushCache(state);
    }
  }
  return json({ error: `No route ${method} ${path}` }, 404);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  let path = url.pathname.replace(/^.*?\/ndis-wizard/, "").replace(/^\/api\/agents/, "") || "/";
  let method = req.method, body: any = null, session = req.headers.get("x-wizard-session");
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  let query = url.searchParams;
  // Bridge: one POST carrying {method, path, body, session}. Used by the claude.ai page, which
  // reaches this function through the database (pg_net) because artifacts can't fetch other hosts.
  if (path === "/bridge") {
    const secret = await setting("WIZARD_BRIDGE_SECRET");
    if (!secret || req.headers.get("x-wizard-bridge") !== secret) return json({ error: "Bridge not allowed." }, 403);
    const u = new URL("http://x" + String(body.path || "/"));
    method = String(body.method || "GET").toUpperCase(); path = u.pathname; query = u.searchParams;
    session = body.session || null; body = body.body || {};
  }
  return dispatch(method, path, body, session, query);
});
