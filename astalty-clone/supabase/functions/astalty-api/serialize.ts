// Astalty clone · spec-driven output. Every response is filtered through the schema that
// Astalty publishes for that endpoint (astalty_api_spec.spec), so the replica can only return
// the properties the real API returns, in the same formats. Anything a handler adds that the
// schema does not declare is dropped; anything the schema requires that is missing becomes null.
import { ApiError, db, must, TZ } from "./lib.ts";

type Schema = any;
export type Op = {
  method: string; path: string; re: RegExp; keys: string[]; op: Schema; ok: number; okSchema: Schema | null;
  filters: string[]; sorts: boolean; params: Schema[];
};

let SPEC: Schema | null = null;
const OPS: Op[] = [];

export async function loadSpec(): Promise<Schema> {
  if (SPEC) return SPEC;
  const r = must(await db.from("astalty_api_spec").select("spec").eq("id", 1).maybeSingle()) as any;
  SPEC = r?.spec ?? { openapi: "3.1.0", paths: {}, components: { schemas: {} } };
  for (const [path, item] of Object.entries<any>(SPEC.paths || {})) {
    for (const [m, op] of Object.entries<any>(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(m)) continue;
      const keys: string[] = [];
      const re = new RegExp("^" + path.replace(/\{(\w+)\}/g, (_: string, k: string) => (keys.push(k), "([^/]+)")) + "/?$");
      const okKey = Object.keys(op.responses || {}).find((c) => c.startsWith("2")) || "200";
      const params = [...(item.parameters || []), ...(op.parameters || [])].map(deref);
      const filters = params.map((p: any) => /^filter\[(.+)\]$/.exec(p.name || "")?.[1]).filter(Boolean) as string[];
      OPS.push({
        method: m.toUpperCase(), path, re, keys, op, ok: Number(okKey), okSchema: op.responses?.[okKey]?.content?.["application/json"]?.schema ?? null,
        filters, sorts: params.some((p: any) => p.name === "sort"), params,
      });
    }
  }
  OPS.sort((a, b) => (a.keys.length - b.keys.length) || (b.path.length - a.path.length));
  return SPEC;
}

