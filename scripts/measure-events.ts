/** Read-only /events measurement. Env: SHEPHERD_SESSION_BASE_URL, SHEPHERD_SESSION_TOKEN.
 * Usage: bun run scripts/measure-events.ts [stationary-seconds=180] [warmup-seconds=5]
 * Counts uncompressed JSON bytes, excluding WebSocket/TLS overhead; never logs payloads.
 */
interface Totals {
  count: number;
  bytes: number;
  events: Record<string, { count: number; bytes: number; maxBytes: number }>;
}
const totals = (): Totals => ({ count: 0, bytes: 0, events: Object.create(null) });

export function measureEvents(origin: URL, token: string, durationMs: number, warmupMs = 5_000) {
  const url = new URL("/events", origin);
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return new Promise<{ warmup: Totals; stationary: Totals; durationMs: number }>(
    (resolve, reject) => {
      const warmup = totals();
      const stationary = totals();
      let started = 0;
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as never);
      const fail = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        ws.close();
        reject(new Error("Event connection failed or closed before measurement completed"));
      };
      timer = setTimeout(fail, 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        started = performance.now();
        timer = setTimeout(() => {
          finished = true;
          ws.close();
          resolve({ warmup, stationary, durationMs });
        }, warmupMs + durationMs);
      };
      ws.onmessage = ({ data }) => {
        if (finished || typeof data !== "string") return;
        const frame = JSON.parse(data) as { event?: unknown };
        const name = typeof frame.event === "string" ? frame.event : "<unknown>";
        const target = performance.now() - started < warmupMs ? warmup : stationary;
        const bytes = Buffer.byteLength(data);
        const row = (target.events[name] ??= { count: 0, bytes: 0, maxBytes: 0 });
        row.count++;
        row.bytes += bytes;
        row.maxBytes = Math.max(row.maxBytes, bytes);
        target.count++;
        target.bytes += bytes;
      };
      ws.onerror = fail;
      ws.onclose = fail;
    },
  );
}

if (import.meta.main) {
  const origin = new URL(process.env.SHEPHERD_SESSION_BASE_URL ?? "http://127.0.0.1:7331");
  const token = process.env.SHEPHERD_SESSION_TOKEN;
  const seconds = Number(process.argv[2] ?? 180);
  const warmup = Number(process.argv[3] ?? 5);
  if (!token || !Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(warmup) || warmup < 0)
    throw new Error("Set SHEPHERD_SESSION_TOKEN and supply valid measurement durations");
  if (
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      ))
  )
    throw new Error("Use an HTTPS origin or loopback HTTP without URL credentials");
  try {
    console.log(
      JSON.stringify(await measureEvents(origin, token, seconds * 1000, warmup * 1000), null, 2),
    );
  } catch {
    console.error("Event measurement failed");
    process.exitCode = 1;
  }
}
