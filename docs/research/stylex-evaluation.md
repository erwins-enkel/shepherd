# StyleX für Shepherd

**Empfehlung: vorerst beim bestehenden Styling bleiben.** StyleX bietet echte Vorteile bei typisierten Style-Schnittstellen, der Komposition von Varianten und der Deduplizierung erzeugter CSS-Regeln. Für Shepherd rechtfertigt die bisherige Evidenz jedoch keine breite Migration. Der sinnvollere erste Ansatz wäre, konkret wiederholte Komponentenrezepte gemeinsam zu implementieren und bestehende Token-Regeln automatisch zu prüfen.

Stand: **9. September 2026**. Untersucht wurde Shepherd bei Commit `e6abd37b46e003226904f6432a3aa033afc419f7`, ergänzt durch aktuelle Primärquellen. Dies ist eine Recherche mit Quellcodeinventur, **kein Integrationsversuch und kein Performance-Benchmark**.

## Entscheidungsgrundlage

Die Recherche beantwortet vier überprüfbare Fragen:

1. Welche Styling-Probleme löst Shepherd bereits selbst?
2. Welche zusätzlichen Fähigkeiten bietet StyleX tatsächlich?
3. Wie passt die aktuelle Integration zu unseren Paketen und Build-Werkzeugen?
4. Welche Evidenz würde einen späteren Versuch oder eine Einführung rechtfertigen?

## Was Shepherd heute hat

| Bereich            | Befund                                                                                                                                                                                                        | Bedeutung für StyleX                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Haupt-UI           | Svelte 5, SvelteKit 2, Vite 8 und Tailwind 4 laut [Manifest](../../ui/package.json); [Build](../../ui/vite.config.ts) mit Paraglide, Tailwind und SvelteKit                                                   | Ein zusätzlicher Compiler muss in die vorhandene Pipeline passen.                                                                                                            |
| Lokale Styles      | 276 versionierte `.svelte`-Dateien unter `ui/src`; 260 enthalten `<style>`-Blöcke, zusammen ungefähr 33.077 Zeilen                                                                                            | Viel Bestand für eine Migration; daraus folgt noch keine entsprechende CSS-Downloadgröße.                                                                                    |
| Tokens und Themes  | [app.css](../../ui/src/app.css) enthält semantische Farben, Typografie, Statusfarben sowie Dark/Light und High Contrast; [Theme-Controller](../../ui/src/lib/theme.svelte.ts) steuert die Attribute           | StyleX müsste kein fehlendes Theme-System ersetzen.                                                                                                                          |
| Komponentenrezepte | [Design-System-Seite](../../ui/src/routes/design-system/+page.svelte) dokumentiert Buttons, Felder, Badges und Panels; [Projektregel](../../.claude/rules/ui-design-system.md) verlangt ihre Wiederverwendung | Konventionen existieren, sind aber nicht durchgehend gemeinsame Komponenten. Die Regel nennt ausdrücklich die fehlende automatische Prüfung von Farben außerhalb der Tokens. |
| Extension          | Zwei Svelte-Dateien ohne eigene `<style>`-Blöcke; [app.css](../../extension/src/app.css) importiert Tailwind; [Vite-Konfiguration](../../extension/vite.config.ts) nutzt zusätzlich CRXJS                     | Eigener Integrations- und Prüfaufwand bei kleinerem Styling-Bestand.                                                                                                         |
| Marketing und Docs | Astro beziehungsweise Astro Starlight mit [eigenen CSS-Tokens](../../site/src/styles/global.css) und [Starlight-Variablen](../../docs-site/src/styles/custom.css)                                             | Gemeinsame Markenwerte benötigen nicht zwangsläufig dieselbe Styling-Bibliothek.                                                                                             |
| Root               | Bun-Server und CLI                                                                                                                                                                                            | Kein unmittelbarer Nutzen eines Frontend-Styling-Wechsels.                                                                                                                   |

Die Mengenangaben stammen aus `git ls-files` und einer Textauswertung der `<style>`-Blöcke mit `<style\b[^>]*>(.*?)</style>` über `ui/src/**/*.svelte`. Gezählt wurden die Zeilen jedes getrimmten Treffers einschließlich Kommentaren und Leerzeilen. Das ist eine ungefähre Quelltextinventur, keine AST-Auswertung, Duplikatmessung oder Messung des komprimierten Produktionsbundles.

