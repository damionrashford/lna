// Bridge auth handshake (browser side). The bridge issues a per-connection nonce; the client proves it
// knows the shared token by returning HMAC-SHA256(token, nonce) rather than the token itself, so the
// secret never crosses the wire and a captured handshake cannot be replayed on a new connection.
// Uses Web Crypto SubtleCrypto (requires a secure context).
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The auth frame sent in response to the bridge's hello. Falls back to the plaintext token when an
// older bridge sends no nonce, so a stale cached page still connects.
export async function authFrame(token: string, nonce: unknown): Promise<string> {
  return typeof nonce === "string" && nonce
    ? JSON.stringify({ type: "auth", hmac: await hmacHex(token, nonce) })
    : JSON.stringify({ type: "auth", token });
}