export function deref(s: Schema): Schema {
  let cur = s, guard = 0;
  while (cur && cur.$ref && guard++ < 20) {
    const parts = String(cur.$ref).replace(/^#\//, "").split("/");
    let node: any = SPEC;
    for (const p of parts) node = node?.[p];
    cur = node ?? {};
  }
  return cur ?? {};
}

/** Find the spec operation for a request: returns the op, or the allowed methods when only the path matched. */
export function matchSpec(method: string, path: string): { op: Op; pp: Record<string, string> } | { allowed: string[] } | null {
  const allowed: string[] = [];
  let hit: { op: Op; pp: Record<string, string> } | null = null;
  for (const o of OPS) {
    const m = path.match(o.re);
    if (!m) continue;
    allowed.push(o.method);
    if (o.method === method && !hit) {
      const pp: Record<string, string> = {};
      o.keys.forEach((k, i) => (pp[k] = decodeURIComponent(m[i + 1])));
      hit = { op: o, pp };
    }
  }
  if (hit) return hit;
  return allowed.length ? { allowed: [...new Set(allowed)] } : null;
}

// ---------------------------------------------------------------- dates: the real API returns UTC with +00:00
const pad = (n: number) => String(n).padStart(2, "0");
export function utcIso(d: Date) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`;
}
const DATE_ONLY_KEYS = new Set(["dob"]);
// Resources whose dates the live API returns as plain YYYY-MM-DD.
const DATE_ONLY_IN = new Set(["PublicHolidayResource.date", "PlanServicePlanResource.start", "PlanServicePlanResource.end"]);
// Keys that mark the end of a range: the live API stores them as 23:59:59 local time.
const END_KEYS = new Set(["end", "end_date"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
function offsetMinutes(ms: number, tz: string) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(part);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}
/** A calendar date as the live API stores it: midnight (or 23:59:59) in the account's timezone, expressed in UTC. */
export function localDateUtc(date: string, endOfDay = false, tz = TZ) {
  const base = Date.parse(`${date}T${endOfDay ? "23:59:59" : "00:00:00"}Z`);
  let ms = base - offsetMinutes(base, tz) * 60000;
  const again = offsetMinutes(ms, tz); if (again !== offsetMinutes(base, tz)) ms = base - again * 60000;
  return utcIso(new Date(ms));
}
function formatTemporal(key: string, v: unknown, schemaName: string | null) {
  if (typeof v !== "string") return v;
  if (DATE_ONLY_KEYS.has(key) || DATE_ONLY_IN.has(`${schemaName}.${key}`)) return v.slice(0, 10);
  if (DATE_RE.test(v)) return localDateUtc(v, END_KEYS.has(key));
  if (TS_RE.test(v)) { const d = new Date(v); if (!isNaN(d.getTime())) return utcIso(d); }
  return v;
}
// Properties the live API returns although the published document does not list them.
const OVERLAY: Record<string, string[]> = { ParticipantNoteResource: ["updated_at"] };

// ---------------------------------------------------------------- schema-driven serialisation
function refName(s: Schema): string | null { const r = s?.$ref; return r ? String(r).split("/").pop()! : null; }

/** Flatten allOf/anyOf/$ref into one object schema description for a given value. */
function resolve(s: Schema, value: unknown): { props: Record<string, Schema>; required: Set<string>; type?: string; items?: Schema; enum?: unknown[]; name: string | null; isObject: boolean } {
  const out = { props: {} as Record<string, Schema>, required: new Set<string>(), type: undefined as string | undefined, items: undefined as Schema, enum: undefined as unknown[] | undefined, name: refName(s), isObject: false };
  const visit = (x: Schema) => {
    if (!x) return;
    const nm = refName(x);
    if (nm && !out.name) out.name = nm;
    x = deref(x);
    if (x.allOf) for (const part of x.allOf) visit(part);
    if (x.anyOf || x.oneOf) {
      const opts = (x.anyOf || x.oneOf) as Schema[];
      const nonNull = opts.filter((o) => deref(o).type !== "null");
      if (value === null || value === undefined) { if (!nonNull.length) return; }
      // pick the first option that describes an object/array for objects, else the first
      const pick = nonNull.find((o) => { const d = deref(o); return d.type === "object" || d.properties || d.allOf || d.type === "array"; }) || nonNull[0];
      if (pick) visit(pick);
      return;
    }
    if (x.properties) { out.isObject = true; for (const [k, v] of Object.entries<any>(x.properties)) out.props[k] = v; }
    if (x.required) for (const k of x.required) out.required.add(k);
    if (x.type === "object") out.isObject = true;
    const t = Array.isArray(x.type) ? x.type.find((q: string) => q !== "null") : x.type;
    if (t && !out.type) out.type = t;
    if (x.items && !out.items) out.items = x.items;
    if (x.enum && !out.enum) out.enum = x.enum;
  };
  visit(s);
  return out;
}

export function serialize(schema: Schema | null, value: unknown, key = "", parentName: string | null = null): unknown {
  if (!schema) return value;
  const r = resolve(schema, value);
  if (value === null || value === undefined) {
    if (r.isObject && Object.keys(r.props).length && !r.name?.endsWith("Request") && value === undefined) return undefined;
    return null;
  }
  if (r.type === "array" || (Array.isArray(value) && r.items)) {
    const arr = Array.isArray(value) ? value : [];
    return arr.map((x) => serialize(r.items ?? {}, x, key, r.name));
  }
  if (r.isObject && Object.keys(r.props).length) {
    const src = (typeof value === "object" && value) ? value as Record<string, unknown> : {};
    const out: Record<string, unknown> = {};
    for (const [k, ps] of Object.entries(r.props)) {
      const has = k in src;
      const v = has ? src[k] : undefined;
      if (!has && !r.required.has(k)) continue;
      const s = serialize(ps, v, k, r.name);
      out[k] = s === undefined ? null : s;
    }
    for (const k of OVERLAY[r.name ?? ""] ?? []) if (k in src && !(k in out)) out[k] = formatTemporal(k, src[k] ?? null, r.name);
    return out;
  }
  if (r.isObject && typeof value === "object") return value; // free-form object (additionalProperties)
  // primitives
  if (r.type === "integer") { const n = Number(value); return Number.isFinite(n) ? Math.round(n) : null; }
  if (r.type === "number") { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (r.type === "boolean") return !!value;
  if (r.type === "string") {
    if (value instanceof Date) return utcIso(value);
    return formatTemporal(key, String(value), parentName);
  }
  if (typeof value === "string") return formatTemporal(key, value, parentName);
  return value;
}

// ---------------------------------------------------------------- request validation from the spec (Laravel wording)
const words = (f: string) => f.replace(/[._\[\]]+/g, " ").trim();
export function laravel422(errors: Record<string, string[]>) {
  const all = Object.values(errors).flat();
  const message = all.length > 1 ? `${all[0]} (and ${all.length - 1} more error${all.length > 2 ? "s" : ""})` : all[0] || "The given data was invalid.";
  return new ApiError(422, message, errors);
}
export function validateBody(op: Op, body: any) {
  const schema = deref(op.op.requestBody?.content?.["application/json"]?.schema ?? null);
  if (!schema) return;
  const r = resolve(schema, body);
  const errors: Record<string, string[]> = {};
  for (const k of r.required) if (body?.[k] === undefined || body?.[k] === null || body?.[k] === "") errors[k] = [`The ${words(k)} field is required.`];
  for (const [k, ps] of Object.entries(r.props)) {
    const v = body?.[k];
    if (v === undefined || v === null || errors[k]) continue;
    const d = resolve(ps, v);
    const t = d.type;
    if (d.enum && !d.enum.includes(v)) errors[k] = [`The selected ${words(k)} is invalid.`];
    else if (t === "string" && typeof v !== "string") errors[k] = [`The ${words(k)} field must be a string.`];
    else if (t === "integer" && !Number.isInteger(Number(v))) errors[k] = [`The ${words(k)} field must be an integer.`];
    else if (t === "number" && !Number.isFinite(Number(v))) errors[k] = [`The ${words(k)} field must be a number.`];
    else if (t === "boolean" && typeof v !== "boolean") errors[k] = [`The ${words(k)} field must be true or false.`];
    else if (t === "array" && !Array.isArray(v)) errors[k] = [`The ${words(k)} field must be an array.`];
    else if (t === "object" && typeof v !== "object") errors[k] = [`The ${words(k)} field must be an object.`];
    const ds = deref(ps);
    if (typeof v === "string" && ds.maxLength && v.length > ds.maxLength) errors[k] = [`The ${words(k)} field must not be greater than ${ds.maxLength} characters.`];
    if (typeof v === "string" && ds.format === "email" && !/^[^@\s]+@[^@\s]+$/.test(v)) errors[k] = [`The ${words(k)} field must be a valid email address.`];
    if (typeof v === "string" && ds.format === "date" && isNaN(Date.parse(v))) errors[k] = [`The ${words(k)} field must be a valid date.`];
  }
  if (Object.keys(errors).length) throw laravel422(errors);
}

/** spatie/laravel-query-builder style guards for filter[] and sort, plus page[] bounds. */
export function validateQuery(op: Op, query: URLSearchParams, sortsKnown = false) {
  const asked: string[] = [];
  for (const k of query.keys()) { const m = /^filter\[(.+?)\]$/.exec(k); if (m && !asked.includes(m[1])) asked.push(m[1]); }
  const bad = asked.filter((f) => !op.filters.includes(f));
  if (bad.length) {
    throw new ApiError(400, `Requested filter(s) \`${bad.join(", ")}\` are not allowed. Allowed filter(s) are \`${op.filters.join(", ")}\`.`);
  }
  if (!sortsKnown && query.has("sort") && !op.sorts) throw new ApiError(400, `Requested sort(s) \`${query.get("sort")}\` is not allowed. Allowed sort(s) are \`\`.`);
  const size = query.get("page[size]");
  if (size !== null && size !== "" && !(Number(size) >= 1 && Number(size) <= 100 && Number.isInteger(Number(size)))) {
    throw laravel422({ "page.size": ["The page.size field must be between 1 and 100."] });
  }
  const num = query.get("page[number]");
  if (num !== null && num !== "" && !(Number(num) >= 1 && Number.isInteger(Number(num)))) throw laravel422({ "page.number": ["The page.number field must be at least 1."] });
}

