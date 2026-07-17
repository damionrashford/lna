// Local user profile — one identity per browser, stored client-side (no accounts, no server). Captured by
// onboarding, editable in Settings, and folded into the greeting and the agent's system prompt.
export type Tone = "warm" | "concise" | "technical" | "";
export interface Profile {
  name: string;      // what to call them
  focus: string;     // what they mostly work on — steers the agent
  tone: Tone;        // how the assistant should talk
  onboarded: boolean;// has the first-run flow been seen (or skipped)
}

const KEY = "automo.profile";
const EMPTY: Profile = { name: "", focus: "", tone: "", onboarded: false };

export function getProfile(): Profile {
  try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...EMPTY }; }
}
export function saveProfile(patch: Partial<Profile>): Profile {
  const next = { ...getProfile(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

// A time-of-day + name greeting for the empty/connect states.
export function greeting(p = getProfile()): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return p.name ? `${part}, ${p.name}` : part;
}

// Fold the profile into the agent's instructions — name, focus, and a tone directive.
export function personalize(base: string, p = getProfile()): string {
  const bits: string[] = [];
  if (p.name) bits.push(`The user's name is ${p.name} — address them by name naturally, not in every message.`);
  if (p.focus) bits.push(`They mostly work on: ${p.focus}. Bias examples and defaults toward that.`);
  if (p.tone === "warm") bits.push("Keep a warm, encouraging tone.");
  else if (p.tone === "concise") bits.push("Be concise and direct — skip preamble, lead with the answer.");
  else if (p.tone === "technical") bits.push("Be precise and technical; assume real expertise.");
  return bits.length ? `${base}\n\n[About the person you're helping — ${bits.join(" ")}]` : base;
}
