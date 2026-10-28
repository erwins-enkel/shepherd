# Desktop-Agent-Umgebungen aus Claude Code und Codex nutzen

Stand: 28. Oktober 2026. Recherche anhand offizieller Dokumentation und der lokal
installierten CLIs; keine Cloud-Aufgabe gestartet, keine Runtime-Konfiguration geändert.

## Ergebnis

**Ja: Beide CLIs können Aufgaben in ihre jeweiligen Cloud-Umgebungen schicken.
Eine interne Desktop-VM lässt sich dagegen nicht über eine gefundene, dokumentierte
Schnittstelle als allgemeine Shell-Umgebung für diese Shepherd-Sitzung übernehmen.**
Für lokale Isolation bieten beide CLIs Sandboxes; eine eigene VM ist ebenfalls ein
möglicher Ausführungsort. Cloud-Delegation, lokale Sandbox und Git-Worktree sind
unterschiedliche Mechanismen.

Die Recherche sollte drei Fragen beantworten: Welche Umgebungen existieren tatsächlich,
welche offiziellen CLI-Zugänge gibt es, und was davon verwendet Shepherd bereits?
Die folgenden Abschnitte trennen dokumentierte Fähigkeiten, lokale Beobachtungen und
Empfehlungen. Kontozugriff und erfolgreiche Cloud-Ausführung wurden nicht getestet.

## Was mit „Desktop-VM“ gemeint sein kann

| Umgebung                                     | Ausführung                                                            | Aus dem CLI nutzbar?                                            |
| -------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| Claude Cowork, bestehende lokale Deployments | Shell und generierter Code in einer Linux-VM; Agent-Loop nativ        | Keine dokumentierte allgemeine VM-Attach-Schnittstelle gefunden |
| Claude Code Cloud                            | Eigene Cloud-Session, standardmäßig auf Anthropic-Infrastruktur       | Ja, `claude --cloud`                                            |
| Codex Local / Worktree                       | Auf dem eigenen Rechner, mit konfigurierbarer OS-Sandbox              | Ja, entsprechende lokale CLI-Funktionen                         |
| Codex Cloud                                  | Remote-Aufgabe mit eigenem Workspace aus einer vorbereiteten Umgebung | Ja, experimentell über `codex cloud`                            |

