# Research: Ein macOS-Runner für Shepherd — wie Agenten an Xcode kommen

_Recherche, 2026-10-02. Rahmen vom Operator: Das MacBook ist der **tägliche, mobile Arbeitsrechner**
(kein verlässlicher 24/7-Host). Ein dedizierter Mac (Mac mini, Cloud-Mac) ist **ausgeschlossen**.
Ziel: die Feedback-Schleife für iOS- und macOS-Arbeit an `native/` so kurz wie möglich._

Dies ist eine reine Recherche-Notiz (Research-Direktive): Der Bericht ist das Deliverable, es wurde
kein Produktcode geändert.

## Verdikt

**Ja: ein eigenes Shepherd-Backend auf dem MacBook ist der schnellste Weg, und es geht heute ohne
eine Zeile Code.** Die Mac-App kann einen lokalen Server installieren und überwachen („Run on this
Mac“) und zwischen mehreren Server-Profilen umschalten. Agenten, die dort laufen, haben `xcodebuild`,
den Simulator, Xcodes eigenen MCP-Server und warme DerivedData direkt vor Ort. Heute schiebt ein
Agent auf Linux und wartet auf `native`-CI mit **28,6 min Median**.

Die Empfehlung in drei Stufen:

| Stufe | Was                                                                                                                                                                                             | Aufwand                          | Wann                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------- |
| **1** | **Zweite Shepherd-Instanz auf dem MacBook** für Native-Tasks. Linux (`moes-tavern`) bleibt Heimat für alles andere.                                                                             | Setup, kein Code                 | sofort                |
| **2** | **Mac-Build-Brücke** für Linux-Sessions: ein eng begrenztes SSH-Kommando spiegelt den Worktree auf den Mac und ruft `native/scripts/*` auf. Ist der Mac offline, fällt es sauber auf CI zurück. | klein (Skript + Agent-Anleitung) | wenn Stufe 1 trägt    |
| 3     | **Echter Remote-Runner** in Shepherd: ein Linux-Server dispatcht Sessions an herdr auf dem Mac.                                                                                                 | groß (Architektur)               | nur bei echtem Bedarf |

**Nicht empfohlen:**

- **Self-hosted GitHub-Runner auf dem MacBook.** Das Repo ist öffentlich, und GitHub warnt
  ausdrücklich davor. Außerdem verkürzt er die innere Schleife nicht.
- **Cloud-Mac.** Vom Operator ausgeschlossen; Kosten zum Vergleich unten.
- **Cross-Compile auf Linux.** Ohne Apple-SDK unmöglich.

Der Preis von Stufe 1 ist bekannt und tragbar:

- **Kein Sandbox-Membran auf macOS.** Agenten laufen mit den vollen Rechten deines Benutzers.
- **Zwei getrennte Herden** statt einer.
- **Sessions pausieren, wenn der Deckel zugeht.**

---

## Inhalt

