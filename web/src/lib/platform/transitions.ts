// Wrap a state change that swaps large regions of the UI (connect screen → chat) in a View Transition so
// the browser cross-fades old and new frames. flushSync forces React to commit the update inside the
// transition callback, which is what the API captures. Where View Transitions are unsupported, the update
// runs directly.
import { flushSync } from "react-dom";

export function viewTransition(update: () => void): void {
  const start = (document as any).startViewTransition?.bind(document);
  if (!start) { update(); return; }
  start(() => flushSync(update));
}