Eine reale Wiederholung ist bereits dokumentiert: [settings-controls.css](../../ui/src/lib/components/settings/settings-controls.css) wurde eingeführt, damit zwei Settings-Panels nicht dieselben Regeln kopieren. Dieselbe Datei beschreibt, dass mehrere Komponenten eigene `.gbtn`-Rezepte besitzen. Das spricht für gezielte Wiederverwendung; es beweist nicht, dass nur ein anderes Styling-System das Problem lösen kann.

## Was StyleX zusätzlich bringen würde

| Fähigkeit                                | Zusätzlicher Nutzen für Shepherd                                                                     | Grenze                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Typisierte Styles und erlaubte Overrides | Komponenten können festlegen, welche CSS-Eigenschaften oder Werte Aufrufer überschreiben dürfen.     | Der Nutzen entsteht durch entsprechend gestaltete Komponenten-APIs, nicht allein durch Installation.                   |
| Deterministische Komposition             | Varianten lassen sich kombinieren, ohne ihre Reihenfolge über getrennte CSS-Selektoren auszuhandeln. | Die Garantie betrifft StyleX-Komposition; bestehende globale oder Svelte-Regeln unterliegen weiter der CSS-Kaskade.    |
| Atomare CSS-Ausgabe                      | Gleiche Deklarationen können über Komponenten hinweg dieselbe Klasse verwenden.                      | Das dedupliziert Ausgabe, nicht automatisch kopierte Rezepte im Quelltext. Der tatsächliche Bytegewinn ist ungemessen. |
| Typisierte Variablen und Themes          | Referenzen auf zentral definierte Variablen erleichtern Refactorings.                                | Shepherd besitzt bereits semantische CSS-Variablen und laufzeitfähige Themes.                                          |

