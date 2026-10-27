// Which account-gated Claude models the logged-in account can spawn (server side:
// src/claude-account-models.ts). Fed by every GET /api/settings (api.ts getSettings) so any model
// picker can read it without threading a prop through every dialog. Starts false: until settings
// load, a gated model stays hidden — fail closed, like the server.
class AccountModels {
  mythosAvailable = $state(false);
}
export const accountModels = new AccountModels();
