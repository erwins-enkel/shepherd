# Research: Eine native iOS-App als Shepherd-Client — statt oder neben der PWA?

**Verdikt: JETZT NICHT BAUEN — aber nicht aus dem Grund, den man erwartet.**

Das Terminal ist **nicht** das Problem. Shepherds PTY-Wire-Protokoll ist so simpel, dass ein
nativer Swift-Client es an einem Wochenende streamen kann, und mit SwiftTerm existiert ein
ausgereifter, aktiv gepflegter Terminal-Emulator dafür. Das Problem ist **Push**: Ein Apple-DTS-
Engineer bestätigt, dass Web Push in **keiner** App-Verpackung funktioniert — weder in Swift-nativ
noch in Capacitor, Tauri oder einem PWABuilder-Wrapper. Sobald Shepherd eine iOS-App wird,
verliert es genau die Eigenschaft, die es heute als Self-Hosted-Tool auszeichnet: Benachrichtigungen
ohne jede zentrale Infrastruktur. Der Ersatz (APNs) zwingt das Projekt in einen dauerhaft
betriebenen Push-Relay, ein Apple-Developer-Konto und eine DSGVO-Verantwortung für fremde
Metadaten.

Damit kippt die Rechnung: Der einzige Bereich, in dem eine native App den größten Mehrwert
verspräche — zuverlässige, reichere Benachrichtigungen — ist zugleich der Bereich, in dem sie
architektonisch teurer wird. Was übrig bleibt (Diktat, Hardware-Tastatur, Live Activities), ist real,
aber kein Fundament für einen zweiten Client neben ~113 000 Zeilen UI-Produktivcode.

Der Markt bestätigt beides. **Omnara**, das nächstliegende Vergleichsprodukt (Claude Code und Codex
vom Handy steuern, Open Source), hat eine native iOS-App — und ist dafür eine **zentrale gehostete
Kontrollebene** geworden, mit eigenem Notification-Service; Self-Hosting ist dort nur noch teilweise
unterstützt. Und ihre Mobile-App streamt **kein Terminal**. Wer das Problem also schon gelöst hat,
hat genau den Teil weggelassen, um den es in der Ausgangsfrage ging.

Dies ist eine reine Recherche-Notiz (Research-Direktive): Der Bericht ist das Deliverable, es wurde
kein Produktcode geändert.

---

## Inhalt

