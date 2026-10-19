// Persistence via PostgREST with the service-role key (tables have RLS on and no policies,
// so only this function can read or write them).
const URL_ = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "content-type": "application/json" };

async function req(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`store ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
export const db = {
  select: (table: string, q = "") => req(`${table}?${q}`),
  insert: (table: string, rows: unknown) => req(table, { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "return=representation" } }),
  upsert: (table: string, rows: unknown) => req(table, { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "return=representation,resolution=merge-duplicates" } }),
  update: (table: string, q: string, patch: unknown) => req(`${table}?${q}`, { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=representation" } }),
  del: (table: string, q: string) => req(`${table}?${q}`, { method: "DELETE" }),
  rpc: (fn: string, args: unknown) => req(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }),
};

let cfgCache: Record<string, string> | null = null;
export async function config(): Promise<Record<string, string>> {
  if (cfgCache) return cfgCache;
  const rows: { key: string; value: string }[] = await db.select("wizard_config", "select=key,value");
  cfgCache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return cfgCache;
}
/** Env var wins over the config table, so the same code runs on Netlify/Vercel with env-only config. */
export async function setting(name: string): Promise<string | undefined> {
  return Deno.env.get(name) || (await config())[name];
}
