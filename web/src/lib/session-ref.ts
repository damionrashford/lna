// Holds a reference to the live sandbox session so tools (defined outside agent.ts) can use it
// without an import cycle. agent.ts sets it when a session is created/reset.
/* eslint-disable @typescript-eslint/no-explicit-any */
let active: any = null;
export function setActiveSandbox(s: any) { active = s; }
export function activeSandbox(): any { return active; }