1. [Ausgangslage: warum es den Mac braucht](#1-ausgangslage-warum-es-den-mac-braucht)
2. [Was Shepherd heute auf macOS kann](#2-was-shepherd-heute-auf-macos-kann)
3. [Was die Agenten auf dem Mac nutzen können](#3-was-die-agenten-auf-dem-mac-nutzen-können)
4. [Stufe 1: Shepherd auf dem MacBook](#4-stufe-1-shepherd-auf-dem-macbook)
5. [Stufe 2: Mac-Build-Brücke für Linux-Sessions](#5-stufe-2-mac-build-brücke-für-linux-sessions)
6. [Stufe 3: Remote-Runner als Produktfeature](#6-stufe-3-remote-runner-als-produktfeature)
7. [Verworfene Optionen](#7-verworfene-optionen)
8. [Nebenbefunde](#8-nebenbefunde)
9. [Offene Punkte und Vorschläge für Folge-Issues](#9-offene-punkte-und-vorschläge-für-folge-issues)
10. [Quellen](#10-quellen)

---

## 1. Ausgangslage: warum es den Mac braucht

- **Kein Apple-SDK unter Linux.** swift-corelibs-foundation „builds for non-Darwin platforms only“.
  SwiftUI und UIKit gibt es unter Linux nicht. Linux kann reine SwiftPM-Logik bauen, aber keine
  App, keinen Simulator und kein Codesigning ([swift-corelibs-foundation][scf]).
- **Alle Skripte unter `native/scripts/` brauchen Xcode-Werkzeuge:** `ios-dev.sh`,
  `test-ios-app.sh`, `build-ios-app.sh`, `test-app.sh`, `build-app.sh` rufen `xcodegen`,
  `xcodebuild`, `xcrun simctl`, `codesign` und `security` auf.
- **Die heutige Schleife ist CI.** Ein Linux-Agent verifiziert Native-Code nur per Push und
  `macos-latest`. Laut `docs/research/ci-speed-and-granularity.md` dauert ein `native`-Lauf
  **28,6 min im Median** (p90 33,8 min), seit #2444 den iOS-Simulator-Job ergänzt hat.
- **macOS-Slots sind knapp.** Der Team-Plan hat **5 macOS-Slots**, ein `native`-Lauf belegt bis zu
  3 (`.github/workflows/native.yml:14-15`). Parallele Agenten stauen sich dort.
- **GitHub-Runner sind klein:** M1, 3 Kerne, 7 GB RAM ([GitHub-hosted runners][gh-hosted]).

Für iterative UI-Arbeit (Preview ansehen, Simulator-Screenshot, Test, Fix) ist eine Schleife von
einer halben Stunde unbrauchbar. Mit einem lokalen Mac und warmer DerivedData ist ein
inkrementeller Build eine Sache von Sekunden bis wenigen Minuten. Das ist eine Schätzung; es
existiert keine Messung auf deinem MacBook.

## 2. Was Shepherd heute auf macOS kann

### 2.1 Server: „Core-only / degraded“

Laut OS-Matrix (`docs/getting-started.md:45-51`) installiert der Installer auf macOS die
Voraussetzungen, klont das Repo und baut die UI.

| Funktion                                          | macOS          | Grund                                                                                              |
| ------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| Sessions in herdr, Diff, Dateien, Git, PRs, Merge | ✅             | plattformneutral; herdr hat ein macOS-Asset (`src/herdr-install.ts:32-39`)                         |
| Dev-Server-Erkennung, Loopback-Previews           | ✅             | `lsof`-Backend `src/proc-probes-darwin.ts`, abgesichert durch `.github/workflows/macos.yml`        |
| Sandbox-Membran (`standard`/`autonomous`)         | ❌             | bubblewrap braucht Linux-User-Namespaces (`src/sandbox.ts:125-150`); es gibt kein Seatbelt-Pendant |
| Egress-Allowlist                                  | ❌             | slirp4netns + nftables + dnsmasq, nur Linux (`src/egress.ts`)                                      |
| Auto-Drain                                        | ❌             | laut OS-Matrix                                                                                     |
| systemd-Unit                                      | ❌             | `bun run start` von Hand oder über die Mac-App                                                     |
| Preview über das Tailnet                          | ❌ (laut Doku) | siehe [Nebenbefund 8.1](#8-nebenbefunde)                                                           |

**Konsequenz:** Auf dem Mac läuft jede Session effektiv im Profil `trusted`, also ohne Membran.

### 2.2 Clients können schon mehrere Server

- **Mac-/iOS-App:** `ServerProfile` (`native/Sources/ShepherdKit/Model/ServerProfile.swift:14`)
  kennt die Modi `local` und `remote`. Der `ProfileStore` speichert beliebig viele Profile mit
  Token im Schlüsselbund, eines davon ist aktiv. Remote-Profile müssen `https` nutzen, außer bei
  Loopback und `.ts.net`-Namen (`ServerProfile.swift:48-68`).
- **„Run on this Mac“:** `LocalServerSupervisor`
  (`native/Sources/ShepherdKit/LocalServer/LocalServerSupervisor.swift:57`) installiert über
  `deploy/install.sh` nach `~/.shepherd/app` und startet den Server auf Port 7330. Er überwacht
  ihn mit Backoff und erkennt einen von außen gestarteten Server (`externallyManaged`).
- **Rust-CLI:** benannte Profile in `~/.config/shepherd/config.toml` (`cli/src/config.rs`).
- **Web-UI:** nur same-origin. Pro Server gibt es einen Browser-Tab.

### 2.3 Was einen Remote-Runner heute verhindert

Diese Punkte sind für Stufe 3 relevant:

- **herdr nur über einen lokalen Unix-Socket.** Der Pfad ist `~/.config/herdr/herdr.sock` bzw.
  `…/sessions/<name>/herdr.sock` (`src/herdr-session.ts:26-30`). Die Verbindung öffnet
  `net.createConnection(this.socketPath)` (`src/herdr-socket-client.ts:95`); es gibt keinen TCP-
  oder Host-Begriff.
- **Kein Host-Attribut pro Repo.** `RepoConfig` (`src/store.ts:505`) kennt Sandbox-Profil, Modelle
  und Autopilot, aber kein „läuft auf Host X“.
- **Worktrees werden als lokal angenommen.** Process-Reaper (`/proc` bzw. `lsof` nach cwd),
  Sandbox-Binds, Diff, Dateibrowser und Previews lesen alle direkt vom Dateisystem des Servers.

### 2.4 Zwei Server, ein GitHub-Repo: verträglich

Geprüft wurde, ob sich ein Linux- und ein Mac-Server auf demselben Repo gegenseitig stören:

- **`BranchPruner`** löscht nur **lokale** `shepherd/*`-Branches, deren PR gemergt ist
  (`src/branch-pruner.ts:10-24`). Er greift nicht in die Clone des anderen Servers ein.
- **`BacklogPoller`** wärmt nur Zähler-Caches (`src/backlog-poller.ts:3-17`). Er startet keine
  Tasks.
- **Up Next** schlägt nur vor, es startet nichts von selbst.
- **Der echte geteilte Posten ist das GitHub-API-Budget.** Beide Server nutzen dasselbe
  `gh`-Konto und damit dieselben Rate-Limit-Töpfe. #2656/#2663 haben das Volumen gerade erst
  gesenkt. Ein zweiter Server, der dutzende Referenz-Repos pollt, würde es wieder verdoppeln.
  Deshalb sollte die Mac-Instanz nur die Repos führen, an denen dort wirklich gearbeitet wird.

## 3. Was die Agenten auf dem Mac nutzen können

Aktuell ist **Xcode 27** (27A266a, 2026-09-14) ([Apple Releases][apple-releases]).

### 3.1 Xcodes eigener MCP-Server

- **Seit Xcode 26.3.** Claude Agent und Codex sind integriert, und Xcode „makes its capabilities
  available through the Model Context Protocol“ ([Apple Newsroom][xc263-news],
  [26.3 Release Notes][xc263-notes]).
- **Einrichtung:** Settings › Intelligence › „Allow external agents to use Xcode tools“, dann
  `claude mcp add --transport stdio xcode -- xcrun mcpbridge` ([Apple: external agents][xc-agents]).
- **Einschränkung:** Apple verlangt „open your project in Xcode“ vor dem Prompt. Xcode meldet,
  wenn sich ein Agent verbindet.
- **Werkzeuge:** Apple veröffentlicht keine Liste. Laut einem Praxisbericht gibt es unter anderem
  `BuildProject`, `GetBuildLog`, `RunSomeTests`, `XcodeListNavigatorIssues`, `RenderPreview`,
  `DocumentationSearch` und Dateioperationen ([rudrank.com][rudrank], Sekundärquelle).
- **Neu in Xcode 27:**
  - Simulator booten, App installieren und starten, Touches synthetisieren, Screenshots
  - Debugger-Steuerung
  - Scheme- und Destination-Wechsel
  - Build-Settings, Entitlements und Info.plist bearbeiten
  - Preview-Varianten
  - String-Catalog-Bearbeitung
  - Plug-ins (Skills, MCP, ACP)
  - „a new security layer that monitors and controls filesystem access by coding agents and any
    processes they spawn“

  Quelle: [Xcode 27 Release Notes][xc27-notes].

- **Headless-Vorschau** (seit Beta 5): `sudo xcrun mcp-server enable` ist ein MCP-Server „without
  requiring an open Xcode workspace“. Apple warnt, er „may not work in all configurations“.
  Unbelegt ist, ob er ohne eingeloggte GUI-Sitzung läuft.

### 3.2 MobileBuildMCP (vormals XcodeBuildMCP)

- **Herkunft:** Sentry hat XcodeBuildMCP im Februar 2026 übernommen ([Sentry][sentry-acq]). Seit
  v2.7.1 heißt es **MobileBuildMCP** (`brew install mobilebuildmcp` bzw.
  `npx -y mobilebuildmcp@latest mcp`) ([Release v2.7.1][mbm-release], [README][mbm-readme]).
- **Werkzeuge:**
  - Simulator- und Device-Build/Run/Test
  - LLDB
  - UI-Automation mit `snapshot_ui`, Tap/Swipe und `wait_for_ui`
  - Coverage und Video
  - optional ein Proxy auf `xcrun mcpbridge`

  Quellen: [CHANGELOG][mbm-changelog], [IDE-Bridge][mbm-ide].

- **Transport ist nur stdio** ([Docs][mbm-docs]).

### 3.3 Grundregeln für Xcode ohne Mensch davor

Bei einem Daily-Driver, an dem du sitzt, sind diese Punkte meist automatisch erfüllt. Wichtig
werden sie für Stufe 2:

- **Aqua-Sitzung nötig.** Apple: `xcodebuild` „from a remote login with `ssh` … fails unless the
  correct session environment is created“, und „testing on the Simulator … requires an Aqua
  session“. Ist der Benutzer am Gerät eingeloggt, bekommt auch der SSH-Login diese Aqua-Sitzung
  ([Apple: Automating the test process][apple-aqua]).
- **Dienste als LaunchAgent, nie als LaunchDaemon.** Ein Daemon „is not allowed to connect to the
  window server“ ([TN2083][tn2083]). GitLab und Buildkite fordern für Mac-Runner Auto-Login und
  einen LaunchAgent ([GitLab][gitlab-macos], [Buildkite][buildkite-mac]).
- **Schlüsselbund über SSH.** SSH entsperrt den Login-Schlüsselbund nicht, `codesign` scheitert
  dann mit `errSecInternalComponent` bzw. `errSecInteractionNotAllowed`. Abhilfe:
  `security unlock-keychain` plus `set-key-partition-list`, und kein `sudo`
  ([Apple DTS][dts-keychain], [Forum][forum-25308]). Simulator-Builds brauchen kein Signing.
- **Erststart:** `xcode-select -s …`, `xcodebuild -runFirstLaunch` (installiert unter anderem
  `simctl`), `xcodebuild -downloadPlatform iOS` ([Apple: additional components][apple-components]).
- **FileVault schließt Auto-Login aus** ([Apple 102316][apple-filevault]). Nach einem Neustart gibt
  es bis zum manuellen Login keine Aqua-Sitzung. Beim Daily-Driver ist das egal, weil du dich
  ohnehin einloggst.

### 3.4 Agenten-Sandboxen blockieren den Simulator

- **Claude Code:** Die `/sandbox` nutzt auf macOS Seatbelt ([Claude Code Sandboxing][cc-sandbox]).
  Ihr `deny mach-lookup com.apple.CoreSimulator.CoreSimulatorService` bricht `xcrun simctl` und
  `xcodebuild test`. Das Issue wurde als **„not planned“** geschlossen ([#36611][cc-36611]). Offen
  ist zudem, dass sandboxed Kommandos `securityd` bzw. den Schlüsselbund nicht erreichen
  ([#87008][cc-87008]).
- **Codex:** zeigt dasselbe Muster ([openai/codex#4987][codex-4987]).
- **Folge für Stufe 1:** Wenn du die Claude-Code-Sandbox auf dem Mac aktivierst, gehören
  `xcodebuild`, `xcrun`, `simctl` und `codesign` in `excludedCommands`. Sonst scheitern Tests mit
  „CoreSimulatorService connection became invalid“.

## 4. Stufe 1: Shepherd auf dem MacBook

**Idee:** Für Tasks, die Xcode brauchen, startest du die Session in der Mac-Instanz statt auf
`moes-tavern`. In der Mac-App wechselst du per Profil zwischen beiden Herden.

### 4.1 Warum das am schnellsten ist

- **Keine Synchronisation.** Der Worktree liegt dort, wo gebaut wird, und DerivedData sowie
  SwiftPM-`.build` bleiben pro Worktree warm.
- **Xcode-MCP direkt nutzbar.** Bei Xcode-Fokusarbeit lädt der Agent `RenderPreview`, Navigator-
  Issues und Tests direkt. Für parallele Sessions eignen sich CLI-Skripte plus MobileBuildMCP
  besser, weil `mcpbridge` an ein geöffnetes Projekt gebunden ist.
- **Der Simulator läuft sichtbar.** Du kannst zuschauen und eingreifen.
- **Keine Aqua- und Keychain-Fallen.** Du bist ohnehin eingeloggt.
- **Kein neuer Code.** Profile, Supervisor und macOS-Installer existieren schon (§2.2).

### 4.2 Einrichtung (Checkliste)

1. **Xcode 27 installieren:**
   ```sh
   sudo xcode-select -s /Applications/Xcode.app
   xcodebuild -runFirstLaunch
   xcodebuild -downloadPlatform iOS
   brew install xcodegen   # die native/scripts generieren das Projekt mit xcodegen
   ```
2. **Shepherd installieren:** In der Mac-App die Karte „Run on this Mac“ öffnen. Sie führt
   `deploy/install.sh` nach `~/.shepherd/app` aus und startet den Server auf `:7330`. Alternativ
   geht der `curl … | bash`-Installer mit anschließendem `bun run start`.
   - `~/.local/bin` muss im `PATH` liegen, wegen herdr und claude (`docs/getting-started.md:134-137`).
   - Danach `claude` und `gh auth login` ausführen.
3. **Profile:** In der Mac-App gibt es zwei Profile: _local_ (Mac) und _remote_
   (`https://moes-tavern.long-tautara.ts.net:<port>/`).
4. **Repos schlank halten:** Auf dem Mac nur `shepherd` (und eventuelle weitere iOS-Repos)
   registrieren, keine Referenz-Clones. Das schont das geteilte GitHub-API-Budget (§2.4).
5. **Agenten-Werkzeuge auf User-Ebene** (gelten für alle Sessions der Mac-Instanz):
   ```sh
   claude mcp add -s user --transport stdio xcode -- xcrun mcpbridge   # vorher: Xcode › Settings › Intelligence
   claude mcp add -s user mobilebuild -- npx -y mobilebuildmcp@latest mcp
   ```
   Ist die Claude-Code-Sandbox aktiv, kommt `excludedCommands` für die Xcode-Werkzeuge dazu (§3.4).
6. **Simulator-Parallelität:** UI-Tests mehrerer Sessions über `native/scripts/uitest-lock.sh`
   serialisieren. Das ist ein runner-lokaler `fcntl`-Lock, der genau dafür existiert.
7. **Strom und Deckel:**
   - Zugeklappt pausiert der Mac und mit ihm die Sessions; nach dem Aufwachen laufen sie weiter.
   - Für lange Läufe am Netzteil hilft `caffeinate -s` (gilt nur am Netzteil, [ss64][ss64-caff]).
   - Apple dokumentiert den Betrieb mit geschlossenem Deckel nur mit externem Display
     ([Apple][apple-clamshell]).

### 4.3 Was du dafür in Kauf nimmst

| Preis                                                                                 | Bewertung                                                 | Milderung                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Keine Membran.** Agenten sehen dein ganzes Home: SSH-Keys, Browser-Profile, iCloud. | Das größte Risiko, weil es dein persönlicher Rechner ist. | Plan-Gate an, Autopilot aus. Später ein separater macOS-Benutzer oder eine Tart-VM (§7). Xcode 27 bringt eine eigene Dateisystem-Kontrolle für Agenten mit (§3.1). |
| **Zwei Herden.** Die Web-UI ist same-origin; die Mac-App zeigt jeweils ein Profil.    | Lästig, nicht kritisch.                                   | Native-Arbeit bewusst auf dem Mac, alles andere auf Linux. Ein gemeinsamer Blick wäre ein Folge-Feature.                                                           |
| **Kein Auto-Drain, kein Egress-Filter**                                               | Für interaktive Native-Arbeit verschmerzbar.              | Native-Epics auf Linux planen, einzelne Tasks auf dem Mac abarbeiten.                                                                                              |
| **Erreichbarkeit.** Mac zu = Herde nicht erreichbar.                                  | Passt zum Daily-Driver-Profil.                            | Die iOS-App bleibt auf `moes-tavern` verbunden.                                                                                                                    |
| **Rechenlast** auf deinem Arbeitsrechner                                              | `xcodebuild` ist schwer.                                  | Wenige parallele Native-Sessions (1–2).                                                                                                                            |

## 5. Stufe 2: Mac-Build-Brücke für Linux-Sessions

**Idee:** Die Agenten bleiben auf `moes-tavern`, mit Membran, einer Herde und Auto-Drain. Nur das
**Verifizieren** geht an den Mac, wenn er online ist. Das ist kein Ersatz für Stufe 1 bei
UI-Iteration, schließt aber die Lücke für „schnell prüfen, ob es kompiliert und die Tests grün
sind“, ohne 30 min auf CI zu warten.

Skizze (Details gehören ins Folge-Issue):

- **Transport:** macOS „Entfernte Anmeldung“ (OpenSSH) über die Tailnet-IP.
  - Tailscale SSH als Server geht auf macOS nur mit dem Open-Source-`tailscaled`, nicht mit
    App-Store- oder Standalone-App ([Tailscale macOS-Varianten][ts-variants]).
- **Eng begrenzte Schlüssel** in `authorized_keys`:
  - **Key A:** `command="<dispatch.sh>",no-port-forwarding,no-agent-forwarding,no-pty`. Er erlaubt
    nur Verben wie `swift-test`, `ios-test`, `mac-test` und `ios-build`, die auf die vorhandenen
    `native/scripts/*` abbilden.
  - **Key B** für die Dateisynchronisation, beschränkt auf ein einziges Zielverzeichnis, z. B.
    `rrsync`, das mit rsync ≥ 3.2 ausgeliefert wird. Die Wahl zwischen rsync und tar-Stream klärt
    das Folge-Issue.
  - Ein Agent auf Linux kann so **nichts anderes** auf deinem MacBook ausführen.
- **Aqua kommt geschenkt:** Bist du am Mac eingeloggt, bekommt der SSH-Login die Aqua-Sitzung
  (§3.3). Simulator-Tests laufen also, solange du am Mac arbeitest.
- **Offline-Verhalten:** Ein Verbindungs-Timeout wird zu Exit 75 (`EX_TEMPFAIL`) mit einer klaren
  Meldung: „Mac offline, verifiziere über CI“. Die Agent-Anleitung (CLAUDE.md bzw. Skill) macht
  daraus den Fallback.
- **Membran-Verträglichkeit:**
  - `standard` braucht den SSH-Key als Read-only-Bind in der Membran.
  - `autonomous` braucht zusätzlich die Mac-Adresse in `egressExtraHosts`.
- **Option für später:** `claude mcp add mac -- ssh mac-bridge mobilebuildmcp mcp`, also stdio-MCP
  über SSH. Damit bekäme ein Linux-Agent Simulator-Screenshots und UI-Automation. Das ist
  technisch naheliegend, aber **undokumentiert und ungetestet** und gehört in einen Spike.

Ein self-hosted GitHub-Runner wäre die „fertige“ Variante dieser Idee. Er ist hier aber falsch,
siehe §7.

## 6. Stufe 3: Remote-Runner als Produktfeature

Die saubere Langfrist-Architektur: **eine Kontrollebene, mehrere Ausführungshosts.** Ein Worker
auf dem Mac verbindet sich ausgehend mit dem Linux-Server und führt dort herdr-Sessions in lokalen
Worktrees aus.

Genau dieses Muster hat Cursor am 2026-09-02 mit „self-hosted workers“ ausgeliefert: `agent worker
start` auf dem Mac, „a long-lived outbound HTTPS connection“ ([Cursor][cursor-workers]). Devin hat
am 2026-09-15 eigene macOS-Umgebungen mit Xcode nachgezogen ([Devin][devin-mac]).

Für Shepherd hieße das mindestens:

1. ein Host-Attribut pro Repo bzw. Task in `RepoConfig` und im Spawn-Pfad
2. herdr über eine Netzverbindung statt `net.createConnection(socketPath)` bzw. einen Worker, der
   lokal mit herdr spricht
3. Remote-Zugriff auf den Worktree für Diff, Dateien, Git, Reaper und Previews (§2.3)

Das ist ein Epic und rechtfertigt sich erst, wenn Stufe 1 und 2 im Alltag an „zwei Herden“
scheitern.

## 7. Verworfene Optionen

| Option                                                    | Warum nicht (jetzt)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-hosted GitHub-Runner auf dem MacBook**             | GitHub: „Self-hosted runners should almost never be used for public repositories … any user can open pull requests against the repository and compromise the environment“ ([Secure use][gh-secure]). Bei einem mobilen Laptop warten oder scheitern Jobs, wenn er weg ist. Vor allem verkürzt der Runner nur CI, nicht die Agent-Schleife. Für **private** iOS-Repos denkbar: `./svc.sh install` legt einen LaunchAgent an ([svc.sh-Template][gh-svc]), Ziel `runs-on: [self-hosted, macOS, ARM64]` ([Labels][gh-labels]).                                    |
| **Cloud-Mac** (ausgeschlossen)                            | Nur als Referenz: Scaleway M4-S **€149/Monat** ([Scaleway][scaleway]), MacStadium M4 **$149/Monat** ([MacStadium][macstadium]), AWS EC2 mac-m4 ca. **$898/Monat** bei 24 h Mindestmiete ([AWS][aws-mac], [Vantage][vantage]). Hetzner bietet keine Macs mehr an ([Hetzner][hetzner]). Minuten-Runner (Namespace, Depot, WarpBuild, Blacksmith) kosten $0,06–0,08/min und eignen sich nur für bursty CI.                                                                                                                                                       |
| **Tart-VM auf dem MacBook** (Isolation)                   | Technisch gut: `tart clone ghcr.io/cirruslabs/macos-…-xcode`, `--no-graphics`, SSH in die VM ([Tart][tart]). Kosten: Apples Lizenz erlaubt höchstens **2** macOS-VMs pro Host ([macOS Tahoe SLA 2B(iii)][macos-sla]), und eine Xcode-VM frisst RAM auf dem Arbeitsrechner. Tart steht seit 2026 unter FSL-1.1-ALv2 (© OpenAI, [LICENSE][tart-license]); die Lizenzseite ist widersprüchlich. **Sinnvolle Härtung für Stufe 1, wenn das Membran-Risiko stört**, nicht für den Start. Anka Develop: kostenlos, 1 VM, nur auf MacBook-Hardware ([Veertu][anka]). |
| **Cross-Compile / Bazel-Remote-Execution**                | Kein Apple-SDK unter Linux (§1). BuildBuddy-Mac-Executors sind self-hosted, nicht im Free-Tier und für ein Ein-Personen-Setup überdimensioniert ([BuildBuddy][buildbuddy]).                                                                                                                                                                                                                                                                                                                                                                                   |
| **Kommerzielle Remote-Xcode-Dienste** (Limrun, Cua Cloud) | `lim xcode build` synchronisiert Quellen und baut auf Cloud-Macs ([Limrun][limrun]). Cua: rund $0,36/h bei 4 vCPU/8 GiB ([cua.ai][cua]). Kostet monatlich, also außerhalb des Rahmens.                                                                                                                                                                                                                                                                                                                                                                        |

## 8. Nebenbefunde

1. **Möglicher Doku-Drift in der OS-Matrix.** `docs/getting-started.md:50` sagt, Tailnet-Previews
   seien auf macOS nicht verfügbar, weil der App-Store-Build kein `tailscale`-CLI liefere. Laut
   Tailscale hat **jede** macOS-Variante ein CLI (App Store, Standalone, Open Source); nur der
   Open-Source-`tailscaled` kann SSH-Server sein und vor dem Login laufen ([Tailscale][ts-variants]).
   Ob `tailscale serve` aus der App-Store-Variante funktioniert, ist nicht belegt. Am Mac prüfen und
   die Doku gegebenenfalls korrigieren.
2. **Claude Code Desktop hat ein iOS-Simulator-Pane** (Public Beta), aber nur „in local sessions
   only“ ([Claude Code Docs][cc-sim-pane]). Für eine Shepherd-Session in herdr ist das nicht
   nutzbar; dort bleiben MobileBuildMCP und Xcode-MCP.
3. **Der `native`-CI-Speedup aus `ci-speed-and-granularity.md`** (die `needs:`-Kette auflösen,
   28,6 auf ca. 12–15 min) bleibt unabhängig davon lohnend. Er ist der Fallback, wenn der Mac weg ist.

## 9. Offene Punkte und Vorschläge für Folge-Issues

**Offen bzw. auf dem MacBook zu verifizieren:**

- Schlüsselbund-Zugriff für `codesign` aus einer Shepherd-Session, deren Server die Mac-App gestartet
  hat (Kindprozess der GUI-App, sollte funktionieren)
- `xcrun mcp-server` (Xcode-27-Headless) im Zusammenspiel mit parallelen Worktrees
- die tatsächliche inkrementelle Build-Zeit von `native/` auf deinem MacBook im Vergleich zu den
  28,6 min auf CI
- stdio-MCP über SSH (Stufe-2-Option)

**Vorgeschlagene Folge-Issues** (bewusst nicht angelegt; das Deliverable ist dieser Bericht):

1. `docs(native)`: Leitfaden „Native-Arbeit auf einer Mac-Instanz“, also Checkliste §4.2 plus
   Agent-Werkzeuge und die Sandbox-Ausnahmen
2. `feat(native)`: Mac-Build-Brücke (§5) mit `dispatch.sh`, Sync, Offline-Fallback und einer
   Agent-Anleitung in CLAUDE.md
3. `docs`: OS-Matrix-Aussage zu `tailscale` auf macOS prüfen (§8.1)
4. später, als Epic: Remote-Runner (§6)

## 10. Quellen

Primärquellen, sofern nicht anders markiert. Codebelege stehen inline als `pfad:zeile`.

[scf]: https://raw.githubusercontent.com/swiftlang/swift-corelibs-foundation/main/README.md
[gh-hosted]: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
[apple-releases]: https://developer.apple.com/news/releases/
[xc263-news]: https://www.apple.com/newsroom/2026/02/xcode-26-point-3-unlocks-the-power-of-agentic-coding/
[xc263-notes]: https://developer.apple.com/documentation/xcode-release-notes/xcode-26_3-release-notes
[xc-agents]: https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode
[rudrank]: https://rudrank.com/exploring-xcode-using-mcp-tools-cursor-external-clients
[xc27-notes]: https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes
[sentry-acq]: https://blog.sentry.io/sentry-acquires-xcodebuildmcp
[mbm-release]: https://github.com/getsentry/XcodeBuildMCP/releases/tag/v2.7.1
[mbm-readme]: https://github.com/getsentry/XcodeBuildMCP
[mbm-changelog]: https://raw.githubusercontent.com/getsentry/XcodeBuildMCP/main/CHANGELOG.md
[mbm-ide]: https://mobilebuildmcp.com/docs/xcode-ide
[mbm-docs]: https://mobilebuildmcp.com/docs
[apple-aqua]: https://developer.apple.com/library/archive/documentation/DeveloperTools/Conceptual/testing_with_xcode/chapters/08-automation.html
[tn2083]: https://developer.apple.com/library/archive/technotes/tn2083/_index.html
[gitlab-macos]: https://docs.gitlab.com/runner/install/osx/
[buildkite-mac]: https://buildkite.com/docs/agent/v3/aws/self-serve-installation/ec2-mac
[dts-keychain]: https://developer.apple.com/forums/thread/712005
[forum-25308]: https://developer.apple.com/forums/thread/791583
[apple-components]: https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components
[apple-filevault]: https://support.apple.com/en-us/102316
[cc-sandbox]: https://code.claude.com/docs/en/sandboxing
[cc-36611]: https://github.com/anthropics/claude-code/issues/36611
[cc-87008]: https://github.com/anthropics/claude-code/issues/87008
[codex-4987]: https://github.com/openai/codex/issues/4987
[ss64-caff]: https://ss64.com/mac/caffeinate.html
[apple-clamshell]: https://support.apple.com/guide/macbook-pro/connect-an-external-display-apd8cdd74f57/mac
[ts-variants]: https://tailscale.com/kb/1065/macos-variants
[cursor-workers]: https://cursor.com/blog/self-hosted-machines
[devin-mac]: https://devin.ai/blog/devin-gets-a-mac
[gh-secure]: https://docs.github.com/en/actions/reference/security/secure-use
[gh-svc]: https://raw.githubusercontent.com/actions/runner/main/src/Misc/layoutbin/darwin.svc.sh.template
[gh-labels]: https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow
[scaleway]: https://www.scaleway.com/en/pricing/apple-silicon/
[macstadium]: https://macstadium.com/pricing
[aws-mac]: https://aws.amazon.com/ec2/instance-types/mac/
[vantage]: https://instances.vantage.sh/aws/ec2/mac-m4.metal?currency=USD
[hetzner]: https://docs.hetzner.com/robot/dedicated-server/server-lines/apple-rx-server/
[tart]: https://tart.run/quick-start/
[macos-sla]: https://www.apple.com/legal/sla/docs/macOSTahoe.pdf
[tart-license]: https://raw.githubusercontent.com/cirruslabs/tart/main/LICENSE
[anka]: https://docs.veertu.com/anka/anka-develop/
[buildbuddy]: https://www.buildbuddy.io/docs/enterprise-mac-rbe/
[limrun]: https://docs.limrun.com/docs
[cua]: https://cua.ai/
[cc-sim-pane]: https://code.claude.com/docs/en/desktop-ios-simulator

- Swift ohne Apple-SDK: [swift-corelibs-foundation README][scf]
- GitHub-Runner-Specs und -Sicherheit: [hosted runners][gh-hosted], [secure use][gh-secure],
  [svc.sh-Template][gh-svc], [Labels][gh-labels]
- Xcode und agentische Werkzeuge: [Releases][apple-releases], [26.3 Newsroom][xc263-news],
  [26.3 Notes][xc263-notes], [External agents][xc-agents], [27 Notes][xc27-notes],
  [rudrank.com][rudrank] (sekundär)
- MobileBuildMCP: [Sentry][sentry-acq], [v2.7.1][mbm-release], [README][mbm-readme],
  [CHANGELOG][mbm-changelog], [Docs][mbm-docs], [IDE-Bridge][mbm-ide]
- Headless und SSH: [Aqua][apple-aqua], [TN2083][tn2083], [GitLab][gitlab-macos],
  [Buildkite][buildkite-mac], [DTS-Keychain][dts-keychain], [Forum -25308][forum-25308],
  [Components][apple-components], [FileVault][apple-filevault]
- Agenten-Sandboxen: [Claude Code Sandboxing][cc-sandbox], [#36611][cc-36611], [#87008][cc-87008],
  [Codex #4987][codex-4987], [Simulator-Pane][cc-sim-pane]
- Laptop-Betrieb und Netz: [caffeinate][ss64-caff], [Clamshell][apple-clamshell],
  [Tailscale-Varianten][ts-variants]
- Markt: [Cursor Workers][cursor-workers], [Devin macOS][devin-mac], [Limrun][limrun], [Cua][cua]
- Kosten und VMs: [Scaleway][scaleway], [MacStadium][macstadium], [AWS][aws-mac], [Vantage][vantage]
  (sekundär), [Hetzner][hetzner], [Tart][tart], [Tart-Lizenz][tart-license],
  [macOS-SLA][macos-sla], [Anka][anka], [BuildBuddy][buildbuddy]
