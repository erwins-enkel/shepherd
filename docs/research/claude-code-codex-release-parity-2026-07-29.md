# Claude Code und Codex: Release- und Paritätsprüfung vom 29.07.2026

## Kurzfassung

Geprüft wurden die aktuellen stabilen Releases **Claude Code 2.1.220** und **Codex 0.146.0**
sowie die für Shepherd relevanten Änderungen unmittelbar davor. Beide Versionen sind lokal
installiert; auf den offiziellen Release-Seiten gibt es am Stichtag keinen neueren Stable Release.

Die sichtbaren TUI-, Resume- und MCP-Fixes wirken größtenteils automatisch. Vier Punkte verdienen
Arbeit in Shepherd:

1. Claudes persistenter **Fast Mode** kann unbeaufsichtigte Rollen unerwartet verteuern, während
   Shepherd weiterhin Standard-Opus-Preise ansetzt.
2. Codex kann seine SQLite-State-DB jetzt zuverlässig außerhalb von `CODEX_HOME` ablegen;
   Shepherd sucht sie weiterhin nur dort und kann Usage dadurch lautlos verlieren.
3. Codex' stabiles `/fork` wechselt zu einer neuen Thread-ID. Shepherds gespeicherte
   `providerSessionId` ist dagegen populate-once und kann anschließend veraltet sein.
4. Die Konfigurationsisolation transienter Codex-Rollen sollte nach dem Ausbau von Plugins, Hooks
   und MCP gegen die bereits strengere Claude-Isolation geprüft werden.

