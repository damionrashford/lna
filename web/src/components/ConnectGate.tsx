import { useStore } from "../store";
import { connect } from "../lib/agent";

function copy(text: string, e: { currentTarget: HTMLButtonElement }) {
  const btn = e.currentTarget;
  navigator.clipboard.writeText(text).catch(() => {});
  btn.textContent = "copied"; setTimeout(() => (btn.textContent = "copy"), 1200);
}

export default function ConnectGate() {
  const { connecting, diag, machine } = useStore();
  const origin = location.origin;
  const ollamaCmd = `OLLAMA_ORIGINS='${origin}' ollama serve`;
  return (
    <section className="gate">
      <div className="badge" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 2l2.4 6.5L21 11l-6.6 2.5L12 20l-2.4-6.5L3 11l6.6-2.5z" /></svg>
      </div>
      <h2>Connect to your machine</h2>
      <p>AUTOMO runs in this browser but thinks on <b>your</b> computer. The model never leaves your machine — this page just talks to it over Local Network Access.</p>
      <div className="steps">
        <div className="step"><div className="n">1</div><div className="b">Start Ollama, allowing this page
          <div className="d">So your model accepts requests from this origin (CORS).</div>
          <pre><button className="copy" onClick={(e) => copy(ollamaCmd, e)}>copy</button><span>{ollamaCmd}</span></pre></div></div>
        <div className="step"><div className="n">2</div><div className="b">Pull a model (once)
          <pre><button className="copy" onClick={(e) => copy("ollama pull llama3.2", e)}>copy</button><span>ollama pull llama3.2</span></pre></div></div>
        <div className="step"><div className="n">3</div><div className="b">Connect &amp; grant the prompt
          <div className="d">Chrome will ask to allow local-network access. Click Allow.</div></div></div>
      </div>
      {machine && (
        <div className="diag" style={{ marginTop: 4, textAlign: "left" }}>
          <b>Your machine</b>{machine.summary ? ` — ${machine.summary}` : ""}: <b>{machine.tier}</b> tier. {machine.note}<br />
          <span style={{ color: "var(--muted)" }}>Suggested: {machine.examples.join(" · ")}</span>
        </div>
      )}
      <button className="cta" disabled={connecting} onClick={() => connect()}>
        <span>{connecting ? "connecting…" : "Connect to your machine"}</span>
      </button>
      {diag.show && <div className="diag" dangerouslySetInnerHTML={{ __html: diag.html }} />}
      <div className="foot">Your model, files, and shell stay on your machine. (Web search, if the agent uses it, fetches through a public proxy.)</div>
    </section>
  );
}
