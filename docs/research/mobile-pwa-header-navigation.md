# Mobile PWA-Header auf dem iPhone 14 — wie wir die obere Navigation entzerren

**Auftrag:** Recherche, wie sich die obere Menü-/Filter-Zone der Shepherd-PWA in der
mobilen Ansicht (Referenz: iPhone 14, 6.1", 390 CSS-px breit) besser gestalten lässt.
Heute wird sie „dreiteilig" und zu hoch; sie soll touch-sicher bedienbar bleiben und
auch für Augen jenseits der 50 noch erkennbar sein. Vorbilder: Apple, Google/Material,
Things, Todoist, Linear.

**Diese Datei ist eine Recherche-/Referenz-Notiz — kein Code.** Sie ordnet den
Ist-Zustand ein, fasst die belegbaren Design-Regeln zusammen und leitet einen konkreten,
priorisierten Umbauvorschlag ab. Umsetzung wäre ein eigener Folge-PR.

---

## TL;DR — Empfehlung in einem Absatz

Der mobile Kopf stapelt heute **drei bis vier** voll sichtbare Bänder übereinander
(Logo+Zähler → Control-Leiste → Repo-Chips → „THE HERD"-Filter). Das ist zu viel
permanent sichtbare Chrome. Die etablierten Apps lösen das gleiche Problem mit **einem
einzigen Prinzip: so wenig wie möglich _immer_ sichtbar, der Rest hinter genau einer
Geste/Tap.** Konkret für Shepherd:

1. **Primär-Aktion nach unten** — „+ NEUE AUFGABE" sitzt schon unten (gut, Daumenzone);
   das bleibt der Anker.
2. **Status-Filter (ALLE/BEREIT/RECHERCHE/FERTIG/RUNDOWN) als _ein_ Segmented Control**
   statt einer Reihe winziger Text-Tabs — Apple erlaubt ≤5 Segmente auf dem iPhone, wir
   haben genau 5. Das ersetzt das „THE HERD"-Band durch eine einzelne, daumenbreite Zeile.
3. **Sekundär-Chrome (Usage-Gauges, Health, What's-New, Update-Badges, Theme) in ein
   Bottom-Sheet** hinter das Zahnrad verschieben — heute liegt das alles offen in der
   Control-Leiste. Sichtbar bleiben nur: Verbindungs-Dot, „NEEDS YOU" (wenn >0) und das
   Zahnrad.
4. **Repo-Chips als horizontaler Scroller _behalten_, aber mit Pflicht-„Peek"** (rechter
   Chip angeschnitten) und 44px-Höhe — das ist der einzige Teil, der legitim scrollen darf.
5. **Zähler (13 ● 1 · 6 ⚡0) zu einer kompakten, tappbaren Zeile** verdichten, die als
   Filter-Shortcut dient (tippt man „⚡0", filtert man auf Blocked) — das ist heute schon
   teilweise so verdrahtet.

Netto: aus drei/vier Bändern werden **zwei** (kompakter Top-Bar + ein Segment-Filter),
plus optionaler Repo-Scroller. Alles ≥44px, alle Icons behalten Labels.

---

## 1. Ist-Zustand (Code-verankert)

Die mobile Kopfzone wird aus drei Komponenten zusammengesetzt
(`ui/src/routes/+page.svelte`, Mobile-Branch ab der `MediaQuery("max-width: 768px")`,
`+page.svelte:590`):

| Band | Komponente                                     | Was drinsteht                                                                                                                                                                     | Problem mobil                                                                                                                                           |
| ---- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `TopBar.svelte` (`hud.mobile`, ab `:1688`)     | SHEPHERD-Wortmarke, Zähler-Tallies (`.tallies.compact`, `:1712`), rechts: RUNDOWN, NEEDS-YOU, Usage-Gauges, Connection-Dot, Update-/Herdr-/What's-New-Badges, Health-Pip, Zahnrad | Flex-wrap zwingt die rechte Control-Gruppe **auf eine zweite Zeile** (`:1758`) → der „Kopf" ist faktisch schon zweizeilig, bevor irgendein Filter kommt |
| 2    | `RepoSwitcher.svelte` (`.rs-scroller`, `:305`) | Horizontal scrollende Repo-Chips mit Edge-Fades; darunter optionale Detail-Zeile des aktiven Repos (`:409`)                                                                       | An sich okay (scrollt), aber addiert ein weiteres volles Band + eine Detail-Subzeile                                                                    |
| 3    | `Herd.svelte` (`.phead`, `:257`)               | „THE HERD" + 5 Text-Filter (`.fbtn`, `:799`): ALLE / BEREIT / RECHERCHE / FERTIG / RUNDOWN, dazu ggf. ein aktiver Status-Chip                                                     | `.fbtn` hat **keine** Touch-Höhe gesetzt (nur `padding: 2px 5px`) → unter dem 44px-Minimum; bei aktivem Status-Chip wrappt die Zeile                    |

Dazu die Screenshot-Beobachtung: zwischen Band 1 und 2 liegt noch eine **eigene
Toggle-/Switch-Reihe** (Theme-Punkt, Hamburger, Kontrast-Slider, Akzent-Dot, Zahnrad) —
das ist die zweite gewrappte Zeile der `TopBar`-Controls. Effektiv sieht der Nutzer
**vier** horizontale Streifen, bevor die erste Karte kommt. Genau das meint „es wird
dreiteilig / zu groß".

Positiv schon vorhanden und behaltenswert:

- Die `+ NEUE AUFGABE`-Leiste sitzt **unten** (Daumenzone) — richtig platziert.
- Touch-Floors sind teilweise da: `.ctally`, `.gear`, `.needsyou`, Repo-Chips erzwingen
  `min-height: 44px` (`TopBar.svelte:1735`, `RepoSwitcher.svelte` coarse-Block `:549`).
- Es gibt bereits ein Scrim-Primitive mit Blur (`app.css` `.scrim`/`.overlay`) und
  Drawer-Muster (`TriageDrawer`, `LearningsDrawer`, `BacklogOverlay`) zum Wiederverwenden.

Die Lücken sind also nicht „kein Touch-Bewusstsein", sondern: **zu viel gleichzeitig
sichtbar** und **die Herd-Filter-Tabs sind unter Touch-Größe**.

---

## 2. Die belegbaren Regeln (worauf wir uns berufen)

### Touch-Ziele

- **Apple HIG: 44×44 pt Minimum** für jedes tappbare Element. Das _sichtbare_ Element darf
  kleiner sein, solange die _Trefferfläche_ (per Padding) 44pt erreicht.
  ([Apple HIG – Layout](https://developer.apple.com/design/human-interface-guidelines/layout))
- **Material 3: 48×48 dp Minimum**, ≥8dp Abstand zwischen Zielen.
  ([Android A11y](https://support.google.com/accessibility/android/answer/7101858))
- **WCAG 2.2 SC 2.5.8 (AA): 24×24 CSS-px** Minimum (oder 24px Abstand als Alternative);
  **SC 2.5.5 (AAA): 44×44 CSS-px** — deckt sich 1:1 mit Apple.
  Auf dem iPhone 14 (DPR 3, Default-Viewport) gilt **1 CSS-px = 1 pt**, d.h. unsere
  `min-height: 44px` trifft Apples Regel exakt.
  ([WCAG 2.5.8 Guide](https://www.allaccessible.org/blog/wcag-258-target-size-minimum-implementation-guide))
- **Praxis-Floor für uns: 44px** (nicht die 24px-AA-Untergrenze) — bei der Zielgruppe
  40–60+ sind 24px-Ziele fehleranfällig.

### Anzahl & Muster

- **Tab-Bar / Bottom-Nav: 3–5 Ziele** — Apple _und_ Material sagen identisch 3–5; ab 6
  → „More"-Overflow bzw. Drawer (= Architektur-Warnsignal).
  ([Apple Tab Bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars),
  [M3 Navigation Bar](https://m3.material.io/components/navigation-bar/guidelines))
- **Segmented Control: ≤5 Segmente auf dem iPhone**, gleich breit, _entweder_ Text _oder_
  Icon (nicht mischen), für sich gegenseitig ausschließende Sichten desselben Inhalts —
  exakt unser Status-Filter-Fall.
  ([Apple Segmented Controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls))
- **Filter-Chips ≠ Segmented Control:** Chips sind Mehrfachauswahl/Radio-artig, scrollbar,
  für viele Optionen; Segmented Control ist der Einfach-Auswahl-View-Switch. Repo-Auswahl =
  Chips (viele, scrollbar), Status = Segmented (genau 5, exklusiv).
  ([Mobbin Glossary](https://mobbin.com/glossary/segmented-control))

### Lesbarkeit für ältere Augen

- **Body-Text ≥ 16px**, realistisch **17–18px** ab Presbyopie (40+). iOS-Default Body =
  17pt; absolutes Minimum jedes Texts = 11pt.
  ([Learn UI – iOS Font Sizes](https://www.learnui.design/blog/ios-font-size-guidelines.html))
- **Eingabefelder: Schrift ≥16px Pflicht** auf iOS-Safari, sonst Auto-Zoom beim Fokus.
- **Kontrast WCAG AA: 4.5:1** (normal), **3:1** (groß ≥18pt); **AAA 7:1**. Die 4.5:1-Schwelle
  ist explizit für die Kontrast-Sensitivität alternder Augen gewählt — bei dichter UI mit
  kleiner Schrift **7:1 als verantwortliches Ziel** für Body/Primär-Labels.
  ([W3C SC 1.4.3](https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-contrast.html))
- **Icons brauchen Labels.** NN/g: außer Home/Suche/Print ist fast kein Icon eindeutig;
  Labels müssen _permanent sichtbar_ sein, nicht im Hover/Tooltip. Apple- und Material-
  Tab-Bars zeigen Icon **+** Text. → Unsere Filter behalten ihre Wörter.
  ([NN/g Icon Usability](https://www.nngroup.com/articles/icon-usability/))

### Reichweite (Daumenzone) auf 6.1"

- Auf >6"-Phones deckt der Daumen einhändig nur noch ~50–60% des Schirms; ~75% der
  Touches macht der Daumen. **Primär-Navigation und Haupt-Aktion gehören nach unten**,
  die obere Ecke ist „rote Zone".
  ([LukeW – Large Screens](https://www.lukew.com/ff/entry.asp?1927=),
  [Parachute – Thumb Zone](https://parachutedesign.ca/blog/thumb-zone-ux/))
- NN/g-Studie: versteckte Hamburger werden übersehen (Navigationsnutzung 44% vs. 89% bei
  sichtbarer Nav). → **Nicht** alles in einen Hamburger verstecken; nur _sekundäre_
  Steuerung hinter Progressive Disclosure.
  ([NN/g Hamburger Study](https://www.nngroup.com/articles/find-navigation-mobile-even-hamburger/))

---

## 3. Wie die Vorbilder es machen

**Things 3 (iPhone).** Kein Tab-Bar, kein Filter-Band. Großer Listentitel oben, Inhalt
sofort darunter. **Magic-Plus-Button unten rechts**, ziehbar zum Einsortieren. Navigation
zwischen Listen per Drill-down + „Quick Find" (Pull-down-Suche, die Navigation _und_ Suche
vereint). Lehre: **maximale Inhalts-Fläche, Chrome auf das Nötigste, Power-Navigation hinter
einer Geste.** ([Cultured Code](https://culturedcode.com/things/support/articles/2803584/))

**Todoist (iPhone).** Persistente **Bottom-Tab-Bar (bis 5 Tabs, konfigurierbar)**:
Inbox/Today/Upcoming/…/Browse. „Browse" = der Overflow-Drawer für alles Nicht-Angepinnte.
Oben großer Titel + **„Display"-Button rechts**, der Gruppieren/Sortieren/Filtern in ein
Sheet öffnet (Progressive Disclosure). **Schwebender oranger „+"** über der Tab-Bar.
Lehre: **Sortier-/Filter-Optionen gehören in ein Sheet hinter einen Button, nicht offen ins
Band.** ([Todoist Nav](https://www.todoist.com/help/articles/customize-the-todoist-navigation-bar-L4qpkI0xj),
[Pratt Critique](https://ixd.prattsi.org/2024/01/design-critique-todoist-ios-app/))

**Linear (iPhone).** Eigene **5-Tab-Bottom-Bar** (Home/Inbox/Create/Search/Settings),
„Create" als zentraler Tab. Komplexes Filtern ist auf Mobile bewusst **reduziert** —
„away from keyboard"-Nutzung. Sub-Sichten nutzen eine kleine horizontale Tab-Reihe oben
(Pulse: For Me/Popular/Recent). Lehre: **Mobil nicht die Desktop-Filtertiefe nachbauen;
weniger ist hier Feature.** ([Linear Mobile](https://linear.app/changelog/2024-09-19-introducing-linear-mobile))

**Apple iOS 18/26 & Material 3 (2025).** Trend zu **schwebenden, scroll-komprimierenden**
Bars: iOS-26-Tab-Bar minimiert sich beim Runterscrollen auf das aktive Icon und kehrt in
Ruhe zurück (`.tabBarMinimizeBehavior(.onScrollDown)`). Native „Liquid Glass" können wir im
PWA nicht nutzen, aber **das Muster „beim Scrollen Chrome einklappen, in Ruhe zeigen" ist
in CSS gut nachbaubar** und wäre der eleganteste Weg, Höhe zurückzugewinnen.
([Donny Wals – iOS 26 Tab Bar](https://www.donnywals.com/exploring-tab-bars-on-ios-26-with-liquid-glass/))

**Scroll-Chips — Fallstricke (gilt für unseren RepoSwitcher).** Pflicht: der rechte Chip
muss **angeschnitten** sein (Peek) — der einzige zuverlässige Hinweis „hier geht's weiter".
Edge-Fade allein reicht nicht. Nie _navigationskritische_ Ziele in den Scroll verstecken;
aktiver Zustand muss klar abheben; „Clear all" ohne Scrollen erreichbar. A11y: horizontale
Scrollregionen sind für Voice-Control schwierig → ARIA-Rollen/Labels + sichtbare Fokusse.
([Horizontal Lists Best Practices](https://blog.iamsuleiman.com/horizontal-scrolling-lists-mobile-best-practices/),
[A11y horiz. scroll](https://cerovac.com/a11y/2024/02/consider-accessibility-when-using-horizontally-scrollable-regions-in-webpages-and-apps/))

---

## 4. Konkreter Umbauvorschlag für Shepherd (priorisiert)

Reihenfolge = Aufwand-/Wirkungs-Verhältnis, jede Stufe ist eigenständig lieferbar.

### Stufe 1 — Status-Filter als Segmented Control (höchste Wirkung, klein)

Das „THE HERD"-Band (`Herd.svelte:257`) ist der billigste große Gewinn.

- Die 5 `.fbtn` (ALLE/BEREIT/RECHERCHE/FERTIG/RUNDOWN) auf Mobile als **ein** gleich-breites
  Segmented Control rendern (genau Apples ≤5-Regel). Eine Zeile, voll daumenbreit,
  `min-height: 44px` je Segment — heute fehlt die Touch-Höhe ganz.
- „THE HERD"-Label auf Mobile weglassen (der Segment-Filter _ist_ selbsterklärend) → spart
  eine halbe Zeile.
- Der separate aktive Status-Chip entfällt — der aktive Zustand _ist_ das gewählte Segment.
- Icons über den Labels nur, wenn die Höhe es hergibt; sonst Label-only (Labels bleiben,
  s. NN/g). Token-konform: `--color-amber` = aktiv, `--color-faint` = inaktiv.

### Stufe 2 — Sekundär-Chrome ins Zahnrad-Sheet (mittel)

Die rechte `TopBar`-Control-Gruppe (`:1758`) ist die zweite gewrappte Zeile, die den Kopf
aufbläht. Sichtbar bleiben mobil nur drei Dinge:

- **Connection-Dot**, **NEEDS-YOU-Badge** (nur wenn >0), **Zahnrad**.
- Alles andere — Usage-Gauges, Health-Pip, Update-/Herdr-/What's-New-Badges, Theme-/
  Kontrast-/Akzent-Toggles — wandert in ein **Bottom-Sheet** hinter das Zahnrad
  (wiederverwendbar: `.scrim`/`.overlay`-Primitive + Drawer-Muster wie `TriageDrawer`).
  Das Zahnrad-Menü hält heute schon Theme-Controls (`TopBar.svelte:872`) — also Erweiterung,
  keine Neuerfindung.
- Ergebnis: Band 1 wird wieder **einzeilig** (Logo + Zähler links, drei Controls rechts).

### Stufe 3 — Repo-Chips schärfen (klein)

`RepoSwitcher` bleibt als Scroller (richtig für „viele, exklusiv-ein" Repos), aber:

- **Peek erzwingen**: Track so kappen, dass bei Überlauf der rechte Chip sichtbar
  angeschnitten ist (nicht nur Fade). 44px-Höhe ist im coarse-Block schon da.
- Die optionale Repo-Detail-Subzeile (`:409`) mobil **in den ausgewählten Zustand
  einklappen** statt als Dauer-Subzeile — spart das vierte Band.

### Stufe 4 — Zähler als Filter-Shortcuts verdichten (klein, teils vorhanden)

Die `.ctally`-Buttons (`:1720`) sind schon tappbar und filtern. Mobil als eine kompakte,
tabellarische Zeile (`tabular-nums` ist gesetzt) belassen — sie ersetzt einen Teil des
Status-Filters für „schnell auf Blocked springen". Sicherstellen, dass aktiver Tally und
aktives Segment **denselben** Filterzustand spiegeln (eine Quelle der Wahrheit).

### Stufe 5 (optional, ambitioniert) — Scroll-Kompression

Den iOS-26-Trick adaptieren: beim **Runterscrollen** Top-Bar + Repo-Scroller wegklappen,
beim **Hochscrollen/Ruhe** zurückholen (CSS `transform`/`translateY` an einen
Scroll-Listener, `prefers-reduced-motion` respektieren). Gibt im Lesefluss die volle Höhe
frei, ohne dauerhaft etwas zu verstecken. Nur angehen, wenn Stufen 1–3 das Problem nicht
schon ausreichend lösen.

### Bewusst _nicht_ empfohlen

- **Kein Voll-Hamburger für die Primär-Navigation** (NN/g: Entdeckbarkeit bricht ein). Das
  Sheet ist nur für _Sekundär_-Chrome.
- **Keine Bottom-Tab-Bar à la Todoist/Linear** — Shepherd hat keine 3–5 gleichrangigen
  Top-Level-Sektionen; die eine Liste mit Status-Filter ist die App. Ein Segmented Control
  ist das richtige Muster, nicht eine Tab-Bar.
- **Repo-Chips nicht in ein Sheet verbannen** — Repo-Wechsel ist häufig genug, um sichtbar
  zu bleiben; nur schärfen, nicht verstecken.

---

## 5. Akzeptanzkriterien für den Umsetzungs-PR

- Mobiler Kopf belegt in Ruhe **max. zwei** horizontale Bänder (kompakte Top-Bar +
  Segment-Filter), Repo-Scroller optional als drittes nur bei >1 Repo.
- Jedes tappbare Element ≥ **44×44 px** Trefferfläche (Apple/AAA), Abstände ≥8px.
- Alle Filter behalten **Text-Labels** (kein Icon-only).
- Body-/Label-Text ≥ **16px**, Kontrast ≥ **4.5:1** (Ziel 7:1 für Primär-Labels).
- Token-konform: nur `var(--color-*)` / `var(--fs-*)`, kein Roh-Hex/px (CLAUDE.md
  Design-System). Segmented-Control-Recipe ggf. auf `/design-system` ergänzen.
- i18n: „THE HERD"-Weglassung/Segment-Labels über `messages/en.json`+`de.json`
  (`check:i18n`). Neues sichtbares Feature → Eintrag in `feature-announcements.ts`.
- Bei Modal-Sheet: Scrim **mit Blur** (`.scrim`/`.overlay`), Esc/Outside-Click schließt.

---

## Quellen

**Standards & Guidelines**

- Apple HIG – Layout (44pt): https://developer.apple.com/design/human-interface-guidelines/layout
- Apple HIG – Tab Bars (3–5): https://developer.apple.com/design/human-interface-guidelines/tab-bars
- Apple HIG – Segmented Controls (≤5 iPhone): https://developer.apple.com/design/human-interface-guidelines/segmented-controls
- Material 3 – Navigation Bar (3–5, 48dp): https://m3.material.io/components/navigation-bar/guidelines
- Material 3 – Tabs: https://m3.material.io/components/tabs/guidelines
- Material 3 – Chips: https://m3.material.io/components/chips/guidelines
- WCAG 2.5.8 (AA, 24px): https://www.allaccessible.org/blog/wcag-258-target-size-minimum-implementation-guide
- WCAG 2.5.5 (AAA, 44px): https://silktide.com/accessibility-guide/the-wcag-standard/2-5/input-modalities/2-5-5-target-size-enhanced/
- W3C SC 1.4.3 – Kontrast/alternde Augen: https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-contrast.html
- Android A11y – Touch Targets (48dp): https://support.google.com/accessibility/android/answer/7101858

**UX-Forschung & Muster**

- NN/g – Icon Usability (Labels nötig): https://www.nngroup.com/articles/icon-usability/
- NN/g – Hamburger/Mobile Navigation: https://www.nngroup.com/articles/find-navigation-mobile-even-hamburger/
- NN/g – Progressive Disclosure: https://www.nngroup.com/articles/progressive-disclosure/
- LukeW – Designing for Large Screen Smartphones (Daumenzone): https://www.lukew.com/ff/entry.asp?1927=
- Parachute – Thumb Zone UX: https://parachutedesign.ca/blog/thumb-zone-ux/
- Horizontal Scrolling Lists – Best Practices (Peek): https://blog.iamsuleiman.com/horizontal-scrolling-lists-mobile-best-practices/
- A11y – horizontale Scrollregionen: https://cerovac.com/a11y/2024/02/consider-accessibility-when-using-horizontally-scrollable-regions-in-webpages-and-apps/
- Mobbin – Segmented Control vs. Chips: https://mobbin.com/glossary/segmented-control

**Vorbild-Apps & aktuelle Trends**

- Things 3 – Quick Find / Gesten: https://culturedcode.com/things/support/articles/2803584/
- Todoist – Navigation anpassen: https://www.todoist.com/help/articles/customize-the-todoist-navigation-bar-L4qpkI0xj
- Todoist – Design Critique (Pratt): https://ixd.prattsi.org/2024/01/design-critique-todoist-ios-app/
- Linear Mobile (Launch): https://linear.app/changelog/2024-09-19-introducing-linear-mobile
- Frank Rausch – iOS Navigation Patterns: https://frankrausch.com/ios-navigation/
- Donny Wals – iOS 26 Tab Bar / Scroll-Kompression: https://www.donnywals.com/exploring-tab-bars-on-ios-26-with-liquid-glass/

---

_Recherche-Notiz, erstellt 2026-06-15. Kein Code geändert; Umsetzung = Folge-PR._
