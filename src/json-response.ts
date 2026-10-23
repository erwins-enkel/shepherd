// Only responses created here are known to contain fully buffered JSON. Never consume an
// arbitrary Response body: it may be an SSE/JSON stream, download or precompressed static file.
const bufferedJson = new WeakSet<Response>();

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
  bufferedJson.add(res);
  return res;
}

function acceptsGzip(header: string | null): boolean {
  let gzip: number | undefined;
  let wildcard = 0;
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [coding, ...params] = part.trim().split(";");
    const token = coding?.trim();
    if (token !== "gzip" && token !== "*") continue;
    const q = params
      .map((p) => p.trim())
      .find((p) => p.startsWith("q="))
      ?.slice(2);
    const quality = q === undefined ? 1 : /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(q) ? Number(q) : 0;
    if (token === "gzip") gzip = quality;
    else wildcard = quality;
  }
  return (gzip ?? wildcard) > 0;
}

/** Call before any middleware that replaces the Response object (e.g. cookie restamping). */
export async function compressJsonResponse(req: Request, res: Response): Promise<Response> {
  if (
    !bufferedJson.has(res) ||
    !res.body ||
    res.bodyUsed ||
    req.method === "HEAD" ||
    res.headers.has("content-encoding")
  )
    return res;

  const vary = res.headers.get("vary");
  if (!vary?.split(",").some((v) => ["*", "accept-encoding"].includes(v.trim().toLowerCase())))
    res.headers.set("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  if (!acceptsGzip(req.headers.get("accept-encoding"))) return res;

  const bytes = new Uint8Array(await res.arrayBuffer());
  let output = bytes;
  if (bytes.byteLength >= 1024) {
    const compressed = Bun.gzipSync(bytes);
    if (compressed.byteLength < bytes.byteLength) {
      output = compressed;
      res.headers.set("Content-Encoding", "gzip");
      res.headers.delete("Content-Length");
    }
  }
  return new Response(output, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
