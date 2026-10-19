// Astalty clone · shared helpers (Deno / Supabase edge runtime)
import { createClient } from "npm:@supabase/supabase-js@2";

export const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
export const TZ = "Australia/Adelaide";
export const FN_SLUG = "astalty-api";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, accept, x-requested-with",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public errors?: Record<string, string[]>) { super(message); }
}
export const notFound = (what = "Record") => new ApiError(404, `No query results for model [${what}].`);
export function invalid(errors: Record<string, string[]>) { return new ApiError(422, "The given data was invalid.", errors); }

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...headers } });
}
export function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
}

/** Throw a 500 (or mapped 4xx) when a PostgREST call fails. */
export function must<T>(r: { data: T; error: any }): T {
  if (r.error) {
    const code = r.error.code, msg = r.error.message || String(r.error);
    if (code === "23505") throw invalid({ id: ["The value has already been taken."] });
    if (code === "23503") throw invalid({ id: ["The selected value references a record that does not exist."] });
    if (["23514", "22P02", "22007", "22008", "23502"].includes(code)) throw invalid({ value: [msg] });
    throw new ApiError(500, msg);
  }
  return r.data;
}

// ---------------------------------------------------------------- auth
export type Key = { key_id: string; label: string; permission: "full" | "read" };
export async function authenticate(req: Request): Promise<Key> {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new ApiError(401, "Unauthenticated.");
  const r = await db.rpc("ast_verify_token", { p_token: m[1].trim() });
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  if (r.error || !row) throw new ApiError(401, "Unauthenticated.");
  return row as Key;
}

// ---------------------------------------------------------------- request context
export type Ctx = {
  req: Request; method: string; path: string; url: URL; query: URLSearchParams;
  params: Record<string, string>; body: any; key: Key | null; base: string;
};

export function q(c: Ctx, name: string): string | null { const v = c.query.get(name); return v === null || v === "" ? null : v; }
export function filter(c: Ctx, name: string) { return q(c, `filter[${name}]`); }
export function csv(v: string | null): string[] | null { if (!v) return null; const a = v.split(",").map((s) => s.trim()).filter(Boolean); return a.length ? a : null; }

// ---------------------------------------------------------------- pagination (Laravel style)
export type Page = { number: number; size: number; from: number; to: number };
export function paging(c: Ctx, defaultSize = 15): Page {
  const size = Math.max(1, Math.min(Number(q(c, "page[size]") || defaultSize) || defaultSize, 100));
  const number = Math.max(1, Number(q(c, "page[number]") || q(c, "page") || 1) || 1);
  return { number, size, from: (number - 1) * size, to: number * size - 1 };
}
export function listOf(data: unknown[], total: number, p: Page, allowedSorts: string[] = []) {
  return { data, meta: { current_page: p.number, last_page: Math.max(1, Math.ceil(total / p.size)), per_page: p.size, total, allowed_sorts: allowedSorts } };
}
/** Parse `sort=-start_time` against an allow-list; returns [column, ascending]. */
export function sortOf(c: Ctx, allowed: Record<string, string>, def: string): [string, boolean] {
  const raw = q(c, "sort") || def;
  const desc = raw.startsWith("-");
  const name = desc ? raw.slice(1) : raw;
  if (!allowed[name]) throw invalid({ sort: [`The selected sort is invalid. Allowed: ${Object.keys(allowed).join(", ")}.`] });
  return [allowed[name], !desc];
}
export async function run<T = any>(query: any, p: Page): Promise<{ rows: T[]; total: number }> {
  const r = await query.range(p.from, p.to);
  return { rows: must(r) as T[], total: r.count ?? 0 };
}
export async function one<T = any>(table: string, id: string, select = "*", what?: string): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(what);
  const r = must(await db.from(table).select(select).eq("id", id).maybeSingle());
  if (!r) throw notFound(what);
  return r as T;
}

// ---------------------------------------------------------------- dates
const fmts = new Map<string, Intl.DateTimeFormat>();
export function iso(v: string | Date | null | undefined, tz = TZ): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" });
    fmts.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  let off = (p.timeZoneName || "GMT").replace("GMT", "");
  if (!off) off = "+00:00";
  if (/^[+-]\d{2}$/.test(off)) off += ":00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
export function dateOnly(v: string | null | undefined): string | null { return v ? String(v).slice(0, 10) : null; }
export function todayIn(tz = TZ): string { return iso(new Date(), tz)!.slice(0, 10); }
export function parseWhen(v: unknown, field: string): string {
  const d = new Date(String(v));
  if (!v || isNaN(d.getTime())) throw invalid({ [field]: [`The ${field} is not a valid date.`] });
  return d.toISOString();
}

// ---------------------------------------------------------------- validation
export function need(body: any, fields: string[]) {
  const errors: Record<string, string[]> = {};
  for (const f of fields) if (body?.[f] === undefined || body?.[f] === null || body?.[f] === "") errors[f] = [`The ${f.replace(/_/g, " ")} field is required.`];
  if (Object.keys(errors).length) throw invalid(errors);
}
export function oneOf(body: any, field: string, values: string[], optional = true) {
  const v = body?.[field];
  if ((v === undefined || v === null) && optional) return;
  if (!values.includes(v)) throw invalid({ [field]: [`The selected ${field.replace(/_/g, " ")} is invalid.`] });
}
export function pick(body: any, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (body?.[k] !== undefined) out[k] = body[k] === "" ? null : body[k];
  return out;
}

// ---------------------------------------------------------------- change log attribution + webhooks
export async function attribute(c: Ctx, rowIds: string[]) {
  if (!c.key || !rowIds.length) return;
  await db.from("ast_change_log").update({ actor: c.key.label, via: "api" }).in("row_id", rowIds).is("actor", null);
}

async function hmacHex(secret: string, text: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Record a webhook event for every enabled subscription and try to deliver it (best effort). */
export async function emit(type: string, data: unknown) {
  const hooks = must(await db.from("ast_webhooks").select("*").eq("is_enabled", true).is("archived_at", null)) as any[];
  const targets = hooks.filter((h) => (h.event_types || []).includes(type));
  const rows = targets.length ? targets.map((h) => ({ event_type: type, payload: data, webhook_id: h.id })) : [{ event_type: type, payload: data, webhook_id: null, delivery_status: "no_subscriber" }];
  const inserted = must(await db.from("ast_webhook_events").insert(rows).select()) as any[];
  const work = (async () => {
    for (const ev of inserted) {
      const h = targets.find((x) => x.id === ev.webhook_id);
      if (!h) continue;
      const body = JSON.stringify({ id: ev.id, type, created_at: ev.created_at, data });
      let code = 0;
      try {
        const res = await fetch(h.url, { method: "POST", headers: { "Content-Type": "application/json", "Signature": await hmacHex(h.signing_secret, body), "X-Event-Type": type }, body, signal: AbortSignal.timeout(5000) });
        code = res.status;
      } catch { code = 0; }
      await db.from("ast_webhook_events").update({ delivery_status: code >= 200 && code < 300 ? "delivered" : "failed", response_code: code || null }).eq("id", ev.id);
    }
  })();
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else await work;
}

export const name = (r: any) => r ? [r.first_name, r.last_name].filter(Boolean).join(" ") : null;
export const initials = (r: any) => [r.first_name, r.last_name].filter(Boolean).map((s: string) => s[0]).join("").toUpperCase();
export const cents = (n: unknown) => Math.round(Number(n ?? 0));
