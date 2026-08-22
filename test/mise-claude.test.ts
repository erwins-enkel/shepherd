import { describe, expect, it, beforeEach } from "bun:test";
import {
  detectMiseClaude,
  formatResidueSize,
  refreshMiseClaude,
  pinFor,
  verdictFor,
  claudeSpawnPinned,
  __resetMiseClaude,
  type MiseClaudeDeps,
  type MiseClaudeState,
} from "../src/mise-claude";

const HOME = "/home/op";
const MISE_BIN = `${HOME}/.local/share/mise/installs/claude/latest/claude`;
const ON_PATH = `${HOME}/.local/bin/claude`;
const NATIVE_DIR = `${HOME}/.local/share/claude/versions`;

/** One host shape. Anything omitted defaults to the healthy mise-shim host. */
function host(over: {
  /** null ⇒ `mise which claude` fails (mise absent, or claude not a mise tool). */
  misePath?: string | null;
  /** Every `claude` on PATH, in PATH order. `[]` ⇒ none. */
  onPath?: string[];
  /** What `<on-path claude> --version` prints; null ⇒ the call throws. */
  pathVersionOut?: string | null;
  /** What `<mise claude> --version` prints; null ⇒ the call throws. */
  miseVersionOut?: string | null;
  /** realpath every PATH entry resolves to. Defaults to the launcher-script shape (the entry
   *  itself), which keeps the two `--version` probes distinguishable. */
  real?: string;
  native?: { path: string; bytes: number }[];
}): MiseClaudeDeps {
  const misePath = over.misePath === undefined ? MISE_BIN : over.misePath;
  const onPath = over.onPath ?? [ON_PATH];
  const pathOut = over.pathVersionOut === undefined ? "2.1.237 (Claude Code)" : over.pathVersionOut;
  const miseOut = over.miseVersionOut === undefined ? "2.1.237 (Claude Code)" : over.miseVersionOut;
  return {
    home: HOME,
    run: async (bin, args) => {
      if (bin === "mise" && args[0] === "which") {
        if (misePath === null) throw new Error("claude is not a mise bin");
        return `${misePath}\n`;
      }
      if (args[0] === "--version") {
        const out = bin === misePath ? miseOut : pathOut;
        if (out === null) throw new Error("boom");
        return out;
      }
      throw new Error(`unexpected ${bin} ${args.join(" ")}`);
    },
    listOnPath: async () => onPath,
    realpath: async () => over.real ?? ON_PATH,
    listNative: async (dir) => (dir === NATIVE_DIR ? (over.native ?? []) : []),
  };
}

