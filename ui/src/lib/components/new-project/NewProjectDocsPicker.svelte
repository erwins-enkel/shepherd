<script lang="ts">
  import type { ProjectDocFiles } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import { toDocs } from "./project-docs";

  // #3112: the "Bootstrap from PRD + design" kickoff imports the PRD and the design export into
  // docs/prd + docs/design of the initial commit. Both optional — the bootstrap agent asks for
  // whatever is missing.
  let { docs = $bindable() }: { docs: ProjectDocFiles } = $props();
</script>

<div class="docs" role="group" aria-label={m.newproject_docs_group()}>
  <label class="micro" for="np-prd">{m.newproject_docs_prd_label()}</label>
  <input
    id="np-prd"
    type="file"
    multiple
    accept=".md,.markdown,.txt,.pdf"
    onchange={(e) => (docs = { ...docs, prd: toDocs(e.currentTarget.files) })}
  />
  <label class="micro" for="np-design">{m.newproject_docs_design_label()}</label>
  <input
    id="np-design"
    type="file"
    multiple
    webkitdirectory
    onchange={(e) => (docs = { ...docs, design: toDocs(e.currentTarget.files) })}
  />
  <p class="hint">
    {m.newproject_docs_hint({ prd: docs.prd.length, design: docs.design.length })}
  </p>
</div>

<style>
  .docs {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 1px solid var(--color-line);
    padding-left: 10px;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-top: 6px;
  }
  input[type="file"] {
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    max-width: 100%;
  }
  .hint {
    margin: 4px 0 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
</style>
