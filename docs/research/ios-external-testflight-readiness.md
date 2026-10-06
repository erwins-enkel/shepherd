# iOS-App: Was fehlt für externes TestFlight (bis 10.000 Tester)?

Stand: 2026-10-06. Ziel ist **nicht** die App-Store-Veröffentlichung, sondern der Schritt von der
internen TestFlight-Gruppe (nur Team, max. 100 Personen, kein Review) zu **externen Testern**
(per E-Mail-Einladung oder öffentlichem Link, max. 10.000). Dafür verlangt Apple eine
**Beta App Review**. Der Bericht fasst zusammen, was Apple dafür prüft, wie die App heute dasteht
und was wir noch tun müssen.

> **Kurzfassung:** Build-Pipeline, Signing, Export-Compliance und Icon sind fertig. Es fehlen vier
> Dinge, die das Review blockieren können:
>
> 1. ein **öffentlich erreichbarer Demo-Server** mit Zugangsdaten für die Reviewer,
> 2. eine **Datenschutzerklärung für die iOS-App** sowie Links dazu in der App,
> 3. ein **Privacy Manifest** (`PrivacyInfo.xcprivacy`),
> 4. die **Test-Informationen** in App Store Connect.
>
> Der Rest besteht aus Empfehlungen, die das Review-Risiko senken.

---

## 1. Was Apple für externes TestFlight verlangt

### 1.1 Beta App Review

- Der erste Build, der einer **externen** Gruppe zugewiesen wird, geht automatisch in die Beta App
  Review. Erst nach Freigabe können externe Tester ihn installieren
  ([TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview),
  [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)).
- Weitere Builds **derselben Version** brauchen meist kein volles Review mehr. Wesentliche
  Änderungen sollen laut Guideline 2.2 aber erneut eingereicht werden. Für uns heißt das: Jede neue
  Marketing-Version (z. B. 2.1.0 → 2.2.0) löst wieder ein Review aus.
- Pro Version kann immer nur ein Build im Review sein. Pro 24 Stunden lassen sich höchstens
  6 Builds einreichen.
- **Es gelten die vollen App Review Guidelines.** Guideline 2.2 sagt: _„Any app submitted for beta
  distribution via TestFlight should be intended for public distribution and should comply with
  the App Review Guidelines."_ ([Guidelines](https://developer.apple.com/app-store/review/guidelines/))
- Dauer: Apple nennt offiziell keine Zahl. Drittquellen berichten von etwa 1 Tag, in Spitzenzeiten
  von mehreren Tagen. Das ist nicht verifiziert.

### 1.2 Pflichtangaben in App Store Connect („Test Information“)

| Feld                                      | Pflicht?                         | Quelle                                                                                                                      |
| ----------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Beta App Description                      | **ja**                           | [Provide test information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information) |
| Beta App Review Information (Kontakt)     | **ja** (Name, Telefon, E-Mail)   | ebd.                                                                                                                        |
| Sign-in-Daten (Username/Passwort) + Notes | **ja**, sobald die App Login hat | Guideline 2.1(a)                                                                                                            |
| What to Test                              | faktisch ja (pro Build)          | [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)           |
| Feedback-E-Mail                           | optional (empfohlen)             | Provide test information                                                                                                    |
| Privacy Policy URL                        | **unklar**, praktisch erwartet   | Guideline 5.1.1(i): _alle_ Apps brauchen eine Privacy Policy in den Metadaten **und** in der App                            |
| Marketing URL                             | optional                         | —                                                                                                                           |

### 1.3 Login: Reviewer brauchen echten Zugang

Guideline 2.1(a) verlangt:

> _„include demo account info (and turn on your back-end service!) if your app includes a login. If
> you are unable to provide a demo account due to legal or security obligations, you may include a
> built-in demo mode in lieu of a demo account with prior approval by Apple."_

