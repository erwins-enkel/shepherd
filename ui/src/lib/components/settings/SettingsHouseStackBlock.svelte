<script lang="ts">
  import { untrack } from "svelte";
  import { putHouseStack, resolveHouseStack } from "#lib/api.js";
  import type { HouseStack, HouseStackResolution, Settings } from "#lib/types.js";
  import { houseStackExplanation } from "#lib/tooltips/explanations.js";
  import { m } from "#lib/paraglide/messages.js";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import "./settings-controls.css";

  // House Stack (#3108): the operator's package list a project bootstrap pins to the current
  // stable versions. Seeded once from the parent's single getSettings() payload; "Check" resolves
  // the SAVED list on the server, so it is disabled while the edit is unsaved.
  let { payload, query = "" }: { payload: Settings | null; query?: string } = $props();

  let saved = $state<HouseStack | null>(null);
  let npmText = $state("");
  let cratesText = $state("");
  let rustToolchain = $state(true);
  let saving = $state(false);
  let checking = $state(false);
  let error = $state<string | null>(null);
  let result = $state<HouseStackResolution | null>(null);

  const lines = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  function seed(stack: HouseStack) {
    saved = stack;
    npmText = stack.npm.join("\n");
    cratesText = stack.crates.join("\n");
    rustToolchain = stack.rustToolchain;
  }

  $effect(() => {
    const stack = payload?.houseStack;
    if (stack && untrack(() => saved) === null) untrack(() => seed(stack));
  });

  const draft = $derived<HouseStack>({
    npm: lines(npmText),
    crates: lines(cratesText),
    rustToolchain,
  });
  const dirty = $derived(saved !== null && JSON.stringify(draft) !== JSON.stringify(saved));

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    error = null;
    try {
      seed((await putHouseStack(draft)).houseStack);
      result = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function check() {
    if (checking || dirty) return;
    checking = true;
    error = null;
    try {
      result = await resolveHouseStack();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      checking = false;
    }
  }
</script>

{#if saved}
  <SettingRow
    title={m.settings_house_stack_title()}
    description={m.settings_house_stack_hint()}
    explanation={houseStackExplanation()}
    {query}
  >
    {#snippet below()}
      <div class="hs">
        <label class="field">
          <span class="lbl">{m.settings_house_stack_npm_label()}</span>
          <textarea rows="6" spellcheck="false" bind:value={npmText}></textarea>
        </label>
        <label class="field">
          <span class="lbl">{m.settings_house_stack_crates_label()}</span>
          <textarea rows="3" spellcheck="false" bind:value={cratesText}></textarea>
        </label>
        <div class="toggle">
          <span class="lbl">{m.settings_house_stack_rust_toolchain()}</span>
          <SettingToggle
            checked={rustToolchain}
            label={m.settings_house_stack_rust_toolchain()}
            onchange={() => (rustToolchain = !rustToolchain)}
          />
        </div>
        <div class="actions">
          <button type="button" class="set-gbtn" disabled={!dirty || saving} onclick={save}>
            {saving ? m.settings_saving() : m.settings_house_stack_save()}
          </button>
          <button type="button" class="set-gbtn" disabled={dirty || checking} onclick={check}>
            {checking ? m.settings_house_stack_checking() : m.settings_house_stack_check()}
          </button>
        </div>
        {#if error}<div class="err" role="alert">{error}</div>{/if}
        {#if result?.ok}
          <div class="res">
            <span class="lbl">
              {m.settings_house_stack_resolved({ date: result.resolvedAt.slice(0, 10) })}
            </span>
            <ul>
              {#each result.npm as p (p.name)}
                <li><code>{p.name}</code> <span class="ver">{p.version}</span></li>
              {/each}
              {#each result.crates as p (p.name)}
                <li><code>{p.name}</code> <span class="ver">{p.version}</span></li>
              {/each}
              {#if result.rustToolchain}
                <li>
                  <code>{m.settings_house_stack_rust_label()}</code>
                  <span class="ver">{result.rustToolchain}</span>
                </li>
              {/if}
            </ul>
          </div>
        {:else if result}
          <div class="res" role="alert">
            <span class="err">{m.settings_house_stack_failed()}</span>
            <ul>
              {#each result.errors as e (`${e.ecosystem}:${e.name}`)}
                <li><code>{e.name}</code> <span class="why">{e.reason}</span></li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/snippet}
  </SettingRow>
{/if}

<style>
  .hs {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lbl {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  textarea {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 6px 10px;
    resize: vertical;
    box-sizing: border-box;
    width: 100%;
  }
  textarea:focus {
    outline: none;
    border-color: var(--color-amber);
  }
  .toggle,
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .res ul {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-meta);
  }
  .res li {
    overflow-wrap: anywhere;
  }
  .ver {
    color: var(--color-amber);
  }
  .why,
  .err {
    color: var(--color-red);
    font-size: var(--fs-meta);
  }
</style>
