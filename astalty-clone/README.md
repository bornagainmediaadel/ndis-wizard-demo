# Astalty clone (NDIS Wizard test replica)

A synthetic copy of **Astalty**, built the same way as the ShiftCare dummy the Wizard already
tests against: Astalty's own public API shape (paths, bearer tokens, `{data, meta}` envelopes),
backed by Postgres tables in the *NDIS Wizard Shiftcare Dummy* Supabase project, filled with
synthetic participants, workers, agreements, supports, shifts, notes, invoices and incidents.
No real Astalty account or data is involved.

| What | Where |
|---|---|
| API base | `https://qzzlxhreshuxahocllwm.supabase.co/functions/v1/astalty-api` |
| Endpoints | `/public/v1/...` exactly as in Astalty's reference; replica-only helpers under `/_replica/changes`, `/_replica/planted`, `/_replica/conformance` |
| OpenAPI | `GET /docs.json` (Astalty's published spec with the server URL rewritten) |
| Console | `astalty-clone/console.html` on the demo site (sign in with an API token) |
| API docs page | `astalty-clone/docs.html` on the demo site |
| Tables | `ast_*` in the `public` schema; `astalty_api_spec` holds the spec |
| Auth | `Authorization: Bearer <token>`; tokens are minted with `select ast_mint_api_key('label', 'full'|'read')` |

The function root (`/`) also serves the console, but Supabase serves HTML from the shared
`supabase.co` domain as plain text, so use the GitHub Pages copies above.

## Fidelity

The replica is meant to be swapped for the real API by changing only `ASTALTY_API_BASE` and the token:

- Routing, success codes, allowed `filter[...]`/`sort` values, request validation and the shape of every
  response are taken at runtime from Astalty's published OpenAPI document (`astalty_api_spec`), so a
  response can only contain the properties the real API documents, and unknown filters or sorts are
  rejected the way Laravel's query builder rejects them.
- Timestamps are UTC with a `+00:00` offset, dates are `YYYY-MM-DDT00:00:00+00:00`, `dob` is `YYYY-MM-DD`,
  money is integer cents, as in Astalty's examples.
- Errors use Laravel's wording (`Unauthenticated.`, `This action is unauthorized.`, `No query results for
  model [...]`, `The route ... could not be found.`, validation `message` + `errors`).
- `GET /_replica/conformance` replays 82 representative requests through the pipeline and validates every
  response against the schema (required properties, types, enums, timestamp format). It passes 82/82.
- What the data cannot express is left honest rather than invented: the public API has no invoice payment
  state, no staff phone numbers and no incident-to-shift link, so the Wizard sees the same gaps it would see
  against the real account.

## Files

- `sql/001_schema.sql` tables, the `ast_log_change` trigger that feeds the change log, token functions.
- `sql/002_seed_reference.sql` staff, participants, plans, budgets, agreements, charge items, records.
- `sql/003_seed_delivery.sql` seven weeks of supports, shifts, notes, charges, travel and support coordination tasks (the generator lives in `ast_seed_delivery()` and `ast_seed_tasks()`).
- `sql/004_seed_billing_quality.sql` invoices and batches, payments, incidents, complaints, risks and the planted errors.
- `sql/005_fidelity.sql` brings a database seeded before 2026-10-19 up to the documented shapes (fresh installs do not need it).
- `supabase/functions/astalty-api/` the edge function: `index.ts` (router, auth), `routes.ts` (every endpoint), `shapes.ts` (response shapes), `lib.ts`, `ui.ts`.
- `supabase/functions/ndis-wizard/` the Wizard's agent function with the ShiftCare/Astalty source switch (`feeds_astalty.ts` is new; `shiftcare.ts` and `index.ts` carry the switch; the rest is unchanged).

## Pointing the Wizard at Astalty

`wizard_config` holds `ASTALTY_API_BASE` and `ASTALTY_API_KEY`. Any Wizard API call made with
`?source=astalty` reads the Astalty clone instead of ShiftCare; without it nothing changes.
Setting `WIZARD_SOURCE=astalty` in `wizard_config` flips the default for every call. The demo
page passes the switch through when it is opened with `?source=astalty`.

## Planted errors

`GET /_replica/planted` lists the 19 problems hidden in the data (a Saturday billed at the weekday
rate, a duplicate charge, an invoice total that does not add up, an expired worker screening on
the roster, missing progress notes, an unreported fall, an overdue risk review, and so on) so the
agents' findings can be checked against a known answer.

## Reseeding

Run the SQL files in order (`005` only on a database seeded earlier). The seed uses deterministic ids (`ast_id('p:1')` is always
Alex Marino), so it is safe to run twice. `select ast_mint_api_key(...)` afterwards and put the
token in `wizard_config`.
