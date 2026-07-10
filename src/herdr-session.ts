// Resolves which herdr session + Unix-socket path Shepherd talks to, and guards the footgun
// where a Shepherd launched INSIDE a herdr pane silently attaches to the parent pane's herd
// (issue #1596). herdr exports HERDR_ENV=1 + HERDR_SOCKET_PATH=<its own socket> into every
// managed pane, so an *inherited* HERDR_SOCKET_PATH used to override an explicit HERDR_SESSION
// outright — a dev/test instance could spawn agents into, or steer, the live production herd.
// When the inherited value disagrees with an explicit non-`default` HERDR_SESSION we now prefer
// the session's own socket (explicit intent wins) and warn loudly.

/** A pane-inherited HERDR_SOCKET_PATH that disagrees with an explicit non-`default`
 *  HERDR_SESSION — the cross-herd-attach footgun. Set only when we override. */
export type HerdrSocketConflict = {
  session: string;
  /** Socket path inherited from the enclosing herdr pane (HERDR_ENV=1). */
  inheritedPath: string;
  /** The per-session socket we prefer instead. */
  sessionPath: string;
};

export type HerdrSocketResolution = {
  session: string;
  socketPath: string;
  conflict: HerdrSocketConflict | null;
};

/** herdr's per-session socket convention (issue #1529): a non-`default` session gets its own
 *  socket under sessions/<name>/, the `default` session uses herdr's top-level socket. */
function sessionSocketPath(session: string, home: string): string {
  return session !== "default"
    ? `${home}/.config/herdr/sessions/${session}/herdr.sock`
    : `${home}/.config/herdr/herdr.sock`;
}

/**
 * Pure resolver — no I/O, no env mutation. Given an env snapshot + $HOME, decide the herdr
 * session + socket path and flag the in-pane conflict.
 *
 * Precedence:
 *  - Conflict (inside a herdr pane, explicit non-`default` HERDR_SESSION, and the inherited
 *    HERDR_SOCKET_PATH differs from that session's socket) → the session socket wins.
 *  - Otherwise an explicit/inherited HERDR_SOCKET_PATH wins, else the session-derived path.
 *
 * The conflict is gated on HERDR_ENV==="1" — our only proxy for "HERDR_SOCKET_PATH was
 * inherited from the enclosing pane" (herdr sets both together). Outside a pane an explicit
 * HERDR_SOCKET_PATH always wins. SHEPHERD_HERDR_IGNORE_SESSION=1 suppresses the override
 * entirely (keep the inherited socket / attach to the parent herd), ignoring HERDR_SESSION.
 */
export function resolveHerdrSocket(
  env: Record<string, string | undefined>,
  home: string,
): HerdrSocketResolution {
  const session = env.HERDR_SESSION ?? "default";
  const sessionPath = sessionSocketPath(session, home);
  const inherited = env.HERDR_SOCKET_PATH;
  const insidePane = env.HERDR_ENV === "1";
  const ignoreSession = env.SHEPHERD_HERDR_IGNORE_SESSION === "1";

  const conflict: HerdrSocketConflict | null =
    !ignoreSession &&
    insidePane &&
    session !== "default" &&
    inherited != null &&
    inherited !== sessionPath
      ? { session, inheritedPath: inherited, sessionPath }
      : null;

  const socketPath = conflict ? conflict.sessionPath : (inherited ?? sessionPath);
  return { session, socketPath, conflict };
}

/**
 * Resolve + apply the side effect that keeps the CLI path coherent: on conflict, rewrite
 * `env.HERDR_SOCKET_PATH` IN PLACE to the preferred session socket and warn once. Every
 * spawned `herdr` subprocess inherits this env (the CLI driver spawns with no env override;
 * the node PTY helpers spread `...process.env`), so the socket driver AND the CLI driver then
 * agree on the same herd. `log` is injectable for tests. Returns the resolution.
 */
export function applyHerdrSocket(
  env: Record<string, string | undefined>,
  home: string,
  log: (msg: string) => void = console.warn,
): HerdrSocketResolution {
  const res = resolveHerdrSocket(env, home);
  if (res.conflict) {
    env.HERDR_SOCKET_PATH = res.socketPath;
    log(
      `[herdr-session] HERDR_SESSION='${res.conflict.session}' but HERDR_SOCKET_PATH was ` +
        `inherited from the enclosing herdr pane (HERDR_ENV=1) as '${res.conflict.inheritedPath}', ` +
        `which points at a different herd. Preferring this session's socket ` +
        `'${res.conflict.sessionPath}' so this instance can't attach to the parent pane's herd. ` +
        `If that session's herdr daemon isn't running, herdr calls will fail offline — start it, ` +
        `unset HERDR_SESSION, or set SHEPHERD_HERDR_IGNORE_SESSION=1 to keep the inherited socket.`,
    );
  }
  return res;
}
