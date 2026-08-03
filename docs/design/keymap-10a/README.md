# Handoff: „Neue Aufgabe" — Tastenkappen auf ⌘-Halten (Option 10a)

## Overview

Der Dialog **Neue Aufgabe** kennt heute ~16 Tastenkürzel, zeigt aber nur drei davon als grauen Fließtext (`# Issue · / Befehl · ⌘V Bild`). Ergebnis: Nutzer bedienen den Dialog dauerhaft mit der Maus.

**10a** löst das mit _hold-to-reveal_: Wird die **⌘-Taste ~350 ms gehalten** (ohne weitere Taste), legt sich ein Scrim über den Inhaltsbereich und **jedes bedienbare Element bekennt sein Kürzel als Tastenkappe — direkt an seinem Platz im Layout**. Loslassen blendet alles wieder aus. Gelernt wird die _Position_ des Kürzels, nicht eine Liste. Im Ruhezustand kostet das Feature genau eine Zeile Chrome (`⌘ HALTEN = TASTEN` in der Fußzeile).

Ergänzend: `?` öffnet die vollständige Tastenkarte als Popover (kanonische Liste, auch ohne Modifier erreichbar, Grundlage für Screenreader/Doku).

## About the Design Files

`reference-10a.html` ist eine **statische Design-Referenz in HTML** — sie zeigt Aussehen und Zustände, sie ist **kein Produktionscode zum Kopieren**. Die Aufgabe ist, das Design in der bestehenden Shepherd-Codebase (SvelteKit, `ui/src/`) mit deren Komponenten (`ui/src/lib/components/`), Tokens (`ui/src/app.css`) und Mustern **nachzubauen**. Die Referenz zeigt drei Zustände:

1. **Ruhe** — der Dialog wie heute, plus Fußzeilen-Hinweis.
2. **⌘ gehalten** — Scrim + Kappen an allen Controls.
3. **Volle Tastenkarte** (`?`) — Popover mit allen Kürzeln, nach Zonen gruppiert.

## Fidelity

**High-fidelity.** Farben, Typo und Abstände verwenden Shepherd-Tokens namentlich (`--panel`, `--panel-2`, `--inset`, `--head`, `--line`, `--line-bright`, `--ink`, `--ink-bright`, `--muted`, `--faint`, `--amber`, `--green`, `--sel`). Deutsche Copy ist final. Der Dialog selbst bleibt unverändert — 10a fügt nur eine Ebene hinzu und **ersetzt** den bisherigen Hinweistext `# Issue · / Befehl · ⌘V Bild` über dem Prompt.

---

## Anatomie

### Tastenkappe (das einzige neue Primitiv)

Eine Kappe ist ein Inline-Element **im Layout des Controls**, kein absolut positioniertes Overlay. Nur so bleibt sie bei jeder Fensterbreite exakt an ihrem Element.

| Eigenschaft | Wert                                                             |
| ----------- | ---------------------------------------------------------------- |
| Border      | `1px solid var(--amber)`                                         |
| Background  | `#12100b` (deckend — muss den Scrim überschreiben)               |
| Text        | `var(--amber)`, 10px (9px in engen Reihen wie dem Modus-Segment) |
| Radius      | `2px` (Control-Radius, **nie** Pill)                             |
| Padding     | `0 4px` (9px-Variante: `0 3px`)                                  |
| Stacking    | `position: relative; z-index: 2`                                 |
| Schrift     | `--font-mono`, tabular                                           |

Für Icon-Buttons ohne Textfläche (Anhang ↥, Diktat 🎙) sitzt die Kappe absolut am Button: `position:absolute; top:-9px; right:-12px` bei `position:relative` auf dem Button; der Button-Container braucht dann `margin-left:10px` Abstand zum Nachbarn, damit sich Kappen nicht berühren.

### Scrim

`position:absolute; inset:45px 0 57px; background: rgba(10,13,12,0.55); z-index:1; pointer-events:none;`
Inset = Höhe der Kopfzeile (oben) bzw. der Fußzeile (unten): **Kopf- und Fußzeile werden nicht gedimmt** und bekommen `position:relative; z-index:2`. Der Scrim liegt über dem Inhalt, die Kappen liegen über dem Scrim. Kein Blur, kein Farbstich — nur Absenkung der Leuchtdichte.

### Fußzeile im gehaltenen Zustand