Die schon speziell markierten Claude-Workarounds funktionieren unter 2.1.220 weiterhin. Für die
Scroll-Lücke aus [#1642](https://github.com/erwins-enkel/shepherd/issues/1642) war dagegen keine
belastbare Revalidierung möglich, weil das Diagnose-Skript mit Herdr 0.7.5 veraltet ist.

## Umfang und Methode

- Primärquellen: [Claude-Code-Releases](https://github.com/anthropics/claude-code/releases),
  [Claude Code 2.1.220](https://github.com/anthropics/claude-code/releases/tag/v2.1.220),
  [Codex-Releases](https://github.com/openai/codex/releases) und
  [Codex 0.146.0](https://github.com/openai/codex/releases/tag/rust-v0.146.0).
- Für Claude wurden die stabilen Releases 2.1.186 bis 2.1.220 auf Shepherds markierte Bereiche
  Terminal, Resume, Hooks, MCP, Subagents und Usage geprüft. 2.1.220 selbst enthält nur allgemein
  bezeichnete Bugfixes und Zuverlässigkeitsverbesserungen; die konkreten neuen Integrationspunkte
  stammen vor allem aus 2.1.219.
- Für Codex wurde 0.146.0 gegen Shepherds Spawn-, Plugin-, Usage-, Session-ID-, Restore- und
  Updatepfade geprüft. Behauptungen über noch unveröffentlichtes `main` werden nicht als
  implementierbare Stable-Funktion behandelt.
- Zusätzlich wurden die expliziten Reverify-Kommentare im Shepherd-Code praktisch gegen die lokal
  installierten CLIs (`claude 2.1.220`, `codex-cli 0.146.0`) geprüft.

## Priorisierte Handlungsmatrix

| Priorität | Befund                                              | Status in Shepherd                                                  | Empfehlung                                                                                                                                                                                |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1**    | Claude Fast Mode und Kosten                         | Neu, noch nicht erfasst                                             | Eigenes Issue/Spike; Policy für unbeaufsichtigte Rollen festlegen und tatsächlichen Service-Tier in Usage abbilden                                                                        |
| **P1**    | Getrenntes Codex-SQLite-Home                        | Neu, noch nicht erfasst                                             | Bug-Issue; Rollout-Home und State-DB-Home getrennt auflösen und testen                                                                                                                    |
| **P1**    | Codex `/fork` lässt gespeicherte Thread-ID veralten | Teilweise von Session-ID-Parität erfasst                            | [#1267](https://github.com/erwins-enkel/shepherd/issues/1267) um In-Terminal-Threadwechsel ergänzen; Aussage in [#1963](https://github.com/erwins-enkel/shepherd/issues/1963) korrigieren |
| **P1/P2** | Isolation transienter Codex-Rollen                  | Lücke, aber gewünschte Vererbung offen                              | Kleiner Hardening-Spike; keine Flags ungeprüft übernehmen                                                                                                                                 |
| **P2**    | Plugin-/Command-Picker-Parität                      | Bereits erfasst                                                     | [#1963](https://github.com/erwins-enkel/shepherd/issues/1963) umsetzen; Root-only-Manifeste noch nicht spekulativ unterstützen                                                            |
| **P2**    | Scroll-Revalidierung                                | [#1642](https://github.com/erwins-enkel/shepherd/issues/1642) offen | Erst Diagnose an Herdr 0.7.5 anpassen und hart auf vollständig erzeugten Testtext prüfen                                                                                                  |
| **Defer** | App Server, Remote Code Mode, Executor-Skills       | Kein inkrementeller Ersatz für die PTY-Integration                  | Nur als eigene Architekturentscheidung evaluieren                                                                                                                                         |

## 1. Claude Fast Mode: Kosten- und Policy-Lücke

[Claude Code 2.1.219](https://github.com/anthropics/claude-code/releases/tag/v2.1.219) führt Opus 5
als Standard-Opus mit 1M Kontext ein und nennt für Fast Mode **$10 Input / $50 Output pro Mtok**.
Laut [offizieller Fast-Mode-Dokumentation](https://code.claude.com/docs/en/fast-mode) bleibt die
Geschwindigkeitspräferenz standardmäßig über Sitzungen erhalten; sie lässt sich unter anderem mit
`CLAUDE_CODE_DISABLE_FAST_MODE=1` abschalten.

Shepherds [`src/pricing.ts`](../../src/pricing.ts) bewertet alle Opus-Modelle mit den normalen
$5/$25-Raten. [`src/usage.ts`](../../src/usage.ts) erfasst Modell und Token-Buckets, aber keinen
Service-Tier. Erbt eine unbeaufsichtigte oder transiente Rolle einen zuvor aktivierten Fast Mode,
werden ihre Input-/Output-Kosten deshalb mit der Hälfte des von Anthropic genannten Fast-Preises
bewertet. Zudem kann ein persistenter Nutzerzustand unbemerkt die Kosten automatischer Rollen
beeinflussen.

**Empfehlung:** Als Produktentscheidung festlegen, ob Fast Mode für unattended/transient Spawns
explizit deaktiviert wird. Für attended Sessions den tatsächlich verwendeten Tier erfassen, sofern
das Transcript ihn verlässlich ausweist; andernfalls die Kostendarstellung als Schätzung kenntlich
machen. Nicht pauschal die Opus-Tabelle verdoppeln, denn normale Opus-Sitzungen bleiben $5/$25.

## 2. Codex: getrenntes SQLite-Home

Codex 0.146 konsolidiert mit [PR #34994](https://github.com/openai/codex/pull/34994) die Nutzung des
konfigurierten SQLite-Homes. Die offizielle
[Konfigurationsreferenz](https://developers.openai.com/codex/config-reference/) dokumentiert
`sqlite_home`; zusätzlich existiert `CODEX_SQLITE_HOME` als Environment-Override.

Shepherds [`codexHome()`](../../src/codex-usage.ts) kennt nur `CODEX_HOME` beziehungsweise
`~/.codex`. `listRolloutFiles()` sucht darunter Sessions, `latestCodexStateDb()` aber auch die
`state_N.sqlite`. Bei getrenntem SQLite-Home funktionieren Codex und die Rollouts weiter, während
Shepherd keine oder veraltete State-/Usage-Daten finden kann.

**Empfehlung:** Rollout-Home und SQLite-Home getrennt modellieren und mit Environment- sowie
Config-Override testen. `codex doctor --json` zeigt den effektiv aufgelösten DB-Pfad
maschinenlesbar an, ist wegen seiner zusätzlichen Prüfungen aber nicht ohne Messung für den
Usage-Hotpath geeignet. Ob Shepherd die Codex-Konfigurationsauflösung selbst spiegelt oder das
Doctor-Ergebnis außerhalb des Hotpaths cached, bleibt eine Implementierungsentscheidung.

## 3. Codex `/fork`: echte Parität, neue Zuordnungslücke

Die offizielle [Codex-CLI-Referenz](https://developers.openai.com/codex/cli/reference/) führt sowohl
`codex fork` als auch `/fork` als stabile Funktionen. `/fork` klont den aktuellen Chat unter einer
frischen ID und wechselt die TUI auf diesen neuen Thread. Damit ist die bisherige Aussage in
[#1963](https://github.com/erwins-enkel/shepherd/issues/1963), der Fork-Primitive sei nur
App-Server-seitig und schließe keine CLI-Parität, nicht mehr richtig.

Shepherds [`captureCodexSessionId()`](../../src/service.ts) setzt `providerSessionId` nur, solange
das Feld leer ist. Nach einem Fork bleibt die TASK-Zeile folglich auf der ursprünglichen ID. Das ist
besonders für die geplanten transcript- und recap-basierten Flows
[#1818](https://github.com/erwins-enkel/shepherd/issues/1818) und
[#1819](https://github.com/erwins-enkel/shepherd/issues/1819) relevant. Der archivierte Restore ist
teilweise robuster: `resolveCodexRestoreId()` leitet die neueste passende Rollout-ID anhand der cwd
frisch her und schreibt sie zurück. Das beseitigt aber nicht die während einer laufenden Sitzung
veraltete Zuordnung.

**Empfehlung:** [#1267](https://github.com/erwins-enkel/shepherd/issues/1267) um Akzeptanzkriterien
für native Thread-Transitions (`/fork`, und nach Prüfung auch `/clear`, `/new` oder Side-Chats)
erweitern. Keine parallele Shepherd-Fork-Oberfläche bauen; zuerst die aktive Provider-ID nach einem
nativen Wechsel korrekt verfolgen.

## 4. Plugins, Hooks und transiente Codex-Isolation

Codex 0.146 erweitert Plugin-/Marketplace-Discovery, Hooks und MCP-Lifecycle. Die Command-Picker-
und Manifest-Abweichungen zu Shepherd sind bereits in
[#1963](https://github.com/erwins-enkel/shepherd/issues/1963) erfasst. Der veröffentlichte Finder
sucht `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json` und
`.cursor-plugin/plugin.json`; die offizielle
[Plugin-Struktur](https://developers.openai.com/plugins/build/plugins#plugin-structure) verlangt
weiterhin `.codex-plugin/plugin.json`. Ein nur im Root liegendes `plugin.json` sollte Shepherd daher
noch nicht unterstützen.

Für transiente Rollen besteht dagegen eine reale Asymmetrie:

- Claude erhält aus [`src/transient-agent-argv.ts`](../../src/transient-agent-argv.ts)
  `disableAllHooks`, `--disable-slash-commands` und für MCP-isolierte Presets das gekoppelte
  `--safe-mode`/`enableAllProjectMcpServers`.
- Codex startet über [`src/codex-role-argv.ts`](../../src/codex-role-argv.ts) mit
  `codex exec --sandbox workspace-write` und lädt ansonsten die normale Nutzerkonfiguration.

Codex 0.146 dokumentiert für `exec` `--ignore-user-config` und `--ignore-rules`. Vor einem Einsatz
muss geklärt werden, welche gewollten Nutzer-/Projektstandards, Skills und MCP-Definitionen interne
Rollen weiterhin erben sollen. `--dangerously-bypass-hook-trust` wäre keine Isolation, sondern
würde Hooks gerade ohne Rückfrage freigeben.

## 5. Explizit markierte Revalidierungen

### Claude 2.1.220: beide Annahmen bestätigt

1. Der Kill-Switch `tui: "default"` aus
   [`src/transient-agent-argv.ts`](../../src/transient-agent-argv.ts) wurde bereits in
   [PR #1957](https://github.com/erwins-enkel/shepherd/pull/1957) gegen Claude 2.1.220 mit echter
   Reviewer-argv und end-to-end geprüft. Der Fullscreen-Upsell blockiert die unbeaufsichtigte Rolle
   damit nicht. **Beibehalten.**
2. Ein zusätzlicher PTY-Repro verwendete die tatsächliche MCP-isolierte Reviewer-Konfiguration:
   `--safe-mode`, `enableAllProjectMcpServers: true`, `--allowedTools Read` und
   `--permission-mode dontAsk`. Eine projektlokale `.mcp.json` löste keinen Approval-Prompt aus,
   ihr Testserver wurde nicht gestartet und Claude lieferte normalen Output. **Das gekoppelte Paar
   beibehalten.** Testkonfiguration und Transcript wurden anschließend entfernt.

Auch die Trust-Vorbelegung, gepinnten Claude-Session-IDs, Usage-Probe sowie die vorhandenen
Terminal-/Mouse-/No-Flicker-Kontrollen werden durch keine Release Note belastbar obsolet.

### Codex 0.146: Scroll-Ergebnis unentscheidbar

Der in [#1642](https://github.com/erwins-enkel/shepherd/issues/1642) verlangte Lauf von
`bun scripts/verify-herdr-terminal.ts --scroll` scheitert mit Herdr 0.7.5 zunächst an der veralteten
`herdr agent start --cwd`-Syntax. Mit einer nur für den Repro angepassten Startsequenz erzeugte Codex
die nummerierte Testausgabe nicht bis zur geforderten Zeile 80; damit war keine Scroll-Matrix
auswertbar. Außerdem meldete der Codex-only-Lauf fälschlich eine Claude-Baseline-Abweichung.

**Folgerung:** Weder „Codex hat weiterhin keinen Scroll-Hebel“ noch „0.146 löst die Lücke“ ist durch
diesen Lauf belegt. Das Skript sollte zuerst an Herdr 0.7.5 angepasst werden, unvollständige
Transcripts als Fehler behandeln und Baselines nur für tatsächlich getestete Provider vergleichen.
[#1642](https://github.com/erwins-enkel/shepherd/issues/1642) bleibt offen. Die temporäre
Repro-Anpassung wurde vollständig zurückgenommen.

## 6. Automatische Gewinne ohne Shepherd-Änderung

- **Codex 0.146:** reaktionsschnellere TUI-/Interrupt-Behandlung, robustere Darstellung und
  Runtime-Refresh/Reconnect von MCP-Verbindungen. Das verbessert Shepherds PTY-Sitzungen, schafft
  aber keine Claude-/Codex-Konfigurationsparität.
- **Claude 2.1.216/217:** Fixes für quadratische Verlangsamung langer Sessions, Resume, fehlerhafte
  Attachments und Memory-Leaks. 2.1.203/206 verbessern Mouse- und Resume-Input; 2.1.210 behebt
  überlappende Frames im Classic Renderer.
- **Claude 2.1.214:** korrigiert doppelte Token-/Kosten-Telemetrie. Shepherd dedupliziert schon nach
  `requestId`, daher ist keine Gegenänderung nötig.
- **Claude 2.1.212:** schreibt Reasoning Effort pro Assistant-Nachricht ins Transcript. Das könnte
  später die tatsächlich verwendete Effort-Historie verbessern, ist aber keine akute Kosten- oder
  Paritätslücke.
- **Claude 2.1.219 `DirectoryAdded`:** Shepherd ingestiert dieses Hook-Event noch nicht. In der
  bwrap-Isolation erzeugt `/add-dir` jedoch keinen neuen Host-Mount; vorerst höchstens für Warnung
  oder Telemetrie interessant, nicht als Zugriffserweiterung.
- **Claude 2.1.219 nested subagents:** Standardtiefe steigt auf drei. Ohne konkreten Schaden sollte
  Shepherd sie nicht künstlich auf eins pinnen; eine hierarchische Darstellung wäre eine separate
  Roster-/UX-Entscheidung.

## 7. Beibehalten oder zurückstellen

- Codex hat weiterhin keine Spawn-Time-`--session-id`; Shepherds Rollout-Discovery bleibt nötig.
- `--no-alt-screen` und der `--output-last-message`-/Ergebnisdatei-Fallback bleiben nötig.
- Codex' eigener Updatepfad ersetzt Shepherds installationskanalübergreifende Updateprüfung nicht.
- App-Server-Remote, Thread-Pinning und Executor-Skills lösen die heutige PTY-Zuordnung nicht
  inkrementell und gehören in eine eigene Architekturentscheidung.
- Das Enterprise-Requirement `in_app_updates` aus
  [PR #35537](https://github.com/openai/codex/pull/35537) kann Desktop-In-App-Updates administrativ
  deaktivieren. Ob ein externer Shepherd-Updater diese Codex-Produktpolicy ebenfalls respektieren
  soll, ist eine offene Enterprise-/Produktentscheidung; daraus folgt noch kein automatischer Fix.

## Empfohlene nächsten Schritte

1. Zwei neue, eng gefasste Issues anlegen: **Claude Fast-Mode-Policy/Usage** und
   **Codex SQLite-Home für Usage**.
2. [#1267](https://github.com/erwins-enkel/shepherd/issues/1267) um native Thread-Wechsel ergänzen
   und den Fork-Abschnitt in [#1963](https://github.com/erwins-enkel/shepherd/issues/1963)
   korrigieren.
3. Im Rahmen von [#1963](https://github.com/erwins-enkel/shepherd/issues/1963) nur die tatsächlich
   dokumentierte Stable-Plugin-Struktur spiegeln.
4. Das Scroll-Diagnoseskript reparieren, bevor aus 0.146 eine Aussage für
   [#1642](https://github.com/erwins-enkel/shepherd/issues/1642) abgeleitet wird.
5. Die gewünschte Vererbung für transiente Codex-Rollen als Produktentscheidung festhalten und
   erst danach `--ignore-user-config`/`--ignore-rules` testen.

Es wurden im Rahmen dieser Recherche bewusst keine Produktänderungen und keine neuen Issues oder
Pull Requests angelegt.
