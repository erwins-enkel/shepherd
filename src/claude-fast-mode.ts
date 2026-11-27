/**
 * Claude Code's hard off switch for Fast mode (#4244). With it set, `/fast` cannot turn Fast on
 * for that process, whatever the user settings' saved `fastMode` says.
 *
 * Every Shepherd `claude` spawn carries it BY DEFAULT, set where the spawn's env is assembled:
 * the herdr `env` shim (`buildWrappedArgv`) for an unwrapped spawn, and the bwrap membrane's
 * `--setenv` (`buildMembraneFlags`) for a wrapped one, because `--clearenv` wipes the outer shim.
 * Both pins are emitted LAST, so neither a caller's nor a plugin's env can undo them.
 *
 * There is ONE opt-out, `allowFastMode`, set only by `SessionService.prepareSpawn` for task
 * sessions. Those start at Standard through `fastModePerSessionOptIn` in their `--settings`
 * (`spawnSettingsOverlay`), but keep Fast available. Helper roles, the prompt recommender, the
 * usage probe and the Operator Assistant never opt out, so a new operator-less role cannot miss
 * the pin.
 */
export const DISABLE_FAST_MODE_ENV = "CLAUDE_CODE_DISABLE_FAST_MODE";
