import { useEffect, useRef } from "react";
import { useStore, type ThreadItem } from "../store";

function argsPreview(argsStr: string): string {
  try { return Object.values(JSON.parse(argsStr || "{}")).map((v) => String(v).slice(0, 40)).join(", "); }
  catch { return ""; }
}
function resultPreview(out: string): string {
  let s = out;
  try { const a = JSON.parse(s); if (Array.isArray(a)) s = a.length + " item" + (a.length === 1 ? "" : "s"); } catch { /* keep */ }
  return "→ " + s.slice(0, 60);
}

function Item({ item }: { item: ThreadItem }) {
  if (item.kind === "tool") {
    const args = argsPreview(item.argsStr);
    return (
      <div className="toolchip">
        <span className="tk">{item.name}</span>
        <span className="ta">{args ? "· " + args : ""}</span>
        <span className="tr">{item.result != null ? resultPreview(item.result) : "running…"}</span>
      </div>
    );
  }
  if (item.kind === "approve") {
    return (
      <div className="approve">
        <div className="at">Run <b>{item.name}</b>? <span className="aa">{(item.argsStr || "").slice(0, 120)}</span></div>
        <div className="ab">
          <button className="ay" onClick={() => item.onDecision(true)}>Approve</button>
          <button className="an" onClick={() => item.onDecision(false)}>Reject</button>
        </div>
      </div>
    );
  }
  // message
  const cls = "bubble" + (item.err ? " err" : "") + (item.thinking ? " thinking" : "") + (item.genImage ? " genwrap" : "");
  return (
    <div className={"msg " + (item.role === "user" ? "user" : "bot")}>
      <div className="who">{item.role === "user" ? "you" : "automo"}</div>
      <div className={cls}>
        {item.image && <img className="att" src={item.image} alt="" />}
        {item.genImage
          ? <><img className="gen" src={item.genImage} alt="" /><div className="imgcap">{item.genCaption}</div></>
          : (item.thinking && !item.text ? "thinking…" : item.text)}
        {item.streaming && <span className="cursor" />}
      </div>
    </div>
  );
}

export default function Thread() {
  const { thread } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const m = ref.current?.closest("main"); if (m) m.scrollTop = m.scrollHeight; }, [thread]);
  return (
    <div className="thread" ref={ref}>
      {thread.map((item) => <Item key={item.id} item={item} />)}
    </div>
  );
}