Quellen: [Cowork-Architektur](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview),
[Claude Code Cloud](https://code.claude.com/docs/en/claude-code-on-the-web),
[Codex-Ausführungsorte](https://learn.chatgpt.com/docs/environments/modes),
[Codex-CLI-Referenz](https://learn.chatgpt.com/docs/cli/reference#codex-cloud).

Cowork läuft inzwischen standardmäßig in der Cloud. Für Pro/Max beschreibt Anthropic
lokale Ausführung nur noch für Aufgaben, die vor dem 6. Oktober 2026 auf dem Gerät
begonnen wurden. Die lokale Variante nutzt Virtualization.framework unter macOS bzw.
Hyper-V unter Windows. Deshalb wäre „Claude Desktop hat immer eine lokale VM“ heute
zu pauschal. Die Architektur-Dokumentation beschreibt keine Freigabe dieser VM für
beliebige externe CLI-Prozesse. Das ist eine Grenze der dokumentierten Integration,
kein Nachweis technischer Unmöglichkeit.
[Quelle](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)

Bei Codex laufen Local und Worktree auf dem eigenen Rechner. Ein Worktree trennt
Git-Arbeitsstände; er stellt keine VM bereit. Cloud-Aufgaben bekommen eigene Dateien.
Lokale Prozesse, Browser-Anmeldungen und VPN-Zugänge werden nicht automatisch
übertragen. [Quelle](https://learn.chatgpt.com/docs/environments/modes)

## Offizielle CLI-Wege

### Claude Code

```sh
claude --cloud "Untersuche die Aufgabe im Repository"
```

Der Befehl startet eine Claude-Code-Cloud-Session. Dieselben Cloud-Ausführungsorte
sind über Desktop, Browser und Mobilgerät verfügbar. Der normale GitHub-Weg nutzt
den gepushten Repository-Stand; lokale Änderungen sind dort nicht automatisch enthalten.
Die Dokumentation beschreibt außerdem einen Repository-Upload für bestimmte Fälle
ohne GitHub-Anbindung. `--teleport` führt eine Cloud-Session lokal weiter.
`--remote-control` bedient dagegen eine weiterhin lokal laufende Sitzung.
Planberechtigung, Claude-Anmeldung und gegebenenfalls Organisationsfreigabe bleiben
Voraussetzungen. [Quelle](https://code.claude.com/docs/en/claude-code-on-the-web)

Lokal geprüft: Claude Code **2.1.312** bietet laut `claude --help` auch
`claude --cloud <session_id|url>` zum Anbinden einer vorhandenen Cloud-Session.
Das ist kein Attach an eine Cowork-VM.

### Codex

```sh
codex cloud
codex cloud exec --env <ENV_ID> "Untersuche die Aufgabe im Repository"
codex cloud status <TASK_ID>
codex cloud diff <TASK_ID>
codex cloud apply <TASK_ID>
```

Die CLI dokumentiert Cloud-Aufgaben als experimentell. Lokal geprüft: **codex-cli
0.165.0** stellt `exec`, `status`, `list`, `diff` und `apply` bereit; `exec` verlangt
eine Environment-ID und bietet `--branch`. `apply` würde den Cloud-Diff lokal
übernehmen; keiner dieser Beispielbefehle wurde ausgeführt.
[CLI-Referenz](https://learn.chatgpt.com/docs/cli/reference#codex-cloud)

Die aktuelle Cloud-Dokumentation beschreibt vorbereitete, veröffentlichte Umgebungen
mit Repositories, Dependencies, Tools und Zugriffsregeln. Neue Aufgaben erhalten einen
eigenen Workspace. OpenAI unterscheidet inzwischen aktuelle Cloud-Umgebungen und
Cloud Legacy. Die konkrete Kombination aus installiertem experimentellem CLI,
Environment-ID und Account muss deshalb praktisch validiert werden; CLI-Hilfe allein
belegt keine erfolgreiche Ausführung gegen jede neue Umgebung.
[Cloud-Umgebungen](https://learn.chatgpt.com/docs/environments/cloud-environments)

## Lokale Isolation ohne Desktop-VM

Claude Code bietet `/sandbox` für Shell-Kommandos und Kindprozesse: Seatbelt unter
macOS, Bubblewrap unter Linux/WSL2. Dateitools, MCP-Server und Hooks liegen außerhalb
dieser Shell-Grenze. Für den ganzen Prozess dokumentiert Anthropic unter anderem
Sandbox Runtime, Container und eigene VMs.
[Shell-Sandbox](https://code.claude.com/docs/en/sandboxing),
[Ausführungsumgebungen](https://code.claude.com/docs/en/sandbox-environments)

Codex verwendet für lokale Kommandos plattformspezifische OS-Sandboxes, auch im
Desktop-Client. Die CLI kann beispielsweise mit
`codex --sandbox workspace-write --ask-for-approval on-request` gestartet werden.
Dies begrenzt lokale Ausführung, erzeugt aber keine separate VM. Die genauen
Datei- und Netzwerkrechte hängen von der Konfiguration ab.
[Sandbox](https://learn.chatgpt.com/docs/sandboxing),
[Berechtigungen](https://learn.chatgpt.com/docs/agent-approvals-security)

## Einordnung für Shepherd

Geprüfter Repository-Stand: `9a073251e3a8d3ff96207a088eb2978aafa88186`.

- [src/service.ts](../../src/service.ts), `buildCodexSpawnArgv`, startet Codex lokal
  mit `--dangerously-bypass-approvals-and-sandbox`. `spawnProfile` ordnet explizite
  Codex-Spawns `trusted` zu. Die jetzige Sitzung meldet ebenfalls
  `danger-full-access`; daraus lässt sich keine Aussage über eine eventuell außerhalb
  des Prozesses vorhandene Host-Virtualisierung ableiten.
- [src/sandbox.ts](../../src/sandbox.ts) und
  [Sandbox-Sicherheitsdokumentation](../sandbox-security.md) beschreiben Shepherds
  eigene Bubblewrap-Isolation für Claude-Spawns mit den Profilen `trusted`,
  `standard` und `autonomous`. Das ist keine Wiederverwendung einer Desktop-VM.

**Empfehlung:** Für isoliertes Arbeiten im bestehenden lokalen Shepherd-Ablauf zuerst
die vorhandenen Sandbox-Grenzen und den Codex-Startmodus betrachten. Falls eine echte
VM-Grenze für beide Anbieter gewünscht ist, ist eine selbst verwaltete VM ein sinnvoller
gemeinsamer Ausführungsort. Das wäre gesonderte Implementierungsarbeit.

Für Arbeit auf Anbieter-Infrastruktur sind die offiziellen Cloud-Befehle der passende
Ansatz. Eine Shepherd-Anbindung müsste Cloud-Session-ID, Status und Ergebnisrückführung
abbilden und den Repository-Stand explizit behandeln. Sie wäre ein eigener
Ausführungsweg; die laufende lokale Sitzung wird dadurch nicht nachträglich zur
Cloud-Sitzung. Keine Integration auf undokumentierte Cowork-VM-Interna aufbauen.

Vor einer solchen Umsetzung genügt als nächster Nachweis jeweils eine kleine,
explizit beauftragte Cloud-Testaufgabe mit dem tatsächlichen Account: Start, Status,
Dateistand und Ergebnisübernahme prüfen. Diese Recherche beansprucht nur belegte
CLI-Verfügbarkeit und dokumentierte Fähigkeiten, keine bereits funktionierende
Cloud-Integration in Shepherd.
