# Handoff: Mobile-Listenansicht — Daumenzone und Touch-Konformität

Betrifft den Telefon-Listen-Screen (`ui/src/routes/+page.svelte`, `mobileScreen === "list"`).
Referenzgerät ist das Gerät aus dem Auslöser-Screenshot: iPhone 15/14 Pro Max, 1290×2796 px =
**430×932 CSS-px**, `env(safe-area-inset-top)` 59 px, PWA im Standalone-Modus.

Die Artboards daneben (`*.dc.html` + `canvas.json`) sind die Entwurfsvorlage, kein Code. Sie sind
aus `DESIGN.md` und `ui/src/app.css` gebaut, nicht aus dem Screenshot nachgezeichnet.

## Der Befund

Zwei Beschwerden — „oben wird Platz verschwendet" und „die Chips sind nicht für Touch gemacht" —
haben **dieselbe Wurzel**: die 44-px-Touch-Untergrenze wurde dort, wo sie umgesetzt war, durch
_höhere Boxen_ erfüllt statt durch Inhalt, der die Höhe rechtfertigt (ein Repo-Chip war 44 px hoch
und trug ein 10-px-Label), und dort, wo sie Platz gekostet hätte, gar nicht.

### Vertikales Budget, vorher

| Zone                       | Quelle                                   |       Höhe |
| -------------------------- | ---------------------------------------- | ---------: |
| Safe Area                  | `.shell.mobile.list .chrome`             |      59 px |
| TopBar                     | `TopBar` → `.hud.mobile` (10 + 44 + 10)  |      64 px |
| Lücke                      | `.shell.mobile { gap: 10px }`            |      10 px |
| Repo-Rail                  | `RepoSwitcher` → `.rs-chip` (2 + 44 + 2) |      48 px |
| Lücke                      | `.shell.mobile { gap: 10px }`            |      10 px |
| Lens-Tabs                  | `herd/HerdSegRow` → `.seg-btn`           |      46 px |
| **Chrome oben**            |                                          | **237 px** |
| ActionBar + Home-Indikator | `--mobile-actionbar-h` + Safe Area       |      90 px |
| **Liste**                  | ~5,1 Karten à ~119 px                    | **605 px** |

Dazu: `HerdSegRow` lag _innerhalb_ des Herd-Panels. Beim Scrollen fuhr das Chrome per
`chromeHidden` aus **und** die Tabs scrollten weg — danach war weder sichtbar, in welchem Lens man
war, noch wie man ihn wechselt.

### Touch-Konformität, vorher

Maßstäbe: **iOS HIG 44×44** (verbindlich — die App läuft als iPhone-PWA), **Material 48×48**
(Zielwert), **WCAG 2.5.8 AA 24×24** (harte Untergrenze).

| Element                             | Ist (touch)     | HIG  | WCAG     |
| ----------------------------------- | --------------- | ---- | -------- |
| `TopBarTallies` → `.ctally`         | 44 × **24**     | nein | knapp    |
| `PrBadge`                           | **~15** × 40–70 | nein | **nein** |
| `PlanGateBadge`                     | **~15** × 40–70 | nein | **nein** |
| `CriticBadge`                       | **~15** × 40–70 | nein | **nein** |
| `BuildQueueBadge`                   | **~15** × 40–70 | nein | **nein** |
| `UnitRowRight` → `.preview-badge`   | **~15** × 60    | nein | **nein** |
| `UnitRow` → `.name-icon.actionable` | **~18 × 19**    | nein | **nein** |
| `UnitRow` → `.hold-cta`             | **~17** × 102   | nein | knapp    |

Die letzte Zeile stand nicht im ursprünglichen Audit — sie fiel erst dem Sweep in
`ui/src/lib/components/touch-targets.browser.test.ts` auf. Das ist der Grund, warum dieser Test
generisch misst, was rendert, statt einer gepflegten Selektorliste zu folgen.

## Was gebaut wurde

### Stufe 1 — Touch-Konformität (richtungsunabhängig)

