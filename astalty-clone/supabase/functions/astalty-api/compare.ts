// Astalty clone · live comparison: replay the same requests against a real Astalty account and this
// replica, then report structural differences only (paths and value kinds, never values).
import { ApiError, Ctx } from "./lib.ts";
import { matchSpec, serialize, validate } from "./serialize.ts";

type Side = "real" | "clone";
type Got = { status: number; body: any; error?: string };
type Route = { method: string; re: RegExp; keys: string[]; fn: (c: Ctx) => Promise<any>; pattern: string };
const V = "/public/v1";

// The same coverage as /_replica/conformance, with placeholders filled from each side's own data.
const TEMPLATES = [
  `${V}/app/status`, `${V}/participants?page[size]=5`, `${V}/participants/{participant}`, `${V}/participants/{participant}/addresses`, `${V}/participants/{participant}/contacts`, `${V}/participants/{participant}/documents`,
  `${V}/participants/{participant}/goals`, `${V}/participants/{participant}/information-items`, `${V}/participants/{participant}/ndis-plans`, `${V}/participants/{participant}/notes?page[size]=5`, `${V}/participants/{participant}/current-services`,
  `${V}/participants/{participant}/budgets`, `${V}/participants/{participant}/risks`, `${V}/participants/{participant}/public-holiday-groups`, `${V}/risks/{risk}`, `${V}/goals/{goal}`, `${V}/goals/{goal}/supports?page[size]=3`, `${V}/goals/{goal}/tasks?page[size]=3`,
  `${V}/ndis-plans/{plan}`, `${V}/ndis-plans/{plan}/budgets`, `${V}/ndis-plans/{plan}/implementations`, `${V}/services?page[size]=5`, `${V}/services/{service}`, `${V}/budgets/{budget}`, `${V}/budgets/{budget}/items`, `${V}/budgets/{budget}/periods`,
  `${V}/charge-items`, `${V}/charge-item-sets`, `${V}/supports?page[size]=5`, `${V}/supports/{support}`, `${V}/shifts?page[size]=5`, `${V}/shifts/{shift}`, `${V}/group-supports`,
  `${V}/tasks?page[size]=5`, `${V}/tasks/{task}`, `${V}/tasks/{task}/charges`, `${V}/tasks/{task}/documents`, `${V}/invoices?page[size]=5`, `${V}/invoices/{invoice}`, `${V}/invoice-batches`, `${V}/invoice-batches/{batch}/invoices?page[size]=3`,
  `${V}/incidents`, `${V}/incidents/{incident}`, `${V}/feedback`, `${V}/feedback/{feedback}`, `${V}/referrals`, `${V}/referrals/{referral}`, `${V}/users`, `${V}/users/{user}`, `${V}/users/{user}/documents`, `${V}/users/{user}/notes`, `${V}/users/{user}/tasks?page[size]=3`,
  `${V}/user-record-types`, `${V}/user-records?page[size]=10`, `${V}/participant-record-types`, `${V}/participant-records?page[size]=10`, `${V}/participant-information-items`, `${V}/participant-tags`,
  `${V}/contacts`, `${V}/contacts/{contact}`, `${V}/contacts/{contact}/participants`, `${V}/organisations`, `${V}/organisations/{organisation}`, `${V}/organisations/{organisation}/contacts`, `${V}/plan-managers`, `${V}/plan-managers/{planManager}`,
  `${V}/sites`, `${V}/sites/{site}`, `${V}/sites/{site}/participants`, `${V}/documents/{document}/download`, `${V}/document-categories`, `${V}/forms`, `${V}/form-submissions`, `${V}/signature-requests`, `${V}/signature-requests/{signatureRequest}`,
  `${V}/public-holidays`, `${V}/public-holiday-groups`, `${V}/exports`, `${V}/webhook-event-types`, `${V}/webhooks`, `${V}/webhooks/{webhook}`, `${V}/note-templates`,
];