// ---------------------------------------------------------------- conformance: does a serialised value satisfy the schema?
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;
export function validate(schema: Schema | null, value: unknown, path = "$", out: string[] = [], key = ""): string[] {
  if (!schema) return out;
  const r = resolve(schema, value);
  const nullable = (() => { const d = deref(schema); const t = d.type; return (Array.isArray(t) && t.includes("null")) || (d.anyOf || d.oneOf || []).some((o: any) => deref(o).type === "null"); })();
  if (value === null || value === undefined) { if (!nullable && (r.isObject || r.type)) out.push(`${path}: null but not nullable`); return out; }
  if (r.type === "array" || (r.items && Array.isArray(value))) {
    if (!Array.isArray(value)) { out.push(`${path}: expected array`); return out; }
    value.forEach((x, i) => validate(r.items ?? {}, x, `${path}[${i}]`, out, key));
    return out;
  }
  if (r.isObject && Object.keys(r.props).length) {
    if (typeof value !== "object") { out.push(`${path}: expected object`); return out; }
    const obj = value as Record<string, unknown>;
    for (const k of r.required) if (!(k in obj)) out.push(`${path}.${k}: required property missing`);
    for (const k of Object.keys(obj)) if (!(k in r.props) && !(OVERLAY[r.name ?? ""] ?? []).includes(k)) out.push(`${path}.${k}: not in schema`);
    for (const [k, ps] of Object.entries(r.props)) if (k in obj) validate(ps, obj[k], `${path}.${k}`, out, k);
    return out;
  }
  if (r.type === "integer" && !Number.isInteger(value)) out.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
  else if (r.type === "number" && typeof value !== "number") out.push(`${path}: expected number`);
  else if (r.type === "boolean" && typeof value !== "boolean") out.push(`${path}: expected boolean`);
  else if (r.type === "string" && typeof value !== "string") out.push(`${path}: expected string, got ${typeof value}`);
  if (r.enum && !r.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(r.enum)}`);
  if (typeof value === "string" && /(_at|_time|^date|_date|^start$|^end$|^time$)/.test(key) && key !== "dob" && TS_RE.test(value) && !UTC_RE.test(value)) out.push(`${path}: timestamp ${value} is not UTC +00:00`);
  return out;
}
export function specOps() { return OPS; }
