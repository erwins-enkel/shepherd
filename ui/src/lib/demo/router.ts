// Thin demo API router. Task 2 only needs the transport proven, so this is a
// starter: an exact `/api/me` handler (200 authenticated, matching what `getMe`
// in api.ts probes) plus a permissive, never-throwing fallback for everything
// else. Task 3 replaces the fallback with state-backed handlers seeded from the
// demo world, returning rich shapes for the showcased panels.

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Map an intercepted `/api/**` request to a Response. Always resolves; never throws. */
export async function handleApi(method: string, url: URL, body: unknown): Promise<Response> {
  const path = url.pathname;
  const m = method.toUpperCase();
  void body; // reserved for the Task 3 state-backed handlers (mutations read it)

  // `getMe` treats any 200 as authenticated (it only reads `r.ok`).
  if (m === "GET" && path === "/api/me") return json({ authenticated: true });

  // Task 3: state-backed handlers replace the permissive fallback below.

  // Permissive fallback: unmatched read → benign empty object; unmatched mutation
  // → a generic success. Keeps the demo UI from erroring on off-screen endpoints.
  if (m === "GET") return json({});
  return json({ ok: true });
}
