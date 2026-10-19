// The AI layer. Every prompt is built from SCRUBBED text only ([CLIENT_1], [STAFF_2], ...).
// Two ways to run it, same prompt:
//   1. In claude.ai: the Wizard page sends item.ai_prompt to Claude (artifact `sample` capability)
//      and posts the answer back to /queue/:id/ai.
//   2. Hosted elsewhere: set ANTHROPIC_API_KEY and this function calls Claude server-side.
import { setting } from "./store.ts";

const SYSTEM = `You are an NDIS compliance assistant for an Australian disability support provider (South Australia).
Personal details have been replaced with tokens like [CLIENT_1], [STAFF_2], [CLIENT_1_FIRST], [PHONE_1]. Keep every token exactly as written; never guess the real value.
You advise a human reviewer. You never lodge, send or change anything. Use plain Australian English. Be specific and brief.
Reply with JSON only, matching: {"summary": string, "flags": [{"severity": "high"|"medium"|"low", "title": string, "reason": string, "suggestion": string}], "rewrite": string|null}.
"flags" lists only problems the rule checks below MISSED (empty array if none). "rewrite" is an improved version of the text where the task asks for one, otherwise null.`;

export function buildPrompt(agent: string, scrubbed: string, rules: unknown): string {
  const task: Record<string, string> = {
    note: "Task: review this progress note against NDIS documentation good practice (goal linkage, objective person-centred language, restrictive practices, incidents and escalation, times). Then write a rewrite of the note that a team leader could accept, using only facts in the note and leaving [ADD: ...] placeholders for anything missing.",
    invoice: "Task: explain this invoice exception to a finance officer in one or two sentences and say what to check in ShiftCare before claiming. Add a flag only if the data shows another billing problem. rewrite = null.",
    expiry: "Task: check this reminder is accurate, kind and clear for the recipient (a staff member or an NDIS participant). rewrite = the improved reminder, same facts, same tokens.",
    hey: "Task: check this draft message is accurate and clear. rewrite = the improved draft.",
  };
  return `${SYSTEM}\n\n${task[agent] || "Task: review this agent output for accuracy, missed risks and tone. rewrite = an improved draft if the item contains a message to send, otherwise null."}\n\nRule checks already found:\n${JSON.stringify(rules, null, 1)}\n\nScrubbed input:\n"""\n${scrubbed}\n"""`;
}

export function heyPrompt(question: string, context: unknown, rulesAnswer: string): string {
  return `${SYSTEM.replace(/Reply with JSON only[\s\S]*$/, "")}
Answer the staff member's question using ONLY the ShiftCare data below. If the data doesn't cover it, say so. Keep tokens as written.
If a reminder or message to someone would help, include one draft.
Reply with JSON only: {"answer": string, "draft": null | {"to": string (a token), "channel": "email"|"sms", "text": string}}

Question: ${question}

ShiftCare data (scrubbed):
${JSON.stringify(context, null, 1)}

Rule-based answer for reference: ${rulesAnswer}`;
}

export async function serverModel(): Promise<string | null> {
  return (await setting("ANTHROPIC_API_KEY")) ? ((await setting("AI_MODEL")) || "claude-sonnet-5-5") : null;
}

export async function callClaude(prompt: string): Promise<{ text: string; model: string } | null> {
  const key = await setting("ANTHROPIC_API_KEY");
  if (!key) return null;
  const model = (await setting("AI_MODEL")) || "claude-sonnet-5-5";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${j?.error?.message || ""}`);
  return { text: (j.content || []).map((c: any) => c.text || "").join(""), model };
}

export function parseJson(text: string): any {
  const m = /\{[\s\S]*\}/.exec(text || "");
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
