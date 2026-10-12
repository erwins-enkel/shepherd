import { expect, test } from "vitest";
import { buildPairingPayload, pairingServer } from "./pairing";
test("payload escapes the address and code as independent query values", () => {
  const url = new URL(buildPairingPayload("https://server.ts.net:443", "shpp_ab+c&x"));
  expect(url.protocol).toBe("shepherd:");
  expect(url.host).toBe("pair");
  expect(url.searchParams.get("server")).toBe("https://server.ts.net:443");
  expect(url.searchParams.get("code")).toBe("shpp_ab+c&x");
});
test("loopback uses the preview host while remote browsers keep their origin", () => {
  for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])
    expect(pairingServer(origin, "server.ts.net")).toEqual({
      server: "https://server.ts.net",
      loopback: true,
    });
  expect(pairingServer("https://example.com", "server.ts.net")).toEqual({
    server: "https://example.com",
    loopback: false,
  });
  expect(pairingServer("http://localhost:3000")).toEqual({
    server: "http://localhost:3000",
    loopback: true,
  });
});
