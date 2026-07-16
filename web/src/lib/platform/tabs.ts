// BroadcastChannel — keep the conversation list in sync across tabs of the same origin. When one
// tab creates, renames, or deletes a session it writes IndexedDB then pings here; other tabs reload
// their list so the drawer stays consistent. Feature-detected; a no-op where unsupported.
import { set } from "../../store";
import { idbGet } from "../storage/idb";

/* eslint-disable @typescript-eslint/no-explicit-any */
const CHANNEL = "automo-tabs";
let bc: BroadcastChannel | null = null;

export function initTabs(): void {
  try { bc = new BroadcastChannel(CHANNEL); } catch { return; }
  bc.onmessage = async (e) => {
    if (e.data?.type === "sessions") {
      set({ sessions: (await idbGet<any[]>("sessions")) || [] });
    }
  };
}

export function broadcastSessions(): void {
  try { bc?.postMessage({ type: "sessions" }); } catch { /* channel closed */ }
}
