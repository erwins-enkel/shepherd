# Implementierungsplan — Tastenkappen auf ⌘-Halten (Keymap 10a)

Umsetzt `README.md` (Spec) in `ui/src/`. Die Referenz `reference-10a.html` ist Vorlage, kein Code.

## Entschiedene Abweichungen von der Spec

Sieben Punkte wurden vor Baubeginn geklärt. Jede Abweichung steht hier mit Begründung,
damit sie im Review nachvollziehbar ist.

| #   | Spec sagt                              | Wir bauen                                                                                                                                                                                                                                             | Warum                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `⌥1/⌥2/⌥3` = Modus Code/Recherche/Epic | wie Spec; der bestehende Recent-Repo-Sprung auf `⌥1–3` **entfällt** samt Hinweiszeile `newtask_repo_shortcuts_hint`                                                                                                                                   | Chord war doppelt vergeben (`onFormKeydown`). `⌥[`/`⌥]`/`⌥R` bleiben und ziehen in die Registry.                                                                                                                                                                                 |
| 2   | `⌘M` Modell, `⌘⇧A` Autopilot           | `⌥M` und `⌥A`                                                                                                                                                                                                                                         | `⌘M` = Fenster minimieren (macOS), `⌘⇧A` = Tab-Suche (Chrome). Fenster-/Tab-Aktionen lassen sich per `preventDefault` nachweislich nicht abfangen — eine Kappe dürfte nichts versprechen, das nicht eintritt. `⌥` ist im Dialog bereits etablierte, browserfreie Ebene.          |
| 3   | `--cap-bg: #12100b`                    | `#12100b` im Dark-Theme (woertlich), `var(--color-panel)` im Light-Theme                                                                                                                                                                              | Gemessen statt geschaetzt: das Literal liefert 8,7:1 (dark) und 11,9:1 (dark+HC) - dort bleibt es. In Light faellt es auf 4,2:1, in Light+High-Contrast auf 2,5:1. `--color-panel` liefert dort 4,3:1 bzw. 7,1:1, ist deckend und theme-nativ. Beste Werte in allen vier Themes. |
| 4   | Tastenkarte ohne Backdrop              | Tastenkarte mit `.scrim` (dim + blur)                                                                                                                                                                                                                 | Sie ist `role="dialog"` + `aria-modal` + Focus-Trap, also blockierend. `CLAUDE.md` verlangt für blockierende Flächen den kanonischen Backdrop.                                                                                                                                   |
| 5   | `↑↓` an der ersten Issue-Zeile         | Navigation wird **neu gebaut**                                                                                                                                                                                                                        | Die Kappe verankert etwas, das es nicht gibt: `↑↓`/`↵` funktionieren heute nur im Inline-`#`-Menü im Prompt, nicht in der Seitenliste (`PromptSources.svelte`). Ohne Bau wäre die Kappe eine Lüge.                                                                               |
| 6   | `⌘E`/`⌘M` „Engine/Modell wählen"       | fokussiert das `<select>`, klappt es nicht auf                                                                                                                                                                                                        | `HTMLSelectElement.showPicker()` fehlt in Firefox. Fokus verhält sich in allen Browsern gleich; Aufklappen danach nativ per `↓`.                                                                                                                                                 |
| 7   | „keine zweite Liste"                   | Registry besitzt alle Dialog-Kürzel; die menülokale Navigation (`↑↓/↵/⇥/Esc` bei offenem `#`- oder `/`-Menü) bleibt in `onSlashMenuKey`/`onIssueMenuKey`, wird aber als Registry-Eintrag **geführt** (speist Kappe, `aria-keyshortcuts`, Tastenkarte) | Eine Quelle für die Anzeige, ohne Menüzustand und Index-Zyklen in die Registry zu koppeln.                                                                                                                                                                                       |

Zusätzlich ohne Rückfrage gesetzt:

- **Scrim-Positionierung.** Statt der Magic Numbers `inset: 45px 0 57px` wird der Scrim
  absolut in `.cbody` positioniert (`inset: 0`, `.cbody` bekommt `position: relative`).
  `.cbody` **ist** exakt der Bereich zwischen `.chead` und `.cfoot` — die Insets ergeben
  sich damit aus dem Layout statt aus geratenen Pixelwerten und bleiben bei jeder
  Kopfzeilenhöhe korrekt.
