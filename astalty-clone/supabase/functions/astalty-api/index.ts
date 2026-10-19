// Astalty clone · entry point
// A synthetic replica of the Astalty public API for testing the NDIS Wizard. Routing, success
// codes, query/body validation and the shape of every response come from Astalty's own OpenAPI
// document (astalty_api_spec), so a client written against this replica sees exactly what the
// real API returns. Synthetic data only.
import { ApiError, authenticate, CORS, Ctx, FN_SLUG, html, json, allowedSorts } from "./lib.ts";
import { ROUTES } from "./routes.ts";
import { consolePage, docsPage } from "./ui.ts";
import { loadSpec, matchSpec, serialize, validateBody, validateQuery } from "./serialize.ts";

function publicBase(url: URL) {
  const i = url.pathname.indexOf(`/${FN_SLUG}`);
  let prefix = i >= 0 ? url.pathname.slice(0, i) : "";
  if (!prefix.startsWith("/functions/v1")) prefix = "/functions/v1" + prefix;
  return `https://${url.host}${prefix}/${FN_SLUG}`;
}
async function specFor(base: string) {
  const spec = await loadSpec();
  return { ...spec, servers: [{ url: base }], info: { ...spec.info, title: "Astalty (NDIS Wizard test replica)", description: "Synthetic replica of the Astalty public API. Authenticate with `Authorization: Bearer <token>`. Responses follow this document exactly; replica-only helpers live under /_replica." } };
}
function findHandler(method: string, path: string) {
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m && r.method === method) {
      const params: Record<string, string> = {};
      r.keys.forEach((k, idx) => (params[k] = decodeURIComponent(m[idx + 1])));
      return { r, params };
    }
  }
  return null;
}
async function readBody(req: Request, method: string) {
  if (method === "GET") return {};
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const t = await req.text();
    if (!t.trim()) return {};
    try { return JSON.parse(t); } catch { throw new ApiError(400, "Malformed JSON body."); }
  }
  if (ct.includes("form")) return Object.fromEntries((await req.formData()).entries());
  return {};
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const base = publicBase(url);
  const i = url.pathname.indexOf(`/${FN_SLUG}`);
  const path = (i >= 0 ? url.pathname.slice(i + FN_SLUG.length + 1) : url.pathname) || "/";
  const method = req.method.toUpperCase();
  try {
    if (method === "GET" && (path === "/" || path === "" || path === "/app")) return html(consolePage(base));
    if (method === "GET" && path === "/docs") return html(docsPage(base));
    if (method === "GET" && path === "/docs.json") return json(await specFor(base));
    if (method === "GET" && path === "/health") return json({ ok: true, name: "Astalty clone", base });
    await loadSpec();

    // Replica-only helpers (not part of Astalty's API): change log, planted errors, conformance check.
    if (path.startsWith("/_replica/")) {
      const h = findHandler(method, path);
      if (!h) throw new ApiError(404, `The route ${path.replace(/^\//, "")} could not be found.`);
      const key = await authenticate(req);
      const ctx: Ctx = { req, method, path, url, query: url.searchParams, params: h.params, body: await readBody(req, method), key, base };
      const out = await h.r.fn(ctx);
      return out instanceof Response ? out : json(out ?? {});
    }

    const hit = matchSpec(method, path);
    if (!hit) throw new ApiError(404, `The route ${path.replace(/^\//, "")} could not be found.`);
    if ("allowed" in hit) throw new ApiError(405, `The ${method} method is not supported for route ${path.replace(/^\//, "")}. Supported methods: ${hit.allowed.join(", ")}.`);

    const key = await authenticate(req);
    if (key.permission === "read" && method !== "GET") throw new ApiError(403, "This action is unauthorized.");
    const body = await readBody(req, method);
    const h = findHandler(method, path);
    if (method === "GET") validateQuery(hit.op, url.searchParams, !!allowedSorts(h?.r.pattern));
    else validateBody(hit.op, body);
    if (!h) throw new ApiError(501, "This endpoint exists in Astalty but is not implemented in the replica.");
    const ctx: Ctx = { req, method, path, url, query: url.searchParams, params: { ...hit.pp, ...h.params }, body, key, base };
    const out = await h.r.fn(ctx);
    if (out instanceof Response) return out;
    const payload = out === null || out === undefined ? {} : serialize(hit.op.okSchema, out);
    return json(payload, hit.op.ok);
  } catch (e) {
    if (e instanceof ApiError) return json(e.errors ? { message: e.message, errors: e.errors } : { message: e.message }, e.status, e.status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
    console.error(e);
    return json({ message: "Server Error" }, 500);
  }
});
