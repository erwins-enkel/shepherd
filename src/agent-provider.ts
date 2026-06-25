import { AGENT_PROVIDERS, type AgentProvider } from "./types";

export function normalizeAgentProvider(value: unknown): AgentProvider | null {
  return (AGENT_PROVIDERS as readonly unknown[]).includes(value) ? (value as AgentProvider) : null;
}
