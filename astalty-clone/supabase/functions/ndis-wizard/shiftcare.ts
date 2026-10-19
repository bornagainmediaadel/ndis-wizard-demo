// Server-side ShiftCare v3 client (HTTP Basic). Works against the clone or live ShiftCare:
// only the base URL, account ID and key change. The key never leaves this function.
import { addDays } from "./util.ts";

export type SCConfig = { base: string; accountId?: string; apiKey: string; kind?: "shiftcare" | "astalty" };

export class ShiftCare {
  calls = 0;
  private auth: string;
  private cache = new Map<string, Promise<unknown>>();
  /** Responses fetched during this request, written to the short-lived cache afterwards. */
  fresh: [string, unknown][] = [];
  constructor(private cfg: SCConfig, preload?: Map<string, unknown>) {
    this.auth = cfg.kind === "astalty" ? `Bearer ${cfg.apiKey}` : "Basic " + btoa(`${cfg.accountId}:${cfg.apiKey}`);
    if (preload) for (const [k, v] of preload) this.cache.set(k, Promise.resolve(v));
  }
  get base() { return this.cfg.base; }
  get kind() { return this.cfg.kind || "shiftcare"; }
  get label() { return this.kind === "astalty" ? "Astalty" : "ShiftCare"; }

  async get<T = any>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const u = new URL(this.cfg.base.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    const key = u.toString();
    if (!this.cache.has(key)) this.cache.set(key, this.fetchJson(key));
    return this.cache.get(key) as Promise<T>;
  }

  private async fetchJson(url: string, attempt = 0): Promise<unknown> {
    this.calls++;
    let r: Response;
    try {
      r = await fetch(url, { headers: { Authorization: this.auth, Accept: "application/json" } });
    } catch (e) {
      // Supabase caps calls between edge functions in one project at 30 per request chain per
      // minute. Only the clone (an edge function in the same project) hits this; live ShiftCare
      // is an external API. The caller resumes in a fresh request with the cached responses.
      const m = /Rate limit exceeded for trace.*?Retry after (\d+)ms/i.exec(String((e as Error)?.message || e));
      if (m) throw new BudgetError(Number(m[1]), this.label);
      throw e;
    }
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      const wait = Number(r.headers.get("retry-after")) * 1000 || 400 * 2 ** attempt;
      await new Promise((res) => setTimeout(res, wait));
      return this.fetchJson(url, attempt + 1);
    }
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.errors?.map?.((e: any) => e.messages?.join(", ")).join("; ") || j.message || msg; } catch { /* keep */ }
      throw new SCError(r.status, `${this.label} ${r.status} on ${new URL(url).pathname}: ${msg}`);
    }
    const body = text ? JSON.parse(text) : null;
    this.fresh.push([url, body]);
    return body;
  }

  /** Walk every page of a list endpoint ({ "<key>": [...] }). */
  async all<T = any>(path: string, key: string, params: Record<string, unknown> = {}, maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const body: any = this.kind === "astalty"
        ? await this.get(path, { ...params, "page[size]": 100, "page[number]": page })
        : await this.get(path, { ...params, per_page: 100, page, include_metadata: true });
      const rows: T[] = Array.isArray(body) ? body : body?.data ?? body?.[key] ?? [];
      out.push(...rows);
      const total = Number(body?.meta?.last_page ?? body?._metadata?.total_pages ?? 1);
      if (page >= total || rows.length === 0) break;
    }
    return out;
  }

  /**
   * Timesheets for a date range, fetched one day at a time. Works around the clone bug where
   * wide from/to ranges were capped at ~20 rows, and keeps each request small on live ShiftCare.
   */
  async timesheets(from: string, to: string): Promise<any[]> {
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const out: any[] = [];
    await pool(days, 6, async (d) => {
      out.push(...(await this.all("/timesheets", "timesheets", { from: d, to: d })));
    });
    // de-duplicate (a timesheet can straddle midnight and show on two days)
    const seen = new Set<string>();
    return out.filter((t) => {
      const k = `${t.shift_id}|${t.staff_id}|${t.clockin_at}|${t.date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  async shiftsByIds(ids: string[]): Promise<any[]> {
    const out: any[] = [];
    const uniq = [...new Set(ids.filter(Boolean))];
    const chunks: string[][] = [];
    for (let i = 0; i < uniq.length; i += 40) chunks.push(uniq.slice(i, i + 40));
    await pool(chunks, 4, async (c) => {
      out.push(...(await this.all("/shifts", "shifts", { ids: c.join(","), include_clients: true, include_staff: true })));
    });
    return out;
  }
}

export class BudgetError extends Error {
  constructor(public retryAfterMs: number, label = "ShiftCare") { super(`Fetched part of the ${label} data. Continuing in a new request.`); }
}
export class SCError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x); }
  });
  await Promise.all(workers);
}

// ---- field helpers (ShiftCare v3 shapes) ----
export const staffName = (s: any) => s?.name || [s?.first_name, s?.family_name].filter(Boolean).join(" ");
export const clientName = (c: any) => c?.display_name || [c?.first_name, c?.family_name].filter(Boolean).join(" ");
