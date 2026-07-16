import { useStore, set } from "../store";
import { createSession } from "../lib/agent";

export default function Header() {
  const { status, usage, debugOpen } = useStore();
  return (
    <header>
      <div className="brand">
        <div className="badge" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 2l2.4 6.5L21 11l-6.6 2.5L12 20l-2.4-6.5L3 11l6.6-2.5z" /></svg>
        </div>
        <div><h1>AUTOMO</h1><div className="sub">local chat</div></div>
      </div>
      <div className="spacer" />
      {usage && usage.total > 0 && (
        <div className="status" title="Tokens used last turn (input/output)">
          <span>{usage.total.toLocaleString()} tok</span>
        </div>
      )}
      <div className="status" title="Connection to your machine">
        <span className={"dot " + status.state} /><span>{status.text}</span>
      </div>
      <button className={"iconbtn" + (debugOpen ? " on" : "")} title="Debug log" aria-label="Debug log" onClick={() => set({ debugOpen: !debugOpen })}>
        <svg viewBox="0 0 24 24"><path d="M8 4h8M9 8h6M6 12h12M8 16h8M10 20h4" /></svg>
      </button>
      <button className="iconbtn" title="New chat" aria-label="New chat" onClick={() => createSession()}>
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button className="iconbtn" title="Settings" aria-label="Settings" onClick={() => set({ drawerOpen: true })}>
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></svg>
      </button>
    </header>
  );
}
