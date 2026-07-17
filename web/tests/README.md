# Tests

New tests are auto-discovered — **just drop a file in the right folder**, no config to touch. CI (`Tests (web/)`) runs both suites on every push/PR, so a new test runs everywhere automatically.

| Kind | Put it here | Named | Runs via | Auto-discovered by |
|---|---|---|---|---|
| Unit (pure functions, fast, no browser) | `tests/unit/` | `*.test.ts` | `bun run test` | `bun test tests/unit` globs `*.test.ts` |
| E2E (real browser against the built app) | `tests/e2e/` | `*.spec.ts` | `bun run test:e2e` | Playwright `testDir: tests/e2e` globs `*.spec.ts` |
| Smoke (headless in-browser module harness) | `tests/smoke/` | — | `bun run smoke:build` | manual (dev-only) |

## Add a unit test

```ts
// tests/unit/my-thing.test.ts
import { test, expect } from "bun:test";
import { myFn } from "../../src/lib/.../my-thing";
test("does the thing", () => expect(myFn(1)).toBe(2));
```
`bun run test` (or `bun run test:watch` for TDD) picks it up immediately.

## Add an E2E test

```ts
// tests/e2e/my-flow.spec.ts
import { test, expect } from "@playwright/test";
test("renders X", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /.../ })).toBeVisible();
});
```
`bun run test:e2e` builds the app (`PUBLIC_PATH=/`), serves `dist/` via `tests/preview.ts`, and runs it across chromium · mobile-chrome · webkit. Use `bun run test:e2e:ui` to author/debug interactively, or `bun run codegen` to record a flow.

## What's testable in E2E

Everything **before** a model connection — the connect gate, layout, responsiveness, copy affordances. A headless runner has no local Ollama over LNA, so don't write E2E that needs a live model; test the UI, and mock the network if a flow needs backend responses.

## Scripts

`test` · `test:watch` · `test:e2e` · `test:e2e:ui` · `test:e2e:headed` · `test:e2e:report` · `test:all` · `codegen` · `preview` · `smoke:build`
