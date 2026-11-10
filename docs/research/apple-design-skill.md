# Research: Hilft das „Apple Design Skill“ bei der Entwicklung unserer iOS-App?

_Recherche, 2026-11-10. Frage des Operators: „Hilft uns dieses Skillset für die Entwicklung unserer
iOS App?“ Gemeint ist [dickwu/apple-design-skill](https://github.com/dickwu/apple-design-skill),
geprüft auf Commit [`ff4ebdd`][c-head] vom 28.10.2026. Dies ist eine reine Recherche-Notiz: Es wurde
kein Produktcode geändert und kein Skript aus dem Repo ausgeführt._

## Verdikt

**TEILWEISE NUTZEN: als gelegentlicher HIG-Prüfer für einzelne iOS-Screens. Nicht als
Entwicklungs-Skill und nicht im Repo.**

Das Skillset ist ein **Design-Review-Skill**. Es bewertet Screenshots, Mockups und UI-Code gegen
Apples Human Interface Guidelines und schreibt einen Befundbericht. Beim Schreiben von SwiftUI-Code
hilft es kaum: Es kennt weder Availability-Gates (`#available`) noch geteilten iOS/macOS-Code.
Inhaltlich ist es sauber. Es enthält 123 HIG-Seiten in Apples Wortlaut (Stand 28.10.2026), und jede
geprüfte Zahl und API stimmt. Seine Accessibility-Regeln, von Hand auf unseren Code angewandt,
treffen echte Lücken: Es gibt keinen Increase-Contrast-Zweig, und ein Text erreicht nur ≈ 3:1
Kontrast. Als reines Markdown läuft es
auch auf unseren Linux-Agenten. Seine verdichteten Regeln widersprechen aber bewussten
Entscheidungen: Dark-only, Versal-Labels, eigene Bottom-Bar, „near-black + ein Akzent“. Ohne
Briefing produziert es deshalb Rauschen. Gegen ein Einchecken in unser öffentliches Repo sprechen
die fehlende Lizenz, 1,4 MB Apple-Text und ein sehr breiter Auto-Trigger.

---

## 1. Was das Skillset ist

- **Ein Reviewer, kein Coder.** `SKILL.md` macht den Agenten zu „a senior design reviewer who
  knows Apple's Human Interface Guidelines cold“ und zugleich zum Designlead eines Studios
  ([`SKILL.md:19–22`][s19]). Der Ablauf hat vier Schritte ([`SKILL.md:123–329`][s123]):
  1. Kontext klären.
  2. 8–12 Referenzdateien laden.
  3. Durch fünf Linsen prüfen: Accessibility, Plattform-Konventionen, Visual/Craft, Interaktion,
     Text.
  4. Einen Bericht mit den Schweregraden Critical, High, Medium und Low schreiben.

  Dazu kommen Spezialmodi, etwa Accessibility-Audit, Dark Mode, Liquid Glass, Apple Pay,
  Code-Audit, Navigation, iPhone Duo und Widgets. Ein „Design improvement mode“ plant ein
  Token-System ([`SKILL.md:331–408`][s331]).

- **Wissensbasis.** In `references/hig/` liegen 123 Seiten, die ein Skript aus Apples HIG-JSON
  erzeugt und auf iOS, iPadOS und macOS filtert. Handgeschrieben sind `liquid-glass.md`,
  `cross-platform.md` und `code-audit.md` mit grep-Mustern für Apple Pay, Liquid Glass und
  iPhone Duo ([`SKILL.md:33–40`][s33]).
- **Zielgruppe.** Laut Beschreibung „any mobile app (iOS, Flutter, React Native) or desktop app
  (macOS, Tauri, Electron)“. SwiftUI, UIKit und AppKit stehen gleichrangig neben Flutter, React
  Native, Tauri und Electron ([`SKILL.md:2–14`][s2]). Web-Apps prüft es nur gegen Prinzipien und
  Foundations ([`SKILL.md:143–144`][s143]). Ein Figma-Werkzeug ist es nicht: „Figma exports“ liest
  es wie Screenshots.
- **Code-Bezug.** Er beschränkt sich auf `code-audit.md`. Ein Treffer der Suchmuster ist dort „a
  lead, not a finding“, dazu nennt die Datei die Ersatz-API ([`code-audit.md:17–19`][ca17]). Code
  schreibt das Skill nicht. Fixes formuliert es „in the user's framework“.
- **Einstiege.** Das Skill bedient Claude Code, `.cursorrules`, `GEMINI.md` (inhaltsgleich mit
  `.cursorrules`) und `AGENTS.md`. Installiert wird es per `npx skills add` oder `git clone`
  ([`README.md:10–76`][r10]).

## 2. Qualität und Korrektheit

Stichprobe gegen Apples Live-Quellen (HIG-JSON und API-Doku), abgerufen am 2026-11-10:

| Behauptung im Skill                                                                                                                                                                                                                                                                                                                                                           | Apple                                                                       | Ergebnis                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Touch-Ziele: iOS 44×44 pt Standard, 28×28 pt Minimum; macOS 28×28 pt und 20×20 pt ([`SKILL.md:170–171`][s165])                                                                                                                                                                                                                                                                | [HIG Accessibility][hig-a11y], Tabelle „Default control size“               | ✔ stimmt                                                                                                                                                    |
| Schrift: iOS 17/11 pt, macOS 13/10 pt. Kontrast: 4,5:1 bis 17 pt, 3:1 ab 18 pt oder fett ([`SKILL.md:166–169`][s165])                                                                                                                                                                                                                                                         | [HIG Accessibility][hig-a11y]                                               | ✔ stimmt                                                                                                                                                    |
| Liquid Glass nur im Functional Layer und sparsam. _Clear_ nur über Medien, 35 % Dimming ([`liquid-glass.md:26–40`][lg26])                                                                                                                                                                                                                                                     | [HIG Materials][hig-mat], fast wörtlich                                     | ✔ stimmt                                                                                                                                                    |
| SwiftUI: `glassEffect(_:in:)`, `Glass` mit `.regular`, `.clear`, `.tint` und `.interactive`, `GlassEffectContainer`, `.buttonStyle(.glass)` und `.glassProminent`. UIKit: `UIGlassEffect`, `UIGlassContainerEffect`, `UIButton.Configuration.glass()` und `.prominentGlass()`. AppKit: `NSGlassEffectView`, `NSGlassEffectContainerView` ([`liquid-glass.md:100–102`][lg100]) | [API-Doku][api-glass]                                                       | ✔ alle existieren, alle **ab iOS bzw. macOS 26.0**                                                                                                          |
| `UIDesignRequiresCompatibility` ist temporär und wird ab SDK 27 ignoriert ([`liquid-glass.md:103`][lg100])                                                                                                                                                                                                                                                                    | [Info.plist-Doku][api-compat], wörtlich                                     | ✔ stimmt                                                                                                                                                    |
| iPhone-Duo-APIs: `ArrangementView`, `ReservedRegion`, `UIArrangementViewController`, `ToolbarOverflowMenu`, Device Hub ([`code-audit.md:91–104`][ca91])                                                                                                                                                                                                                       | [HIG „Designing for iPhone Duo“][hig-duo] (neu seit 9.9.2026) verlinkt alle | ✔ existieren, verlangen aber **iOS 27.1** ([`ArrangementView`][api-arr]) bzw. 27.0 ([`ToolbarOverflowMenu`][api-tom]). Das Skill nennt keine Mindestversion |
| Acht Designprinzipien, „reintroduced June 2026“ ([`SKILL.md:107–121`][s107])                                                                                                                                                                                                                                                                                                  | [HIG Design principles][hig-dp], Change log vom 8.6.2026                    | ✔ stimmt                                                                                                                                                    |
| Generierte Seiten enthalten Apples Text                                                                                                                                                                                                                                                                                                                                       | Stichproben in `accessibility.md`, `dark-mode.md`, `icons.md`               | ✔ originalgetreu, bis zu den Zero-Width-Zeichen aus Apples JSON                                                                                             |

Erfundene APIs oder falsche Zahlen haben wir nicht gefunden. Die Schwächen liegen in den
**verdichteten Regeln** von `SKILL.md`, die strenger sind als Apple:

- **Dark Mode.** Linse 2 verlangt „light and dark appearance with no app-specific appearance
  switch“ ([`SKILL.md:207–209`][s207]). Apple erlaubt ausdrücklich eine Ausnahme: „In rare cases,
  consider using only a dark appearance in the interface“ ([HIG Dark Mode][hig-dark]). Die
  Ausnahme steht sogar in der mitgelieferten [`dark-mode.md:22`][dm22], fehlt aber in der Linse.
- **Großschreibung.** Linse 5 macht Apples Title-Style zur Plattformregel
  ([`SKILL.md:272–274`][s270]). [HIG Writing][hig-writing] sagt dagegen: „Adopt capitalization
  rules that align with your app's style, then apply them consistently.“
- **Reduce Transparency.** `code-audit.md` wertet jedes eigene Glas ohne
  `accessibilityReduceTransparency`-Zweig als Befund ([`code-audit.md:77`][ca70]). Laut
  [HIG Materials][hig-mat] passen die Liquid-Glass-Varianten ihr Aussehen bei Reduce Transparency
  und Increase Contrast selbst an. Für System-`glassEffect` ist die Regel daher strenger als Apple
  (eigene Einschätzung). Für selbstgebauten Blur stimmt sie.
- **Die Craft-Linse ist Meinung, kein HIG.** Die „drei Template-Looks“
  ([`SKILL.md:230–235`][s230]) kennzeichnet das Skill selbst als „studio practice“
  ([`SKILL.md:225`][s225]). Ein Review muss sie als Urteil ausweisen, nicht als Apple-Regel.
- **Keine Versionslogik.** Weder `SKILL.md` noch `code-audit.md`, `liquid-glass.md` oder
  `cross-platform.md` erwähnen `#available` oder Deployment-Targets.

## 3. Reife und Sicherheit

- **Projekt.** Ein Maintainer (GitHub `dickwu`, Peilin Wu) mit 23 Commits:
  - 15 vom Autor,
  - 3 Merge-Commits seines Zweitkontos,
  - 3 von „Claude“,
  - 2 aus externen PRs.

  Angelegt wurde das Repo am 27.02.2026. Aktiv entwickelt wird es erst seit 09.09.2026. Der letzte
  Commit vom 28.10.2026 ist ein HIG-Re-Pull ohne Änderungen. Stand heute: 3 074 Sterne, 238 Forks,
  keine offenen Issues oder PRs (7 insgesamt, alle geschlossen). Finanziert wird es nur über
  GitHub Sponsors.

- **Keine Lizenz.** Es gibt kein `LICENSE`, die GitHub-API liefert für die Lizenz 404. Das README
  sagt selbst: „The guideline text belongs to Apple Inc.“ ([`README.md:192–198`][r192]). Rund
  1,4 MB davon in unser **öffentliches** Repo zu kopieren, ist rechtlich ungeklärt.
- **Ausführbarer Code.** Nur `scripts/pull-hig.mjs`, laut Skill „Not needed for reviews“
  ([`SKILL.md:40`][s33]). Wir haben es statisch gelesen, nicht ausgeführt. Es lädt ausschließlich
  `developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json`
  ([`pull-hig.mjs:29`][p29], [`:141`][p141]). Löschen kann es nur Dateien mit generiertem Header
  ([`pull-hig.mjs:712–736`][p712]). Hooks, Settings oder MCP-Konfiguration enthält das Repo nicht.
- **Prompt-Injection.** Gesucht haben wir nach Override-Formulierungen, Shell-Befehlen,
  HTML-Kommentaren und unsichtbaren Zeichen, ohne Befund. Die Links zeigen fast nur auf apple.com.
  Die Zero-Width-Zeichen in [`icons.md:87`][ic87] stammen nachweislich aus Apples JSON.
- **Installationsweg.** `npx skills add` lädt eine fremde CLI aus npm. Ein `git clone` mit festem
  Commit hat weniger Angriffsfläche.
- **Kontextkosten.** `SKILL.md` (28 KB) lädt bei jedem Trigger vollständig. Zusammen mit dem
  Pflichtset (`accessibility`, `layout`, `typography`, `color`, `designing-for-ios`) sind das
  ≈ 120 KB (~30 k Tokens), bevor die erste Komponentenseite gelesen ist
  ([`SKILL.md:47–56`][s47]).
- **Trigger-Breite.** Die Beschreibung greift schon bei „UI code … wants feedback“, „is this good
  UI“ und „audit a codebase or pull request“ ([`SKILL.md:11–13`][s2]). Projektweit installiert,
  würde das Skill auch Reviews der Web-UI an sich ziehen. Die folgt aber eigenen Regeln
  (`.claude/rules/ui-design-system.md`), und das Skill würde mit `impeccable` und
  `frontend-design` konkurrieren.

## 4. Passung zu Shepherd iOS

| Unser Bedarf                                                                                                                  | Deckt das Skill ab?                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SwiftUI-Code schreiben (State, Navigation, Performance)                                                                       | **Nein.** Es reviewt nur, es schreibt keinen Code                                                                                                                 |
| iOS-18-Baseline mit iOS-26-Features hinter `#available` (`native/Package.swift:7`, `native/Apps/ShepherdIOS/project.yml:6–7`) | **Nein.** Keine Versionslogik; die Duo-APIs bräuchten iOS 27.1                                                                                                    |
| Geteilter iOS/macOS-Code (`ShepherdAppCore`)                                                                                  | **Teilweise.** HIG für beide Plattformen, aber nichts zur Code-Teilung                                                                                            |
| Dynamic Type, VoiceOver, Kontrast                                                                                             | **Ja.** Das ist die stärkste Linse                                                                                                                                |
| Dunkle Terminal-Ästhetik                                                                                                      | **Konfliktträchtig**, siehe unten                                                                                                                                 |
| Linux-Agenten ohne Xcode (`native/docs/ios-development.md:528–530`)                                                           | **Ja** für Code- und Screenshot-Reviews, weil es reines Markdown ist. Gerenderte Größen und Kontraste misst es auf Linux nicht, es rechnet sie nur aus Hex-Werten |

### Wo es hilft

Wir haben das Skill nicht als Agent gegen unseren Code laufen lassen. Die Befunde unten entstehen,
wenn man seine Linsen und `code-audit.md` von Hand anwendet.

1. **Increase Contrast und Reduce Transparency fehlen.** Weder in
   `native/Apps/ShepherdIOS/Sources` noch in `native/Sources/ShepherdAppCore` gibt es
   `colorSchemeContrast` oder `accessibilityReduceTransparency`. Die Palette besteht aus festen
   Hex-Werten (`native/Apps/ShepherdIOS/Sources/Sessions/SessionListStyle.swift:4–20`).
   [HIG Color][hig-color] fordert: „Make sure all your app's colors work well in light, dark, and
   increased contrast contexts.“ Genau das fragt Linse 1 ab ([`SKILL.md:174–175`][s165]).
2. **Ein echter Kontrastfehler.** Der Hostname in
   `native/Apps/ShepherdIOS/Sources/Sessions/IOSRemoteSessionDetailView.swift:65` nutzt
   `SessionListStyle.slate` (#566460). Das ergibt **3,0:1** auf `panel` (#0f1413) und 3,15:1 auf
   `background`. Apple verlangt 4,5:1 für Text bis 17 pt. Die Werte sind aus Hex gerechnet, nicht
   am Gerät gemessen. `muted` (5,3:1) und `ink` (11,7:1) bestehen.
3. **Liquid Glass wird bestätigt.** Unsere zwei Glas-Stellen sitzen im schwebenden Chrome über dem
   Inhalt:
   - die Merge-Karte „above the steer capsule“
     (`native/Apps/ShepherdIOS/Sources/Merge/IOSMergeCard.swift:6`, Glas `:244–249`),
   - die ruhende Reply-Kapsel
     (`native/Apps/ShepherdIOS/Sources/Terminal/IOSTerminalReplyBar.swift:191–196`).

   Beide stehen korrekt hinter `#available(iOS 26.0, *)`. Damit sind die Punkte 1 und 2 der
   Checkliste (Layer, Zurückhaltung) erfüllt. Das Skill würde hier eher bestätigen als umbauen.

4. **iPhone-Duo-Vorbereitung.** Ob die Bottom-Bar erscheint, hängt an der Size Class, nicht am
   Gerätetyp (`native/Apps/ShepherdIOS/Sources/Sessions/SessionListControls.swift:12`). Genau das
   verlangt [`code-audit.md:91–92`][ca91]. Die Duo-Tabelle taugt als Checkliste, sobald Duo
   ansteht.

### Wo es mit bewussten Entscheidungen kollidiert

1. **Dark-only.** Die iOS-App setzt `.preferredColorScheme(.dark)` an 26 Stellen in 20 Dateien,
   z. B. `native/Apps/ShepherdIOS/Sources/Sessions/SessionDetailView.swift:323` und
   `native/Apps/ShepherdIOS/Sources/Sessions/SessionListControls.swift:105`. Das ist Absicht: „flat
   dark terminal panels … keeps Shepherd's default dark appearance“
   (`native/docs/ios-development.md:37–39`). Linse 2 meldet das trotzdem als Bruch
   ([`SKILL.md:207`][s207]), obwohl Apples Ausnahme existiert.
2. **Eigene Bottom-Bar.** `native/Apps/ShepherdIOS/Sources/Sessions/SessionListView.swift:419–444`
   ist ein `HStack` im `safeAreaInset(edge: .bottom)` (`:64–66`):
   - mit deckendem `panel`-Hintergrund (`:440`),
   - mit Lens-Navigation neben Aktionen (Repos-Sheet `:422`, „+ New“ `:438`),
   - mit Labels in Versalien (`:425`).

   Das Skill trifft hier gleich mehrere Regeln: „hand-built tab bar … where `TabView` … would do“
   und deckender Hintergrund unter der Leiste ([`code-audit.md:74–75`][ca70]), „Tabs navigate,
   they don't act“ ([`SKILL.md:182`][s177]) sowie die Großschreibung ([`SKILL.md:272`][s270]). Die
   Leiste spiegelt aber bewusst die Web-ActionBar (Parität). Ob `TabView` richtig wäre, ist eine
   Produktfrage, keine HIG-Frage.

3. **„Template-Look“.** Unsere Palette ist fast schwarz (#0a0d0c) mit Amber-Akzent (#e8a13a). Das
   liegt nah an „near-black with one acid-green or vermilion accent“. Die Craft-Linse wertet
   diesen Look als generischen Default mit **High** ([`SKILL.md:230–235`][s230],
   [`:316–317`][s314]). Bei uns ist die Palette im Produkt begründet: Sie ist „DESIGN.md's dark
   terminal palette“ (`native/Apps/ShepherdIOS/Sources/Sessions/SessionListStyle.swift:3`). Der
   Reviewer muss das wissen.

Ohne Briefing zu diesen Punkten verbraucht ein Review viel Text auf Befunde zu Dingen, die wir
absichtlich so entschieden haben.

## 5. Alternativen

**Erstanbieter**

- **HIG und API-Doku direkt.** Apple liefert jede HIG- und Doku-Seite als JSON aus. Denselben
  Endpunkt nutzt das Skill ([`pull-hig.mjs:29`][p29]). Ein Agent kann einzelne Seiten bei Bedarf
  abrufen, ohne 1,4 MB Kopie im Repo.
- **Xcode-MCP (ab Xcode 26.3)** für Agenten auf dem Mac, über `xcrun mcpbridge`
  ([Apple: Giving external agents access to Xcode][xc-agents]). Laut einer Sekundärquelle gehört
  `DocumentationSearch` dazu. Details stehen in
  [`macos-runner-xcode.md` §3.1](macos-runner-xcode.md). Das gibt es nur auf macOS.

**Community, code-orientiert.** Existenz, Lizenz und Aktivität haben wir am 2026-11-10 geprüft,
die Inhalte **nicht** auf Korrektheit.

| Repo                                                                            | Fokus laut eigener `SKILL.md`                                                                                                                                                | Lizenz · Sterne · letzter Push |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [twostraws/SwiftUI-Agent-Skill][tw] („swiftui-pro“, Paul Hudson)                | Reviewt SwiftUI-Code: moderne APIs, Datenfluss, Navigation, HIG-Design, Resizability inkl. iPhone Duo, Dynamic Type, VoiceOver und Reduce Motion, Lokalisierung, Performance | MIT · 6,5 k · 26.10.2026       |
| [AvdLee/SwiftUI-Agent-Skill][avd] („swiftui-expert-skill“, Antoine van der Lee) | Schreibt und reviewt SwiftUI: `@Observable`, Layout, Liquid Glass, API-Migration und Deprecations, iPhone Duo, macOS-Scenes                                                  | MIT · 3,9 k · 06.11.2026       |
| [Dimillian/Skills][dim] (Thomas Ricouard)                                       | Einzelne Skills, u. a. `swiftui-liquid-glass`, `swiftui-ui-patterns`, `swiftui-performance-audit`, `swift-concurrency-expert`                                                | MIT · 4,0 k · 29.03.2026       |
| [twostraws/Swift-Agent-Skills][tw-dir]                                          | Kuratiertes Verzeichnis weiterer Swift-Skills                                                                                                                                | MIT · 3,0 k · 04.09.2026       |

Falls die Frage eigentlich „Hilfe beim Schreiben von SwiftUI“ meint, sind diese Skills näher dran
als das Apple Design Skill.

## 6. Empfehlung

1. **Nicht in `.claude/skills/` des Repos aufnehmen.** Dagegen sprechen die fehlende Lizenz, der
   Apple-Text, der breite Trigger und die Kollision mit der Web-UI.
2. **Optional user-weit und fest gepinnt nutzen**, nicht per `npx`:

   ```bash
   git clone https://github.com/dickwu/apple-design-skill ~/.claude/skills/apple-design
   git -C ~/.claude/skills/apple-design checkout ff4ebddf0488598723a82bfdce1afb04de0b1c44
   ```

   Dann gezielt per `/apple-design` aufrufen: für Accessibility-Audits einzelner iOS-Screens, für
   neue Liquid-Glass-Stellen und später für die iPhone-Duo-Readiness.

3. **Jedem Aufruf ein Briefing mitgeben:**
   - Dark-only ist Absicht ([HIG Dark Mode][hig-dark], „rare cases“).
   - Versal-Labels und die eigene Bottom-Bar halten die Parität zur Web-UI.
   - Die Baseline ist iOS 18. iOS-26- und iOS-27-APIs stehen nur hinter `#available`.
4. **Die zwei echten Befunde sind unabhängig vom Skill ein Issue wert:** Increase-Contrast-Varianten
   der Palette und `slate`-Text unter 4,5:1.
5. **Für Hilfe beim Code** stattdessen `twostraws/SwiftUI-Agent-Skill` oder
   `AvdLee/SwiftUI-Agent-Skill` in einer eigenen Recherche gegen unseren Code prüfen.

## Quellen

**Skill-Repo**, alle Permalinks auf Commit `ff4ebddf0488598723a82bfdce1afb04de0b1c44`:

- `SKILL.md`: [Beschreibung/Trigger][s2], [Rolle][s19], [Referenzen][s33], [Laden][s47],
  [Prinzipien][s107], [Review-Prozess][s123], [Web-Scope][s143], [Linse 1][s165],
  [Linse 2 mobil][s177], [Light/Dark][s207], [Craft-Quelle][s225], [Template-Looks][s230],
  [Großschreibung][s270], [Schweregrade][s314], [Spezialmodi][s331]
- `references/code-audit.md`: [Ablauf][ca17], [Liquid Glass][ca70], [iPhone Duo][ca91]
- `references/hig/liquid-glass.md`: [Regeln][lg26], [APIs][lg100]
- `references/hig/dark-mode.md`: [Ausnahme][dm22] · `references/hig/icons.md`: [Zero-Width][ic87]
- `README.md`: [Installation][r10], [Herkunft/Lizenz][r192]
- `scripts/pull-hig.mjs`: [Endpunkt][p29], [fetch][p141], [Prune][p712]
- GitHub-Metadaten: `gh repo view dickwu/apple-design-skill`, `gh api …/license` (404),
  Issue-/PR-Liste, alles abgerufen am 2026-11-10

**Apple** (Live-JSON abgerufen am 2026-11-10)

- HIG: [Accessibility][hig-a11y] · [Materials][hig-mat] · [Dark Mode][hig-dark] ·
  [Color][hig-color] · [Writing][hig-writing] · [Design principles][hig-dp] ·
  [Designing for iPhone Duo][hig-duo]
- API: [`glassEffect(_:in:)`][api-glass] · [`GlassEffectContainer`][api-gec] ·
  [`glassProminent`][api-gp] · [`UIGlassEffect`][api-uige] ·
  [`UIGlassContainerEffect`][api-uigce] · [`prominentGlass()`][api-pg] ·
  [`NSGlassEffectView`][api-nsge] · [`NSGlassEffectContainerView`][api-nsgec] ·
  [`UIDesignRequiresCompatibility`][api-compat] · [`ArrangementView`][api-arr] ·
  [`ReservedRegion`][api-rr] · [`UIArrangementViewController`][api-uiarr] ·
  [`ToolbarOverflowMenu`][api-tom] · [Device Hub][api-dh] ·
  [Preparing your app for iPhone Duo][api-duo] · [External agents in Xcode][xc-agents]

**Community-Alternativen:** [twostraws/SwiftUI-Agent-Skill][tw] · [AvdLee/SwiftUI-Agent-Skill][avd] ·
[Dimillian/Skills][dim] · [twostraws/Swift-Agent-Skills][tw-dir]

**Code-Belege in diesem Repo**

`native/Package.swift:7` · `native/Apps/ShepherdIOS/project.yml:6–7` ·
`native/Apps/ShepherdIOS/Sources/Merge/IOSMergeCard.swift:6`, `:244–249` ·
`native/Apps/ShepherdIOS/Sources/Terminal/IOSTerminalReplyBar.swift:191–196` ·
`native/Apps/ShepherdIOS/Sources/Sessions/SessionListView.swift:64–66`, `:419–444` ·
`native/Apps/ShepherdIOS/Sources/Sessions/SessionListControls.swift:12`, `:105` ·
`native/Apps/ShepherdIOS/Sources/Sessions/SessionDetailView.swift:323` ·
`native/Apps/ShepherdIOS/Sources/Sessions/SessionListStyle.swift:3–20` ·
`native/Apps/ShepherdIOS/Sources/Sessions/IOSRemoteSessionDetailView.swift:65` ·
`native/docs/ios-development.md:37–39`, `:528–530` · `docs/research/macos-runner-xcode.md` §3.1

[c-head]: https://github.com/dickwu/apple-design-skill/tree/ff4ebddf0488598723a82bfdce1afb04de0b1c44
[s2]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L2-L14
[s19]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L19-L22
[s33]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L33-L40
[s47]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L47-L56
[s107]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L107-L121
[s123]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L123-L329
[s143]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L143-L144
[s165]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L161-L175
[s177]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L177-L193
[s207]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L207-L209
[s225]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L225
[s230]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L230-L235
[s270]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L270-L274
[s314]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L312-L325
[s331]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/SKILL.md#L331-L408
[ca17]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/references/code-audit.md#L10-L20
[ca70]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/references/code-audit.md#L63-L81
[ca91]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/references/code-audit.md#L83-L104
[lg26]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/references/hig/liquid-glass.md#L24-L41
[lg100]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/references/hig/liquid-glass.md#L97-L104
[dm22]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/references/hig/dark-mode.md#L22
[ic87]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/references/hig/icons.md#L87
[r10]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/README.md#L10-L76
[r192]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/README.md#L192-L198
[p29]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/scripts/pull-hig.mjs#L29
[p141]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/scripts/pull-hig.mjs#L131-L149
[p712]: https://github.com/dickwu/apple-design-skill/blob/ff4ebddf0488598723a82bfdce1afb04de0b1c44/scripts/pull-hig.mjs#L712-L736
[hig-a11y]: https://developer.apple.com/design/human-interface-guidelines/accessibility
[hig-mat]: https://developer.apple.com/design/human-interface-guidelines/materials
[hig-dark]: https://developer.apple.com/design/human-interface-guidelines/dark-mode
[hig-color]: https://developer.apple.com/design/human-interface-guidelines/color
[hig-writing]: https://developer.apple.com/design/human-interface-guidelines/writing
[hig-dp]: https://developer.apple.com/design/human-interface-guidelines/design-principles
[hig-duo]: https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo
[api-glass]: https://developer.apple.com/documentation/swiftui/view/glasseffect(_:in:)
[api-gec]: https://developer.apple.com/documentation/swiftui/glasseffectcontainer
[api-gp]: https://developer.apple.com/documentation/swiftui/primitivebuttonstyle/glassprominent
[api-uige]: https://developer.apple.com/documentation/uikit/uiglasseffect
[api-uigce]: https://developer.apple.com/documentation/uikit/uiglasscontainereffect
[api-pg]: https://developer.apple.com/documentation/uikit/uibutton/configuration-swift.struct/prominentglass()
[api-nsge]: https://developer.apple.com/documentation/appkit/nsglasseffectview
[api-nsgec]: https://developer.apple.com/documentation/appkit/nsglasseffectcontainerview
[api-compat]: https://developer.apple.com/documentation/bundleresources/information-property-list/uidesignrequirescompatibility
[api-arr]: https://developer.apple.com/documentation/swiftui/arrangementview
[api-rr]: https://developer.apple.com/documentation/swiftui/reservedregion
[api-uiarr]: https://developer.apple.com/documentation/uikit/uiarrangementviewcontroller
[api-tom]: https://developer.apple.com/documentation/swiftui/toolbaroverflowmenu
[api-dh]: https://developer.apple.com/documentation/xcode/device-hub
[api-duo]: https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo
[xc-agents]: https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode
[tw]: https://github.com/twostraws/SwiftUI-Agent-Skill
[avd]: https://github.com/AvdLee/SwiftUI-Agent-Skill
[dim]: https://github.com/Dimillian/Skills
[tw-dir]: https://github.com/twostraws/Swift-Agent-Skills
