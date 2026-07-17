import { useStore } from "../store";

// Live view of the agent's plan (the update_plan tool writes store.plan). Shows only while a plan
// exists; a finished/cleared plan hides itself. Each step shows its state at a glance.
const MARK = { completed: "✓", in_progress: "▸", pending: "○" } as const;

export default function Plan() {
  const { plan } = useStore();
  if (!plan.length) return null;
  const done = plan.filter((s) => s.status === "completed").length;
  return (
    <div className="plan">
      <div className="plan-head">Plan · {done}/{plan.length}</div>
      <ul className="plan-list">
        {plan.map((s, i) => (
          <li key={i} className={"plan-step " + s.status}>
            <span className="plan-mark">{MARK[s.status]}</span>
            <span className="plan-title">{s.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
