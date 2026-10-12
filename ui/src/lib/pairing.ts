import { normalizeAgentServerUrl } from "./access-token-instructions";

export function pairingServer(
  origin: string,
  previewHost?: string | null,
): {
  server: string;
  loopback: boolean;
} {
  const direct = normalizeAgentServerUrl(origin);
  return {
    server: direct ?? (previewHost && normalizeAgentServerUrl(`https://${previewHost}`)) ?? origin,
    loopback: direct === null,
  };
}

export function buildPairingPayload(server: string, code: string): string {
  return `shepherd://pair?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
}
