# Claude Code und Codex: gleiche Plan-Gate-Bedienung in Shepherd

Stand: 12.09.2026. Untersucht: Shepherd-Commit
[`e1e9f223`](https://github.com/erwins-enkel/shepherd/commit/e1e9f2238d2aa0d289de59163dce243438d380e5),
aktuelle Herstellerdokumentation und vorhandene Repository-Experimente.
Lokal meldet `codex --version` **0.154.0**; das ist keine Laufzeitvalidierung der vorgeschlagenen Anbindung.

## Antwort

**Ja, die Plan-Gate-Bedienung lässt sich für beide CLIs vereinheitlichen.** Der aktuelle Unterschied
entsteht durch Shepherds unvollständige Zuordnung von Codex-Unterhaltungen. Er ist keine belegte
grundsätzliche Einschränkung von Codex. Gemeinsame Abläufe brauchen allerdings weiterhin passende
Anbindungen an die unterschiedlichen CLIs.

Als konkreten Bezug verwendet dieser Bericht den zuletzt geänderten Plan-Gate-Hinweis aus
[PR #2292](https://github.com/erwins-enkel/shepherd/pull/2292). Der Prompt nennt keine einzelne
Oberfläche; deshalb ergänzt Abschnitt 5 die Einordnung um weitere Unterschiede. Die Umsetzung der
Plan-Gate-Parität ist bereits in [#2291](https://github.com/erwins-enkel/shepherd/issues/2291)
erfasst. Dieser Bericht dokumentiert Begründung und Lösungswege ohne konkurrierenden Implementierungsauftrag.

## 1. Warum der Unterschied heute besteht

Für normale, vom Operator gestartete Tasks gilt nach erfolgreicher Planprüfung:

| Einstellung                        | Claude Code                      | Codex                            |
| ---------------------------------- | -------------------------------- | -------------------------------- |
| Autopilot aus                      | Operator gibt die Umsetzung frei | Operator gibt die Umsetzung frei |
| Autopilot an, isolierter Worktree  | Automatische Freigabe            | Automatische Freigabe            |
| Autopilot an, gemeinsamer Checkout | Automatische Freigabe            | Wartet auf den Operator          |

Diese Entscheidung steht ausdrücklich in
[`PlanGateService.applyApproved()`](../../src/plan-gate.ts#L1513). Für vom Drain gestartete Tasks
existiert zusätzlich der separate `s.auto`-Freigabepfad. Die Tests für beide Codex-Isolationsfälle
stehen in [plan-gate-service.test.ts](../../test/plan-gate-service.test.ts#L662).

Die Ursache liegt tiefer als im Tooltip:

1. Claude bekommt beim Start eine feste `--session-id`; Resume verwendet diese ID.
   Siehe [Claude-Start](../../src/service.ts#L3100) und [Claude-Resume](../../src/service.ts#L3223).
2. Codex wird interaktiv gestartet. Shepherd sucht dessen selbst erzeugte ID nachträglich anhand
   von Arbeitsverzeichnis und Rollout-Metadaten. `captureCodexSessionId()` arbeitet nur für isolierte
   Sessions und nur solange die gespeicherte ID fehlt. Siehe
   [Erfassung](../../src/service.ts#L3262) und [Resolver](../../src/codex-session-id.ts).
3. Im normalen Resume-Pfad reicht Shepherd diese gespeicherte ID **nicht** weiter. Damit verwendet
   `buildCodexResumeArgv()` weiterhin `codex resume --last`. Das ist sogar ausdrücklich durch
   [einen Test](../../test/service.test.ts#L3554) festgeschrieben; siehe auch
   [Resume-Aufruf](../../src/service.ts#L4672).
4. In einem gemeinsamen Checkout kann die letzte Unterhaltung zu einem anderen Task oder einem
   manuell gestarteten Codex gehören. Deshalb sperren
   [Autopilot](../../src/autopilot.ts#L277), [Full-auto](../../src/full-auto.ts#L29) und Plan Gate
   die entsprechende Codex-Automatik. Auch archiviertes
   [Restore](../../src/service.ts#L4823) ist für Codex auf isolierte Worktrees begrenzt.

Die Sperre einfach zu entfernen würde den Zuordnungsfehler freilegen. Ebenso reicht es nicht,
eine möglicherweise veraltete oder falsch zugeordnete `providerSessionId` ungeprüft zu verwenden.
Das vorhandene Feld allein liefert noch keine verlässliche aktive Gesprächsidentität.

Codex unterstützt explizites Resume per ID bereits. `--last` wählt dagegen die letzte Unterhaltung
im Arbeitsverzeichnis. Quelle: [offizielle CLI-Referenz](https://learn.chatgpt.com/docs/cli/reference#codex-resume).

## 2. Was aktuelle Schnittstellen ermöglichen

### Zuerst den kleineren Weg prüfen: Lifecycle-Hooks

Die aktuellen **OpenAI Docs** dokumentieren Codex-Hooks wie `SessionStart`, `UserPromptSubmit`
und `Stop`. Die gemeinsamen Eingaben enthalten `session_id`, `cwd` und `transcript_path`.
`SessionStart` unterscheidet `startup`, `resume`, `clear` und `compact`. Bei Subagent-Hooks ist
`session_id` die Elternsession; das Transkriptformat ist ausdrücklich keine stabile Schnittstelle.
Quelle: [Codex Hooks](https://learn.chatgpt.com/docs/hooks#common-input-fields).

**Daraus abgeleitete Implementierungshypothese:** Ein pro Start eindeutig zugeordneter Hook könnte
Shepherd die native ID direkt melden. Damit entfiele die mehrdeutige Suche nach dem neuesten
Rollout im gemeinsamen Verzeichnis. Claude besitzt in Shepherd bereits
[Hook-Ingestion](../../src/hooks-ingest.ts); das ist ein vorhandener Ansatzpunkt, aber kein Beweis,
dass derselbe Empfänger unverändert für Codex passt.

Vor einer Umsetzung muss ein kleiner Laufzeitversuch mit der unterstützten Codex-Version belegen:
Die gemeldete ID bezeichnet den **aktuell fortzusetzenden Thread**, die Meldung lässt sich genau
einem Shepherd-Start zuordnen, und Forks sowie verspätete Meldungen alter Prozesse können diese
Zuordnung nicht überschreiben. Gleiches Verzeichnis und ähnliche Startzeit reichen dafür nicht.
Die Dokumentation allein klärt diese Fälle nicht vollständig; sie nennt insbesondere keinen
eigenen `SessionStart`-Quellwert für einen Fork.

### Alternative: native TUI mit App-Server-Beobachtung

Codex dokumentiert die native Terminaloberfläche an einem App-Server über `codex --remote …`.
Der Server bietet explizites Thread-Resume und strukturierte Ereignisse. Dabei sind `thread.id`
und `thread.sessionId` zu unterscheiden: Forks haben eine neue Thread-ID, können aber dieselbe
Session-Wurzel behalten. Die Dokumentation kennzeichnet App-Server-Kommando und WebSocket-Transport
als experimentell und nicht für Produktionslasten unterstützt. Quelle:
[Codex App Server](https://learn.chatgpt.com/docs/app-server#connect-the-cli-terminal-ui).

Shepherds [Spike #2135](../spikes/2135-codex-app-server.md) hat mit **0.150.1** bereits eine echte TUI
und einen zweiten Beobachter am gleichen Thread praktisch nachgewiesen. Der getestete Startablauf
benötigte allerdings zuerst eine direkte API-Nachricht, bevor die TUI die leere Unterhaltung
fortsetzen konnte. Das war unter Shepherds bestehendem
[PTY-Eingabeprinzip](../../PRD.md#L61) nicht übernehmbar.

Die heutige Dokumentation nennt den direkten TUI-Start am Server. Das macht einen Start über das
Terminal zu einem prüfenswerten Weg, beweist jedoch noch keine eindeutige Zuordnung mehrerer
gleichzeitig gestarteter Terminals. Vor Adoption bleiben diese Zuordnung, Wiederverbindung,
Versionsverträglichkeit und passive Behandlung von Freigabeanfragen zu verifizieren. Der vorhandene
Spike dokumentiert dafür konkrete Betriebsrisiken. Ein vollständiger App-Server-Umbau ist deshalb
keine Voraussetzung, die wir der kleineren Plan-Gate-Korrektur ungeprüft auferlegen sollten.

## 3. Empfohlener gemeinsamer Vertrag

Die Bedienregel sollte lauten: **Ein genehmigter Plan wird bei aktivem Autopilot automatisch
weitergeführt, wenn Shepherd die zugehörige Unterhaltung eindeutig und sicher erreichen kann.**
Fehlende oder widersprüchliche Zuordnung führt bei beiden Providern zu einem sichtbaren manuellen
Stopp. Bei ausgeschaltetem Autopilot bleibt die Freigabe beim Operator.

Für [#2291](https://github.com/erwins-enkel/shepherd/issues/2291) ergibt sich diese Reihenfolge:

1. Den kleinsten verlässlichen Nachweis der Zuordnung von Task, aktuellem Terminalstart und nativer
   Thread-ID liefern; zuerst den Hook-Weg prüfen. Native Thread-Wechsel müssen die Zuordnung
   aktualisieren oder sie ausdrücklich ungültig machen.
2. Resume und anschließende Eingabe auf diese geprüfte Identität festlegen. Automatische
   Fortsetzung darf bei fehlender Identität nicht auf `--last` im gemeinsamen Checkout ausweichen.
   Auch manuelles Resume und Restore müssen auf falsche Zielzuordnung geprüft werden.
3. Erst dann die Codex-Isolationsprüfungen durch dieselbe fachliche Erreichbarkeitsbedingung ersetzen:
   Plan Gate, Autopilot, Startdirektiven und Full-auto müssen übereinstimmen. Bestehende andere
   Voraussetzungen wie Nutzerfreigaben, Planung und Pausenzustände bleiben erhalten.
4. Die EN/DE-Erklärungen anschließend auf die gemeinsame Regel umstellen.

Das lässt sich in den vorhandenen Services umsetzen. Ein neues universelles Provider-Framework
ist für diesen begrenzten Unterschied nicht begründet. Unter dem aktuellen PRD erfolgt
Gesprächseingabe weiterhin über den echten PTY; eine Umstellung auf API-Steuerung wäre eine
gesonderte Produktentscheidung und wird hier nicht vorgeschlagen.

## 4. Verifizierbare Abnahmekriterien für die Umsetzung

- Autopilot aus: Beide CLIs warten nach Planfreigabe auf den Operator.
- Autopilot an und gültige Gesprächszuordnung: Beide CLIs starten nach Freigabe automatisch,
  sowohl im isolierten Worktree als auch im gemeinsamen Checkout.
- Zwei gleichzeitige Tasks und ein zusätzlicher manuell gestarteter Codex im selben Verzeichnis:
  Freigabe, Review-Nacharbeit und Resume erreichen ausschließlich den beabsichtigten Task.
- Beendeter Planner, Prozessneustart, Fork/Thread-Wechsel und verspätete Lifecycle-Meldungen:
  exakte Unterhaltung oder sichtbarer Stopp; keine stille Wahl der neuesten Unterhaltung.
- Fehlender Hook, deaktivierte Hooks, nicht unterstützte CLI-Version oder verlorene Beobachtung:
  keine unbestätigte automatische Fortsetzung.
- Bestehende Claude-Abläufe bleiben funktionsfähig; gemeinsame Vertragstests prüfen beide Provider.

Diese Kriterien sind der Testplan für die spätere Implementierung. In dieser Recherche wurden
Quellcode und vorhandene Tests gelesen, aber keine neue Live-Agent-Sitzung oder Produkttestsuite
ausgeführt. Der frühere Live-Spike wird als frühere Evidenz mit seiner damaligen Version zitiert.

## 5. Wie weit sich die gesamte Umgebung angleichen lässt

| Bereich                         | Befund und Grenze                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task-Ablauf und Plan Gate       | Gleiche fachliche Regeln sind möglich; das konkrete Defizit ist oben beschrieben.                                                                                                                                                                                                                                                                                                                                |
| Aktivitätsanzeige und Verbrauch | Teilweise bereits gemeinsam: Der [Poller](../../src/poller.ts#L568) liest auch Codex-Aktivität. Dagegen liefert [sessionUsageDto](../../src/server.ts#L652) für Codex weiterhin ausdrücklich keine Session-Tokenwerte. Das sind unterschiedliche Ausbaustände einzelner Funktionen.                                                                                                                              |
| Shepherd-Anweisungen            | [composeSystemPromptBlocks](../../src/service.ts#L1861) ist bereits gemeinsam. Die Zustellung unterscheidet sich: Claude erhält Systemprompt-Ergänzung und ausgelagerte [Shepherd-Skills](../../src/agent-skills.ts), Codex die entsprechenden Anweisungen im Prompt. Inhaltliche Parität bedeutet hier nicht identische Lade- und Prioritätssemantik.                                                           |
| Projektregeln                   | Codex unterstützt `project_doc_fallback_filenames`, also auch `CLAUDE.md` als Fallback bei fehlendem `AGENTS.md`. Das ersetzt keine Prüfung von Priorität, konkurrierenden Dateien oder bereichsspezifischen Regeln. Die [Codex-Rollen](../../src/codex-role-argv.ts) setzen diesen Fallback bereits explizit. [Offizielle Konfigurationsreferenz](https://learn.chatgpt.com/docs/config-file/config-reference). |
| Interne Rollen                  | Der [gemeinsame Builder](../../src/transient-agent-argv.ts#L214) liefert schon denselben Ergebnisvertrag. Claude-Toollisten und Codex-Sandbox/Config-Isolation setzen ihn technisch verschieden um; siehe die dokumentierten Restunterschiede in [codex-role-argv.ts](../../src/codex-role-argv.ts).                                                                                                             |
| Native Terminaloberflächen      | Shepherd startet die jeweilige Hersteller-TUI. Deren Darstellung, Befehle und Modelldialoge sind damit nicht von Shepherd identisch implementiert. Gemeinsame Shepherd-Bedienelemente können die gleichen Absichten auf unterschiedliche native Befehle abbilden.                                                                                                                                                |

Die sinnvolle Zielsetzung ist gleiche Bedienung für Shepherd-Funktionen mit überprüfbaren
Voraussetzungen. Unterschiede der Herstellerprotokolle gehören in deren Anbindung; sie sollten
nur dann in der Oberfläche erscheinen, wenn sie eine tatsächliche Entscheidung oder Einschränkung
für den Operator bedeuten.
