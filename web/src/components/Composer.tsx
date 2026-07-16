import { useEffect, useRef, useState } from "react";
import { useStore, S } from "../store";
import { setAttachment, clearAttachment, toggleImageMode } from "../lib/agent";
import { startVoice, stopVoice } from "../lib/voice";
import { useAutomoChat } from "../chat";

function fileToDataURL(file: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(file); });
}

export default function Composer() {
  const { attached, imageMode, voice } = useStore();
  const toggleVoice = () => { if (voice.active) void stopVoice(); else void startVoice(); };
  const { busy, sendText, sendImage, generateImage, stop } = useAutomoChat();
  const [value, setValue] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const autosize = () => { const i = ta.current; if (!i) return; i.style.height = "auto"; i.style.height = Math.min(i.scrollHeight, 180) + "px"; };
  useEffect(autosize, [value]);

  const submit = () => {
    if (busy) return;
    const v = value.trim();
    if (imageMode) { if (v) { setValue(""); generateImage(v); } return; }
    if (!v && !attached) return;
    setValue("");
    if (attached) { sendImage(v, attached); clearAttachment(); }
    else sendText(v);
  };

  // paste / drop images anywhere → attachment
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (it) setAttachment(await fileToDataURL(it.getAsFile()!));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  return (
    <section
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/")); if (f) setAttachment(await fileToDataURL(f)); }}
    >
      <div className="attach-strip">
        {attached && (
          <div className="thumb">
            <img src={attached} alt="" />
            <button className="x" onClick={clearAttachment}>×</button>
          </div>
        )}
      </div>
      <div className="inputwrap">
        <button className="cbtn" title="Attach an image (understanding)" aria-label="Attach image" onClick={() => fileInput.current?.click()}>
          <svg viewBox="0 0 24 24"><path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7L14 5.5a3.3 3.3 0 014.6 4.7l-9 9a1.6 1.6 0 01-2.3-2.3l8.5-8.5" /></svg>
        </button>
        <button className={"cbtn" + (imageMode ? " on" : "")} title="Image generation mode" aria-label="Image mode" onClick={toggleImageMode}>
          <svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
        </button>
        <button
          className={"cbtn" + (voice.active ? " on" : "")}
          title={voice.active ? `Voice: ${voice.state} — click to stop` : "Talk to AUTOMO (local voice)"}
          aria-label="Voice mode"
          onClick={toggleVoice}
        >
          <svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4" /></svg>
        </button>
        <textarea
          ref={ta}
          rows={1}
          placeholder={imageMode ? "Describe an image to generate…" : "Ask anything…"}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        {busy ? (
          <button className="send" aria-label="Stop" title="Stop" onClick={() => stop()}>
            <svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="var(--coral-ink)" stroke="none" /></svg>
          </button>
        ) : (
          <button className="send" aria-label="Send" onClick={submit}>
            <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => { const f = e.target.files?.[0]; if (f) setAttachment(await fileToDataURL(f)); e.target.value = ""; }}
      />
      <div className="hint">Your model · your machine · {S.model || "—"} · <a href="#" onClick={(e) => { e.preventDefault(); location.reload(); }}>disconnect</a></div>
    </section>
  );
}
