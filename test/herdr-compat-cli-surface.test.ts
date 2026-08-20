import { describe, expect, it } from "bun:test";
import {
  SHEPHERD_HERDR_COMMANDS,
  diffHelp,
  parseHelpSurface,
} from "../scripts/herdr-compat/cli-surface";

const TAB_CREATE_HELP = `Create a tab

Usage: herdr tab create [OPTIONS]

Options:
      --cwd <PATH>
          Working directory for the new tab

      --label <TEXT>
          Label for the new tab

      --no-focus
          Do not focus the created tab

  -h, --help
          Show this help
`;

const WORKSPACE_HELP = `Manage workspaces over the socket API

Usage: herdr workspace [COMMAND]

Commands:
  list             List workspaces
  create           Create a workspace
  get              Show a workspace
  close            Close a workspace

Options:
  -h, --help  Show this help
`;

describe("parseHelpSurface", () => {
  it("extracts long flags from an Options block", () => {
    const s = parseHelpSurface(TAB_CREATE_HELP);
    expect(s.flags).toEqual(expect.arrayContaining(["--cwd", "--label", "--no-focus", "--help"]));
    expect(s.subcommands).toEqual([]);
  });

  it("extracts subcommands from a Commands block", () => {
    const s = parseHelpSurface(WORKSPACE_HELP);
    expect(s.subcommands).toEqual(["list", "create", "get", "close"]);
    expect(s.flags).toContain("--help");
  });

  it("does not treat prose mentions of --flags in descriptions as new flags twice", () => {
    const s = parseHelpSurface("Options:\n      --cwd <PATH>\n          like --cwd above\n");
    expect(s.flags).toEqual(["--cwd"]);
  });
});

describe("diffHelp", () => {
  it("identical help yields no findings", () => {
    expect(diffHelp("tab create", TAB_CREATE_HELP, TAB_CREATE_HELP)).toEqual([]);
  });

  it("a removed flag is fail; an added flag is info", () => {
    const without = TAB_CREATE_HELP.replace(
      / {6}--no-focus\n {10}Do not focus the created tab\n\n/,
      "",
    );
    const removed = diffHelp("tab create", TAB_CREATE_HELP, without);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      command: "tab create",
      kind: "flag-removed",
      item: "--no-focus",
      severity: "fail",
    });

    const added = diffHelp("tab create", without, TAB_CREATE_HELP);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "flag-added", item: "--no-focus", severity: "info" });
  });

  it("a removed subcommand is fail", () => {
    const without = WORKSPACE_HELP.replace(/^ {2}close .*\n/m, "");
    const findings = diffHelp("workspace", WORKSPACE_HELP, without);
    expect(
      findings.some(
        (f) => f.kind === "subcommand-removed" && f.item === "close" && f.severity === "fail",
      ),
    ).toBe(true);
  });

  it("a command whose candidate help is unreadable is fail", () => {
    const findings = diffHelp("tab create", TAB_CREATE_HELP, null);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "command-missing", severity: "fail" });
  });
});

describe("SHEPHERD_HERDR_COMMANDS", () => {
  it("covers the surface Shepherd drives (spot checks from src/)", () => {
    const flat = SHEPHERD_HERDR_COMMANDS.map((argv) => argv.join(" "));
    for (const cmd of [
      "tab create",
      "tab close",
      "tab list",
      "tab rename",
      "pane run",
      "pane process-info",
      "pane report-agent",
      "pane report-agent-session",
      "pane send-keys",
      "pane send-text",
      "agent attach",
      "agent list",
      "agent read",
      "agent rename",
      "agent send",
      "workspace list",
      "workspace create",
      "terminal session control",
      "api schema",
      "status",
      "server stop",
      "update",
    ]) {
      expect(flat).toContain(cmd);
    }
  });
});
