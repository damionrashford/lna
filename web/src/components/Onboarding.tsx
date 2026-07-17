import { useEffect, useState } from "react";
import { useStore, setOnboarding, setProfileName } from "../store";
import { getProfile, saveProfile, type Tone } from "../lib/runtime/context/profile";

// Warm, NON-BLOCKING first-run welcome. Skippable at every step (Skip / Esc / backdrop) — it personalizes
// AUTOMO but never gates it. Captures a name, a focus, and a preferred tone, all optional.
const FOCUS = ["Coding", "Writing", "Research", "Ops & automation", "Just exploring"];
const TONES: { key: Tone; label: string; blurb: string }[] = [
  { key: "warm", label: "Warm", blurb: "friendly and encouraging" },
  { key: "concise", label: "Straight up", blurb: "short, answer first" },
  { key: "technical", label: "Technical", blurb: "precise, assumes expertise" },
];

export default function Onboarding() {
  const { onboarding } = useStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(getProfile().name);
  const [focus, setFocus] = useState(getProfile().focus);
  const [tone, setTone] = useState<Tone>(getProfile().tone);

  const finish = (persist: boolean) => {
    if (persist) { saveProfile({ name: name.trim(), focus, tone, onboarded: true }); setProfileName(name.trim()); }
    else saveProfile({ onboarded: true });
    setOnboarding(false);
  };

  useEffect(() => {
    if (!onboarding) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") finish(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onboarding, name, focus, tone]);

  if (!onboarding) return null;
  const last = step === 2;

  return (
    <div className="ob-scrim" onClick={() => finish(false)}>
      <section className="ob" onClick={(e) => e.stopPropagation()}>
        <div className="ob-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 2l2.4 6.5L21 11l-6.6 2.5L12 20l-2.4-6.5L3 11l6.6-2.5z" /></svg>
        </div>

        {step === 0 && (
          <>
            <h2>Welcome to AUTOMO</h2>
            <p>A private AI that runs in your browser and works on <b>your</b> machine — your model, your files, nothing leaves. Let's make it yours. (You can skip any of this.)</p>
            <label className="ob-field"><span>What should I call you?</span>
              <input autoFocus value={name} placeholder="your name" onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") setStep(1); }} /></label>
          </>
        )}
        {step === 1 && (
          <>
            <h2>{name ? `Nice to meet you, ${name}` : "What brings you here?"}</h2>
            <p>What do you mostly work on? I'll lean my help and examples that way.</p>
            <div className="ob-chips">
              {FOCUS.map((f) => (
                <button key={f} className={"ob-chip" + (focus === f ? " on" : "")} onClick={() => setFocus(focus === f ? "" : f)}>{f}</button>
              ))}
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2>How should I talk to you?</h2>
            <p>Set the tone — you can change it any time in Settings.</p>
            <div className="ob-tones">
              {TONES.map((t) => (
                <button key={t.key} className={"ob-tone" + (tone === t.key ? " on" : "")} onClick={() => setTone(t.key)}>
                  <b>{t.label}</b><span>{t.blurb}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="ob-dots" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className={i === step ? "on" : ""} />)}</div>
        <div className="ob-actions">
          <button className="ob-skip" onClick={() => finish(false)}>Skip</button>
          <div className="ob-nav">
            {step > 0 && <button className="ob-back" onClick={() => setStep(step - 1)}>Back</button>}
            <button className="ob-next" onClick={() => (last ? finish(true) : setStep(step + 1))}>{last ? "Get started" : "Continue"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
