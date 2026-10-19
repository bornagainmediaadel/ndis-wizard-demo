// Penny: progress-note quality checks (rules). Claude can add a second opinion on the scrubbed text.
export type Flag = {
  code: string; title: string; severity: "high" | "medium" | "low";
  reason: string; suggestion: string; evidence?: string;
};

const VAGUE = ["good", "fine", "ok", "okay", "nice", "normal", "alright", "great", "naughty", "lazy", "attention seeking", "attention-seeking", "non-compliant", "difficult", "behaved", "bad mood", "as usual", "nothing to report", "uneventful"];

const RP: [RegExp, string][] = [
  [/\block(?:ed|ing)?\b[^.]{0,30}\b(pantry|fridge|cupboard|door|room|kitchen|car|gate|cabinet)\b/i, "locked area"],
  [/\b(kept|shut|confined|left)\s+(him|her|them|\[[A-Z_0-9]+\])\s+in\s+(?:his|her|their|the)?\s*(room|bedroom|car|house)/i, "kept in a room"],
  [/\b(held|holding|hold|grabbed|pinned)\s+(?:down\s+)?(?:his|her|their|\[[A-Z_0-9]+\]'?s?)\s+(arms?|hands?|wrists?|legs?)/i, "physical hold"],
  [/\brestrain(?:t|ed|ing)?\b/i, "restraint"],
  [/\bseclu(?:sion|ded)\b/i, "seclusion"],
  [/\b(took|take|taken|removed)\s+(?:away\s+)?(?:his|her|their)\s+(phone|ipad|tablet|money|wallet|walker|wheelchair|cigarettes)/i, "items removed"],
  [/\b(prevent(?:ed)?|stopped|blocked)\s+(him|her|them|\[[A-Z_0-9]+\])\s+(from\s+)?(leaving|going out|getting out)/i, "prevented from leaving"],
  [/\bPRN\b|\bsedat(?:ed|ion|ive)\b/i, "PRN or sedation"],
];

const INCIDENT: [RegExp, string][] = [
  [/\b(fell|fallen|had a fall|slipped|tripped)\b/i, "fall"],
  [/\bhit\s+(?:his|her|their|\[[A-Z_0-9]+\]'?s?)\s+head\b|\bhead\s+(?:injury|knock)|\bconcuss/i, "head injury"],
  [/\b(bruis\w*|bleed\w*|bump|swelling|burn(?:t|ed)?|injur\w*)\b|\ba cut\b|\bcuts? (?:on|to) (?:his|her|their)\b/i, "injury"],
  [/\b(hit|hitting|punch\w*|kick\w*|bit|scratch\w*)\s+(me|staff|out|another|him|her)\b|\bassault|\baggressi\w*/i, "aggression"],
  [/\b(police|ambulance|hospital|emergency department|\bED\b|000)\b/i, "emergency services"],
  [/\b(missing|absconded|ran away|couldn't find|could not find)\b/i, "missing person"],
  [/\b(medication error|missed (?:his|her|their)?\s*medication|wrong (?:medication|dose)|double dose)\b/i, "medication"],
  [/\b(chok\w*|seizure|unconscious|unresponsive|vomit\w*|dizzy|dizziness|faint\w*)\b/i, "health event"],
];

const TIME_RE = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i;
const GOAL_RE = /\bgoals?\b|\bplan goal|\bNDIS goal|\bworking towards\b|\bcapacity building\b/i;

export function checkNote(text: string): Flag[] {
  const t = String(text || "");
  const flags: Flag[] = [];
  if (!GOAL_RE.test(t)) {
    flags.push({
      code: "goals", severity: "medium", title: "No link to the participant's goals",
      reason: "The note does not say which NDIS plan goal the support worked towards, so it can't evidence progress or justify the funding.",
      suggestion: "Add a sentence such as: 'Worked towards goal [n] ([goal name]) by …; [participant] managed … with [level of prompting].'",
    });
  }
  const vague = VAGUE.filter((w) => new RegExp(`(?<![A-Za-z])${w}(?![A-Za-z])`, "i").test(t));
  if (vague.length) {
    flags.push({
      code: "vague", severity: "low", title: "Vague or subjective wording", evidence: vague.join(", "),
      reason: `Words like "${vague.join('", "')}" describe an opinion, not what happened. Judgemental labels are not person-centred and won't stand up in a review.`,
      suggestion: "Describe what you saw and heard, what the participant did and said, and what support you gave. For example: 'Chose lunch from two options and paid at the counter with one verbal prompt.'",
    });
  }
  const rp = RP.filter(([re]) => re.test(t)).map(([, why]) => why);
  if (rp.length) {
    flags.push({
      code: "restrictive_practice", severity: "high", title: "Possible restrictive practice", evidence: rp.join(", "),
      reason: "The note describes a practice that may restrict the participant's rights or freedom of movement. Unless it is authorised in a behaviour support plan it may be an unauthorised restrictive practice, which is reportable to the NDIS Commission within 5 business days.",
      suggestion: "Team leader to check the behaviour support plan today. Record exactly what happened, how long, who authorised it and the participant's response. If unauthorised, raise an incident report.",
    });
  }
  const inc = INCIDENT.filter(([re]) => re.test(t)).map(([, why]) => why);
  if (inc.length) {
    flags.push({
      code: "incident", severity: "high", title: "Possible incident", evidence: inc.join(", "),
      reason: "The note describes something that may need an incident report (injury, fall, aggression, emergency services or a health event).",
      suggestion: "Complete an incident report in ShiftCare. Record the time, what first aid was given, who was notified and when, and any follow-up.",
    });
  }
  const headish = /\bhead\b|dizz|concuss|unconscious|vomit|faint/i.test(t);
  const noEscalation = /\b(did ?n[o']t|didn't|never)\s+(call|ring|tell|report|notify)|\bno one\b|\bnobody\b|\bnot (?:called|reported)\b|\bsaid (?:she|he|they) (?:was|were) (?:fine|ok|okay)/i.test(t);
  if (headish && noEscalation) {
    flags.push({
      code: "not_escalated", severity: "high", title: "Possible head injury not escalated",
      reason: "A knock to the head followed by dizziness or similar signs needs monitoring and escalation (family, GP, or 000 if symptoms worsen). The note says nobody was told.",
      suggestion: "Call the team leader now. Notify the participant's contact person, arrange monitoring for concussion signs, and record who was told and when.",
    });
  }
  if (!TIME_RE.test(t)) {
    flags.push({
      code: "times", severity: "low", title: "Missing times",
      reason: "No start, finish or event times are recorded, so the note can't be matched to the shift or used as evidence.",
      suggestion: "Start with the shift times, for example '9:00am to 12:00pm', and add a time for any event.",
    });
  }
  return flags;
}