// Where each placeholder's id comes from: a list to read and, for nested lists, the placeholder it depends on.
const DISCOVER: [string, string, string?][] = [
  ["participant", `${V}/participants?filter[status]=active&page[size]=1`], ["goal", `${V}/participants/{participant}/goals?page[size]=1`, "participant"],
  ["plan", `${V}/participants/{participant}/ndis-plans?page[size]=1`, "participant"], ["budget", `${V}/participants/{participant}/budgets?page[size]=1`, "participant"],
  ["risk", `${V}/participants/{participant}/risks?page[size]=1`, "participant"], ["document", `${V}/participants/{participant}/documents?page[size]=1`, "participant"],
  ["support", `${V}/supports?page[size]=1`], ["shift", `${V}/shifts?page[size]=1`], ["invoice", `${V}/invoices?page[size]=1`], ["task", `${V}/tasks?page[size]=1`], ["service", `${V}/services?page[size]=1`],
  ["user", `${V}/users?page[size]=1`], ["incident", `${V}/incidents?page[size]=1`], ["feedback", `${V}/feedback?page[size]=1`], ["referral", `${V}/referrals?page[size]=1`], ["signatureRequest", `${V}/signature-requests?page[size]=1`],
  ["batch", `${V}/invoice-batches?page[size]=1`], ["site", `${V}/sites?page[size]=1`], ["contact", `${V}/contacts?page[size]=1`], ["organisation", `${V}/organisations?page[size]=1`], ["planManager", `${V}/plan-managers?page[size]=1`], ["webhook", `${V}/webhooks?page[size]=1`],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function kindOf(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") {
    if (UUID.test(v)) return "uuid";
    if (UTC.test(v)) return v.endsWith("T00:00:00+00:00") ? "datetime-utc-midnight" : "datetime-utc";
    if (OFFSET.test(v)) return "datetime-offset";
    if (DATE.test(v)) return "date";
    if (v === "") return "empty-string";
    return "string";
  }
  return typeof v;
}
/** Every JSON path in a value with the set of kinds seen there (array elements are merged under `[]`). */
function shape(v: unknown, path = "$", out = new Map<string, Set<string>>()) {
  if (!out.has(path)) out.set(path, new Set());
  out.get(path)!.add(kindOf(v));
  if (Array.isArray(v)) { for (const x of v) shape(x, `${path}[]`, out); }
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) shape(x, `${path}.${k}`, out);
  return out;
}
/** Paths whose parent array was empty on one side cannot be compared; collect them so they are reported as unverified rather than missing. */
function emptyArrays(s: Map<string, Set<string>>) {
  const out: string[] = [];
  for (const [p, kinds] of s) if (kinds.has("array") && !s.has(`${p}[]`)) out.push(`${p}[]`);
  return out;
}
const under = (path: string, roots: string[]) => roots.some((r) => path.startsWith(r));
// The validator quotes offending values; keep only the kind of problem.
const sanitize = (m: string) => m.replace(/expected integer, got .*$/, "expected integer").replace(/^(.*?): .* not in enum (.*)$/, "$1: value not in enum $2").replace(/timestamp \S+ is not UTC/, "timestamp is not UTC");

