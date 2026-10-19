// PII scrubber. Everything that leaves this server for a model (or is stored as "what the AI
// sees") goes through here first. Names become [CLIENT_n] / [STAFF_n] / [PERSON_n]; a first
// name used on its own becomes [CLIENT_n_FIRST]. Phones, emails, NDIS numbers and street
// addresses are tokenised by pattern. The map goes back to the browser, which swaps the real
// values back in for display only.
export type Kind = "CLIENT" | "STAFF" | "PERSON";

export class Scrubber {
  map: Record<string, string> = {};
  private byValue = new Map<string, string>();
  private counters: Record<string, number> = {};
  private names: { value: string; tok: string }[] = [];

  private next(kind: string) {
    this.counters[kind] = (this.counters[kind] || 0) + 1;
    return `[${kind}_${this.counters[kind]}]`;
  }

  /** Register a person; returns the token for their full name. */
  person(name: string | null | undefined, kind: Kind = "PERSON"): string {
    const full = String(name || "").trim().replace(/\s+/g, " ");
    if (!full) return "";
    const key = full.toLowerCase();
    const have = this.byValue.get(key);
    if (have) return have;
    const tok = this.next(kind);
    this.byValue.set(key, tok);
    this.map[tok] = full;
    this.names.push({ value: full, tok });
    const first = full.split(" ")[0];
    const ft = tok.replace("]", "_FIRST]");
    this.map[ft] = first; // always available for greetings ("Hi [STAFF_1_FIRST]")
    if (first.length >= 3 && first.length < full.length && !this.byValue.has(first.toLowerCase())) {
      this.byValue.set(first.toLowerCase(), ft);
      this.names.push({ value: first, tok: ft });
    }
    return tok;
  }

  private literal(kind: string, value: string) {
    const key = kind + ":" + value.replace(/\s+/g, "");
    let tok = this.byValue.get(key);
    if (!tok) {
      tok = this.next(kind);
      this.byValue.set(key, tok);
      this.map[tok] = value;
    }
    return tok;
  }

  text(input: string | null | undefined): string {
    let s = String(input ?? "");
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => this.literal("EMAIL", m));
    s = s.replace(/\b43\d{7}\b/g, (m) => this.literal("NDIS", m));
    s = s.replace(/(?:\+?61\s?|0)[2-478](?:[ -]?\d){8}\b/g, (m) => this.literal("PHONE", m));
    s = s.replace(
      /\b\d{1,4}[A-Za-z]?\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Crescent|Cres|Place|Pl|Lane|Ln|Terrace|Tce|Parade|Pde|Way|Close|Cl)\b\.?(?:,?\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)*)?(?:\s+(?:SA|NSW|VIC|QLD|WA|TAS|NT|ACT))?(?:\s+\d{4})?/g,
      (m) => this.literal("ADDRESS", m),
    );
    // then names, longest first names first so "Alex Example" wins over "Alex"
    const sorted = [...this.names].sort((a, b) => b.value.length - a.value.length);
    for (const { value, tok } of sorted) {
      const re = new RegExp(`(?<![A-Za-z])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "gi");
      s = s.replace(re, tok);
    }
    return s;
  }

  /** Scrub every string inside a JSON-ish value. */
  deep<T>(v: T): T {
    if (typeof v === "string") return this.text(v) as unknown as T;
    if (Array.isArray(v)) return v.map((x) => this.deep(x)) as unknown as T;
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, this.deep(x)])) as T;
    }
    return v;
  }
}