- **D4** — Auf coarse pointer sind `PrBadge`, `PlanGateBadge`, `CriticBadge`, `BuildQueueBadge`
  und `.preview-badge` **reine Anzeigen** (neue Prop `interactive`, Default `true`). Fünf
  44-px-Ziele im Kartenstapel hätten die Karte über 200 px getrieben. Jede Aktion bleibt
  erreichbar: der Karten-Tap öffnet den Detail-Screen, wo `GitRail`, `PlanGateBadge`,
  `BuildQueuePanel` und der Preview-Tab dieselben Bedienelemente in konformer Größe tragen.
- **D5** — `.name-icon.actionable` (18 × 19 px) verliert auf coarse pointer seine Tap-Rolle. Der
  Repo-Filter bleibt über das REPOS-Sheet erreichbar, dort mit 48-px-Zeilen.
- **D6** — `.ctally` wird ab 360 px Viewport 44 × 44. Unterhalb bleibt der im Code dokumentierte
  24-px-Kompromiss: vier 44-px-Ziele sprengen dort das Zeilenbudget wirklich, und 24 px erfüllt
  weiter WCAG 2.5.8. Die Ausnahme steht namentlich im Test und wird bei 320 px _gemessen_.
- **Zusatzfund** — `.hold-cta` (Go / Re-Review / Resume / Answer) bekommt auf coarse pointer echte
  44 px. Es ist die primäre Operator-Aktion auf einer Karte, die per Definition auf den Operator
  wartet; ein Knopf pro Karte, nur auf Karten mit Hold — die Höhe ist hier bezahlbar, wie sie es
  bei fünf gestapelten Badges nicht war.

### Stufe 2 — Daumenzone

- **D10** — Die Lens-Segmente ziehen in die untere Leiste (`ActionBar`, neue Props `lens`,
  `filter`, `statusFilter`, `onstatusfilter`). Die Leiste hat jetzt zwei Ränge; die Geometrie
  steht als `--mobile-actionbar-h` in `app.css` und wird von der Liste als `padding-bottom`
  reserviert, damit beide nicht auseinanderlaufen.
- **D11** — Der Lens „Fertig" verliert sein Segment; sein Einstieg liegt im Zahnrad-Menü
  (`TopBarGear`, Prop `ondonelens`). Erst dadurch passen vier Segmente, REPOS und „Neue Aufgabe"
  in eine Leiste. Der Done-Flow selbst ist unverändert.
- **D12** — `REPOS` bleibt ein sichtbarer Dauer-Button.
- **D14** — Der Repo-Filter zieht aus der TopBar in `ReposSheet`, das REPOS öffnet: Repo-Liste mit
  Zählern plus der Backlog-Einstieg. Die Repo-Rail ist auf dem Telefon nicht mehr im Chrome.
- **D15** — Das Falten der vier Tallies zu einem Knopf entfällt: ohne den Repo-Chip ist die TopBar
  nur noch zu ~78 % belegt (320 von 410 px), das Problem gibt es nicht mehr.
- Die 2 × 10 px Chrome-Luft aus `.shell.mobile { gap: 10px }` entfallen auf dem Listen-Screen.
  `DESIGN.md` (Elevation) trennt Flächen durch Haarlinien, nicht durch Abstände.
- TopBar-Padding auf dem Telefon 10 px → 5 px vertikal. Jedes Bedienelement der Zeile trägt seinen
  44-px-Boden selbst; das Padding kaufte Luft, keine Erreichbarkeit.
- Karten-Diät: Prompt einzeilig in `.units.flow`, 9 px statt 11 px Padding, Uhr auf der
  Micro-Stufe, Badge-Stapel auf zwei gedeckelt. Gedeckelt wird per `:nth-last-child`, nicht
  `:nth-child`: der Stapel ist von unspezifisch nach spezifisch sortiert (Agent, Research,
  Terminal, Issue, dann PR, Critic, Queue, Plan-Gate, Status), die ersten zwei zu behalten hätte
  also genau die Badges behalten, die am wenigsten sagen. Die Überlaufmarke „…" ist absolut
  positioniert — eine dritte Flexzeile hätte die gewonnene Höhe sofort zurückgegeben.

## Entschiedene Abweichungen von der Entwurfsvorlage