- **Inventargröße.** Der Auftrag spricht von „16 Kürzeln"; die Inventartabelle der Spec
  hat 20 Zeilen. Die Registry führt 20 Einträge (`⌥1/⌥2/⌥3` als drei eigene, also 22
  Chords), plus den nicht-ausführbaren Anzeigeeintrag „⌘ halten".
- **Reichweite (Gerät).** Die Einblendung erscheint nur, wenn (a) das Desktop-Layout
  montiert ist (`!mobile`, abgeleitet aus dem bestehenden Breakpoint `max-width: 768px`)
  und (b) ein echtes `keydown` mit Meta/Control eintrifft. (b) ist der eigentliche
  Tastatur-Nachweis — ein Touch-Gerät erzeugt das nie. Keine eigene Zoll-Heuristik.

## Dateien

### Neu

| Datei                                                                | Zweck                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/lib/keymap/types.ts`                                         | `KeymapEntry`, `KeymapZone`, `Chord`, `NewTaskKeymapCtx`                                                                                |
| `ui/src/lib/keymap/chord.ts`                                         | Chord-Matching gegen `KeyboardEvent` (auf `e.code`, wie der Bestand) + plattformabhängige Beschriftung (`⌘⌥⇧↵` ↔ `Strg/Alt/Umschalt/↵`) |
| `ui/src/lib/keymap/newTask.ts`                                       | **Die Registry.** Alle Einträge mit `id`, `keys`, `labelKey`, `zone`, `enabled(ctx)`, `run(ctx)`                                        |
| `ui/src/lib/keymap/hold.svelte.ts`                                   | Halte-Statemachine: 350-ms-Timer, `visible`, `flash`, Auf-/Abbau der Listener                                                           |
| `ui/src/lib/components/new-task/Keycap.svelte`                       | Das Kappen-Primitiv (inline + absolut, gedämpfte Variante)                                                                              |
| `ui/src/lib/components/new-task/KeymapSheet.svelte`                  | Die volle Tastenkarte (`?`)                                                                                                             |
| `ui/src/lib/feature-announcements/entries/v1.46.0-newtask-keymap.ts` | Katalogeintrag (Pflicht für user-facing `feat`)                                                                                         |

Tests: `keymap/chord.test.ts`, `keymap/newTask.test.ts`, `keymap/hold.svelte.test.ts`,
`new-task/Keycap.browser.test.ts`, `new-task/KeymapSheet.browser.test.ts`, Ergänzungen in
`NewTask.browser.test.ts` und `PromptSources` (neue Listen-Navigation).

### Geändert

| Datei                                                     | Änderung                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/app.css`                                          | `--cap-bg` (Literal im Dark-Block, Panel-Override im Light-Block)                                                                                                                                                                |
| `ui/src/lib/components/NewTask.svelte`                    | Registry-Dispatch ersetzt die Chord-Zweige in `onFormKeydown`; Scrim in `.cbody`; Kappen an ✕, Prompt-Label, Repo-/Branch-Chip, ↥/🎙; Fußzeilen-Zeilen; **Entfernen** von `.syntax-hint` und `.ctx-hint`; `KeymapSheet` einhängen |
| `ui/src/lib/components/new-task/RunSettingsGroups.svelte` | Kappen ersetzen die `▾` in Engine- und Modell-Select                                                                                                                                                                             |
| `ui/src/lib/components/new-task/InstrumentToggle.svelte`  | Kappe ersetzt das `AN`/`AUS`-Readout (`.status`)                                                                                                                                                                                 |
| `ui/src/lib/components/PromptSources.svelte`              | Kappen an Filter-Chip, Tabs, erster Issue-Zeile; **neue `↑↓`/`↵`-Navigation**; exportiert `openFilter()`, `toggleTab()`, `focusList()`                                                                                           |
| `ui/src/lib/components/IssueFilterPopover.svelte`         | exportiert `open()` (Muster: `RepoSelect.openPanel()`)                                                                                                                                                                           |
| `ui/src/lib/components/MicButton.svelte`                  | exportiert `toggle()` (heute nur intern in `tapMic`)                                                                                                                                                                             |
| `ui/messages/{en,de}.json`                                | ~30 neue Schlüssel; `newtask_syntax_hint` und `newtask_repo_shortcuts_hint` werden verwaist und entfallen. `newtask_syntax_hint_touch` **bleibt** (zweite Verwendung im Mobile-Zweig)                                            |

