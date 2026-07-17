// Desktop notifications for events that happen while the tab is backgrounded — an autonomous task
// finishing or blocking on approval. Only fires when permission is granted and the tab is hidden (an
// in-view user already sees the debug log / chat). Permission is requested on a user gesture elsewhere.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function notifyPermission(): string {
  return typeof Notification !== "undefined" ? Notification.permission : "denied";
}

// Request permission — call from a user gesture (e.g. enabling autonomous mode).
export async function requestNotifyPermission(): Promise<string> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return "denied"; }
}

// Notify only when granted AND the tab is hidden (foreground users don't need OS noise).
export function notifyIfHidden(title: string, body: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  try { new Notification(title, { body, tag: "automo", silent: false }); } catch { /* platform refused */ }
}