Der Statustext (`✓ bereit · Branch …`) wird ersetzt durch `⌘ GEHALTEN — Taste drücken oder loslassen` (11px, `--amber`, `letter-spacing:.06em`). Der Primärbutton behält seine `⌘↵`-Kappe, sie wechselt aber von `--line-bright`/75 % Deckkraft auf die volle Amber-Kappe (`border:1px solid var(--amber)`, `background: rgba(232,161,58,0.14)`).

### Fußzeile im Ruhezustand

Rechts neben dem Statustext: `⌘ HALTEN = TASTEN` (10px, `--faint`, `letter-spacing:.06em`). **Der bisherige Hinweis `# Issue · / Befehl · ⌘V Bild` über dem Prompt entfällt ersatzlos.**

### Tastenkarte (`?`)

560px breites Panel, `--panel` auf `1px --line-bright`, `box-shadow: 0 24px 60px -30px #000` (Popover darf Schatten tragen). Kopfzeile auf `--head`: `TASTENKARTE` (11px, +0.18em, `--muted`) · Kontext `Neue Aufgabe` (10px `--faint`) · rechts `ESC schließt`. Inhalt: 2-spaltiges Grid, Gruppen `GLOBAL / PROMPT / KONTEXT / OPTIONEN` (9px, +0.18em, `--faint`), pro Zeile rechtsbündige Taste (10px `--amber`, `min-width:74px`) + Beschreibung (11px `--ink`).

---

## Kürzel-Inventar (kanonisch)

Kappen erscheinen **nur bei Aktionen, die im aktuellen Zustand ausführbar sind** (siehe Regeln unten).

| Zone     | Taste          | Aktion                                    | Kappe sitzt an                              |
| -------- | -------------- | ----------------------------------------- | ------------------------------------------- |
| Global   | `⌘↵`           | Erstellen & starten                       | Primärbutton (auch im Ruhezustand sichtbar) |
| Global   | `ESC`          | Dialog schließen, Entwurf bleibt erhalten | Schließen-✕ in der Kopfzeile                |
| Global   | `?`            | Tastenkarte öffnen                        | – (nur in der Karte gelistet)               |
| Prompt   | `⌘P`           | Fokus in den Prompt                       | rechts neben dem Label `PROMPT`             |
| Prompt   | `#`            | Issue einfügen/suchen                     | Labelzeile `PROMPT`, rechtsbündig           |
| Prompt   | `/`            | Befehl einfügen                           | Labelzeile `PROMPT`, rechtsbündig           |
| Prompt   | `⌘V`           | Bild einfügen                             | Labelzeile `PROMPT`, rechtsbündig           |
| Prompt   | `⌘U`           | Datei anhängen                            | am ↥-Button (absolut, oben rechts)          |
| Prompt   | `⌘D`           | Diktat starten/stoppen                    | am 🎙-Button (absolut, oben rechts)          |
| Kontext  | `⌥R`           | Repo wechseln                             | im Repo-Chip, an Stelle des ▾               |
| Kontext  | `⌥B`           | Basis-Branch wechseln                     | im Branch-Chip, an Stelle des ▾             |
| Kontext  | `⌘F`           | Issue-Filter öffnen                       | im Chip `Filter 2 ▾`, an Stelle des ▾       |
| Kontext  | `⌥T`           | Issues ⇄ Befehle                          | rechts neben dem Issues/Befehle-Umschalter  |
| Kontext  | `↑↓`           | In der Issue-Liste bewegen                | an der ersten Issue-Zeile                   |
| Kontext  | `↵`            | markiertes Issue übernehmen               | – (nur Karte; ↵ ist kontextabhängig)        |
| Optionen | `⌥1` `⌥2` `⌥3` | Modus Code / Recherche / Epic             | in jedem Segment neben dem Label            |
| Optionen | `⌘E`           | Engine wählen                             | im Engine-Select, an Stelle des ▾           |
| Optionen | `⌥M`[^1]       | Modell wählen                             | im Modell-Select, an Stelle des ▾           |
| Optionen | `⌘G`           | Plan-Gate umschalten                      | rechts in der Zeile, ersetzt `AN`/`AUS`     |
| Optionen | `⌥A`[^1]       | Autopilot umschalten                      | rechts in der Zeile, ersetzt `AN`/`AUS`     |

