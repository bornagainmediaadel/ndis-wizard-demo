// Astalty clone · the `sort` values each list endpoint accepts, as observed on the live API
// (`meta.allowed_sorts`). Keys are the API's sort names, values the replica's columns.
const V = "/public/v1";
const DOCS = { created_at: "created_at" };
export const SORTS: Record<string, Record<string, string>> = {
  [`${V}/participants`]: {},
  [`${V}/participants/:participant/addresses`]: { type: "type" },
  [`${V}/participants/:participant/documents`]: DOCS, [`${V}/users/:user/documents`]: DOCS, [`${V}/tasks/:task/documents`]: DOCS,
  [`${V}/contacts/:contact/documents`]: DOCS, [`${V}/organisations/:organisation/documents`]: DOCS, [`${V}/sites/:site/documents`]: DOCS,
  [`${V}/participants/:participant/information-items`]: { created_at: "created_at", updated_at: "updated_at" },
  [`${V}/participants/:participant/ndis-plans`]: { start: "start", end: "end" },
  [`${V}/participants/:participant/budgets`]: { name: "name", created_at: "created_at" },
  [`${V}/participants/:participant/public-holiday-groups`]: { name: "name" }, [`${V}/public-holiday-groups`]: { name: "name" },
  [`${V}/services`]: { name: "name", start_date: "start", end_date: "end", start: "start", end: "end" },
  [`${V}/budgets/:budget/items`]: { name: "name", price: "price" },
  [`${V}/budgets/:budget/periods`]: { start_date: "start", amount: "amount" },
  [`${V}/charge-items`]: { number: "number", name: "name", price: "price" },
  [`${V}/charge-item-sets`]: { name: "name", reference: "reference" },
  [`${V}/supports`]: { start_time: "start_time", end_time: "end_time" }, [`${V}/shifts`]: { start_time: "start_time", end_time: "end_time" }, [`${V}/group-supports`]: { start_time: "start_time", end_time: "end_time" },
  [`${V}/tasks`]: {}, [`${V}/incidents`]: {}, [`${V}/users`]: {}, [`${V}/user-records`]: {}, [`${V}/participant-records`]: {}, [`${V}/invoices`]: {},
  [`${V}/participant-tags`]: { name: "name", created_at: "created_at" },
  [`${V}/document-categories`]: { name: "name", created_at: "created_at" },
  [`${V}/public-holidays`]: { date: "date", name: "name" },
  [`${V}/exports`]: { created_at: "created_at" },
};