describe("detectMiseClaude", () => {
  it("reports not-managed when mise cannot hand us a claude", async () => {
    const state = await detectMiseClaude(host({ misePath: null }));
    expect(state).toEqual({
      managed: false,
      pathVersion: null,
      miseVersion: null,
      nativeOnPath: false,
      nativeResidue: null,
    });
    expect(verdictFor(state)).toBe("absent");
    expect(pinFor(state)).toBe(false);
  });

  it("reports not-managed when `mise which` succeeds but prints nothing", async () => {
    const state = await detectMiseClaude(host({ misePath: "" }));
    expect(state.managed).toBe(false);
  });

  it("owns a mise shim / symlink host", async () => {
    // The PATH entry resolves straight to mise's binary, so both probes read the same file.
    const state = await detectMiseClaude(host({ real: MISE_BIN }));
    expect(state.managed).toBe(true);
    expect(state.pathVersion).toBe("2.1.237");
    expect(state.miseVersion).toBe("2.1.237");
    expect(state.nativeOnPath).toBe(false);
    expect(verdictFor(state)).toBe("ok");
    expect(pinFor(state)).toBe(true);
  });

  it("owns a launcher-script host, which a path-shape test would miss", async () => {
    // `~/.local/bin/claude` is a regular script that execs `mise x claude` — it realpaths to
    // ITSELF, outside the mise tree, so structural ownership tests call it unmanaged.
    const state = await detectMiseClaude(host({}));
    expect(state.nativeOnPath).toBe(false);
    expect(verdictFor(state)).toBe("ok");
    expect(pinFor(state)).toBe(true);
  });

  it("flags a diverged native install and refuses the pin", async () => {
    const state = await detectMiseClaude(
      host({
        pathVersionOut: "2.1.226 (Claude Code)",
        miseVersionOut: "2.1.222 (Claude Code)",
        real: `${HOME}/.local/share/claude/versions/2.1.226`,
        native: [{ path: `${HOME}/.local/share/claude/versions/2.1.226`, bytes: 1 }],
      }),
    );
    expect(state.pathVersion).toBe("2.1.226");
    expect(state.miseVersion).toBe("2.1.222");
    expect(state.nativeOnPath).toBe(true);
    expect(verdictFor(state)).toBe("diverged");
    expect(pinFor(state)).toBe(false);
  });

  it("refuses the pin for a native duplicate sitting at mise's own version", async () => {
    // Versions agree, so nothing has DIVERGED yet — but what runs is the native copy, which mise
    // cannot advance. Pinning there would freeze it silently, so the row says so instead.
    const state = await detectMiseClaude(
      host({ real: `${HOME}/.local/share/claude/versions/2.1.237` }),
    );
    expect(state.nativeOnPath).toBe(true);
    expect(verdictFor(state)).toBe("native");
    expect(pinFor(state)).toBe(false);
  });

  it("keeps the row's verdict aligned with the pin in every reachable shape", async () => {
    const shapes = [
      host({ misePath: null }),
      host({}),
      host({ real: ON_PATH }),
      host({ pathVersionOut: "2.1.226 (Claude Code)" }),
      host({ real: `${HOME}/.local/share/claude/versions/2.1.237` }),
      host({ native: [{ path: `${HOME}/.local/share/claude/versions/2.1.1`, bytes: 9 }] }),
      host({ pathVersionOut: null }),
    ];
    for (const shape of shapes) {
      const state = await detectMiseClaude(shape);
      // `ok`/`residue` are exactly the pinned states — so an `ok` row can honestly say the
      // auto-updater is pinned, and a warning row never implies one that wasn't applied.
      expect(["ok", "residue"].includes(verdictFor(state))).toBe(pinFor(state));
    }
  });

  it("does not mistake a sibling directory for the native tree", async () => {
    const state = await detectMiseClaude(host({ real: `${HOME}/.local/share/claude-extras/x` }));
    expect(state.nativeOnPath).toBe(false);
  });

  it("rolls up the leftover native tree behind a mise-owned claude", async () => {
    const state = await detectMiseClaude(
      host({
        native: [
          { path: `${HOME}/.local/share/claude/versions/2.1.233`, bytes: 300 * 1024 ** 2 },
          { path: `${HOME}/.local/share/claude/versions/2.1.234`, bytes: 300 * 1024 ** 2 },
          { path: `${HOME}/.local/share/claude/versions/2.1.235`, bytes: 338 * 1024 ** 2 },
        ],
      }),
    );
    expect(state.nativeResidue).toEqual({ count: 3, bytes: 938 * 1024 ** 2 });
    expect(state.nativeOnPath).toBe(false); // so every build listed really is a leftover
    expect(verdictFor(state)).toBe("residue");
    expect(pinFor(state)).toBe(true);
  });

  it("reports no residue when the native tree is empty or gone", async () => {
    expect((await detectMiseClaude(host({ native: [] }))).nativeResidue).toBeNull();
  });

  it("stays quiet when either version is unreadable", async () => {
    for (const shape of [{ pathVersionOut: null }, { miseVersionOut: null }]) {
      const state = await detectMiseClaude(host(shape));
      expect(state.managed).toBe(true);
      expect(verdictFor(state)).toBe("absent");
      expect(pinFor(state)).toBe(false);
    }
  });

  it("stays quiet when nothing named claude is on PATH", async () => {
    const state = await detectMiseClaude(host({ onPath: [] }));
    expect(state.managed).toBe(false);
    expect(verdictFor(state)).toBe("absent");
    expect(pinFor(state)).toBe(false);
  });

  // shepherd.service is ~/.bun/bin-first, herdr.service is ~/.local/bin-first — and herdr is what
  // actually execs the agent. When both dirs hold a DIFFERENT claude we cannot tell which one it
  // will pick, so guessing could pin (freeze) the native copy that really runs, or call the live
  // install safe to delete. Fail closed instead.
  it("fails closed when PATH holds two different claudes, since herdr may pick either", async () => {
    const state = await detectMiseClaude({
      ...host({ onPath: [`${HOME}/.bun/bin/claude`, ON_PATH] }),
      realpath: async (p) => p, // two distinct real targets
    });
    expect(state).toEqual({
      managed: false,
      pathVersion: null,
      miseVersion: null,
      nativeOnPath: false,
      nativeResidue: null,
    });
    expect(pinFor(state)).toBe(false);
  });

  it("accepts several PATH entries that all resolve to the same file", async () => {
    // The service PATH legitimately repeats dirs, and ~/.bun/bin/claude is often a symlink to the
    // ~/.local/bin one. Order cannot matter when every entry lands on the same target.
    const state = await detectMiseClaude(host({ onPath: [`${HOME}/.bun/bin/claude`, ON_PATH] }));
    expect(state.managed).toBe(true);
    expect(verdictFor(state)).toBe("ok");
    expect(pinFor(state)).toBe(true);
  });

  it("survives an unreadable realpath by falling back to the PATH entry", async () => {
    const state = await detectMiseClaude({
      ...host({}),
      realpath: async () => {
        throw new Error("ELOOP");
      },
    });
    expect(state.nativeOnPath).toBe(false);
    expect(pinFor(state)).toBe(true);
  });

  it("survives an unreadable native tree", async () => {
    const state = await detectMiseClaude({
      ...host({}),
      listNative: async () => {
        throw new Error("EACCES");
      },
    });
    expect(state.nativeResidue).toBeNull();
    expect(verdictFor(state)).toBe("ok");
  });
});