| #   | Entwurf sagt                      | Gebaut wurde                                    | Warum                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **7,0 Karten** sichtbar           | **~6,7**                                        | Die 7,0 waren aus einer geschätzten 97-px-Karte gerechnet und ließen den 2-px-Abstand zwischen Karten ganz weg. Gemessen: 99,5 px Karte, ~101,5 px Raster, ~681 px Liste. Die letzten 4 px hätte nur Padding-Kürzen gebracht — das kauft die runde Zahl und bezahlt sie mit der Ergonomie. Gemessen steht im Test. |
| 2   | Badge-Überlauf als „**+1**"       | „**…**"                                         | Die genaue Zahl bräuchte JS-Zählung über fünf Komponenten mit je eigener Render-Bedingung. `:has(> :nth-child(3))::after` setzt das Zeichen rein per CSS und nur, wenn ein drittes Badge wirklich rendert — dieselbe Aussage, ohne Zählwerk.                                                                       |
| 3   | Uhr im Fußzeilen-Rang der Karte   | Uhr bleibt in der Badge-Spalte, auf Micro-Stufe | Ein Umzug hätte `flow` durch `Herd` → `HerdGroup` → `UnitRow` gefädelt, nur für eine Position. Die Micro-Stufe erreicht dasselbe Ziel (die Spalte misst 59 px statt 65,5 px und setzt nicht mehr die Kartenhöhe) mit einer Zeile CSS.                                                                              |
| 4   | Karten-Tap-Ziel `.desig-btn` 44px | bleibt inline, ~64 × 17 px                      | WCAG 2.5.8 „Inline"-Ausnahme wörtlich: das Ziel steht in einem Satz und ist von dessen Zeilenhöhe begrenzt. Sein Menü (Task-ID kopieren, Prompt-Empfehlung) existiert sonst nirgends — ein Umzug würde entfernen statt verlegen. Wachsen hieße ~28 px auf **jeder** Karte. Die Ausnahme steht namentlich im Test.  |

## Nachweis

`ui/src/lib/components/touch-targets.browser.test.ts` läuft im Vitest-Projekt **`browser-touch`**
(`ui/vite.config.ts`), dem einzigen mit `hasTouch: true` — ohne das greift `(pointer: coarse)` nie
und jede hier geprüfte Regel wäre stillschweigend abwesend.

Der Sweep misst **generisch**, was rendert, statt einer gepflegten Selektorliste zu folgen; ein neu
hinzugefügtes Bedienelement kann also nicht daran vorbei. **Jede Ausnahme muss im Test namentlich
mit Begründung stehen** — dadurch ist die Ausnahmeliste selbst der Prüfpfad.

Die Kartenhöhe hält `mobile-list-overflow.browser.test.ts`; die Geometrie der unteren Leiste hält
`Toasts.browser.test.ts` (Toast-Abstand = `--mobile-actionbar-h` + Safe Area).

## Offen

- Die Entwurfsvorlage zeigt Richtung **B3** (Repo-Rail bleibt sichtbar, Tallies zu einem Knopf
  gefaltet) als Gegenentwurf für den Fall, dass die Repos dauerhaft sichtbar sein sollen statt
  hinter einem Tap. Nicht gebaut, bewusst aufgehoben: `B3RepoRail.dc.html` (die verworfenen Zwischenstände B1, B2 und A liegen nur auf der veröffentlichten Canvas).
- Ob das REPOS-Sheet Mehrfachauswahl können soll (am Desktop heute Shift-Klick) ist eine eigene
  Frage, keine Layout-Frage.

## Fallstricke für die nächste Änderung hier

- **Die Badges gehören Kind-Komponenten.** Ein Svelte-gescopter Selektor wie
  `.u-badges > :nth-last-child(n + 3)` wird auf die Scope-Klasse von `UnitRowRight` umgeschrieben
  und trifft nichts — die Badges tragen die Klassen ihrer eigenen Komponenten. Der Deckel steht
  deshalb komplett in `:global(...)`. Kostet einmal eine Stunde Suche, wenn man es nicht weiß.
- **Die z-index-Regel, die Badges über `.unit-hit` hebt, ist ein Nachfahren-Selektor.** Sobald
  jemand die Badges wieder in einen Container packt, würde ein `>` sie unter die Karten-Overlay
  legen und ihre Klicks verschlucken.
- **`--mobile-actionbar-h` ist die einzige Quelle der Leistengeometrie.** Die Liste reserviert sie
  als `padding-bottom`, `Toasts` setzt seinen Abstand daraus. Wer die Leiste ändert, ändert dort.