Die Typ-Schnittstellen sind in [Static types](https://stylexjs.com/docs/learn/static-types/) dokumentiert. Die [Architekturprinzipien](https://stylexjs.com/docs/learn/thinking-in-stylex/) erklären Komposition und Kosten: Bei derselben Eigenschaft gewinnt der zuletzt angewendete Style; Shorthand/Longhand-Auflösung hat eine eigene konfigurierbare Semantik. Lokal statisch auflösbare Aufrufe können wegkompiliert werden, dateiübergreifende Komposition kann Laufzeitcode behalten. Daher wäre „StyleX hat immer null JavaScript-Overhead“ zu pauschal.

Meta berichtet über erhebliche CSS-Einsparungen bei Facebook durch atomare Klassen. Das ist eine reale Erfahrung des Herstellers, aber **keine Prognose für Shepherd**: Unser Vergleich ist Svelte-CSS plus Tailwind, und es gibt hier keine gemessene Vorher/Nachher-Größe. Siehe [Meta Engineering](https://engineering.fb.com/2025/11/11/web/stylex-a-styling-library-for-css-at-scale/).

Svelte bietet bereits [standardmäßig komponentenlokales CSS und gescopte Keyframes](https://svelte.dev/docs/svelte/scoped-styles). Tailwind stellt bereits [Design-Tokens als CSS-Variablen und Utilities](https://tailwindcss.com/docs/theme) bereit. Lokalität, Vermeidung zufälliger Klassennamenskollisionen und Theme-Variablen wären deshalb überwiegend bestehende Fähigkeiten in anderer Form.

StyleX kann außerdem helfen, Design-Regeln maschinell durchzusetzen: Das [ESLint-Plugin](https://stylexjs.com/docs/api/configuration/eslint-plugin/) unterstützt Eigenschafts- und Wertebeschränkungen über `propLimits`. **CSS-Typsicherheit allein verhindert jedoch keine falsche semantische Farbe oder einen unerwünschten Literalwert.** Die Regeln müssen konfiguriert werden. Eine automatische Prüfung unserer vorhandenen CSS- und Svelte-Quellen wäre eine gezieltere Alternative; deren Implementierung wurde hier nicht untersucht.

## Aktuelle Kompatibilität

### SvelteKit ist inzwischen offiziell dokumentiert

Ein Einwand wie „StyleX funktioniert nur mit React“ wäre falsch. Die aktuelle [SvelteKit-Anleitung](https://stylexjs.com/docs/learn/installation/vite/sveltekit) verwendet das offizielle `@stylexjs/unplugin`, platziert es hinter `sveltekit()` und setzt `enforce: undefined`. Sie beschreibt außerdem den CSS-Einstieg und die virtuelle CSS-/Runtime-Einbindung für HMR im Entwicklungsmodus. [stylex.attrs](https://stylexjs.com/docs/api/javascript/attrs/) liefert `class` und einen String für `style`, passend zum Svelte-Markup.

Bei direkter Prüfung der npm-Registry waren `@stylexjs/stylex` und `@stylexjs/unplugin` unter `latest` jeweils **0.19.0**. Quellen: [StyleX-Registry-Metadaten](https://registry.npmjs.org/@stylexjs/stylex/latest), [Unplugin-Registry-Metadaten](https://registry.npmjs.org/@stylexjs/unplugin/latest).

Das [offizielle SvelteKit-Beispiel](https://github.com/facebook/stylex/blob/main/examples/example-sveltekit/package.json) verwendet zum Recherchezeitpunkt Svelte `^5.55.7`, SvelteKit `^2.60.1` und Vite `^7.2.6`. Shepherd deklariert neuere Versionen, insbesondere Vite `^8.2.2`. Daraus folgt **weder nachgewiesene Inkompatibilität noch verifizierte Kompatibilität** mit unserem exakten Stack. Ein Versuch müsste auch Paraglide, Tailwind, Browser-Tests und den Produktionsbuild einschließen.

Shepherd ist aktuell eine statisch ausgelieferte SPA: [Layout-Konfiguration](../../ui/src/routes/+layout.ts) setzt `ssr = false` und `prerender = true`; [Svelte-Konfiguration](../../ui/svelte.config.js) verwendet `adapter-static`. SSR- oder React-Server-Component-Vorteile sind deshalb kein unmittelbares Kaufargument. Relevant sind CSS-Ausgabe, erste Darstellung, Navigation und HMR.

### Eine Integration vereinheitlicht nicht automatisch alle Pakete

Die Extension besitzt ihre eigene Svelte-/Vite-/CRXJS-Pipeline; deren Kombination ist durch die SvelteKit-Anleitung nicht getestet. Bei Astro gibt es zudem eine konkrete Einschränkung: Der offene [StyleX-PR #1821](https://github.com/facebook/stylex/pull/1821) behandelt die Aufnahme kompilierter `.astro`-Module in den Transform-Filter. Der [veröffentlichte Plugin-Quellcode](https://github.com/facebook/stylex/blob/0.19.0/packages/%40stylexjs/unplugin/src/core.js) bestätigt den Filter auf JavaScript- und Svelte-Module. Zum Recherchezeitpunkt war dieser Fix nicht gemergt. Das belegt eine Lücke dieses Integrationswegs, kein grundsätzliches Verbot anderer Astro-Integrationen. Eine reibungslose gemeinsame Einführung in UI, Extension, Marketing und Docs ist damit nicht belegt.

## Was die Migration tatsächlich kosten würde

**Styles und Aufrufstellen umarbeiten.** Bestehende Selektoren müssten auf direkt angewendete StyleX-Styles und Varianten abgebildet werden. StyleX verlangt statisch analysierbare Definitionen; dynamische Werte sind über dafür vorgesehene Funktionen und CSS-Variablen möglich. Hover, Media Queries und dynamische Abmessungen sind also nicht generell ausgeschlossen. Siehe [Defining styles](https://stylexjs.com/docs/learn/styling-ui/defining-styles/).

**Den Mischbetrieb beherrschen.** Ein schrittweiser Einstieg ist möglich. StyleX muss dafür aber mit Tailwind-Layern, globalen Regeln und Sveltes zusätzlicher Selektorspezifität zusammenspielen. Eine automatische Übersetzung von `.gbtn` löst keine Fragen zu erlaubten Varianten, Fokuszuständen oder Semantik. Dafür bleiben Komponentenentwurf und visuelle Prüfung notwendig.

**Bestehende Token-Verbraucher erhalten.** [theme.svelte.ts](../../ui/src/lib/theme.svelte.ts) liest berechnete CSS-Werte für xterm; [WireframeBlock.svelte](../../ui/src/lib/components/blocks/WireframeBlock.svelte) überträgt Tokens in ein iframe; [Viewport.svelte](../../ui/src/lib/components/Viewport.svelte) enthält globale Regeln für fremdes xterm-Markup. Ein Compilerwechsel ersetzt diese Grenzen nicht. StyleX kann bestehende `var(--…)`-Werte weiterverwenden; `defineVars` unterstützt auch stabile Namen mit `--`-Präfix. Eine Umbenennung aller Tokens wäre daher unnötig, und eine reine Brücke auf CSS-Strings würde noch keine vollständige Typsicherheit der alten Token-Namen schaffen. Siehe [Defining variables](https://stylexjs.com/docs/learn/theming/defining-variables/) und [Creating themes](https://stylexjs.com/docs/learn/theming/creating-themes/).

Für Entwickler und Coding-Agents könnten typisierte Imports und Compilerdiagnosen wertvoll sein. Gleichzeitig bleibt das Wissen über StyleX-Definitionen, Komposition und Mischbetrieb zusätzlich zum bestehenden CSS-Wissen erforderlich. Eine Beschleunigung von Entwicklungsarbeit oder eine Verringerung von UI-Fehlern wurde hier nicht gemessen.

## Empfehlung und Bedingungen für eine Neubewertung

**Jetzt:** Keine projektweite Einführung und keine vorsorgliche zweite Styling-Konvention nur für neue Komponenten. Bei konkreten Wiederholungen zunächst die vorhandenen Rezepte gezielt gemeinsam implementieren. Falls Design-Drift das Hauptproblem ist, zuerst die fehlende automatische Token-Prüfung bewerten. Beides sind Empfehlungen für spätere Entscheidungen, keine Änderungen dieses Reports.

**Erneut prüfen**, wenn wiederkehrende Konflikte bei Style-Overrides nachgewiesen sind, eine größere Komponentenbibliothek mit typisierten Styling-Schnittstellen geplant wird oder Messungen das ausgelieferte CSS als relevantes Performanceproblem zeigen.

Ein dann sinnvoller, begrenzter Versuch würde eine zusammenhängende Komponentenfamilie mit realen Varianten, etwa Settings-Felder und Buttons, migrieren und vorher festgelegte Kriterien prüfen:

1. Installation, `bun run check`, `bun run test` und Produktionsbuild funktionieren mit den tatsächlich aufgelösten Shepherd-Versionen. HMR verarbeitet auch Änderungen an importierten Tokens zuverlässig.
2. Dark/Light, High Contrast, mobile Ansichten, Fokus und Disabled-Zustände bleiben visuell und funktional gleich; vorhandene Token-Verbraucher funktionieren weiter.
3. Derselbe Bildschirm wird vor und nach der Änderung auf komprimierte CSS- **und** JS-Transfergröße, erste Darstellung, Buildzeit und HMR-Latenz verglichen. Verbesserungen müssen außerhalb der Messstreuung liegen und ein vorher benanntes Problem lösen.
4. An einer konkreten Variantenänderung wird geprüft, ob die neue API weniger unabhängige Änderungen verlangt und unerlaubte Overrides tatsächlich erkennt. Automatische Deduplizierung allein genügt nicht als Wartbarkeitsnachweis.

Eine vollständige Migration braucht anschließend eine gesonderte Aufwand-Nutzen-Abwägung. Ein erfolgreicher kleiner Versuch würde sie nicht automatisch rechtfertigen.

## Verifikation und Grenzen dieses Reports

Geprüft wurden Paketmanifeste, Build-Konfigurationen, Theme-Code, Design-Regeln, Komponentenbeispiele sowie aktuelle offizielle Dokumentation, Registry-Metadaten und der genannte Integrations-PR. Es wurden keine Produktdateien geändert und keine Dependencies für einen StyleX-Versuch installiert. Die Empfehlung ist eine architektonische Abwägung auf dieser Grundlage; Aussagen über tatsächliche Geschwindigkeits-, Bundle- oder Produktivitätsgewinne bleiben offen.