`RepoSelect.svelte` bleibt unangetastet — `openPanel()` existiert bereits.

## Reihenfolge

Jede Stufe ist für sich lauffähig und testbar; der Dialog bleibt durchgehend benutzbar.

1. **Fundament** — `types.ts` + `chord.ts` mit Unit-Tests (Matching auf `e.code`,
   Mac/Windows-Beschriftung). Noch keine UI.
2. **Registry** — `newTask.ts` mit allen Einträgen gegen ein `NewTaskKeymapCtx`-Interface.
   Unit-Test: keine doppelten Chords, jeder Eintrag hat Zone + Beschriftungsschlüssel.
3. **Migration der Handler** — `onFormKeydown` ruft nur noch den Registry-Dispatch.
   Verhalten bleibt identisch, Bestandstests in `NewTask.browser.test.ts` müssen grün
   bleiben (bis auf die entfallenen `⌥1–3`-Repo-Tests). _Ab hier gibt es genau eine Liste._
4. **Halte-Statemachine** — `hold.svelte.ts` + Unit-Tests (350 ms → sichtbar; Kombination
   innerhalb 350 ms → nicht sichtbar; `keyup`/`blur`/`mousedown`/`Escape` → verborgen).
   Listener am Dialog-Root, Abbau beim Unmount.
5. **Kappe, Scrim, Fußzeile** — `Keycap.svelte`, `--cap-bg`, Scrim in `.cbody`, beide
   Fußzeilen-Zustände; Anker in `NewTask.svelte`; die zwei Hinweistexte entfallen.
   Erster sichtbarer Zustand.
6. **Anker in den Kindkomponenten** — RunSettingsGroups, InstrumentToggle, PromptSources,
   plus die drei imperativen Methoden (`MicButton.toggle()`, `IssueFilterPopover.open()`,
   `PromptSources.*`).
7. **Issue-Listen-Navigation** — `↑↓`/`↵` in `PromptSources` (eigenständige neue Fähigkeit,
   deshalb isoliert nach den Kappen).
8. **Tastenkarte** — `KeymapSheet.svelte` mit `use:dialog` (Focus-Trap + Escape kommen
   daher) und `.scrim`. Öffnet per `?` außerhalb von Textfeldern **und** per `?` während
   ⌘ gehalten wird.
9. **Abschluss** — i18n EN+DE, Feature-Katalogeintrag `v1.46.0`, `bun run check`,
   `bun run check:i18n`, `vitest run`, Root-`bun run lint`; Screenshots der drei Zustände
   gegen `reference-10a.html`.

## Risiken

- **Stacking Context.** Eine Kappe (`z-index: 2`) liegt nur dann über dem Scrim
  (`z-index: 1`), wenn kein Vorfahre zwischen ihr und `.cbody` einen eigenen Stacking
  Context aufmacht (`transform`, `filter`, `opacity < 1`, `contain`, eigenes `z-index`).
  `.left`/`.rail` haben nur `overflow-y: auto` — das genügt allein nicht, ist also in
  Ordnung. Muss trotzdem pro Anker geprüft werden; Gegenmittel ist ein `z-index` auf dem
  betroffenen Vorfahren.
- **Browser-eigene Chords.** `⌘P`, `⌘F`, `⌘D`, `⌘U`, `⌘G` sind Seiten-Aktionen und per
  `preventDefault` abfangbar — in Safari aber unzuverlässiger als in Chrome/Firefox. Wird
  in Stufe 9 real geprüft; scheitert eines, wandert es wie `⌘M`/`⌘⇧A` auf die `⌥`-Ebene.
- **`⌥`+Buchstabe auf macOS** erzeugt Sonderzeichen im Textfeld. Der Bestand löst das über
  `e.code` + `preventDefault`; die Registry übernimmt dieses Muster unverändert.
- **`PromptSources`-Kontextmenü.** Die Issue-Zeilen tragen bereits `use:issueMenuTrigger`.
  Die neue Tastatur-Navigation darf dessen Auslösung nicht stören.
