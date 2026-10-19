// Astalty clone · entry point
// A synthetic replica of the Astalty public API (bearer token, /public/v1, {data, meta} envelopes)
// backed by the ast_* tables, for testing the NDIS Wizard. Synthetic data only.
import { ApiError, authenticate, CORS, Ctx, db, FN_SLUG, html, json, must } from "./lib.ts";
import { ROUTES } from "./routes.ts";
import { consolePage, docsPage } from "./ui.ts";

function publicBase(url: URL) {
  const i = url.pathname.indexOf(`/${FN_SLUG}`);
  let prefix = i >= 0 ? url.pathname.slice(0, i) : "";
  if (!prefix.startsWith("/functions/v1")) prefix = "/functions/v1" + prefix;
  return `https://${url.host}${prefix}/${FN_SLUG}`;
}

let SPEC: any = null;
async function spec(base: string) {
  if (!SPEC) {
    const r = must(await db.from("astalty_api_spec").select("spec").eq("id", 1).maybeSingle()) as any;
    SPEC = r?.spec ?? { openapi: "3.1.0", info: { title: "Astalty" }, paths: {} };
  }
  return { ...SPEC, servers: [{ url: base }], info: { ...SPEC.info, title: "Astalty (NDIS Wizard test replica)", description: "Synthetic replica of the Astalty public API. Authenticate with `Authorization: Bearer <token>`. Replica extras: GET /changes and GET /demo/planted." } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const base = publicBase(url);
  const i = url.pathname.indexOf(`/${FN_SLUG}`);
  const path = (i >= 0 ? url.pathname.slice(i + FN_SLUG.length + 1) : url.pathname) || "/";
  try {
    if (req.method === "GET" && (path === "/" || path === "" || path === "/app")) return html(consolePage(base));
    if (req.method === "GET" && path === "/docs") return html(docsPage(base));
    if (req.method === "GET" && path === "/docs.json") return json(await spec(base));
    if (req.method === "GET" && path === "/health") return json({ ok: true, name: "Astalty clone", base });

    let method = req.method.toUpperCase();
    let pathMatched = false, match: { r: typeof ROUTES[number]; m: RegExpMatchArray } | null = null;
    for (const r of ROUTES) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method) { match = { r, m }; break; }
    }
    if (!match) throw new ApiError(pathMatched ? 405 : 404, pathMatched ? `The ${method} method is not supported for this route.` : "Not Found.");

    const key = await authenticate(req);
    if (key.permission === "read" && method !== "GET") throw new ApiError(403, "This API key is read only.");

    let body: any = {};
    if (method !== "GET") {
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("application/json")) { const t = await req.text(); if (t.trim()) { try { body = JSON.parse(t); } catch { throw new ApiError(400, "Malformed JSON body."); } } }
      else if (ct.includes("form")) body = Object.fromEntries((await req.formData()).entries());
    }
    const params: Record<string, string> = {};
    match.r.keys.forEach((k, idx) => (params[k] = decodeURIComponent(match!.m[idx + 1])));
    const ctx: Ctx = { req, method, path, url, query: url.searchParams, params, body, key, base };
    const out = await match.r.fn(ctx);
    if (out instanceof Response) return out;
    if (out === null || out === undefined) return new Response(null, { status: 204, headers: CORS });
    return json(out, method === "POST" && !/\/(archive|unarchive|finalise|void|payment-allocations|information-items)$/.test(path) ? 201 : 200);
  } catch (e) {
    if (e instanceof ApiError) return json(e.errors ? { message: e.message, errors: e.errors } : { message: e.message }, e.status, e.status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
    console.error(e);
    return json({ message: "Server Error" }, 500);
  }
});
