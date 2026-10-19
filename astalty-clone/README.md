# Astalty clone (NDIS Wizard test replica)

A synthetic copy of **Astalty**, built the same way as the ShiftCare dummy the Wizard already
tests against: Astalty's own public API shape (paths, bearer tokens, `{data, meta}` envelopes),
backed by Postgres tables in the *NDIS Wizard Shiftcare Dummy* Supabase project, filled with
synthetic participants, workers, agreements, supports, shifts, notes, invoices and incidents.
No real Astalty account or data is involved.

| What | Where |
|---|---|
| API base | `https://qzzlxhreshuxahocllwm.supabase.co/functions/v1/astalty-api` |
| Endpoints | `/public/v1/...` as in Astalty's reference, plus `/changes` and `/demo/planted` |
| OpenAPI | `GET /docs.json` (Astalty's published spec with the server URL rewritten) |
| Console | `astalty-clone/console.html` on the demo site (sign in with an API token) |
| API docs page | `astalty-clone/docs.html` on the demo site |
| Tables | `ast_*` in the `public` schema; `astalty_api_spec` holds the spec |
| Auth | `Authorization: Bearer <token>`; tokens are minted with `select ast_mint_api_key('label', 'full'|'read')` |

The function root (`/`) also serves the console, but Supabase serves HTML from the shared
`supabase.co` domain as plain text, so use the GitHub Pages copies above.

## Files

- `sql/001_schema.sql` tables, the `ast_log_change` trigger that feeds the change log, token functions.
- `sql/002_seed_reference.sql` staff, participants, plans, budgets, agreements, charge items, records.
- `sql/003_seed_delivery.sql` seven weeks of supports, shifts, notes, charges, travel and support coordination tasks (the generator lives in `ast_seed_delivery()` and `ast_seed_tasks()`).
- `sql/004_seed_billing_quality.sql` invoices and batches, payments, incidents, complaints, risks and the planted errors.
- `supabase/functions/astalty-api/` the edge function: `index.ts` (router, auth), `routes.ts` (every endpoint), `shapes.ts` (response shapes), `lib.ts`, `ui.ts`.
- `supabase/functions/ndis-wizard/` the Wizard's agent function with the ShiftCare/Astalty source switch (`feeds_astalty.ts` is new; `shiftcare.ts` and `index.ts` carry the switch; the rest is unchanged).

## Pointing the Wizard at Astalty

`wizard_config` holds `ASTALTY_API_BASE` and `ASTALTY_API_KEY`. Any Wizard API call made with
`?source=astalty` reads the Astalty clone instead of ShiftCare; without it nothing changes.
Setting `WIZARD_SOURCE=astalty` in `wizard_config` flips the default for every call. The demo
page passes the switch through when it is opened with `?source=astalty`.

## Planted errors

`GET /demo/planted` lists the 19 problems hidden in the data (a Saturday billed at the weekday
rate, a duplicate charge, an invoice total that does not add up, an expired worker screening on
the roster, missing progress notes, an unreported fall, an overdue risk review, and so on) so the
agents' findings can be checked against a known answer.

## Reseeding

Run the four SQL files in order. The seed uses deterministic ids (`ast_id('p:1')` is always
Alex Marino), so it is safe to run twice. `select ast_mint_api_key(...)` afterwards and put the
token in `wizard_config`.