Apple hat sich nie dazu geäußert, ob ein Server zulässig ist, der nur im privaten Netz erreichbar
ist. Die Reviewer sitzen aber nicht in unserem Tailnet. Ohne erreichbares Backend ist eine
Ablehnung nach 2.1 (App Completeness) sehr wahrscheinlich. In Foren ist das einer der häufigsten
Ablehnungsgründe
([Beispiel](https://developer.apple.com/forums/thread/764103)).

### 1.4 Datenschutz

- **Privacy Manifest.** Seit Frühjahr 2024 muss jede App, die Required-Reason-APIs nutzt
  (praktisch immer `UserDefaults`), eine `PrivacyInfo.xcprivacy` mit dem Grund mitliefern
  ([Apple News](https://developer.apple.com/news/?id=r1henawx)). Fehlt sie, kommt beim Upload die
  Warnung ITMS-91053. Laut Drittquellen ist das „nur“ eine Mail, für ein Review aber ein unnötiges
  Risiko.
- **Purpose Strings** müssen _„clearly and completely describe your use of the data“_ (5.1.1).
- **App-Privacy-Label** (Nutrition Label) und **Altersfreigabe**: Für externes TestFlight ist das
  nicht eindeutig Pflicht. Für den späteren Store-Release brauchen wir beides ohnehin, also lohnt
  es sich, sie gleich mit auszufüllen.
- **Guideline 5.1.2(i)** (seit Nov. 2025): Werden personenbezogene Daten an Dritte gegeben,
  _„including with third-party AI“_, muss die App das klar offenlegen und vorher ausdrücklich um
  Erlaubnis fragen. Unsere App sendet Sprache und Text nur an den eigenen Server. Der leitet sie
  aber an KI-Agenten (Claude, Codex) weiter. Eine kurze Offenlegung beim ersten Start senkt das
  Risiko.

### 1.5 Export-Compliance

Nutzt die App nur die Verschlüsselung des Betriebssystems (HTTPS/TLS, Keychain), reicht
`ITSAppUsesNonExemptEncryption = NO`. Dann fallen die Fragen bei jedem Upload weg
([Export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)).
Frankreich hat Sonderregeln für Apps mit sicherer Kommunikation. Die greifen bei OS-Krypto nach
unserer Lesart nicht, das ist aber nicht abschließend verifiziert.

### 1.6 Weitere Regeln und Grenzen

- **Account-Löschung (5.1.1(v))** gilt nur, wenn die App Accounts _anlegt_. Unsere App meldet sich
  nur an einem bestehenden, selbst betriebenen Server an und kann den Server-Token wieder
  entfernen. Damit ist die Regel nach unserer Lesart **nicht anwendbar**. Wir sollten das in den
  Review Notes kurz erwähnen.
- **DSA-Trader-Status:** Für reine TestFlight-Verteilung handeln wir nicht als „Trader“
  ([Apple](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/)).
  Eine Angabe auf Account-Ebene ist trotzdem nötig. Spätestens für den Store-Release brauchen wir
  den Status als Trader, mit öffentlich sichtbarer Adresse und Telefonnummer.
- **SDK:** Seit 28.04.2026 sind Uploads nur noch mit Xcode 26 / iOS-26-SDK möglich
  ([Apple News](https://developer.apple.com/news/?id=ueeok6yw)).
- **Grenzen:** 10.000 externe Tester. Builds laufen nach 90 Tagen ab. Pro Tester sind 30 Geräte
  erlaubt. Ein öffentlicher Link lässt sich auf eine Maximalzahl begrenzen und nach Gerät und
  iOS-Version filtern. Tester müssen mindestens 13 Jahre alt sein.
- **Kein Entgelt:** TestFlight-Zugang darf nicht gegen Bezahlung vergeben werden (2.2).
- **Guideline 4.2.7 (Remote-Desktop-Clients):** Dazu gibt es weiterhin keine Aussage von Apple,
  siehe [`native-ios-client-vs-pwa.md` §5.3](native-ios-client-vs-pwa.md). Die App sollte im
  Review als **API-Client mit eigener Oberfläche** auftreten (Session-Liste, Pläne, Diffs,
  Diktat), nicht als „Terminal-Spiegel“. Die Beta-Beschreibung und die Review Notes sollten das
  so formulieren.

---

## 2. Stand der App (Audit des Repos)

| Bereich                      | Stand                                                                                                                                                         | Bewertung                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Bundle-ID / ASC-Record       | `run.shepherd.ios`, Record „Shepherd for Agents“ (`native/docs/testflight-ios.md`)                                                                            | ✅                                                                |
| Pipeline                     | `.github/workflows/native-ios-testflight.yml`: nächtlicher Upload per `altool`, Export mit `testFlightInternalTestingOnly=false`                              | ✅ Builds sind extern nutzbar                                     |
| Export-Compliance            | `ITSAppUsesNonExemptEncryption=false` (`native/Apps/ShepherdIOS/Sources/Info.plist:28`), vom Validator geprüft                                                | ✅                                                                |
| App-Icon                     | 1024×1024, ohne Alpha                                                                                                                                         | ✅                                                                |
| Purpose Strings              | Kamera, Mikrofon und Spracherkennung vorhanden, EN + DE (`en.lproj`/`de.lproj/InfoPlist.strings`)                                                             | ✅ Inhalt gut. Basis-Strings in `Info.plist` sind knapper als EN  |
| Fotos                        | `PhotosPicker` / `.fileImporter`, laufen außerhalb des App-Prozesses                                                                                          | ✅ kein Purpose String nötig                                      |
| Apple-Server-Spracherkennung | nur nach Einwilligung in der App (`IOSDictationEngine.swift`)                                                                                                 | ✅ gutes Muster für 5.1.2                                         |
| Tracking / Analytics / SDKs  | keine. Daten gehen nur an den eigenen Server und an Apple (APNs, Speech)                                                                                      | ✅                                                                |
| **Privacy Manifest**         | **fehlt** im ganzen Repo. Genutzt werden `UserDefaults`/`@AppStorage` (Grund CA92.1) und `stat`/`fstat` in SwiftTerm 1.20.0, das kein eigenes Manifest hat    | ❌                                                                |
| **Privacy Policy**           | `shepherd.run/privacy` deckt **nur die Chrome-Extension** ab (`site/src/pages/privacy.astro`)                                                                 | ❌                                                                |
| **Links in der App**         | keine Links zu Datenschutz, Support oder Impressum                                                                                                            | ❌ (5.1.1(i), 1.5)                                                |
| **Reviewer-Zugang**          | Login nur per Server-Adresse und Operator-Passwort. Erwarteter Fall ist ein Tailscale-Name. Kein Demo-Modus in Release-Builds                                 | ❌ größter Blocker                                                |
| Test-Informationen / Gruppen | nicht automatisiert. Nur die interne Gruppe „Enkel“ ist eingerichtet                                                                                          | ❌ manuell nachzuholen                                            |
| ATS                          | nur `NSAllowsLocalNetworking`. Die App erlaubt `http://` für `*.ts.net` (`ServerProfile.swift:59-69`), ATS blockiert das vermutlich                           | ⚠️ Fehlerquelle für Tester                                        |
| Local-Network-Prompt         | kein `NSLocalNetworkUsageDescription`. Bei LAN-IP mit https zeigt iOS einen generischen Text                                                                  | ⚠️ klein                                                          |
| Push für Self-Hoster         | APNs geht nur mit unserem APNs-Key (`docs-site/.../reference/configuration.md:95-109`). Externe Tester mit eigenem Server bekommen **keine Push-Nachrichten** | ⚠️ in „What to Test“ erwähnen                                     |
| Isolated-Testmodus           | per `-ShepherdIsolated`-Argument auch in Release erreichbar (`IOSLaunchEnvironment.swift:22-38`)                                                              | ⚠️ für Reviewer unsichtbar, aber besser mit `#if DEBUG` absichern |
| Xcode-Version in CI          | `macos-latest`, nicht gepinnt                                                                                                                                 | ⚠️ Xcode ≥ 26 muss garantiert sein                                |

---

## 3. To-do-Liste

### A. Blocker: ohne diese Punkte keine externe Freigabe

1. **Demo-Server für Apple-Reviewer**
   - Eine eigene, dauerhaft laufende Shepherd-Instanz mit **öffentlicher HTTPS-Adresse**,
     z. B. per Tailscale Funnel oder einem kleinen VPS. Sie braucht ein eigenes Operator-Passwort
     nur für Reviewer, Beispiel-Sessions und Beispieldaten.
   - Sie muss **während jedes Reviews erreichbar** sein, also bei jeder neuen Marketing-Version.
   - Sie darf **keine echten Repos oder Secrets** enthalten. Den Agenten-Zugang beschränken wir,
     z. B. auf ein Sandbox-Repo mit begrenztem Budget, damit Reviewer nicht auf unsere Kosten
     beliebige Agenten starten.
   - Alternative: ein **eingebauter Demo-Modus** in Release-Builds, aber nur mit vorheriger
     Zustimmung von Apple und mit dem vollen Funktionsumfang. Das ist mehr Aufwand und
     riskanter, deshalb nicht empfohlen.
2. **Datenschutzerklärung für die iOS-App** auf shepherd.run, als eigene Seite oder Erweiterung
   von `/privacy`. Inhalt:
   - Mikrofon und Diktat: Audio geht an den eigenen Server, Apple-Spracherkennung nur nach
     Einwilligung.
   - Kamera, Fotos, Dateien als Anhänge.
   - Push-Token, Keychain-Token.
   - Weitergabe an KI-Agenten über den eigenen Server.
   - Kein Tracking, keine Analytics.
   - Verantwortlicher und Kontakt.
3. **Links in der App:** Datenschutz, Support/Kontakt und Impressum, z. B. in den Einstellungen
   oder auf einem „Über“-Screen, in EN und DE.
4. **`PrivacyInfo.xcprivacy`** im iOS-Target mit diesen Einträgen:
   - `NSPrivacyTracking = false`, keine Tracking-Domains.
   - Accessed API Types: `UserDefaults` (CA92.1) und File Timestamp (für SwiftTerm, z. B. C617.1
     oder 3B52.1; den Grund am Code prüfen).
   - Collected Data Types passend zur Datenschutzerklärung (Audio, Fotos, sonstige
     Nutzerinhalte; „not linked to tracking“).
   - Zusätzlich ein Check im Archiv-Validator, dass das Manifest im Bundle liegt.
5. **App Store Connect einrichten** (einmalig, manuell):
   - Beta App Description, Feedback-E-Mail, Kontakt für das Beta Review, Privacy Policy URL.
   - Sign-in-Daten des Demo-Servers. In den **Review Notes** stehen:
     - Server-Adresse im Feld „Add server“ eintragen, dann mit dem Passwort anmelden.
     - Die App ist ein Client für den selbst betriebenen Shepherd-Server und legt keine Accounts
       an. Deshalb gilt 5.1.1(v) nicht.
     - Sprache und Text gehen nur an den Server des Nutzers.
   - Externe Gruppe anlegen, später einen öffentlichen Link mit Limit.
   - DSA-Trader-Angabe auf Account-Ebene prüfen.

### B. Empfohlen: senkt das Review-Risiko und verbessert die Erfahrung der Tester

6. **Offenlegung beim ersten Start (5.1.2(i))**, ein Screen mit diesem Inhalt: „Texte, Sprache und
   Anhänge gehen an deinen Shepherd-Server und von dort an die KI-Agenten, die du dort
   konfiguriert hast (z. B. Anthropic Claude, OpenAI Codex).“ Dazu ein Bestätigen-Button.
7. **App-Privacy-Label und Altersfreigabe** gleich mit ausfüllen. Für den Store brauchen wir sie
   ohnehin, und das Review ist dann konsistent.
8. **`.ts.net`-über-`http`-Fehler beheben.** Entweder akzeptiert die App für `.ts.net` nur
   `https`, oder wir ergänzen eine passende ATS-Ausnahme. So scheitern externe Tester nicht an
   einer Fehlermeldung, die sie nicht verstehen.
9. **Onboarding-Hilfe für externe Tester:** eine Seite auf docs.shepherd.run nach dem Muster
   „Server einrichten → per Tailscale Serve mit HTTPS erreichbar machen → in der App verbinden“.
   Dazu der Hinweis, dass Push auf eigenen Servern nicht funktioniert. Link in die Beta
   Description.
10. **Xcode-Version in CI pinnen** (≥ 26), damit ein Runner-Wechsel keinen ungültigen Upload
    erzeugt.
11. **Isolated-Testmodus mit `#if DEBUG` absichern** und die `preconditionFailure`-Stellen prüfen
    (`IOSPlanController.swift:17`, `IOSSessionActions.swift:45`). Ein Absturz während des Reviews
    führt sofort zur Ablehnung nach 2.1.
12. **`NSLocalNetworkUsageDescription`** ergänzen (EN + DE), für Nutzer, deren Server im LAN liegt.
13. **„What to Test“ automatisieren** (optional): Changelog per App Store Connect API
    (`betaBuildLocalizations`) aus der Pipeline setzen.

### C. Positionierung im Review (4.2.7)

Beta Description und Review Notes sollten die App als **eigenständigen API-Client** beschreiben:
Sessions steuern, Pläne freigeben, Diffs und Status ansehen, Aufgaben diktieren. Den
Terminal-Mirror erwähnen wir nur als Nebenfunktion. So vermeiden wir, dass der Reviewer
Guideline 4.2.7 (Remote Desktop, LAN-Pflicht) anwendet.

---

## 4. Offene Punkte (nicht abschließend verifiziert)

- Ob die Privacy Policy URL, das App-Privacy-Label und die Altersfreigabe für **externes
  TestFlight** formal Pflicht sind. Apple-Seiten und Forenaussagen widersprechen sich. Die
  Empfehlung lautet: alles ausfüllen.
- Ob ITMS-91053 (fehlende API-Deklaration) beim Upload nur eine Warnung ist oder zur Ablehnung
  führt. Mit einem Manifest stellt sich die Frage nicht.
- Wie Apple einen Server sieht, der nur im privaten Netz liegt. Es gibt keine offizielle Aussage,
  deshalb planen wir mit einem öffentlichen Demo-Server.
- Die genaue Behandlung von `.ts.net`-Hosts durch ATS sollten wir auf dem Gerät testen.

## Quellen

- App Review Guidelines (2.1, 2.2, 4.2.7, 5.1.1, 5.1.2): https://developer.apple.com/app-store/review/guidelines/
- TestFlight overview: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview
- Invite external testers: https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers
- Provide test information: https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information
- TestFlight: https://developer.apple.com/testflight/
- Export compliance: https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance
- Privacy manifest / Required Reason APIs: https://developer.apple.com/news/?id=r1henawx
- Xcode 26 SDK requirement: https://developer.apple.com/news/?id=ueeok6yw
- Age ratings update: https://developer.apple.com/news/?id=ks775ehf
- DSA trader requirements: https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/
- Offering account deletion: https://developer.apple.com/support/offering-account-deletion-in-your-app/
- TestFlight terms: https://www.apple.com/legal/internet-services/itunes/testflight/sren/terms.html
- Interne Vorarbeit: [`native-ios-client-vs-pwa.md`](native-ios-client-vs-pwa.md) §5, `native/docs/testflight-ios.md`