export async function compare(c: Ctx, routes: Route[]) {
  const realBase = (c.req.headers.get("x-real-base") || "https://api.app.astalty.com.au").replace(/\/$/, "");
  const token = c.req.headers.get("x-real-token");
  if (!token) throw new ApiError(422, "The x-real-token header is required.");
  const offset = Math.max(0, Number(c.query.get("offset") || 0) || 0);
  const limit = Math.max(1, Math.min(Number(c.query.get("limit") || 100) || 100, 100));
  const onlyRe = c.query.get("only") ? new RegExp(c.query.get("only")!) : null;
  const pace = Math.max(0, Number(c.query.get("pace_ms") || 250) || 250);

  const realCalls = { count: 0, retried: 0 };
  async function real(path: string): Promise<Got> {
    for (let attempt = 0; attempt < 3; attempt++) {
      realCalls.count++;
      if (pace) await sleep(pace);
      let res: Response;
      try { res = await fetch(realBase + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(25000) }); }
      catch (e) { return { status: 0, body: null, error: String((e as Error).message) }; }
      if (res.status === 429 && attempt < 2) { realCalls.retried++; const wait = Math.min(Number(res.headers.get("retry-after") || 10), 30); await res.text(); await sleep(wait * 1000); continue; }
      const text = await res.text();
      let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = { _raw_type: res.headers.get("content-type") }; }
      return { status: res.status, body };
    }
    return { status: 429, body: null, error: "rate limited" };
  }
  async function clone(path: string): Promise<Got> {
    const u = new URL("https://x" + path);
    const hit = matchSpec("GET", u.pathname);
    if (!hit || "allowed" in hit) return { status: 404, body: null, error: "no spec operation" };
    const h = routes.find((r) => r.method === "GET" && u.pathname.match(r.re));
    if (!h) return { status: 501, body: null, error: "not implemented in replica" };
    const m = u.pathname.match(h.re)!;
    const params: Record<string, string> = {}; h.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    try {
      const out = await h.fn({ ...c, path: u.pathname, url: u, query: u.searchParams, params, body: {} });
      if (out instanceof Response) return { status: out.status, body: { _raw_type: out.headers.get("content-type") } };
      return { status: 200, body: serialize(hit.op.okSchema, out) };
    } catch (e) { return { status: (e as ApiError).status ?? 500, body: { message: (e as Error).message } }; }
  }
  const get = (side: Side, path: string) => side === "real" ? real(path) : clone(path);

  // Discover one id per placeholder on each side.
  async function discover(side: Side) {
    const ids: Record<string, string> = {}; const notes: Record<string, string> = {};
    for (const [name, tpl, dep] of DISCOVER) {
      if (dep && !ids[dep]) { notes[name] = `no ${dep}`; continue; }
      const path = tpl.replace(/\{(\w+)\}/g, (_, k) => ids[k]);
      let g = await get(side, path);
      if (name === "participant" && (g.status !== 200 || !g.body?.data?.length)) g = await get(side, `${V}/participants?page[size]=1`);
      const first = g.body?.data?.[0];
      if (g.status === 200 && first?.id) ids[name] = String(first.id);
      else notes[name] = g.status === 200 ? "empty list" : `HTTP ${g.status}${g.body?.message ? ` ${g.body.message}` : ""}`;
    }
    return { ids, notes };
  }
  const [R, C] = await Promise.all([discover("real"), discover("clone")]);

  const selected = TEMPLATES.filter((t) => !onlyRe || onlyRe.test(t)).slice(offset, offset + limit);
  const results: any[] = [];
  for (const tpl of selected) {
    const need = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const missingReal = need.filter((k) => !R.ids[k]), missingClone = need.filter((k) => !C.ids[k]);
    if (missingReal.length || missingClone.length) { results.push({ template: tpl, skipped: `real account has no ${missingReal.join(", ") || "-"}; replica has no ${missingClone.join(", ") || "-"}` }); continue; }
    const rp = tpl.replace(/\{(\w+)\}/g, (_, k) => R.ids[k]), cp = tpl.replace(/\{(\w+)\}/g, (_, k) => C.ids[k]);
    const [r, k] = await Promise.all([real(rp), clone(cp)]);
    const row: any = { template: tpl, real_status: r.status, clone_status: k.status };
    if (r.error) row.real_error = r.error;
    if (r.status !== 200 || k.status !== 200) { if (r.status !== 200) row.real_message = r.body?.message ?? null; if (k.status !== 200) row.clone_message = k.body?.message ?? k.error ?? null; results.push(row); continue; }
    const hit = matchSpec("GET", new URL("https://x" + rp).pathname) as any;
    row.real_vs_spec = validate(hit.op.okSchema, r.body).map(sanitize).filter((m, i, a) => a.indexOf(m) === i).slice(0, 20);
    const rs = shape(r.body), cs = shape(k.body);
    const emptyR = emptyArrays(rs), emptyC = emptyArrays(cs);
    const missing_in_clone: string[] = [], extra_in_clone: string[] = [], kind_differs: string[] = [], unverified: string[] = [];
    for (const p of new Set([...rs.keys(), ...cs.keys()])) {
      const a = rs.get(p), b = cs.get(p);
      if (a && !b) { (under(p, emptyC) ? unverified : missing_in_clone).push(p); continue; }
      if (!a && b) { (under(p, emptyR) ? unverified : extra_in_clone).push(p); continue; }
      const an = [...a!].filter((x) => x !== "null").sort(), bn = [...b!].filter((x) => x !== "null").sort();
      if (!an.length || !bn.length) continue; // one side only ever null here: nothing to compare
      if (an.join("|") !== bn.join("|")) kind_differs.push(`${p}: real ${an.join("|")} vs clone ${bn.join("|")}`);
    }
    const rSorts = r.body?.meta?.allowed_sorts, cSorts = k.body?.meta?.allowed_sorts;
    if (Array.isArray(rSorts) && Array.isArray(cSorts) && JSON.stringify([...rSorts].sort()) !== JSON.stringify([...cSorts].sort())) row.allowed_sorts = { real: rSorts, clone: cSorts };
    Object.assign(row, { missing_in_clone, extra_in_clone, kind_differs, unverified_in_this_sample: unverified.length });
    row.same = !missing_in_clone.length && !extra_in_clone.length && !kind_differs.length && !row.allowed_sorts;
    results.push(row);
  }
  return {
    real_base: realBase, real_calls: realCalls.count, rate_limit_retries: realCalls.retried,
    discovery: { real_missing: R.notes, clone_missing: C.notes },
    checked: results.length, same: results.filter((r) => r.same).length, differing: results.filter((r) => r.same === false), skipped: results.filter((r) => r.skipped),
    offset, limit, total_templates: TEMPLATES.filter((t) => !onlyRe || onlyRe.test(t)).length,
  };
}