[^1]:
    **Nachträgliche Änderung, vom Auftraggeber am 2026-07-30 freigegeben.** Ursprünglich
    spezifiziert waren `⌘M` und `⌘⇧A`. Beides sind Fenster- bzw. Tab-Aktionen des Browsers
    (`⌘M` = Fenster minimieren unter macOS, `⌘⇧A` = Tab-Suche in Chrome) — genau die Klasse
    von Tastenkombinationen, die eine Seite **nicht** per `preventDefault` abfangen kann,
    im Gegensatz zu Seiten-Aktionen wie `⌘F`/`⌘P`/`⌘D`. Eine Tastenkappe darf nichts
    versprechen, das nicht eintritt, deshalb wandern beide auf die `⌥`-Ebene, die dieser
    Dialog ohnehin schon nutzt (`⌥R`, `⌥B`, `⌥T`) und die browserfrei ist.

> Im gehaltenen Zustand **ersetzen** Kappen die stummen Zeichen an derselben Stelle (▾-Chevrons, `AN`/`AUS`-Readouts). Dadurch springt das Layout nicht: gleiche Zeilenhöhe, gleiche Position, nur anderer Inhalt. Einzige Ausnahme: bei den Modus-Segmenten wird `RECHERCHE` zu `RECH.` gekürzt, damit ⌥2 in die Spalte passt. Wo kein stummes Zeichen existiert (Issues/Befehle-Umschalter), wird die Kappe **angehängt** — der Umschalter selbst bleibt vollständig sichtbar.

---

## Interaktion & Verhalten

**Auslösen**

- `keydown` mit `event.key === 'Meta'` (Windows/Linux: `Control`) startet einen Timer von **350 ms**. Läuft er ab, ohne dass eine weitere Taste gedrückt oder die Maus bewegt/geklickt wurde → Zustand `keymapVisible = true`.
- `keyup` von Meta/Control, `blur` des Fensters, jedes `mousedown` und jedes `Escape` → `keymapVisible = false`, Timer abbrechen.
- Wird **während** der 350 ms eine Kombination vollendet (z. B. ⌘V), führt sie normal aus und die Karte erscheint nicht. Das ist der Kern: Profis werden nie gestört.
- Wird eine Kombination **im sichtbaren Zustand** ausgelöst, wird sie ausgeführt, die Kappe des getroffenen Controls blitzt **einmal** auf (`background: rgba(232,161,58,0.22)`, 120 ms) und der Overlay-Zustand endet.
- Die Karte erscheint **nur, wenn der Dialog offen und fokussiert ist**. Kein globales Listener-Leck: `addEventListener` auf dem Dialog-Root bzw. `window` mit Guard auf `dialogOpen`.

**Ein-/Ausblenden**

- Scrim: `opacity 0 → 1`, **120 ms**, `cubic-bezier(0.2,0.8,0.3,1)`.
- Kappen: `opacity 0 → 1` + `transform: translateY(-2px) → none`, **120 ms**, mit **Stagger 0** (alle gleichzeitig — gestaffelte Kappen lesen sich als Spielerei und verzögern das Ablesen).
- Ausblenden: 80 ms, nur `opacity`.
- Nur `transform`/`opacity` animieren (Compositor). Kein animierter `box-shadow`.

**Deaktivierte Aktionen**
Ist eine Aktion aktuell nicht möglich (z. B. `⌘↵` ohne Prompt und ohne Issue), wird die Kappe in `--faint` auf `--inset` statt Amber gezeichnet, mit `opacity: .5`. Sie verschwindet **nicht** — Nutzer sollen lernen, dass das Kürzel existiert.

**Textfelder**
`?` öffnet die Tastenkarte nur, wenn der Fokus **nicht** in einem Text-/Textarea-Feld liegt. `⌘`-Halten funktioniert auch im Prompt (dort ist es besonders nützlich).

**Touch/Mobile**
Kein ⌘ auf Touch — dort entfällt der Zustand vollständig, statt dessen bleibt der bestehende Mobile-Dialog unverändert. Externe Tastatur an iPad: Feature aktiv (Erkennung über das erste `keydown` mit Meta).

**Accessibility**

- Scrim ist `aria-hidden="true"`, Kappen sind `aria-hidden="true"` (dekorativ). Die semantische Quelle ist `aria-keyshortcuts` auf **jedem** Control (z. B. `aria-keyshortcuts="Meta+G"`) — das ist ohnehin die richtige Implementierung und macht die Kürzel für Screenreader verfügbar.
- Die Tastenkarte (`?`) ist ein fokussierbarer Dialog mit Focus-Trap, `role="dialog"`, `aria-label="Tastenkürzel"`.
- `prefers-reduced-motion`: Transitions entfallen (sofortiges Ein-/Ausblenden), Funktion bleibt.
- Kontrast: Amber `#e8a13a` auf `#12100b` ≈ 8.9:1 — passt für 10px-Text.