1. [Was ein nativer Client tatsächlich nachbauen müsste](#1-was-ein-nativer-client-tatsächlich-nachbauen-müsste)
2. [Das Terminal — der einfachste Teil](#2-das-terminal--der-einfachste-teil)
3. [Die echten Vorteile einer nativen App](#3-die-echten-vorteile-einer-nativen-app)
4. [Der Show-Stopper: Push](#4-der-show-stopper-push)
5. [Die weiteren Nachteile](#5-die-weiteren-nachteile)
6. [Mythen: Was eine native App NICHT löst](#6-mythen-was-eine-native-app-nicht-löst)
7. [Umsetzungswege im Vergleich](#7-umsetzungswege-im-vergleich)
8. [Empfehlung](#8-empfehlung)
9. [Quellen](#9-quellen)

---

## 1. Was ein nativer Client tatsächlich nachbauen müsste

Die Größenordnung zuerst, weil sie jede weitere Abwägung dominiert:

| Metrik                                            | Wert                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| HTTP-Route-Handler (`ROUTE_HANDLERS`, Top-Level)  | 100 (`src/server.ts:7418`)                                                         |
| Methode+Pfad-Vergleiche real                      | 173                                                                                |
| `src/server.ts`                                   | 7 951 Zeilen                                                                       |
| Svelte-Komponenten                                | 242 (`ui/src/lib/components/**`)                                                   |
| UI-Produktivcode (`ui/src`, ohne Tests/Paraglide) | 112 970 Zeilen                                                                     |
| UI-Code inkl. Tests                               | 173 138 Zeilen                                                                     |
| `Viewport.svelte` (Session-Detail)                | 4 160 Zeilen                                                                       |
| i18n-Schlüssel (EN)                               | 3 478 (`ui/messages/en.json`)                                                      |
| OpenAPI-/Schema-Vertrag für die HTTP-API          | **keiner**                                                                         |
| Typdefinitionen                                   | handgepflegt **doppelt**: `src/types.ts` 1 412 Z. ↔ `ui/src/lib/types.ts` 2 302 Z. |

Zwei Dinge folgen daraus unmittelbar.

**Erstens:** Es gibt keinen API-Vertrag, an dem sich ein dritter Client festhalten könnte. Die
Typen werden bereits heute zweimal von Hand gepflegt — der Kommentar in `ui/src/lib/types.ts:10`
("Role a session plays … see server `ExperimentRole`") belegt das explizit. Ein Swift-Client wäre
die **dritte** handgepflegte Kopie, ohne Codegen und ohne CI-Gate, das Divergenz bemerkt.

**Zweitens:** Ein nativer Client wäre dauerhaft eine Teilmenge. Das ist für sich genommen in
Ordnung — genau das war ja die Ausgangsidee („kann initial nicht alles"). Es ist nur kein
temporärer Zustand, sondern der Dauerzustand.

### Die Repo-Gates greifen bei Swift nicht

Shepherd erzwingt UI-Qualität über vier CI-Gates, die alle an Web-Pfaden hängen:

- `check:i18n` — EN/DE-Schlüsselparität über `ui/messages/*.json` (3 478 Schlüssel)
- Design-System-Direktive — semantische Tokens statt Literale, `/design-system` als Referenz
- `scripts/check-feature-catalog.sh` — jedes `feat` mit UI muss einen Feature-Announcement-Eintrag mitliefern
- `scripts/check-glossary.mjs` — referenzielle Integrität der Glossar-Marker

Ein Swift-Client säße **außerhalb aller vier**. Übersetzungen, Farbtoken, Feature-Discovery und
Glossar würden dort neu und ungeprüft entstehen. Genau die Drift, gegen die diese Gates laut
`CLAUDE.md` existieren („It exists to stop design drift — every session re-inventing buttons,
spacing and colors"), wäre auf der iOS-Seite wieder offen. Das ist kein Argument gegen native Apps
im Allgemeinen, aber ein spezifisches, hausgemachtes Argument gegen einen zweiten Client **in
diesem Repo**.

### Wie viel Mobile-Arbeit schon in der PWA steckt

Nicht wenig — das ist relevant, weil ein Neuanfang das alles wieder von vorn bezahlt:

- 124 Dateien mit Mobile-Bezug, 70 mit Mobile-Breakpoints
- Eigene Touch-Gesten-State-Machine (`ui/src/lib/components/swipe.ts`, `longpress.ts`)
- Mobile-only Komponenten (`TopBarMobileSheet.svelte` 596 Z., `MobileEngineSheet.svelte`)
- Keyboard-aware Compose-Sheet, Master-Detail-Overlay im Backlog
- **164 von 1 668 Commit-Betreffen** auf `main` betreffen mobile/iOS/Touch/Keyboard — davon 88 `fix:`

Diese ~10 % Commit-Anteil sind zweischneidig: Sie belegen sowohl, wie viel iOS-Reibung es
tatsächlich gibt, als auch, wie viel bereits abgearbeitet ist.

---

## 2. Das Terminal — der einfachste Teil

Die Ausgangsfrage war, ob man das Terminal „in die iOS-App gestreamt bekommt". Antwort: **ja, und
zwar unerwartet leicht.**

### Das Wire-Protokoll

```
GET /pty/<terminalId>?cols=<n>&rows=<n>          (WebSocket-Upgrade)
Server → Client:  rohe UTF-8-Bytes des PTY-Outputs, 1:1 durchgereicht
Client → Server:  rohe Eingabebytes
                  ODER  \x00resize:<cols>:<rows>\n   (Inline-Control-Frame)
Close 4000 = superseded (anderes Gerät hat übernommen) → nicht reconnecten
Close 4001 = gone (Agent beendet)                     → endgültig stoppen
```

Kein JSON-Envelope, kein Multiplexing, kein Handshake-Protokoll
(`src/pty-bridge.ts:42-49`, `src/pty-demux.mjs:20-47`, `ui/src/lib/pty.ts:97-146`). Das PTY selbst
gehört `herdr`; jedes Attach liefert automatisch ein volles Repaint des aktuellen Bildschirms — es
gibt weder Scrollback-Replay noch ein Snapshot-Protokoll, das ein Client anfordern müsste.

### Zwei Stellen, an denen ein nativer Client es _leichter_ hat als der Browser

- **Auth-Header auf dem WS-Upgrade.** Browser können auf WebSocket-Upgrades keine Header setzen
  und sind deshalb auf das Session-Cookie angewiesen. Ein nativer Client kann schlicht
  `Authorization: Bearer <SHEPHERD_TOKEN>` mitsenden — derselbe Machine-Client-Pfad, den die
  Chrome-Extension schon nutzt (`extension/src/lib/transport.ts:61`), akzeptiert vom zentralen
  Auth-Seam `src/server.ts:705-718`.
- **Origin-Prüfung.** `/pty/:id` und `/events` prüfen den `Origin`-Header gegen eine Allowlist.
  Ein nativer Client sendet gar keinen — und `classifyOrigin` behandelt das explizit als erlaubt
  („no-browser client (curl, CLI)", `src/validate.ts:928`).

### SwiftTerm ist reif und lebendig

Die entscheidende Frage war, ob es unter Swift überhaupt einen brauchbaren Terminal-Emulator gibt.
Ja — und er ist aktueller, als man vermuten würde:

| Fakt              | Wert                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Letztes Release   | **v1.15.0, 19. Juli 2026**                                                                                                     |
| Letzter Push      | 26. Juli 2026                                                                                                                  |
| Lizenz / Sterne   | MIT / ~1 640                                                                                                                   |
| Produktiv genutzt | Secure ShellFish, La Terminal, CodeEdit                                                                                        |
| Features          | volle xterm/VT100-Kompatibilität, TrueColor, Mouse-Tracking, Unicode/Grapheme-Cluster, Sixel, Kitty-Graphics, OSC-8-Hyperlinks |
| API-Modell        | UI-agnostische Engine, `TerminalView` (UIView) + Delegate — man füttert selbst Bytes, kein eingebautes SSH                     |

Das „Bytes rein, Rendering raus"-Modell ist exakt das, was Shepherds Stream braucht. Für volle
Parität kämen noch Bracketed Paste (`\x1b[200~…\x1b[201~\r`, `ui/src/lib/compose.ts:10`), OSC 52
lesend und die Shift+Enter→`\x0A`-Umsetzung dazu (`Viewport.svelte:1796`).

### Wo der Aufwand wirklich liegt

Nicht im Stream, sondern in `Viewport.svelte` (4 160 Zeilen). Dort steckt die Logik, die aus einem
Bytestrom ein benutzbares Agenten-Terminal macht: wer die Scroll-Hoheit hat, wenn der Agent
Mouse-Tracking aktiviert; die Escape-Rettung, wenn xterms verstecktes Textarea den Fokus verliert;
WebGL-Fallback; IME-Behandlung; Bild-Paste; Slash-Command-Links; Selection unter aktivem
Mouse-Reporting. Ein nativer Client müsste diese Entscheidungen alle noch einmal treffen — mit
anderen Primitiven.

### Eine Produkt-Einschränkung, die für beide Clients gilt

Pro `terminalId` gibt es **genau einen** Owner (`ptyOwners`, `src/server.ts:7757`). Ein neuer
Client wirft den alten mit Close-Code 4000 raus. Wer das Terminal am Handy öffnet, kickt also
seinen Desktop-Browser aus derselben Session. Das ist keine PWA-vs-native-Frage, aber es begrenzt,
wie sehr „Terminal am Handy" überhaupt ein Nebeneinander-Feature sein kann.

---

## 3. Die echten Vorteile einer nativen App

Damit die Abwägung ehrlich bleibt: Das hier sind belegte, nicht wegdiskutierbare Gewinne.

### 3.1 Diktat — heute auf iOS schlicht kaputt

Der stärkste einzelne Punkt, weil er ein bestehendes Loch schließt. Der Code sagt es selbst
(`ui/src/lib/dictation.svelte.ts:9-13`):

> Web Speech (Chrome/Android, Safari browser tab) … **WebKit doesn't expose it inside an iOS
> home-screen PWA at all.** … Local Whisper … **The ONLY mic in an iOS PWA.**

Auf dem iPhone gibt es in der installierten PWA also **kein** Diktat, außer man installiert das
optionale `voice-whisper`-Plugin und lässt Audio zum eigenen Server hochladen. Nativ wäre das
`SFSpeechRecognizer` mit `requiresOnDeviceRecognition` — On-Device, ohne Plugin, ohne Upload. Für
ein Tool, dessen mobiler Kern-Use-Case „light steering on the go" ist (`PRODUCT.md:9`), ist das
substanziell.

### 3.2 Benachrichtigungen mit Textantwort

APNs kennt `UNTextInputNotificationAction` — ein Textfeld direkt in der Benachrichtigung, dessen
Inhalt als `UNTextInputNotificationResponse.userText` ankommt. Für Shepherd hieße das: Ein Agent
meldet „blocked", und man beantwortet die Frage vom Sperrbildschirm aus, ohne die App zu öffnen.
Das ist genau der Ablauf, den Shepherds `blocked`-Push heute anstößt (eine von 18 Push-Arten in
`src/push.ts:15-29`) — nur eben mit vier statt einem Tap.

Web Push auf iOS kann das nicht. Belegbar ist: Bei Einführung (16.4) wurden selbstdefinierte
Action-Buttons ignoriert, nur „View" erschien. Dass es seither nachgeliefert wurde, ließ sich in
keinem WebKit-Release-Post bis Safari 26.6 (Juli 2026) finden — das ist ein Argument aus
_Abwesenheit_ einer Ankündigung, also schwächer als die Positivbelege, und vor einer Entscheidung
auf einem echten Gerät gegenzuprüfen.

Dazu kommen native Interruption Levels — insbesondere **Time Sensitive**, das Fokus-Modi
durchbricht. Für „Agent blockiert seit 20 Minuten, während du in einem Meeting bist" ist das der
Unterschied zwischen gesehen und nicht gesehen. `interruption-level` ist ein Feld des nativen
APNs-Payloads und nicht Teil der Web-Push-Spezifikation; eine WebKit-Quelle, die es aus einem
Web-Push-Payload liest, existiert nicht.

### 3.3 Live Activities

Ein laufender Agent auf dem Sperrbildschirm bzw. in der Dynamic Island, per Push aktualisiert und
sogar per Push startbar (`registerPushToStart`). Passt konzeptionell hervorragend zu Shepherds
Modell. Grenzen: 8 Stunden aktiv, danach bis zu 4 Stunden „stale", danach automatisch entfernt;
das Update-Budget ist von Apple bewusst nicht dokumentiert und wird gedrosselt.

### 3.4 Hardware-Tastatur

`UIKeyCommand` liefert Escape, Ctrl-Kombinationen, Tab und Pfeiltasten sauber an die App. In Safari
ist genau das die Schwachstelle: Escape wird weitgehend vom Browser vereinnahmt, Tab teilweise für
Fokus-Cycling. Für ein Terminal an einem iPad mit Magic Keyboard ist das ein echter Unterschied.

Wichtige Relativierung: Für die **Software**-Tastatur hat die PWA das Problem bereits gelöst —
`ControlBar.svelte` rendert eine eigene Leiste mit Esc/Tab/Space/Pfeilen/^-Tasten samt
Tap-vs-Drag-Unterscheidung, und `ComposeBar.svelte` umgeht das Tippen im Terminal ganz.

### 3.5 Weiteres

Keychain + Face ID für den Server-Token; App Intents/Shortcuts (Siri: „Zeig mir blockierte
Agenten"); Share Sheet als Eingang für neue Aufgaben; Handoff zwischen iPhone und Mac.

### 3.6 Flucht aus konkreten WebKit-Bugs 2026

Nicht theoretisch, sondern aktuell:

- **iOS 26/26.1 + iCloud Private Relay**: fehlerhafte `CONNECT`-statt-`GET`-Upgrade-Requests für
  WebSockets, Server antworten mit 400. Betrifft u. a. Home Assistant und Figma. In 26.2 gebessert,
  aber mit 5–6 s Verbindungsverzögerung; nicht offiziell als gefixt bestätigt.
- **`theme-color`-Regression in Safari 26** mit fixed-position-Elementen (Statusleiste färbt sich
  nach Popover-Hintergrund statt Body).
- **Safe-Area-Insets im iPadOS-26-Fenstermodus** funktionieren nicht; Fenstersteuerelemente können
  UI verdecken.
- **7-Tage-Storage-Eviction (ITP)**: WebKit behandelt Datenverlust bei installierten Home-Screen-Apps
  laut Team-Position als Bug, garantiert es aber nirgends dokumentiert. Wer Shepherd seltener als
  wöchentlich öffnet, riskiert Verlust — mit `navigator.storage.persist()` abmilderbar.

---

## 4. Der Show-Stopper: Push

### 4.1 Der Befund

Ein Apple-DTS-Engineer im offiziellen Developer-Forum, wörtlich:

> „Web Push Notifications will not work in apps with a `WKWebView`. You can use native push
> notifications with an app that also happens to have a `WKWebView`, but not Web Push.
> BTW, Service Workers work fine in a `WKWebView`. That is not the reason why Web Push is not
> working."
> — Argun Tekant, DTS Engineer, Core Technologies

Das gilt für **jede** Verpackung: Swift-nativ, Capacitor, Tauri, PWABuilder-Wrapper. Es gibt keine
Variante einer iOS-App, die Shepherds heutigen Push-Pfad weiterbenutzt.

### 4.2 Warum das für ein Self-Hosted-Tool besonders weh tut

Shepherds Push ist heute vollständig dezentral: `src/push.ts` erzeugt beim ersten Start selbst
VAPID-Schlüssel und persistiert sie in den Settings (`src/push.ts:386-410`); der Server spricht
danach direkt mit Apples Web-Push-Endpunkt. **Das Projekt betreibt nichts, weiß nichts, haftet für
nichts.** Der Service Worker ist bewusst push-only ohne Offline-Caching
(`ui/static/sw.js:1`) — Push ist der einzige Grund, warum die PWA überhaupt existiert
(`ui/src/lib/pwa.ts:5-8`).

APNs kehrt das um: Der Auth-Key (`.p8`) gehört dem Apple-Developer-Team, nicht dem Nutzer. Ihn an
jeden Self-Hoster auszuliefern wäre gleichbedeutend damit, jedem die Fähigkeit zu geben, an **alle**
Nutzer der App zu pushen. Bleibt nur ein zentraler Relay, den das Projekt dauerhaft betreibt:
Verfügbarkeits-SPOF, laufende Kosten, DSGVO-Verantwortung für fremde Metadaten — für ein
Ein-Personen-Open-Source-Projekt eine strukturelle Zäsur, keine Implementierungsdetail-Frage.

### 4.3 Der Präzedenzfall: Omnara

Das ist keine theoretische Sorge. **Omnara** („The Open Source Agent Control Plane", Apache-2.0) ist
das nächstliegende Vergleichsprodukt überhaupt — Claude Code und Codex, die auf dem eigenen Laptop
laufen, vom Handy aus überwachen und steuern. Also exakt Shepherds mobiler Use-Case. Und Omnara hat
eine native iOS-App im App Store.

Wie sie das Push-Problem gelöst haben: **gar nicht — sie haben das Produkt darum herum gebaut.**
Die Architektur besteht aus einem zentralen API-Server, PostgreSQL, Supabase und einem eigenen
„Notification Service (Push/Email/SMS)". Die Mobile-App spricht mit dem gehosteten Dienst, nicht
direkt mit der Maschine des Nutzers. Self-Hosting ist laut eigenem README nur teilweise unterstützt:
„You can build both the web dashboard and mobile app from source **if you prefer to self-host or run
an older version**" — dokumentiert ist im Wesentlichen ein Entwicklungs-Setup, keine
produktionsreife Self-Hosting-Anleitung.

Das ist die Bestätigung der These aus 4.2 durch den Markt: Wer in dieser Produktkategorie eine
native Mobile-App will, wird zur gehosteten Kontrollebene. Shepherd ist heute bewusst das Gegenteil
— Loopback-Bind plus Tailscale (`src/config.ts:548`), kein Multi-Tenant-Modus, ein einziges
Operator-Passwort.

**Und ein zweiter, ebenso aufschlussreicher Befund:** Omnaras Mobile-App (React Native 0.81 /
Expo 54, `expo-notifications`) enthält in ihrem Manifest **keine einzige Terminal-Abhängigkeit**.
Der mobile Zuschnitt ist Nachrichten, Steuern, Freigeben — kein gestreamtes PTY. Wer das Problem
also bereits gelöst hat, hat das Terminal auf dem Handy bewusst weggelassen. _(Inferenz aus
`apps/mobile/package.json`; nicht dasselbe wie eine ausdrückliche Aussage der Autoren.)_

---

## 5. Die weiteren Nachteile

### 5.1 App-Store-Betrieb

| Posten                        | Realität (Stand Juli 2026)                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer Program             | 99 USD/Jahr                                                                                                                                                      |
| Build-Maschine                | Mac zwingend (oder Xcode Cloud — 25 Compute-Stunden/Monat sind im Programm enthalten)                                                                            |
| **Jährlicher Zwangs-Rebuild** | Seit **28. April 2026** müssen alle Uploads mit **Xcode 26 / SDK 26** gebaut sein                                                                                |
| Review                        | Apple: „90 % of submissions are reviewed in less than 24 hours"                                                                                                  |
| Privacy Manifest              | `PrivacyInfo.xcprivacy` Pflicht, sobald Required-Reason-APIs genutzt werden (z. B. `UserDefaults` — praktisch immer), **auch wenn keine Daten gesammelt werden** |
| Datenschutzerklärung          | Pflicht für jede App, auch bei „wir sammeln nichts"                                                                                                              |
| Demo für Reviewer             | Guideline 2.1 verlangt Demo-Account **oder** eingebauten Demo-Modus mit vollem Funktionsumfang                                                                   |

Der letzte Punkt hat für Shepherd eine unangenehme Pointe: Der Server bindet standardmäßig nur auf
Loopback (`SHEPHERD_HOST=127.0.0.1`, `src/config.ts:548`) und ist per Tailscale erreichbar. Apples
Reviewer haben keinen Zugang zum privaten Tailnet — es bräuchte also eine **öffentlich erreichbare
Demo-Instanz**, die permanent läuft. Immich löst das über Transparenz in der Store-Beschreibung
(„you will need to run/manage the server on your own"), Home Assistant über einen öffentlichen
Demo-Server. Beides ist zusätzlicher Dauerbetrieb.

### 5.2 Guideline 4.2.7 — die ungeklärte Rechtsfrage

Der Wortlaut (verifiziert am Primärtext):

> **4.2.7 Remote Desktop Clients.** If your remote desktop app acts as a mirror of specific software
> or services rather than a generic mirror of the host device, it must comply with the following:
> **(a)** The app must only connect to a user-owned host device … and both the host device and
> client must be connected on a **local and LAN-based network**. **(b)** Any software or services
> appearing in the client are fully executed on the host device … **(e)** Thin clients for
> cloud-based apps are not appropriate for the App Store.

Die Auslösebedingung ist „mirror of **specific software**". Ein Client, der eine Claude-Code-TUI
streamt, ist dem gefährlich nahe — und (a) verlangt dann LAN. Ob ein Tailscale-Overlay als „LAN-based"
gilt, hat Apple nie öffentlich geklärt.

**Gegenargument:** Termius, Blink Shell und Prompt 3 streamen Remote-Shells über das offene Internet
und sind im Store. Apple wendet 4.2.7 offenkundig nicht auf Terminal-/SSH-Clients an. Ein Client mit
eigener API-Anbindung (strukturierte Diffs, Agenten-Steuerung, Session-Liste) ist zudem
architektonisch näher an GitHub Mobile oder Home Assistant als an VNC.

**Ehrliche Einordnung:** kein K.-o., aber Review-Lotterie. Zu keinem dokumentierten
2.5.2-Rejection-Fall für Terminal-Apps ließ sich eine Quelle finden — es gibt schlicht wenig
öffentliche Evidenz in beide Richtungen.

### 5.3 Zweiter Client = doppelte Wahrheit

Siehe Abschnitt 1: 3 478 i18n-Schlüssel, ~150 Routen, keine Schema-Quelle, bereits doppelt gepflegte
Typen. Die Chrome-Extension zeigt die Untergrenze eines Zweit-Clients: ~8 000 Zeilen, eigener
i18n-Katalog, eigener Build — und deckt trotzdem nur **4 von ~150 Endpunkten** ab
(`/api/ping`, `/api/uploads`, `POST /api/sessions`, `POST /api/issues`). Sie ist ein
Fire-and-forget-Capture-Tool; für einen iOS-Client ist daraus außer dem Bearer-Auth-Muster
praktisch nichts wiederverwendbar.

---

## 6. Mythen: Was eine native App NICHT löst

**Das Terminal läuft im Hintergrund weiter.** Nein. iOS suspendiert auch native Apps; die
WebSocket-Verbindung stirbt genauso. `beginBackgroundTask` gibt ~30 Sekunden ohne Garantie;
`BGAppRefreshTask` ist für kurze Auffrischungen gedacht, nicht für Dauerverbindungen;
Background-URLSession unterstützt **keine** WebSocket-Tasks; VoIP-Push ist ausdrücklich nur für
echte Anrufe zulässig und führt bei Missbrauch zur Terminierung der App. Shepherds PWA-Code
beschreibt das Problem bereits präzise für die Web-Seite (`ui/src/lib/store.svelte.ts:65`: „a
mobile freeze kills the socket WITHOUT ever firing `onclose`") — nativ ist es dasselbe Problem mit
anderen Symptomen. Die korrekte Architektur ist in beiden Welten identisch: Push statt gehaltener
Verbindung, Reconnect beim Zurückkehren.

**Badges gibt es nur nativ.** Nein — die Badging-API läuft seit iOS 16.4 in der PWA und wird
bereits genutzt (`ui/src/lib/tab-signal.svelte.ts:264`).

**Die Software-Tastatur hat kein Esc/Ctrl, das geht nur nativ.** Nein — `ControlBar.svelte` löst
das heute schon.

**Die App könnte einfach in den Browser verlinken, dann ist die Login-Frage gelöst.** Nein, nicht
mit `SFSafariViewController`: Apple dokumentiert ausdrücklich, dass dessen Web-Sitzung von der App
isoliert ist („You don't need to secure data between your app and Safari"). Der Nutzer müsste sich
dort erneut anmelden. Der funktionierende Weg ist `WKWebView` plus
`WKHTTPCookieStore.setCookie` (iOS 11+): Die App meldet sich einmal per Token an und injiziert das
`shepherd_session`-Cookie selbst in die WebView. Das ist der technisch richtige Bauplan für die
Hybrid-Idee — nur eben mit dem Push-Verlust aus Abschnitt 4.

---

## 7. Umsetzungswege im Vergleich

Es gibt nicht „die native App", sondern vier Wege mit sehr unterschiedlichen Kostenprofilen.

| Weg                          | UI-Wiederverwendung | Terminal              | Push                 | Store-Risiko   | Kernproblem                                 |
| ---------------------------- | ------------------- | --------------------- | -------------------- | -------------- | ------------------------------------------- |
| **A** Swift/SwiftUI nativ    | 0 %                 | SwiftTerm (sehr gut)  | APNs + Relay         | mittel (4.2.7) | Zweiter Client, dauerhafte Teilmenge        |
| **B2** React Native / Expo   | 0 %                 | keine gute Lösung     | APNs + Relay         | niedrig        | Voller UI-Rewrite (= Omnaras Weg)           |
| **B** Capacitor              | ~100 %              | xterm.js in WKWebView | APNs + Relay         | niedrig        | Apple-Tretmühle für geringen Zugewinn       |
| **C** Tauri 2 iOS            | ~100 %              | xterm.js in WKWebView | APNs + Relay, unreif | niedrig        | iOS ist die schwächste Tauri-Zielplattform  |
| **D** Hybrid (A + WKWebView) | teilweise           | SwiftTerm             | APNs + Relay         | mittel         | Kombiniert die Kosten von A mit denen von B |

Die Spalte „Push" ist in allen vier Zeilen identisch — das ist der Punkt aus Abschnitt 4: Der
Push-Relay ist keine Eigenschaft des gewählten Frameworks, sondern von „ist eine App".

### A — Swift/SwiftUI nativ

Maximale Kontrolle, alle Vorteile aus Abschnitt 3 vollständig verfügbar. Das Terminal ist mit
SwiftTerm der leichteste Teil. Bezahlt wird mit der vollständigen Neuimplementierung des
API-Clients (~150 Routen, ~80 Typen als handgeschriebene `Codable`-Strukturen ohne Schema-Quelle)
und einem zweiten i18n-/Design-Universum.

### B — Capacitor (aktuell 8.4.2, Juli 2026; 9.0 in Alpha)

Der überraschend billige Weg: Shepherds UI baut bereits mit `@sveltejs/adapter-static` und
`fallback: "index.html"` (`ui/svelte.config.js:10`) — also exakt als statische SPA, die Capacitor
in eine `WKWebView` packt. Die 242 Komponenten, alle 3 478 Übersetzungen, das Design-System und
sämtliche CI-Gates bleiben gültig, weil es dieselbe Codebasis bleibt. Man bekommt dafür: App-Store-
Präsenz, natives APNs, Keychain, `SFSpeechRecognizer` über ein Plugin.

Zwei Einschränkungen, die man nicht wegkonfigurieren kann:

- **Web Push ist auch hier tot** (Apple DTS, Abschnitt 4). Der bestehende Push-Pfad in
  `src/push.ts` müsste für App-Nutzer durch APNs ersetzt werden — der Server müsste also
  **beide** Wege parallel bedienen: Web Push für PWA-Nutzer, APNs-über-Relay für App-Nutzer.
- **Das Terminal bleibt xterm.js im WebView.** `WKWebView` bekommt JIT (der JavaScript-Code läuft
  im separaten WebContent-Systemprozess), es ist also nicht die langsame In-Process-JavaScriptCore-
  Variante. Belastbare Messwerte speziell für xterm.js in `WKWebView` ließen sich allerdings nicht
  finden — das wäre vor einer Entscheidung selbst zu benchmarken, nicht anzunehmen.

Nüchtern betrachtet ist B die Frage: Rechtfertigt „im App Store und mit APNs" den jährlichen
Xcode-Rebuild, 99 USD, einen Mac, eine Demo-Instanz für Reviewer und einen Push-Relay — wenn die
UI exakt dieselbe bleibt, die der Nutzer heute über „Zum Home-Bildschirm" bekommt?

### B2 — React Native / Expo (der Weg, den Omnara gegangen ist)

Der Vollständigkeit halber, weil das Vergleichsprodukt genau das gewählt hat: Omnaras Mobile-App
läuft auf React Native 0.81 / Expo 54 mit `expo-notifications`. Für Shepherd hieße das ein
vollständiger UI-Rewrite — keine Svelte-Komponente ist übertragbar. Der Weg ergibt nur Sinn, wenn
man ohnehin einen bewusst kleinen mobilen Zuschnitt baut (Nachrichten/Steuern/Freigeben statt
Feature-Parität) und dafür ein Ökosystem mit ausgereiften Push-, Build- und OTA-Update-Diensten
will. Er ist die direkte Alternative zu A, nicht zu B.

### C — Tauri 2 (aktuell 2.11.5, Juli 2026)

Ebenfalls `WKWebView`-basiert, also dieselbe Terminal- und Push-Situation wie B. iOS ist innerhalb
von Tauri die jüngste und am wenigsten ausgereifte Zielplattform; Push- und Background-Integration
sind schwächer abgedeckt als bei Capacitor, das aus dem Mobile-Ökosystem kommt. Für dieses Vorhaben
gibt es keinen Grund, C statt B zu wählen.

### D — Hybrid: native Hülle + eingebettete Web-Views

Das ist die Variante aus der ursprünglichen Frage — „kann initial nicht alles, verlinkt aber auf
die Webseiten". Technisch der richtige Bauplan dafür steht in Abschnitt 6: **nicht**
`SFSafariViewController` (eigener Cookie-Jar → zweiter Login), sondern `WKWebView` plus
`WKHTTPCookieStore.setCookie`.

Realistisch nativ wären: Session-Liste mit Status, Terminal, Compose/Steer, Push, Diktat. Alles
Übrige — Diff-Ansicht (`@pierre/diffs` + `shiki`), PR-Dashboard, Backlog/Epics, Settings, Plugin-UI —
bliebe Web-View. Das ist ein ehrlicher, funktionierender Zuschnitt. Es ist nur der Weg mit den
**addierten** Kosten: der zweite Client aus A **plus** die App-Store-Tretmühle aus B.

### Nicht empfohlen: Wrapper-Dienste

PWABuilder-/Median-artige Generatoren produzieren genau das, was Guideline 4.2.2 adressiert
(„apps shouldn't primarily be … web clippings … or a collection of links"). Für eine App, deren
gesamter Inhalt eine gewrappte Website ist, ist das Ablehnungsrisiko am höchsten — und der Zugewinn
gegenüber der installierten PWA am kleinsten.

---

## 8. Empfehlung

### 8.1 Kurzfassung

**Keine native iOS-App bauen — stattdessen die PWA gegen die konkreten iOS-26-Probleme härten.**

Die Begründung in einem Satz: Der Nutzen einer nativen App konzentriert sich auf Benachrichtigungen
und Diktat, und ausgerechnet die Benachrichtigungen kosten dabei die Eigenschaft, die Shepherd als
Self-Hosted-Tool definiert — dass niemand außer dem Nutzer selbst etwas betreiben muss.

Die Terminal-Frage, die den Anstoß gab, entpuppt sich dabei als die am wenigsten interessante: Sie
ist technisch leicht lösbar (Abschnitt 2), aber sie ist auch der Teil, der in der PWA heute schon
funktioniert. Man würde also das Einfache neu bauen und das Schwierige (die 4 160 Zeilen
Terminal-Verhaltenslogik) entweder verlieren oder ein zweites Mal bezahlen. Omnara — das einzige
direkt vergleichbare Produkt mit nativer iOS-App — hat das Terminal auf dem Handy gar nicht erst
mitgenommen (Abschnitt 4.3). Das ist ein Signal: Der mobile Wert liegt im Steuern und Freigeben,
nicht im Zusehen.

### 8.2 Was stattdessen zu tun wäre — nach Nutzen pro Aufwand

1. **WebSocket-Reconnect gegen den iOS-26-Private-Relay-Bug testen und härten.** Das ist die einzige
   Position auf dieser Liste, die einen aktiven Fehler betrifft, nicht ein fehlendes Feature. Auf
   einem echten Gerät mit aktiviertem iCloud Private Relay prüfen, ob `/events` und `/pty/:id`
   sauber hochkommen. Der bestehende `wake()`-Pfad (`ui/src/lib/store.svelte.ts:1031`) ist die
   richtige Stelle.
2. **`navigator.storage.persist()` anfordern.** Eine Zeile, adressiert das 7-Tage-Eviction-Risiko;
   WebKit gewichtet die Home-Screen-Installation bei der Vergabe positiv.
3. **Diktat auf iOS ehrlich machen.** Heute ist die installierte PWA auf iPhone ohne
   `voice-whisper`-Plugin stumm, und der Grund dafür steht nur als Kommentar im Code. Entweder das
   Plugin im Onboarding sichtbar empfehlen oder die Mic-Abwesenheit in der UI erklären.
4. **Declarative Web Push evaluieren** (iOS 18.4+): JSON-Push, der die Benachrichtigung auch dann
   anzeigt, wenn der Service Worker scheitert — genau der Fehlerfall, gegen den sich `sw.js` heute
   mit Guards wehrt.

### 8.3 Falls trotzdem nativ — dann so

Sollte die Entscheidung anders ausfallen, ist der Bauplan aus dieser Recherche eindeutig:

- **Nicht** von Grund auf nativ, sondern **Hybrid**: native Hülle mit nativer Session-Liste,
  nativem Terminal (SwiftTerm) und nativem Push; alles andere in einer `WKWebView`, in die die App
  per `WKHTTPCookieStore.setCookie` das `shepherd_session`-Cookie injiziert, damit kein zweiter
  Login entsteht.
- **Als Erstes den Push-Relay klären, nicht das Terminal.** Das Terminal ist ein Wochenende, der
  Relay ist eine Dauerverpflichtung. Wer mit dem Terminal anfängt, baut den einfachen Teil und
  entdeckt die eigentliche Entscheidung zu spät.
- **In den Review-Notes ausdrücklich klarstellen**, dass es sich um einen API-/WebSocket-Client
  handelt und nicht um Screen-Mirroring — damit Guideline 4.2.7 gar nicht erst in Betracht gezogen
  wird. Dazu eine öffentlich erreichbare Demo-Instanz für den Reviewer bereitstellen.

### 8.4 Was die Entscheidung umdrehen würde

- **Shepherd bekommt einen gehosteten Modus.** Dann existiert die zentrale Infrastruktur ohnehin,
  der Push-Relay ist keine zusätzliche Zäsur mehr — und damit fällt das Hauptargument weg.
- **Apple öffnet Web Push für `WKWebView`** oder liefert Notification-Actions für Web Push nach.
  Ersteres würde Capacitor schlagartig attraktiv machen, Letzteres den größten nativen Vorsprung
  einebnen.
- **Belege, dass Web Push auf iOS unzuverlässig zustellt.** Bisher ist das Anekdote. Eine Messung
  (zugestellt vs. gesendet, aus `src/push.ts` heraus instrumentierbar) würde aus einem Bauchgefühl
  ein Argument machen — in beide Richtungen.

---

## 9. Quellen

**Primärquellen — Apple**

- App Store Review Guidelines (4.2, 4.2.2, 4.2.7, 2.5.2, 2.1, 5.1.1, 4.7) — https://developer.apple.com/app-store/review/guidelines/
- Upcoming Requirements (Xcode 26 / SDK 26 seit 28.04.2026) — https://developer.apple.com/news/upcoming-requirements/
- `SFSafariViewController` (Datenisolation gegenüber Safari) — https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller
- `WKHTTPCookieStore` (Cookie-Injektion, iOS 11+) — https://developer.apple.com/documentation/webkit/wkhttpcookiestore
- Web Push in `WKWebView` — Apple DTS, Developer Forums Thread 760767 — https://developer.apple.com/forums/thread/760767
- `UNTextInputNotificationAction` — https://developer.apple.com/documentation/usernotifications/untextinputnotificationaction
- `UNNotificationInterruptionLevel` (Time Sensitive) — https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel
- ActivityKit: Live Activities per Push starten/aktualisieren — https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
- `ActivityState.stale` (8h + 4h Lebensdauer) — https://developer.apple.com/documentation/activitykit/activitystate/stale
- `SFSpeechRecognizer.supportsOnDeviceRecognition` — https://developer.apple.com/documentation/Speech/SFSpeechRecognizer/supportsOnDeviceRecognition
- TN3151 „Choosing the right networking API" (Network Framework statt URLSession für WebSocket) — https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api
- Background-Download (keine WebSocket-Tasks in Background-Sessions) — https://developer.apple.com/documentation/Foundation/downloading-files-in-the-background
- `BGAppRefreshTask` — https://developer.apple.com/documentation/backgroundtasks/bgapprefreshtask
- PushKit / VoIP-Notifications (nur für echte Anrufe) — https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit
- TN3183 Privacy Manifest / Required Reason APIs — https://developer.apple.com/documentation/technotes/tn3183-adding-required-reason-api-entries-to-your-privacy-manifest
- Developer Program (99 USD/Jahr, Xcode Cloud) — https://developer.apple.com/programs/whats-included/
- Enterprise Program (≥100 Mitarbeiter, nur In-House) — https://developer.apple.com/programs/enterprise/
- App Review (90 % < 24 h) — https://developer.apple.com/distribute/app-review/
- DMA / EU-Distribution, Notarisierung — https://developer.apple.com/support/dma-and-apps-in-the-eu/
- Local Network Privacy (WWDC20) — https://developer.apple.com/videos/play/wwdc2020/10110/

**Primärquellen — WebKit**

- Web Push für Web-Apps auf iOS/iPadOS (16.4, nur Home-Screen) — https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- WebKit Features in Safari 16.4 (Badging) — https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
- Meet Declarative Web Push (18.4) — https://webkit.org/blog/16535/meet-declarative-web-push/
- WebKit Features in Safari 26.0 („every site can be a web app", WebSocket über HTTP/2+3) — https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- Updates to Storage Policy (Quoten, `navigator.storage.persist()`) — https://webkit.org/blog/14403/updates-to-storage-policy/
- Async Clipboard API — https://webkit.org/blog/10855/async-clipboard-api/
- WebKit Bug 211018 — iOS-PWAs mit Service Worker frieren nach Backgrounding ein — https://bugs.webkit.org/show_bug.cgi?id=211018
- WebKit Bug 302561 — WebSockets unter iCloud Private Relay — https://bugs.webkit.org/show_bug.cgi?id=302561
- WebKit Bug 204117 — Background Sync, seit 2019 offen — https://bugs.webkit.org/show_bug.cgi?id=204117

**Bibliotheken / Projekte**

- SwiftTerm (MIT, v1.15.0 vom 19.07.2026) — https://github.com/migueldeicaza/SwiftTerm
- xterm.js — mobile Plattformen / virtuelle Tastenleiste — https://github.com/xtermjs/xterm.js/issues/1101
- Immich im App Store („you will need to run/manage the server on your own") — https://apps.apple.com/us/app/immich/id1613945652
- **Omnara** — Architektur, Self-Hosting-Status — https://github.com/omnara-ai/omnara
- Omnara Mobile — React Native 0.81 / Expo 54, `expo-notifications`, keine Terminal-Abhängigkeit — https://github.com/omnara-ai/omnara/blob/main/apps/mobile/package.json
- Omnara im App Store — https://apps.apple.com/us/app/omnara-ai-command-center/id6748426727
- Capacitor Releases (8.4.2 stabil, 9.0.0-alpha.6 — Juli 2026) — https://github.com/ionic-team/capacitor/releases
- Tauri Releases (2.11.5 — Juli 2026) — https://github.com/tauri-apps/tauri/releases

**Sekundärquellen (als solche gekennzeichnet)**

- Web Push auf iOS — Praxisbericht nach einem Jahr — https://webventures.rejh.nl/blog/2024/web-push-ios-one-year/
- WebSocket-Upgrade-Fehler unter Safari/iOS 26 mit Private Relay (Paket-Analyse) — https://www.jackpearce.co.uk/posts/debugging-websocket-upgrade-failures-safari-ios26/
- `theme-color`-Regression in Safari 26 — https://benfrain.com/ios26-safari-theme-color-tab-tinting-with-fixed-position-elements/
- Safe-Area-Insets im iPadOS-26-Fenstermodus — https://dev.to/reinhart1010/pwa-in-ipados-26-is-a-joke-38g1
- Alternative Browser-Engines faktisch weiterhin nicht ausgeliefert — https://open-web-advocacy.org/blog/apples-browser-engine-ban-persists-even-under-the-dma/

**Code-Belege in diesem Repo**

`src/pty-bridge.ts:42` · `src/pty-demux.mjs:20` · `src/socket-pty-bridge.ts` · `src/server.ts:705`
(Auth-Seam), `:7757` (PTY-Owner), `:7793` (WS-Upgrade), `:7418` (Routen) · `src/push.ts:15`
(18 Push-Arten), `:386` (VAPID-Selbstprovisionierung) · `src/config.ts:548` (Loopback-Bind) ·
`src/validate.ts:928` (Origin-Klassifikation) · `ui/src/lib/pty.ts:97` · `ui/src/lib/pwa.ts:5` ·
`ui/src/lib/dictation.svelte.ts:9` · `ui/src/lib/store.svelte.ts:65`, `:1031` ·
`ui/src/lib/components/Viewport.svelte:1597` (xterm-Konstruktion), `:1796` (Shift+Enter) ·
`ui/src/lib/components/ControlBar.svelte` · `ui/src/lib/compose.ts:10` (Bracketed Paste) ·
`ui/static/sw.js:1` · `extension/src/lib/transport.ts:61` (Bearer-Muster)
