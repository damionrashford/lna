# LNA — the complete Local Network Access surface

A single-page reference covering the entire [Local Network Access](https://wicg.github.io/local-network-access/) (LNA) surface in one reading order:

1. **Threat model** — drive-by pharming, router CSRF, localhost server abuse, why CORS doesn't help
2. **Address spaces** — `public` / `local` / `loopback`, the *less public* ordering, and the full non-public IP block table
3. **Permission model** — `local-network`, `loopback-network`, the `local-network-access` alias, secure contexts, Permissions-Policy delegation, CSP `treat-as-public-address`
4. **API surface** — `fetch()` `targetAddressSpace`, mixed-content exemptions, Permissions API, WebSockets / WebTransport / workers / HTTP cache behavior
5. **Limits & caveats** — DNS rebinding, cross-network confusion, local attackers, proxies, cache probing
6. **Timeline** — Chrome 138 flag → 139+ origin trial & enterprise policy → 142 prompt launch
7. **Prepare** — an 8-step migration checklist

**Live site:** https://damionrashford.github.io/lna/
**Test platform:** https://damionrashford.github.io/lna/test.html

## Local testing

LNA only fires when the page is a **public** origin and the fetch target is local/loopback. Opened from `localhost` the page is itself loopback, so nothing triggers. To test:

1. Enable enforcement: `chrome://flags/#local-network-access-check` → **Enabled (Blocking)** (Chrome 138–141; 142+ enforces by default).
2. Run the daemon: `bun test-server.ts` → serves `127.0.0.1:7966` (CORS JSON + WebSocket echo).
3. Open the **public** test platform (the GitHub Pages URL above, or a tunnel that fronts your local build) and run the suite. Grant the prompt to watch verdicts flip.

## Sources

- [WICG Local Network Access spec](https://wicg.github.io/local-network-access/) (Draft CG Report, 18 Jun 2026)
- [Chrome blog: New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [MDN: Local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access) + `Request.targetAddressSpace` and Permissions-Policy reference pages

Unofficial reference — not affiliated with Google or Mozilla. Static site, no build step: `index.html` is everything.
