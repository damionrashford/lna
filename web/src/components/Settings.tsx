import { useState } from "react";
import { useStore, S, set, setProfileName } from "../store";
import { getProfile, saveProfile, type Tone } from "../lib/runtime/context/profile";
import { enqueueTask } from "../lib/runtime/autonomy/tasks";
import {
  createSession, switchSession, deleteSession, pullModel,
  addRepo, snapshotWorkspace, restoreSnapshot, deleteSnapshot,
} from "../lib/agent";
import { grantFolder } from "../lib/storage/opfs";
import { addMcpServer, removeMcpServer } from "../lib/mcp/index";
import { useAutomoChat } from "../chat";

export default function Settings() {
  const st = useStore();
  const { messages, clear } = useAutomoChat();
  const [url, setUrl] = useState(S.url);
  const [model, setModel] = useState(S.model);
  const [vision, setVision] = useState(S.vision);
  const [image, setImage] = useState(S.image);
  const [instructions, setInstructions] = useState(S.instructions);
  const [bridgeToken, setBridgeToken] = useState(S.bridgeToken);
  const [provider, setProvider] = useState<string>(S.provider);
  const [sandbox, setSandbox] = useState<string>(S.sandbox);
  const [vllmUrl, setVllmUrl] = useState(S.vllmUrl);
  const [hfToken, setHfToken] = useState(S.hfToken);
  const [approve, setApprove] = useState(S.approve);
  const [guardrails, setGuardrails] = useState(S.guardrails);
  const [pullName, setPullName] = useState("");
  const [repoSpec, setRepoSpec] = useState("");
  const [snapName, setSnapName] = useState("");
  const [mcpLabel, setMcpLabel] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"http" | "stdio" | "inpage">("http");
  const [mcpTarget, setMcpTarget] = useState("");
  const [mcpAuth, setMcpAuth] = useState("");
  const [autonomous, setAutonomous] = useState(S.autonomous);
  const [taskText, setTaskText] = useState("");
  const [pname, setPname] = useState(getProfile().name);
  const [pfocus, setPfocus] = useState(getProfile().focus);
  const [ptone, setPtone] = useState<Tone>(getProfile().tone);

  const close = () => set({ drawerOpen: false });

  return (
    <>
      <div className={"scrim" + (st.drawerOpen ? " open" : "")} onClick={close} />
      <aside className={"drawer" + (st.drawerOpen ? " open" : "")} aria-label="Settings">
        <div className="dh"><h3>Settings</h3><div className="spacer" />
          <button className="iconbtn" aria-label="Close" onClick={close}><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </div>
        <div className="body">
          <div className="field"><label>You</label>
            <input placeholder="your name" value={pname} onChange={(e) => { setPname(e.target.value); }} onBlur={() => { saveProfile({ name: pname.trim() }); setProfileName(pname.trim()); }} />
            <input placeholder="what you mostly work on" value={pfocus} onChange={(e) => setPfocus(e.target.value)} onBlur={() => saveProfile({ focus: pfocus.trim() })} style={{ marginTop: 6 }} />
            <select value={ptone} onChange={(e) => { const t = e.target.value as Tone; setPtone(t); saveProfile({ tone: t }); }} style={{ marginTop: 6 }}>
              <option value="">Default tone</option>
              <option value="warm">Warm — friendly and encouraging</option>
              <option value="concise">Straight up — short, answer first</option>
              <option value="technical">Technical — precise, assumes expertise</option>
            </select>
            <div className="note">Personalizes your greeting and how the assistant talks to you. Stays on this device — no account, nothing sent anywhere.</div></div>

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
            <div className="note">Every conversation is saved on this device and picks up where you left off — open one to switch back to it.</div></div>

          <div className="field"><label>Inference backend</label>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); S.provider = e.target.value; }}>
              <option value="ollama">Ollama (local)</option>
              <option value="vllm">vLLM (native Responses — full capability)</option>
              <option value="huggingface">HuggingFace (remote)</option>
              <option value="browser">In-browser (transformers.js / WebGPU)</option>
              <option value="webllm">In-browser (web-llm / MLC / WebGPU)</option>
            </select>
            {provider === "vllm" && <input type="text" spellCheck={false} placeholder="http://localhost:8000" value={vllmUrl} onChange={(e) => setVllmUrl(e.target.value)} onBlur={() => { S.vllmUrl = vllmUrl.trim(); }} style={{ marginTop: 6 }} />}
            {provider === "huggingface" && <input type="text" spellCheck={false} placeholder="hf_… token" value={hfToken} onChange={(e) => setHfToken(e.target.value)} onBlur={() => { S.hfToken = hfToken.trim(); }} style={{ marginTop: 6 }} />}
            <div className="note"><b>vLLM</b> unlocks native <code>apply_patch</code> + compaction (no shim). Ollama/HF fall back to function tools. In-browser is generation-only (no agent tools yet).</div></div>

          <div className="field"><label>Sandbox backend</label>
            <select value={sandbox} onChange={(e) => { setSandbox(e.target.value); S.sandbox = e.target.value; }}>
              <option value="bridge">Bridge daemon (real Unix on your machine)</option>
              <option value="inbrowser">In-browser (Pyodide + bash + git — zero install)</option>
            </select>
            <div className="note"><b>Bridge</b> lets the assistant use the real terminal and files on your computer — full power (start it with <code>bun run bridge</code>). <b>In-browser</b> gives it a safe sandbox that runs right in this page — nothing to install, but it can't reach your real files. Takes effect on your next new chat.</div></div>

          <div className="field"><label>Model endpoint (Ollama)</label>
            <input type="text" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => { S.url = url.trim(); }} />
            <div className="note">Where your model runs on this computer. Chrome asks permission once, then remembers.</div></div>

          <div className="field"><label>Bridge token</label>
            <input type="text" spellCheck={false} value={bridgeToken} onChange={(e) => setBridgeToken(e.target.value)} onBlur={() => { S.bridgeToken = bridgeToken.trim(); }} />
            <div className="note">Must match <code>BRIDGE_TOKEN</code> the daemon was started with (default <code>dev</code>). The token is the whole perimeter on the bridge — change both if you ever expose it beyond loopback.</div></div>

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

          <div className="field"><label>Workspace mirror (real disk)</label>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <button onClick={() => grantFolder()} style={{ background: "var(--coral)", color: "var(--coral-ink)", border: "none", borderRadius: "var(--r-sm)", padding: "9px 14px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Grant a folder</button>
              <span className="note" style={{ margin: 0 }}>folder: {st.fsName}</span>
            </div>
            <div className="note">The agent's files live in a real Unix workspace on your machine (via the bridge). Grant a folder and AUTOMO mirrors that workspace into <code>&lt;folder&gt;/workspace/</code> after every turn — open and edit what it made in Finder. Without a folder the workspace still survives reloads: it's gzip-cached per session in private browser storage (OPFS).</div></div>

          <div className="field"><label>GitHub repo → workspace</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input placeholder="owner/repo  (optionally @ref)" style={{ flex: 1 }} value={repoSpec} onChange={(e) => setRepoSpec(e.target.value)} />
              <button onClick={() => addRepo(repoSpec)} style={{ background: "var(--coral)", color: "var(--coral-ink)", border: "none", borderRadius: "var(--r-sm)", padding: "0 15px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Clone</button>
            </div>
            {st.repoSt && <div className="note" style={{ marginTop: 6 }}>{st.repoSt}</div>}
            <div className="note">Clones a public repo into the agent's real sandbox workspace (<code>repos/&lt;owner&gt;_&lt;repo&gt;/</code>) via <code>gitRepo()</code> materialization over the bridge. The agent reads it with its shell + filesystem tools.</div></div>

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
            <div className="note">Saves the real sandbox workspace (a tar via the bridge) + this conversation. Restore seeds a fresh session from it. Plain resume across reloads is automatic — the workspace is gzip-cached in OPFS per session and rehydrated on open.</div></div>

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
              <select style={{ width: 78 }} value={mcpTransport} onChange={(e) => setMcpTransport(e.target.value as "http" | "stdio" | "inpage")}><option value="http">HTTP</option><option value="stdio">stdio</option><option value="inpage">in-page</option></select>
              <input placeholder={mcpTransport === "inpage" ? "in-page server name (e.g. browser)" : "https://…/mcp   or   npx -y @modelcontextprotocol/server-everything"} style={{ flex: 1, minWidth: 160 }} value={mcpTarget} onChange={(e) => setMcpTarget(e.target.value)} />
              <button onClick={() => { if (!mcpTarget.trim()) return; addMcpServer((mcpLabel || "mcp").trim().replace(/[^a-zA-Z0-9_-]/g, "_"), mcpTransport, mcpTarget.trim(), mcpAuth.trim()); setMcpLabel(""); setMcpTarget(""); setMcpAuth(""); }} style={{ background: "var(--coral)", color: "var(--coral-ink)", border: "none", borderRadius: "var(--r-sm)", padding: "0 15px", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}>Add</button>
            </div>
            <input placeholder="auth token (optional, for HTTP servers)" style={{ marginTop: 6, width: "100%" }} value={mcpAuth} onChange={(e) => setMcpAuth(e.target.value)} />
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: "0.82rem", color: "var(--ink-mid)", cursor: "pointer" }}>
              <input type="checkbox" checked={approve} onChange={(e) => { setApprove(e.target.checked); S.approve = e.target.checked; }} /> Require approval before running any tool call
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: "0.82rem", color: "var(--ink-mid)", cursor: "pointer" }}>
              <input type="checkbox" checked={guardrails} onChange={(e) => { setGuardrails(e.target.checked); S.guardrails = e.target.checked; }} /> Credential guardrails (block pasted/leaked secrets; redact tool output)
            </label>
            <div className="note"><b>Streamable HTTP</b> connects directly (LNA-gated for local; auth + headers supported). <b>stdio</b> runs the command through the bridge daemon over LNA. Tools become the agent's tools (prefixed <code>mcp_&lt;label&gt;_</code>). Hosted MCP tools aren't listed — they route through OpenAI's Responses API and need an OpenAI model, not a local one.</div></div>

          <div className="field"><label>Autonomous mode</label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem", color: "var(--ink-mid)", cursor: "pointer" }}>
              <input type="checkbox" checked={autonomous} onChange={async (e) => { const on = e.target.checked; setAutonomous(on); S.autonomous = on; if (on) void (await import("../lib/platform/notify")).requestNotifyPermission(); const s = await import("../lib/runtime/autonomy/scheduler"); on ? s.startScheduler() : s.stopScheduler(); }} /> Let AUTOMO work on queued tasks on its own
            </label>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <input placeholder="queue a task for AUTOMO to do…" style={{ flex: 1 }} value={taskText} onChange={(e) => setTaskText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && taskText.trim()) { enqueueTask({ prompt: taskText.trim() }); setTaskText(""); } }} />
              <button disabled={!autonomous || !taskText.trim()} onClick={() => { enqueueTask({ prompt: taskText.trim() }); setTaskText(""); }} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "0 15px", color: "var(--ink)", fontSize: "0.8rem", cursor: "pointer" }}>Queue</button>
            </div>
            <div className="note">The agent runs queued tasks by itself using the same tools + sandbox. It only runs while this tab is open — the browser gives no reliable background scheduling, so treat it as "runs when I'm around," not a guaranteed cron. Approval + guardrails still apply; a task needing approval waits for you.</div></div>

          <div className="field"><label>System prompt</label>
            <textarea rows={4} spellCheck={false} placeholder="(using the built-in AUTOMO default — describe custom behavior here to override)" style={{ fontFamily: "inherit", resize: "vertical", lineHeight: 1.5 }} value={instructions} onChange={(e) => setInstructions(e.target.value)} onBlur={() => { S.instructions = instructions; }} />
            <div className="note">The LLM context. Sent as <code>instructions</code> on every turn, with live run context appended (model, granted folder, MCP servers, date). Blank = the built-in default.</div></div>

          <div>
            <label style={{ fontSize: "0.7rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)" }}>Local capabilities</label>
            <div className="caps" style={{ marginTop: 9 }}>
              <div className="cap"><span className={"dot " + st.caps.model.dot} /><span className="nm">Model</span><span>Ollama over LNA</span><span className="st">{st.caps.model.text}</span></div>
              <div className="cap"><span className={"dot " + st.caps.bridge.dot} /><span className="nm">Tools / shell</span><span>bridge daemon</span><span className="st">{st.caps.bridge.text}</span></div>
              <div className="cap"><span className={"dot " + st.caps.files.dot} /><span className="nm">Mirror</span><span>folder (real disk)</span><span className="st">{st.caps.files.text}</span></div>
              <div className="cap"><span className="dot ok" /><span className="nm">Memory</span><span>OPFS (private)</span><span className="st">ready</span></div>
            </div>
          </div>

          <button className="ghost" onClick={() => { clear(); close(); }}>Clear conversation</button>
          <div className="privacy"><b>Local-first.</b> AUTOMO is a static page on GitHub Pages. It has no server. Your messages go straight to the model on your machine and stay there; connection settings and chat history live in this browser only. Two caveats: the shell + filesystem tools run <b>real, unsandboxed commands</b> on your machine — treat the agent's shell as full local access and use approval mode for untrusted prompts; and <b>web search</b>, if the agent uses it, fetches through a public CORS proxy.</div>
        </div>
      </aside>
    </>
  );
}