**Plattform-Labels**
Kappenbeschriftung wird plattformabhängig gerendert: macOS `⌘ ⌥ ⇧ ↵`, Windows/Linux `Strg Alt Umschalt ↵` (dann ist die Kappe breiter — Padding `0 5px`, Text 9px). Erkennung einmalig über `navigator.platform`/UA-CH, als Store, nicht pro Kappe.

---

## State

```ts
keymap: {
  visible: boolean; // Scrim + Kappen sichtbar
  armTimer: number | null; // 350-ms-Timer-Handle
  sheetOpen: boolean; // volle Tastenkarte (?)
  flash: string | null; // id des zuletzt ausgelösten Controls (120 ms)
}
```

Keine Persistenz. Kein Onboarding-Zustand, kein „schon gesehen"-Flag — das ist die Stärke gegenüber 10c.

Registrierung der Kürzel: **eine Quelle**, z. B. `ui/src/lib/keymap/newTask.ts` mit `{ id, keys, label, zone, enabled(ctx), run(ctx) }`. Aus derselben Liste speisen sich (a) der Handler, (b) die Kappen, (c) die Tastenkarte, (d) `aria-keyshortcuts`. **Keine zweite Liste im Markup pflegen.**

---

## Design Tokens

| Token                                            | Wert                                                      | Verwendung                  |
| ------------------------------------------------ | --------------------------------------------------------- | --------------------------- |
| `--bg`                                           | `#0a0d0c`                                                 | Seitengrund                 |
| `--inset`                                        | `#070a09`                                                 | Eingaben, vertiefte Flächen |
| `--panel-2`                                      | `#0c100f`                                                 | rechte Optionsspalte, Chips |
| `--head`                                         | `#0a0f0d`                                                 | Kopf-/Fußzeile              |
| `--panel`                                        | `#0f1413`                                                 | Dialogfläche                |
| `--sel`                                          | `#18211e`                                                 | aktives Segment             |
| `--line` / `--line-bright`                       | `#1b2422` / `#2c3835`                                     | Hairlines                   |
| `--faint` / `--muted` / `--ink` / `--ink-bright` | `#4a5752` / `#7c8c86` / `#c4d0cb` / `#eef4f0`             | Textstufen                  |
| `--amber`                                        | `#e8a13a`                                                 | Kappen, Primäraktion        |
| `--green`                                        | `#5ad19a`                                                 | „bereit"                    |
| _(neu)_ `--cap-bg`                               | `#12100b` (dark) · `var(--color-panel)` (light)[^2]       | Kappenfüllung               |
| Scrim                                            | `rgba(10,13,12,0.55)`                                     | Dimmung                     |
| Radius                                           | `2px` Controls/Kappen · `6px` Chips · **nie** Pill        |
| Abstände                                         | 4 / 8 / 12 / 16 / 22                                      |
| Schrift                                          | `"Berkeley Mono","JetBrains Mono",ui-monospace,monospace` |

[^2]:
    **Nachträgliche Ergänzung.** Der spezifizierte Wert `#12100b` bleibt im Dark-Theme
    unverändert — dort ist er vermessen (Amber `#e8a13a` darauf ≈ 8,7:1). Für die
    Light-Themes, die der Handoff nicht kennt, wird er überschrieben: mit Lights dunklerem
    Amber fällt derselbe Kasten auf 4,2:1, unter Light+High-Contrast (Amber `#7a4a00`)
    sogar auf **2,5:1** — weniger als die Hälfte von WCAG AA, ausgerechnet im Theme, das
    mehr Kontrast herstellen soll. `var(--color-panel)` erreicht dort 4,3:1 bzw. 7,1:1 und
    ist ebenfalls deckend (Bedingung, um den Scrim zu überschreiben). Die 4,3:1 im
    Light-Theme sind die Obergrenze für _jede_ Füllung: das ist Lights
    Amber-auf-Panel-Verhältnis, das alle Amber-Chips der App teilen, keine Eigenheit der
    Kappe.

## Assets

Keine. Alle Zeichen sind Unicode-Glyphen (`⌘ ⌥ ⇧ ↵ ↑ ↓ ⇥ ✕ ▾ ✓`), passend zur Shepherd-Ikonografie.

## Files

- `reference-10a.html` — die Design-Referenz (drei Zustände), self-contained.
- `CLAUDE_CODE_PROMPT.md` — fertiger Implementierungs-Prompt für Claude Code.
- Im Projekt: `New Task Modal.dc.html`, Abschnitt **Turn 10 / 10a** (dort auch die Alternativen 10b und 10c).
