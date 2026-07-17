// Unit tests for the autonomy pure functions — run by `bun test` (NOT Playwright). Kept fast and
// dependency-free: JSON repair, loop-detection fingerprinting, cron next-run math, and the MCP Task
// projection. These guard the trickiest logic in the autonomous loop without needing a browser.
import { test, expect, describe } from "bun:test";
import { repairJson, repairToolArgs } from "../../src/lib/runtime/autonomy/repair";
import { fingerprint, isLooping, clearLoopGuard } from "../../src/lib/runtime/autonomy/loopguard";
import { isValidCron, nextCronRun } from "../../src/lib/runtime/autonomy/cron";
import { toMcpTask, isTerminal, type Task } from "../../src/lib/runtime/autonomy/tasks";

describe("repairJson", () => {
  test("parses clean json", () => expect(repairJson('{"a":1}')).toEqual({ a: 1 }));
  test("strips code fences", () => expect(repairJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  test("extracts json from surrounding prose", () => expect(repairJson('sure: {"pass":true,"reason":"ok"} done')).toEqual({ pass: true, reason: "ok" }));
  test("tolerates trailing commas", () => expect(repairJson('{"a":1,}')).toEqual({ a: 1 }));
  test("tolerates single quotes", () => expect(repairJson("{'pass': true}")).toEqual({ pass: true }));
  test("tolerates unquoted keys", () => expect(repairJson("{pass: false}")).toEqual({ pass: false }));
  test("closes truncated objects", () => expect(repairJson('{"a":1')).toEqual({ a: 1 }));
  test("returns undefined for garbage", () => expect(repairJson("garbage")).toBeUndefined());
  test("repairToolArgs degrades to {}", () => expect(repairToolArgs("nope")).toEqual({}));
  test("repairToolArgs parses an object", () => expect(repairToolArgs('{"path":"x"}')).toEqual({ path: "x" }));
});

describe("loopguard", () => {
  const a = "done id 3f2a1b6c9d4e5f60 at 2026-07-16T01:00:00Z run 1784252305999";
  const b = "done id aa11bb22cc33dd44 at 2026-07-17T09:30:00Z run 1784999999111";
  test("volatile ids/timestamps are stripped → same fingerprint", () => expect(fingerprint(a)).toBe(fingerprint(b)));
  test("genuinely different output → different fingerprint", () => expect(fingerprint("alpha")).not.toBe(fingerprint("beta")));
  test("flags a repeat as looping on the second identical output", () => {
    clearLoopGuard("t1");
    expect(isLooping("t1", a)).toBe(false);
    expect(isLooping("t1", b)).toBe(true);
  });
});

describe("cron", () => {
  test("accepts a valid expression", () => expect(isValidCron("0 9 * * *")).toBe(true));
  test("rejects an invalid expression", () => expect(isValidCron("nonsense xyz")).toBe(false));
  test("computes a numeric next-run", () => expect(typeof nextCronRun("*/5 * * * *")).toBe("number"));
  test("returns null for an invalid expression", () => expect(nextCronRun("nope")).toBeNull());
});

describe("toMcpTask (MCP Tasks projection)", () => {
  const base: Task = {
    id: "t1", goalId: null, prompt: "x", status: "pending", runAfter: 0, deps: [], attempts: 0, maxAttempts: 3,
    budget: { turns: 1, toolCalls: 1, wallMs: 1 }, allowlist: null, replaySafe: true, toolAllowlistLocked: false,
    createdAt: 1784252305000, updatedAt: 1784252306000, ttl: 60000, note: "hi",
  };
  test("maps pending → working on the wire", () => expect(toMcpTask(base).status).toBe("working"));
  test("preserves ttl and note→statusMessage", () => {
    const m = toMcpTask(base);
    expect(m.ttl).toBe(60000);
    expect(m.statusMessage).toBe("hi");
  });
  test("emits ISO timestamps", () => expect(toMcpTask(base).createdAt).toContain("T"));
  test("passes through terminal + input_required statuses", () => {
    expect(toMcpTask({ ...base, status: "input_required" }).status).toBe("input_required");
    expect(toMcpTask({ ...base, status: "completed" }).status).toBe("completed");
  });
  test("isTerminal classifies correctly", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("working")).toBe(false);
    expect(isTerminal("input_required")).toBe(false);
  });
});
