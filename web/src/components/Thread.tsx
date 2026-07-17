import { useEffect, useRef } from "react";
import { useAutomoChat } from "../chat";
import Approvals from "./Approvals";
import Plan from "./Plan";

/* eslint-disable @typescript-eslint/no-explicit-any */
function argsPreview(input: any): string {
  if (input == null) return "";
  try { return Object.values(typeof input === "string" ? JSON.parse(input) : input).map((v) => String(v).slice(0, 40)).join(", "); } catch { return String(input).slice(0, 40); }
}
function resultPreview(output: any): string {
  let s = typeof output === "string" ? output : JSON.stringify(output ?? "");
  try { const a = JSON.parse(s); if (Array.isArray(a)) s = a.length + " item" + (a.length === 1 ? "" : "s"); } catch { /* keep */ }
  return "→ " + s.slice(0, 60);
}

function ToolChip({ part }: { part: any }) {
  const name = part.type === "dynamic-tool" ? part.toolName : String(part.type).replace(/^tool-/, "");
  const running = part.state === "input-streaming" || part.state === "input-available";
  const errored = part.state === "output-error";
  return (
    <div className="toolchip">
      <span className="tk">{name}</span>
      <span className="ta">{part.input ? "· " + argsPreview(part.input) : ""}</span>
      <span className="tr">{running ? "running…" : errored ? "→ error" : part.output != null ? resultPreview(part.output) : ""}</span>
    </div>
  );
}

function Message({ m }: { m: any }) {
  const isUser = m.role === "user";
  const parts: any[] = m.parts || [];
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  const reasoning = parts.filter((p) => p.type === "reasoning").map((p) => p.text).join("");
  const images = parts.filter((p) => p.type === "file" && String(p.mediaType || "").startsWith("image/"));
  const tools = parts.filter((p) => p.type === "dynamic-tool" || String(p.type).startsWith("tool-"));
  const gen = !isUser && images.length > 0;
  return (
    <>
      {tools.map((t, i) => <ToolChip key={m.id + "t" + i} part={t} />)}
      <div className={"msg " + (isUser ? "user" : "bot")}>
        <div className="who">{isUser ? "you" : "automo"}</div>
        <div className={"bubble" + (gen ? " genwrap" : "")}>
          {images.map((im, i) => <img key={i} className={isUser ? "att" : "gen"} src={im.url} alt="" />)}
          {text ? (gen ? <div className="imgcap">{text}</div> : text) : reasoning ? <span style={{ color: "var(--muted)", fontStyle: "italic" }}>{reasoning}</span> : null}
        </div>
      </div>
    </>
  );
}

export default function Thread() {
  const { messages, status, error, regenerate } = useAutomoChat();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const mn = ref.current?.closest("main"); if (mn) mn.scrollTop = mn.scrollHeight; }, [messages, status]);
  return (
    <div className="thread" ref={ref}>
      <Plan />
      {messages.map((m) => <Message key={m.id} m={m} />)}
      <Approvals />
      {status === "submitted" && (
        <div className="msg bot"><div className="who">automo</div><div className="bubble thinking">thinking…<span className="cursor" /></div></div>
      )}
      {error && (
        <div className="msg bot"><div className="who">automo</div>
          <div className="bubble err">Couldn't complete the turn ({error.message}). Check the connection + bridge in settings.{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); regenerate(); }}>retry</a>
          </div>
        </div>
      )}
    </div>
  );
}
