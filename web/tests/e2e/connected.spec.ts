// E2E: the CONNECTED app — the part a headless runner can't reach for real (no local Ollama over LNA),
// unlocked by mocking the model discovery endpoint. connect() → refreshModels() fetches `/api/tags`; we
// fulfill it with a fake model list, so clicking "Connect" flips the app into its chat shell. This is how
// the composer, header, and settings surfaces become testable without a backend.
import { test, expect, type Page } from "@playwright/test";

// Just click the gate CTA — the fake model list is served by the fetch override installed in beforeEach.
async function connect(page: Page) {
  await page.getByRole("button", { name: /connect to your machine/i }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // skip the first-run overlay so it can't race the connect button
    localStorage.setItem("automo.profile", JSON.stringify({ onboarded: true }));
    // Fake a reachable Ollama by overriding fetch for /api/tags. The app's localFetch always sets
    // targetAddressSpace:"loopback" (a Local-Network-Access hint) which headless Linux Chromium routes
    // outside page.route's reach — so we stub at the fetch level instead: OS-independent, no real network.
    const orig = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.includes("/api/tags"))
        return Promise.resolve(new Response(JSON.stringify({ models: [{ name: "llama3.2" }] }), { status: 200, headers: { "content-type": "application/json" } }));
      return orig(input as any, init);
    }) as typeof fetch;
  });
  await page.goto("/");
});

test("connecting reveals the chat composer and hides the gate", async ({ page }) => {
  await connect(page);
  // the composer only renders once connected
  await expect(page.getByPlaceholder("Ask anything…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  // the connect gate is gone
  await expect(page.getByRole("heading", { name: "Connect to your machine" })).toBeHidden();
});

test("the composer accepts input", async ({ page }) => {
  await connect(page);
  const box = page.getByPlaceholder("Ask anything…");
  await box.fill("hello automo");
  await expect(box).toHaveValue("hello automo");
});

test("settings drawer opens from the header", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".drawer, .settings, [class*='drawer']").first()).toBeVisible();
});