describe("formatResidueSize", () => {
  it("scales to KB / MB / GB", () => {
    expect(formatResidueSize(4 * 1024)).toBe("4 KB");
    expect(formatResidueSize(938 * 1024 ** 2)).toBe("938 MB");
    expect(formatResidueSize(Math.round(1.5 * 1024 ** 3))).toBe("1.5 GB");
  });

  it("only ever emits a purity-safe host fact", () => {
    for (const bytes of [0, 1, 1024, 1024 ** 2, 1024 ** 3, 987_654_321]) {
      expect(formatResidueSize(bytes)).toMatch(/^\d+(\.\d+)? [KMG]B$/);
    }
  });
});

describe("refreshMiseClaude + the spawn pin", () => {
  beforeEach(() => __resetMiseClaude());

  it("reads false while cold", () => {
    expect(claudeSpawnPinned()).toBe(false);
  });

  it("latches the pin from the probed state", async () => {
    const state: MiseClaudeState = await refreshMiseClaude(host({}));
    expect(state.managed).toBe(true);
    expect(claudeSpawnPinned()).toBe(true);
  });

  it("re-probes on EVERY call — no cache of its own, so a forced diagnostics re-run is honest", async () => {
    let calls = 0;
    const counting = (over: Parameters<typeof host>[0]): MiseClaudeDeps => ({
      ...host(over),
      listOnPath: async () => {
        calls++;
        return [ON_PATH];
      },
    });
    await refreshMiseClaude(counting({}));
    await refreshMiseClaude(counting({}));
    expect(calls).toBe(2);
    // …and the pin follows the newest state, so the row and the pin never drift apart.
    await refreshMiseClaude(counting({ misePath: null }));
    expect(claudeSpawnPinned()).toBe(false);
  });
});
