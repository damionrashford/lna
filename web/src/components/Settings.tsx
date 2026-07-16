import { useState } from "react";
import { useStore, S, set } from "../store";
import {
  createSession, switchSession, deleteSession, pullModel,
  addRepo, snapshotWorkspace, restoreSnapshot, deleteSnapshot,
} from "../lib/agent";
import { grantFolder } from "../lib/opfs";
import { addMcpServer, removeMcpServer } from "../lib/mcp";
import { useAutomoChat } from "../chat";

export default function Settings() {
  const st = useStore();
  const { messages, compact, clear } = useAutomoChat();
  const [url, setUrl] = useState(S.url);
  const [model, setModel] = useState(S.model);
  const [vision, setVision] = useState(S.vision);
  const [image, setImage] = useState(S.image);
  const [instructions, setInstructions] = useState(S.instructions);
  const [budget, setBudget] = useState(S.budget);
  const [compactAt, setCompactAt] = useState(S.compactAt);
  const [approve, setApprove] = useState(S.approve);
  const [pullName, setPullName] = useState("");
  const [repoSpec, setRepoSpec] = useState("");
  const [snapName, setSnapName] = useState("");
  const [mcpLabel, setMcpLabel] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"http" | "stdio">("http");
  const [mcpTarget, setMcpTarget] = useState("");
  const [mcpAuth, setMcpAuth] = useState("");

  const close = () => set({ drawerOpen: false });

  return (
    <>
      <div className={"scrim" + (st.drawerOpen ? " open" : "")} onClick={close} />
      <aside className={"drawer" + (st.drawerOpen ? " open" : "")} aria-label="Settings">
        <div className="dh"><h3>Settings</h3><div className="spacer" />
          <button className="iconbtn" aria-label="Close" onClick={close}><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
        <div className="body">
          <div className="field"><label>Conversations</label>
            <div>
              {st.sessions.slice(0, 40).map((s) => (
                <div key={s.id} className={"srow" + (s.id === st.sessionId ? " cur" : "")}>
                  <span className="stitle" onClick={() => { switchSession(s.id); close(); }}>{s.title || "New chat"}</span>
                  <button className="sx" onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}>×</button>
                </div>
              ))}
              {!st.sessions.length && <div className="note" style={{ margin: 0 }}>none</div>}
            </div>
            <button onClick={() => { createSession(); close(); }} style={{ marginTop: 8, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "8px 14px", color: "var(--ink)", fontSize: "0.8rem", cursor: "pointer" }}>+ New conversation</button>
            <div className="note">Persistent multi-conversation memory (IndexedDB). Each is a Session: history is loaded on open and saved after every turn.</div></div>

          <div className="field"><label>Auto-compact after N messages (0 = off)</label>
            <input type="number" min={0} step={1} value={compactAt} onChange={(e) => { const v = Math.max(0, +e.target.value || 0); setCompactAt(v); S.compactAt = v; }} />
            <div className="note">When a conversation grows past this, AUTOMO summarizes the older turns into one note (client-side; Ollama has no <code>responses.compact</code>). Also a <button onClick={() => { compact(); close(); }} style={{ background: "none", border: "none", color: "var(--coral)", cursor: "pointer", padding: 0, font: "inherit" }}>compact now</button>.</div></div>

          <div className="field"><label>Model endpoint (Ollama)</label>
            <input type="text" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => { S.url = url.trim(); }} />
            <div className="note">Loopback address on your machine. Reached over LNA — Chrome prompts once, then remembers.</div></div>

          <div className="field"><label>Chat model</label>
            <select value={model} onChange={(e) => { setModel(e.target.value); S.model = e.target.value; }}>
              {st.models.chat.length ? st.models.chat.map((m) => <option key={m} value={m}>{m}</option>) : <option value="">— connect to load models —</option>}
            </select></div>

          <div className="field"><label>Vision model (image understanding)</label>
            <select value={vision} onChange={(e) => { setVision(e.target.value); S.vision = e.target.value; }}>
              <option value="">— none —</option>
              {st.models.vision.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="note">Used when you attach an image. Needs a vision model (e.g. a <code>-vl</code> / llava model).</div></div>

          <div className="field"><label>Image model (generation)</label>
            <select value={image} onChange={(e) => { setImage(e.target.value); S.image = e.target.value; }}>
              <option value="">— none —</option>
              {st.models.image.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="note">Used in image mode (the ✦ button). Needs a diffusion model (e.g. flux).</div></div>

          <div className="field"><label>Get a model — downloads to your machine</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="text" spellCheck={false} placeholder="llama3.2" style={{ flex: 1 }} value={pullName} onChange={(e) => setPullName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") pullModel(pullName); }} />
              <button onClick={() => pullModel(pullName)} style={{ background: "var(--coral)", color: "var(--coral-ink)", border: "none", borderRadius: "var(--r-sm)", padding: "0 16px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Pull</button>
            </div>
            {st.pull.show && (
              <div>
                <div style={{ height: 5, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden", marginTop: 9 }}><div style={{ height: "100%", width: st.pull.pct + "%", background: "var(--coral)", transition: "width .2s" }} /></div>
                <div className="note" style={{ marginTop: 6 }}>{st.pull.text}</div>
              </div>
            )}
            <div className="note">The browser triggers <code>/api/pull</code> on your machine — no terminal needed. (Setting the origin + starting Ollama still has to happen once on the machine — the browser can't launch a process.)</div></div>

          <div className="field"><label>Agent file tools</label>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <button onClick={() => grantFolder()} style={{ background: "var(--coral)", color: "var(--coral-ink)", border: "none", borderRadius: "var(--r-sm)", padding: "9px 14px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Grant a folder</button>
              <span className="note" style={{ margin: 0 }}>folder: {st.fsName}</span>
            </div>
            <div className="note">The granted folder is a <b>local-bind mount</b>: <code>fs_list</code> · <code>fs_read</code> · <code>fs_write</code> · <code>apply_patch</code>. OPFS gives private <code>mem_*</code> tools. Shell (<code>bash</code>) is the <b>Unix-local</b> tool, active when the bridge runs.</div></div>

          <div className="field"><label>GitHub repo → workspace</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input placeholder="owner/repo  (optionally @ref)" style={{ flex: 1 }} value={repoSpec} onChange={(e) => setRepoSpec(e.target.value)} />
              <button onClick={() => addRepo(repoSpec)} style={{ background: "var(--coral)", color: "var(--coral-ink)", border: "none", borderRadius: "var(--r-sm)", padding: "0 15px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Clone</button>
            </div>
            {st.repoSt && <div className="note" style={{ marginTop: 6 }}>{st.repoSt}</div>}
            <div className="note">Clones a public repo's files into OPFS (<code>repos/&lt;owner&gt;_&lt;repo&gt;/</code>) — the browser's <code>gitRepo()</code> workspace entry, materialized with a concurrency-tuned parallel download. The agent reads them via <code>mem_*</code>.</div></div>

          <div className="field"><label>Snapshots — workspace + conversation</label>
            <div>
              {st.snaps.map((n) => (
                <div key={n} className="srow">
                  <span className="stitle" onClick={() => { restoreSnapshot(n); close(); }}>{n}</span>
                  <button className="sx" onClick={() => deleteSnapshot(n)}>×</button>
                </div>
              ))}
              {!st.snaps.length && <div className="note" style={{ margin: 0 }}>none</div>}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <input placeholder="snapshot name" style={{ flex: 1 }} value={snapName} onChange={(e) => setSnapName(e.target.value)} />
              <button onClick={() => { snapshotWorkspace(snapName, messages); setSnapName(""); }} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "0 15px", color: "var(--ink)", fontSize: "0.8rem", cursor: "pointer" }}>Snapshot</button>
            </div>
            <div className="note">Saves the OPFS workspace + this conversation. Restore seeds a fresh session from it. (Plain resume across reloads is automatic — OPFS + IndexedDB persist, so the agent's sandbox is developer-owned and durable.)</div></div>

          <div className="field"><label>MCP servers</label>
            <div>
              {st.mcpView.map((s, i) => (
                <div key={s.label + i} className="mcprow">
                  <span className={"dot " + (s.connected ? "ok" : s.error ? "err" : "")} />
                  <span className="ml">{s.label}</span><span className="mt">{s.transport}</span>
                  <span className="mc">{s.connected ? s.tools + " tools" : s.error ? "error" : "…"}</span>
                  <button className="mx" onClick={() => removeMcpServer(i)}>×</button>
                </div>
              ))}
              {!st.mcpView.length && <div className="note" style={{ margin: 0 }}>none</div>}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <input placeholder="label" style={{ width: 78 }} value={mcpLabel} onChange={(e) => setMcpLabel(e.target.value)} />
              <select style={{ width: 78 }} value={mcpTransport} onChange={(e) => setMcpTransport(e.target.value as "http" | "stdio")}><option value="http">HTTP</option><option value="stdio">stdio</option></select>
              <input placeholder="https://…/mcp   or   npx -y @modelcontextprotocol/server-everything" style={{ flex: 1, minWidth: 160 }} value={mcpTarget} onChange={(e) => setMcpTarget(e.target.value)} />
              <button onClick={() => { if (!mcpTarget.trim()) return; addMcpServer((mcpLabel || "mcp").trim().replace(/[^a-zA-Z0-9_-]/g, "_"), mcpTransport, mcpTarget.trim(), mcpAuth.trim()); setMcpLabel(""); setMcpTarget(""); setMcpAuth(""); }} style={{ background: "var(--coral)", color: "var(--coral-ink)", border: "none", borderRadius: "var(--r-sm)", padding: "0 15px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Add</button>
            </div>
            <input placeholder="auth token (optional, for HTTP servers)" style={{ marginTop: 6, width: "100%" }} value={mcpAuth} onChange={(e) => setMcpAuth(e.target.value)} />
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: "0.82rem", color: "var(--ink-mid)", cursor: "pointer" }}>
              <input type="checkbox" checked={approve} onChange={(e) => { setApprove(e.target.checked); S.approve = e.target.checked; }} /> Require approval before running any tool call
            </label>
            <div className="note"><b>Streamable HTTP</b> connects directly (LNA-gated for local; auth + headers supported). <b>stdio</b> runs the command through the bridge daemon over LNA. Tools become the agent's tools (prefixed <code>mcp_&lt;label&gt;_</code>). Hosted MCP tools aren't listed — they route through OpenAI's Responses API and need an OpenAI model, not a local one.</div></div>

          <div className="field"><label>System prompt</label>
            <textarea rows={4} spellCheck={false} placeholder="(using the built-in AUTOMO default — describe custom behavior here to override)" style={{ fontFamily: "inherit", resize: "vertical", lineHeight: 1.5 }} value={instructions} onChange={(e) => setInstructions(e.target.value)} onBlur={() => { S.instructions = instructions; }} />
            <div className="note">The LLM context. Sent as <code>instructions</code> on every turn, with live run context appended (model, granted folder, MCP servers, date). Blank = the built-in default.</div></div>

          <div className="field"><label>Context budget (characters)</label>
            <input type="number" min={2000} step={1000} value={budget} onChange={(e) => { const v = Math.max(2000, +e.target.value || 16000); setBudget(v); S.budget = v; }} />
            <div className="note">History is trimmed to this size before each turn (oldest messages drop first, tool call/output pairs kept together) so long chats + tool loops don't overflow the model.</div></div>

          <div>
            <label style={{ fontSize: "0.7rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)" }}>Local capabilities</label>
            <div className="caps" style={{ marginTop: 9 }}>
              <div className="cap"><span className={"dot " + st.caps.model.dot} /><span className="nm">Model</span><span>Ollama over LNA</span><span className="st">{st.caps.model.text}</span></div>
              <div className="cap"><span className={"dot " + st.caps.bridge.dot} /><span className="nm">Tools / shell</span><span>bridge daemon</span><span className="st">{st.caps.bridge.text}</span></div>
              <div className="cap"><span className={"dot " + st.caps.files.dot} /><span className="nm">Files</span><span>File System Access</span><span className="st">{st.caps.files.text}</span></div>
              <div className="cap"><span className="dot ok" /><span className="nm">Memory</span><span>OPFS (private)</span><span className="st">ready</span></div>
            </div>
          </div>

          <button className="ghost" onClick={() => { clear(); close(); }}>Clear conversation</button>
          <div className="privacy"><b>Local-first.</b> AUTOMO is a static page on GitHub Pages. It has no server. Your messages go straight to the model on your machine and stay there. Connection settings and chat history live in this browser only.</div>
        </div>
      </aside>
    </>
  );
}
