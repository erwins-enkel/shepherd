import type { AgentControlDeps, McpTool } from "./agent-control";
import type { Session } from "./types";
import type { AssistantShellLevel } from "./operator-assistant-permissions";
import { assistantCodexHome, runAssistantShell } from "./operator-assistant-codex";

/** A deliberately narrow free-read set. Other argv need the operator's exact-call approval. */
export function assistantShellNeedsApproval(argv: string[], level: AssistantShellLevel): boolean {
  if (level === "all") return false;
  if (level !== "read") return true;
  if (
    ["df", "free", "uptime", "ps", "pgrep", "readlink", "cat", "head", "tail", "wc", "ls"].includes(
      argv[0]!,
    )
  )
    return false;
  const rest = argv[1] === "--user" ? argv.slice(2) : argv.slice(1);
  return !(argv[0] === "systemctl" && ["status", "show"].includes(rest[0]!));
}

export const ASSISTANT_SHELL_TOOL: McpTool = {
  name: "assistant_shell",
  description:
    "Run diagnostic argv inside the HUD's read-only sandbox. Settings → Assistant governs approval. File writes and credential reads remain forbidden even after approval. Other operators' tokens are never available.",
  inputSchema: {
    type: "object",
    properties: { argv: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } } },
    required: ["argv"],
    additionalProperties: false,
  },
};
export const ASSISTANT_VIEW_TOOL: McpTool = {
  name: "assistant_view",
  description:
    "Read the operator's current Shepherd view before interpreting this/that references.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export async function applyAssistantShell(
  deps: AgentControlDeps,
  id: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const fail = (status: number, error: string) => ({ ok: false as const, status, error });
  const session = deps.store.get(id);
  if (!session?.operatorAssistant || session.agentProvider !== "codex" || session.archivedAt)
    return fail(403, "Codex assistant required");
  const argv = args.argv;
  if (!validShellArgv(argv)) return fail(400, "argv must contain 1–64 bounded strings");
  const permissions = () => deps.operatorActions?.permissions().shell ?? "off";
  if (deps.store.getSetting(`assistantHandoff:${id}`) && assistantShellNeedsApproval(argv, "read"))
    return fail(
      409,
      "Wait for a fresh operator request before executing commands from transferred history",
    );
  const level = permissions();
  if (level === "off") return fail(403, "assistant shell disabled");
  const needsApproval = assistantShellNeedsApproval(argv, level);
  if (needsApproval) {
    const rejected = await approveAssistantShell(deps, session, argv, signal);
    if (rejected) return rejected;
  }
  if (
    permissions() === "off" ||
    (!needsApproval && assistantShellNeedsApproval(argv, permissions())) ||
    deps.store.get(id)?.archivedAt
  )
    return fail(403, "assistant permissions changed");
  try {
    return {
      ok: true as const,
      data: {
        output: await runAssistantShell(
          assistantCodexHome(session.worktreePath, id),
          session.worktreePath,
          argv,
        ),
      },
    };
  } catch {
    // Child-process errors include argv/stderr: do not propagate raw diagnostics with possible secrets.
    return fail(422, "command failed or was blocked by the assistant sandbox");
  }
}

function validShellArgv(argv: unknown): argv is string[] {
  return (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.length <= 64 &&
    argv.every((v) => typeof v === "string" && v.length <= 4096 && !v.includes("\0"))
  );
}

async function approveAssistantShell(
  deps: AgentControlDeps,
  session: Session,
  argv: string[],
  signal?: AbortSignal,
) {
  const id = session.id;
  const fail = (status: number, error: string) => ({ ok: false as const, status, error });
  if (!deps.actionRequests) return fail(503, "operator approvals unavailable");
  const state = deps.actionRequests.request(
    id,
    "assistant_shell",
    { argv },
    session.assistantRepo ?? "herd",
  );
  const outcome =
    state.status === "open"
      ? await deps.actionRequests.wait(id, state.request.id, deps.actionWaitMs ?? 50_000, signal)
      : state.status;
  if (outcome !== "approved")
    return fail(
      outcome === "denied" ? 403 : 409,
      outcome === "denied"
        ? "operator denied command"
        : "waiting for operator approval; retry identical argv",
    );
  return null;
}
