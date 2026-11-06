# Research: Spracherkennung übers Mikrofon — Gemma, Parakeet und eine Engine ohne Handarbeit

**Verdikt: Gemma ist für die Erkennung selbst der falsche Hebel. Parakeet Ultra ist der richtige,
vor allem weil es sich ohne Handarbeit mitliefern lässt.**

- **Gemma.** Ein „Gemma 5“ gibt es nicht. Gemma 4 kann Audio, transkribiert Deutsch laut Google aber
  nicht besser als Whisper. Es ist auf 30 s pro Anfrage begrenzt und passt nicht in den
  Speicherhaushalt dieses Hosts.
- **Parakeet Ultra.** Die nachtrainierte Parakeet-Variante von Moondream gab es beim letzten
  Modellvergleich (4. Oktober) noch nicht. Auf diesem Host ist sie bei kurzen deutschen Sätzen fast
  so genau wie unser turbo-Server und **rund 13× schneller**: 0,13 s statt 1,6 s pro Clip [M].
- **Ohne Handarbeit.** Ultra läuft ohne GPU, Python, Docker und root aus einem npm-Paket. Das
  heutige Plugin verlangt dagegen einen von Hand installierten Python-Server oder whisper.cpp,
  ffmpeg und eine Modelldatei.

> Recherche vom **2026-11-06**, Stand `origin/main` `bf833b607`. Host des Operators: AMD Ryzen AI
> MAX 385 (Strix Halo, Radeon 8050S, XDNA-2-NPU), 32 GB Unified Memory, Arch Linux.
> **Nur Bericht: diese Datei ist der gesamte Diff, Produktcode wurde nicht geändert.**
> Sie baut auf dem Modellvergleich `docs/research/stt-modellvergleich.md` im Plugin-Repo auf
> ([shepherd-plugin-voice-whisper#13](https://github.com/erwins-enkel/shepherd-plugin-voice-whisper/pull/13),
> ungemergt geschlossen, Branch `shepherd/whistle-integration-pruefen`) und widerspricht ihm nicht.
> Er hat nur Ultra noch nicht gekannt.

Legende: **[M]** = auf diesem Host gemessen · **[V]** = gegen die Primärquelle geprüft ·
**[3P]** = Messung Dritter · **[I]** = eigene Schlussfolgerung.

---

## 0. Wie die Frage gelesen wurde

Die Frage war: _„Spracherkennung über unser Mikrofon — können wir da die Integration mit dem Gemma-5-Model
etwas verbessern und paketeer?“_

- **„Gemma 5“** heißt hier **Gemma 4**, die neueste Generation (§2). Es gibt heute **keine**
  Gemma-Integration im Code. Sie wäre neu, nicht verbessert.
- **„paketeer“** lässt zwei Lesarten zu: **Parakeet** (NVIDIAs ASR-Modell) oder **paketieren** (die
  Engine so ausliefern, dass sie ohne Handarbeit läuft). Der Bericht beantwortet beide. Sie führen
  ohnehin zur selben Empfehlung.

---

## 1. Ist-Zustand

| Teil             | Heute                                                                                                                                                                                                                   | Quelle                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Aufnahme Web     | Die Live-Vorschau schickt den **wachsenden** Clip alle 2,5 s als 16-kHz-WAV mit `mode=partial`. Der finale Clip (≤ 60 s) ist ein MediaRecorder-webm/mp4. Die Sprache wird aus der UI-Locale gesetzt.                    | `ui/src/lib/dictation.svelte.ts:57-58`, `:204`, `:326`                                                                      |
| Aufnahme iOS/Mac | Vorschau über Apple SpeechAnalyzer auf dem Gerät. Das Finale geht pro Clip als 16-kHz-WAV an den Server; nach 25 s Timeout gilt Apples Text.                                                                            | `native/Sources/ShepherdAppCore/Compose/Voice/WhisperFinalizer.swift`                                                       |
| Naht im Core     | fest verdrahtet auf `/api/plugins/voice-whisper/status\|transcribe`                                                                                                                                                     | `ui/src/lib/api.ts:657`, `contracts/openapi.yaml` (`getVoiceStatus`, `transcribeAudio`); generischer Vertrag offen in #1453 |
| Plugin           | `shepherd-plugin-voice-whisper` v1.1.0. Es leitet an einen faster-whisper-Server auf `127.0.0.1:9876` weiter, sonst an whisper.cpp-CLI + ffmpeg. Lastbremse: 3 gleichzeitige Anfragen, davon 1 fürs Finale reserviert.  | Plugin `index.ts:80-89`                                                                                                     |
| Engine           | `whisper-stt.service`: faster-whisper 1.2.1, `large-v3-turbo`, int8, **CPU**, 12 Threads, `beam_size=5`, VAD, `Nice=10`. Läuft außerhalb beider Repos (`~/.openclaw/skills-repo/whisper-stt`) und braucht ~1,06 GB RSS. | `systemctl --user cat whisper-stt` [M]                                                                                      |

**Gemessen [M]:** 2,1 s für den 4-s-Selbsttest-Clip auf Deutsch, 1,7 s für 2 s Englisch. Bei 60 s
braucht turbo laut paralleler Messung ~8 s. Die Vorschau-Schleife im Web kann ab etwa 20–30 s
Cliplänge mit dem 2,5-s-Takt nicht mehr mithalten. Die Lastbremse verwirft dann Vorschau-Ticks.

---

## 2. Gemma

### 2.1 Was es gibt [V]

- **Es gibt kein Gemma 5 und keinen angekündigten Nachfolger.**
  - Googles Release-Liste endet mit EmbeddingGemma 2 (2026-10-06), Gemma 4 12B Unified (2026-06-03)
    und Gemma 4 E2B/E4B/26B A4B/31B (2026-03-31). Quelle:
    [ai.google.dev/gemma/docs/releases](https://ai.google.dev/gemma/docs/releases).
  - Auch DeepMinds Gemma-Seite nennt Gemma 4 als neueste Generation:
    [deepmind.google/models/gemma](https://deepmind.google/models/gemma/).
- **Gemma 4 ist Apache-2.0**: [Model Card](https://ai.google.dev/gemma/docs/core/model_card_4).
- **Nur E2B, E4B und 12B nehmen Audio an.**
  - Google dokumentiert dafür ausschließlich ASR und Sprachübersetzung.
  - Das Limit liegt bei **30 s pro Anfrage** und 25 Audio-Tokens pro Sekunde:
    [Audio-Doku](https://ai.google.dev/gemma/docs/capabilities/audio),
    [12B-Guide](https://developers.googleblog.com/gemma-4-12b-the-developer-guide/).
  - Shepherds 60-s-Clips würden in mindestens zwei Anfragen zerfallen.

### 2.2 Als Erkennungs-Engine: kein Gewinn

FLEURS-de-WER aus dem
[Gemma-4-Technical-Report](https://arxiv.org/html/2607.02770), Tabellen 7/8 [V]:

| Modell                                                                 | FLEURS-de WER |
| ---------------------------------------------------------------------- | ------------- |
| Gemma 4 E2B                                                            | 7,6 %         |
| Gemma 4 E4B                                                            | 6,1 %         |
| Gemma 4 12B                                                            | 5,3 %         |
| _Whisper large-v2 (Whisper-Paper, Tab. 13)_                            | _4,5 %_       |
| _Whisper large-v3-turbo (Open ASR Leaderboard, laut Vorgängerbericht)_ | _3,67 %_      |

Die Normalisierung unterscheidet sich zwischen den Quellen. Die Tendenz ist trotzdem eindeutig:
**Kein Gemma-4-Modell schlägt Whisper auf Deutsch.** Dazu kommen Laufzeitprobleme, die in den
Runtime-PRs dokumentiert sind [V]:

- **Wiederholungsschleifen** bei Q4_K_M und darunter oder bei einem nicht-BF16-Audio-Projektor
  ([llama.cpp#21421](https://github.com/ggml-org/llama.cpp/pull/21421),
  [#21599](https://github.com/ggml-org/llama.cpp/pull/21599)).
- **Thinking frisst das Token-Budget**, bevor ein Transkript kommt (#21421).
- **Ältere Ollama-Versionen „transkribieren“ stumm nichts**, wenn das Modell gar kein Audio kann
  ([ollama#19397](https://github.com/ollama/ollama/pull/19397), offen).
- **Keine Timestamps.** Zur Geschwindigkeit veröffentlicht niemand Echtzeitfaktoren für
  Gemma-Audio. Hochgerechnet aus Googles CPU-Textzahlen liegt E4B bei ~2–2,6 s für 4 s Audio,
  also nicht schneller als heute [I].

### 2.3 Als Nachbearbeiter: plausibel, aber nicht auf diesem Host

Die Gemma-Rolle mit dem meisten Sinn ist die eines **Nachbearbeiters des finalen Texts**: Füllwörter
entfernen, Satzzeichen setzen, Fachbegriffe aus einem Glossar korrigieren.

- **Google macht genau das.** Seine Diktier-App _AI Edge Eloquent_ ist „Powered by Google's latest
  Gemma technology“. Sie entfernt „ums“ und Selbstkorrekturen und lernt ein Vokabular
  ([App Store](https://apps.apple.com/us/app/google-ai-edge-eloquent/id6756505519)) [V].
- **Google veröffentlicht weder Prompts noch Latenzen.**

Auf **diesem** Host scheitert das an zwei Dingen:

1. **Speicher.**
   - Ollama listet `gemma4:e2b` mit 4,6–7,5 GB und `e4b` mit 6,6–9,5 GB
     ([ollama.com/library/gemma4](https://ollama.com/library/gemma4)) [V].
   - [`local-decision-model-laya.md`](./local-decision-model-laya.md) §3–4 hat gezeigt, dass der
     Host dafür keinen Speicher frei hat: Ein Messversuch hat per OOM `herdr.service` und alle
     Sessions mitgerissen.
2. **Ollama ist zu alt.** Auf dem Host läuft `0.23.1` [M], root-eigen. Gemma-4-Audio über
   `/v1/audio/transcriptions` steht in Ollamas Release-Tests erst für deutlich neuere Versionen
   ([reg_release_test.go](https://github.com/ollama/ollama/blob/main/integration/reg_release_test.go)) [V].

Das **Jargon-Problem** (Repo-, Session- und Tool-Namen) lässt sich billiger lösen, ganz ohne LLM:

- **faster-whisper 1.2.1 kennt `hotwords` und `initial_prompt` schon** [M, Signatur der installierten
  Version geprüft]. Das kostet keine Latenz und schreibt nichts um.
- **Der OpenAI-Vertrag `/v1/audio/transcriptions` hat dafür das Feld `prompt`.** Der Weg dorthin
  führt über den generischen Transkriptionsvertrag (#1453, Plugin-Issue #16).
- **Bei Parakeet gibt es keinen Prompt.** sherpa-onnx bietet für Transducer Hotword-Boosting
  über `modified_beam_search`. Ob das mit Parakeet TDT funktioniert, ist **nicht geprüft** [I].

**Gemma-Fazit:**

- **Jetzt nicht.** Neu bewerten, sobald der Speicher es erlaubt, Ollama aktualisiert ist und ein
  Testsatz aus echten Shepherd-Diktaten existiert (§5).
- **Wenn überhaupt, dann so:**
  - E2B nur auf den **finalen** Text anwenden, nie auf die Vorschau.
  - Temperatur 0, Thinking aus.
  - Längen- und Edit-Distanz-Prüfung mit Rückfall auf den Rohtext.

---

## 3. Parakeet

### 3.1 Was sich seit dem 4. Oktober geändert hat

Der Vorgängerbericht hat Parakeet v3 auf diesem Host verworfen, aus zwei Gründen:

- Deutsch war schwächer: MLS 5,2 % bei fp32 und **9,1 %** bei int8, turbo kam auf 3,4 %.
- Die int8-Varianten **driften mitten im Satz ins Englische** („ich say your Leben“).

Seitdem ist **Parakeet Ultra** erschienen [V], ein Nachtraining von Moondream:

- Es hat dieselbe Architektur und dieselben 0,6B Parameter wie v3.
- Die Lizenz ist **CC-BY-4.0**.
- Laut Moondream liegt es auf FLEURS-de bei **3,61 % statt 4,13 %** und bei 5 dB Rauschen bei
  6,91 % statt 8,07 %:
  [huggingface.co/moondream/parakeet-ultra](https://huggingface.co/moondream/parakeet-ultra).
- Der int8-Export für sherpa-onnx ist **heute** gelandet:
  [sherpa-onnx#4163](https://github.com/k2-fsa/sherpa-onnx/pull/4163).
- Laut demselben PR erreicht **Ultra-int8 auf 300 FLEURS-de-Clips 5,20 %, v3-int8 nur 6,84 %**.
  Der int8-Schaden betrifft also vor allem v3.

Neuere NVIDIA-Modelle helfen nicht [V]:

- `nemotron-3.5-asr-streaming` ist auf Deutsch schwach (FLEURS-de 8,3 %).
- `nemotron-labs-unified-asr` (27.10.) läuft bisher nur unter NeMo.
- `Nemotron-3.5-Transcribe-30B` braucht eine H100.
- Einen „Parakeet v4“ gibt es nicht
  ([NVIDIA-ASR-Modelle auf HF](https://huggingface.co/models?author=nvidia&pipeline_tag=automatic-speech-recognition&sort=created)).

### 3.2 Eigene Messung: Ultra gegen den laufenden turbo-Server [M]

**Testsätze:**

- **CV17-de:** 60 Clips aus Common Voice 17 German, Test-Split, Offsets 0/500/…/2500,
  367 s, 558 Wörter. Kurze, moderne Sätze, also nah am Diktat.
- **MLS-de:** 24 Clips aus Multilingual LibriSpeech German, Test-Split, 346 s, 710 Wörter.
  Hörbuch und Lyrik, alte Rechtschreibung, Kleinschreibung in der Referenz.

**Normalisierung:** NFC, Kleinschreibung, ß→ss, Satzzeichen entfernt, Bindestriche zu Leerzeichen.

**Engines:**

- **turbo:** der produktive `whisper-stt`-Server mit `language=de`.
- **Parakeet:** `sherpa-onnx-node` 2.0.1 unter **Bun 1.4.4**, int8, 8 Threads, Modell warm.

Der Host war geteilt, mit Load 5–8 während des turbo-Laufs.

| Engine                  | CV17-de WER         | MLS-de WER          | Median-Latenz CV (≈6 s Clip) | Median MLS (≈14 s) | RSS      |
| ----------------------- | ------------------- | ------------------- | ---------------------------- | ------------------ | -------- |
| turbo-Server (heute)    | **3,41 %** (19/558) | **8,87 %** (63/710) | 1642 ms                      | 1741 ms            | ~1,06 GB |
| Parakeet v3 int8        | 6,99 % (39/558)     | 14,23 %             | 126 ms                       | 239 ms             | ~1,26 GB |
| **Parakeet Ultra int8** | **3,94 %** (22/558) | 12,68 %             | **129 ms**                   | 266 ms             | ~1,35 GB |

**Was die Zahlen sagen:**

- **Bei kurzen Sätzen ist Ultra praktisch gleichauf mit turbo.**
  - Es macht 3 Fehler mehr auf 558 Wörter, also +0,5 Punkte. Das liegt im Rauschen eines so
    kleinen Satzes.
  - Dabei ist Ultra **12–13× schneller**.
- **v3 bestätigt den Vorgängerbericht.**
  - Ein ganzer Satz kippt ins Englische: „Die Linie wurde später von der Union Pacific Railroad
    übernommen.“ wird zu **„But not“**.
  - Ultra hatte auf CV17 keinen solchen Ausreißer. Seine schlimmsten Fehler sind Verhörer wie
    „Mucks“ → „Moks“.
- **Bei Hörbuch-Lyrik bleibt turbo klar vorne** (8,9 gegenüber 12,7 %). Diktate von
  Dev-Prompts ähneln eher CV17 als Gedichten aus dem 19. Jahrhundert. Den Fall, der zählt,
  misst aber keiner der beiden Sätze: **Deutsch mit englischen Fachbegriffen**.
  - Hinweise von Dritten: Bei deutschem Code-Switching kommt Ultra auf 10,7 % und Apple
    SpeechAnalyzer auf 21,2 %
    ([TypeWhisper-Benchmark #13](https://github.com/TypeWhisper/typewhisper-benchmark/pull/13)) [3P].
  - Bei 5 dB Rauschen: Ultra 1,9 %, whisper.cpp turbo 3,9 %, sherpa v3 int8 31 %
    ([#14](https://github.com/TypeWhisper/typewhisper-benchmark/pull/14)) [3P].
  - Beides sind Messungen eines App-Anbieters, keine unabhängige Quelle.
- **Bei Stille und Rauschen liefern v3 und Ultra leeren Text, auch ohne VAD** [M, parallele
  Messung].
  - NVIDIA hat v3 dafür mit 36.000 h Nicht-Sprache trainiert
    ([arXiv 2509.14128](https://arxiv.org/abs/2509.14128)) [V].
  - Der typische Fehler von Parakeet ist ein **verschlucktes Wort**, kein erfundener Text.

### 3.3 Sprache: kein Pinning, und das ist hier ein Vorteil

- **Man kann Parakeet keine Sprache vorgeben.** Es erkennt sie selbst, eine Vorgabe ist nicht
  dokumentiert ([Model Card v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)) [V].
- **Bei Whisper hat das Pinning zwei Nachteile.**
  - Wird es auf die UI-Locale gepinnt, **übersetzt** Whisper statt zu transkribieren, sobald man
    die andere Sprache spricht (#1482, Plugin-Issue #10).
  - Echtes Auto-Detect **verdoppelt** bei turbo die Latenz: 3,1 statt 1,7 s für 4 s
    [M, parallele Messung].
- **Bei Parakeet fällt beides weg.** Die Erkennung ist im Modell eingebaut und kostet nichts, und
  übersetzen kann es nicht.
- **Das Risiko ist die Drift innerhalb eines Satzes.** Sie ist bei v3 belegt, bei Ultra in
  dieser Messung nicht aufgetreten.

---

## 4. Ausliefern ohne Handarbeit

### 4.1 Optionen

| Option                                                                | Was der Operator tun muss                                                                                                   | Plattformen                                                                                                                                                                                                                                                           | OpenAI-Vertrag                           | Bewertung                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `sherpa-onnx-node` mit Parakeet Ultra, vom Plugin mitgeliefert** | nichts. Das npm-Paket bringt `libonnxruntime` mit; das Modell (~490 MB) lädt das Plugin beim ersten Start und prüft SHA-256 | linux-x64 und darwin-arm64 als fertige Binaries ([npm](https://www.npmjs.com/package/sherpa-onnx-node), [Release v2.0.1](https://github.com/k2-fsa/sherpa-onnx/releases)) [V]. Lädt in Bun 1.4.4 hier ohne `LD_LIBRARY_PATH` [M]. Auf einem echten Mac nicht getestet | nicht nötig, das Plugin _ist_ die Engine | **empfohlen als Standard-Engine**                                                                                                                                                                                         |
| B. whisper.cpp `whisper-server` + Vulkan (Plugin-Issue #16)           | `vulkan-radeon` installieren (**root**), whisper.cpp selbst bauen (keine fertige Linux-Vulkan-Binary), Dienst einrichten    | Linux mit Vulkan-GPU                                                                                                                                                                                                                                                  | teilweise (`--inference-path`)           | am genauesten auf diesem Host (turbo, 0,27–0,55 s laut Vorgängerbericht), aber **das Gegenteil von „ohne Handarbeit“**. Bleibt als optionale Genauigkeits-Engine sinnvoll                                                 |
| C. whisper.cpp-CLI per Ein-Klick-Download (Plugin-Issue #14)          | nichts                                                                                                                      | Linux/macOS                                                                                                                                                                                                                                                           | –                                        | auf der CPU ~5 s pro Clip mit turbo, mit `small` ungenauer. Nach A überflüssig                                                                                                                                            |
| D. speaches (Docker)                                                  | Docker                                                                                                                      | überall, wo Docker läuft                                                                                                                                                                                                                                              | **ja**                                   | lädt Parakeet nur in fp32 (2,4 GB, `# TODO: support model quants` in [parakeet.py](https://github.com/speaches-ai/speaches/blob/master/src/speaches/executors/parakeet.py)); letzter Tag ist ein RC vom Dezember 2025 [V] |
| E. parakeet.cpp `parakeet-server`                                     | eine 3-MB-Binary + GGUF                                                                                                     | Linux (CPU/Vulkan), macOS (Metal)                                                                                                                                                                                                                                     | **ja**                                   | laut README nur „an example“, eine Anfrage gleichzeitig ([mudler/parakeet.cpp](https://github.com/mudler/parakeet.cpp)) [V]                                                                                               |

### 4.2 Die Speichergrenze entscheidet, _wo_ A läuft

- **`shepherd.service` hat ein festes Limit:** `MemoryMax=6G`. Er braucht im Betrieb ~2,3 GB und
  hatte einen **Peak von 4,3 GB** [M].
- **`OOMPolicy=stop` ist gesetzt** [M]. Ein OOM-Kill irgendeines Prozesses in diesem cgroup
  stoppt also den ganzen Dienst. Das ist dasselbe Muster wie bei herdr in
  [`local-decision-model-laya.md`](./local-decision-model-laya.md) §4.
- **Ultra im Server-Prozess bringt den Peak auf ~5,6 GB.** Ultra braucht ~1,35 GB RSS [M]. Das
  ist zu knapp am Limit, und ein nativer Absturz in ONNX Runtime würde Shepherd mitnehmen.
- **Folgerung [I]:** Das Plugin lädt die Engine **nicht im eigenen Prozess**. Es startet sie als
  eigenen, überwachten Prozess **mit eigenem cgroup**.
  - Auf Linux z. B. per `systemd-run --user --unit=shepherd-stt …`.
  - Auf macOS gibt es dieses Limit nicht.
  - Der Code bleibt derselbe (Bun + `sherpa-onnx-node`). Nur der Startweg unterscheidet sich.
  - Auf diesem Host würde Ultra den `whisper-stt`-Server (~1,06 GB) nicht ersetzen, sondern
    ergänzen, solange andere Werkzeuge ihn nutzen. **Das ist eine Betriebsentscheidung des
    Operators.**

### 4.3 Kein ffmpeg mehr

Parakeet über sherpa-onnx liest PCM bzw. WAV. iOS und die Web-Vorschau schicken schon 16-kHz-WAV.
Nur das **finale Web-Clip** kommt noch als webm/mp4 an. Zwei offene Issues lösen das:

- **#2724** (Core): das Web-Finale aus dem vorhandenen PCM als WAV bauen.
- **Plugin-#15**: WAV ohne ffmpeg durchreichen.

Danach braucht der Weg A **gar keine Systemabhängigkeit** mehr.

---

## 5. Empfehlung

Reihenfolge nach Nutzen pro Aufwand. Alles Plugin-Spezifische gehört laut Konvention des
Plugin-Repos dorthin. Alles, was UI oder Vertrag betrifft, ist Core-Arbeit
(`CLAUDE.md` im Plugin-Repo).

| #   | Schritt                                                                                                                                                                                                        | Wo                     | Nutzen                                                                                                                                                                                                                                     | Bezug                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1   | **#2724 + Plugin-#15**: alle Clients schicken 16-kHz-WAV, das Plugin braucht kein ffmpeg mehr                                                                                                                  | Core + Plugin          | Voraussetzung für 2; entfernt eine Systemabhängigkeit                                                                                                                                                                                      | offen                                                          |
| 2   | **Parakeet-Ultra-Engine im Plugin (Option A)**: eigener Prozess, Modell-Download mit SHA-256, Engine bleibt warm, CC-BY-Attribution für NVIDIA und Moondream im Plugin                                         | Plugin                 | Spracheingabe funktioniert **nach der Plugin-Installation ohne weitere Schritte** auf Linux x64 und macOS arm64. Antwort in ~0,1–0,3 s statt ~2 s. Die Vorschau-Schleife hält bis 60 s den Takt (≤ 1,8 s pro Tick laut paralleler Messung) | neu; ersetzt #14 und Teil (c) von #1                           |
| 3   | **Engine-Wahl pro Modus**: `mode=partial` immer über Parakeet. Das Finale über Parakeet oder, falls konfiguriert und erreichbar, über eine genauere Engine (turbo-Server heute, whisper.cpp + Vulkan nach #16) | Plugin                 | schnelle Vorschau ohne CPU-Stau; Genauigkeit fürs Finale bleibt wählbar                                                                                                                                                                    | ergänzt #5, #16                                                |
| 4   | **Testsatz aus echten Shepherd-Diktaten** (50–100 Clips, Deutsch mit Dev-Begriffen), gemessen gegen Ultra, turbo-CPU und turbo-Vulkan                                                                          | Recherche              | die einzige belastbare Antwort, ob das Finale Whisper überhaupt noch braucht                                                                                                                                                               | Option 6 im Vorgängerbericht                                   |
| 5   | **Glossar-Hinweis im Vertrag** (`prompt` bzw. Hotwords aus Repo- und Session-Namen)                                                                                                                            | Core (#1453) + Engines | zielt auf das Jargon-Problem, ohne LLM                                                                                                                                                                                                     | #1453, #16                                                     |
| –   | **Gemma** als Nachbearbeiter des Finales                                                                                                                                                                       | –                      | **geparkt** (§2.3): erst bei freiem Speicher, aktuellem Ollama und einem Testsatz aus 4                                                                                                                                                    | –                                                              |
| –   | **iOS/Mac**: SpeechAnalyzer für die Vorschau beibehalten; das Server-Finale wird mit 2 ohnehin schneller. FluidAudio + Ultra auf dem Gerät (~630 MB, iOS 17+) erst, wenn ein Finale ohne Server gebraucht wird | –                      | –                                                                                                                                                                                                                                          | [FluidAudio](https://github.com/FluidInference/FluidAudio) [V] |

**Was dieser Bericht nicht entscheidet:**

- **Ob der `whisper-stt`-Server auf diesem Host abgelöst wird.** Er läuft außerhalb beider Repos
  und dient womöglich weiteren Werkzeugen.
- **Ob Ultra turbo auch beim Finale ersetzt.** Das entscheidet Schritt 4.

---

## 6. Grenzen

- **Kleine Testsätze.** Auf CV17 entspricht 1 Fehler 0,18 Punkten. Differenzen unter ~1 Punkt sind
  Rauschen.
- **Keine echten Diktate.** Es gab keine Messung mit Code-Switching und keine
  Format-Genauigkeit für Pfade und Flags (`origin/main`, `--force-with-lease`). Die
  Code-Switch-Zahlen oben stammen von Dritten.
- **Geteilter Host** mit Load 5–8. turbo lief als produktiver Dienst mit `Nice=10`, Parakeet mit
  8 Threads ohne Nice. Das Verhältnis ist robust (>10×), die absoluten Zeiten schwanken.
- **Nicht gemessen:**
  - `sherpa-onnx-node` auf einem echten Mac.
  - Parakeet auf der iGPU über parakeet.cpp + Vulkan. Das ist nicht nötig, weil die CPU schon
    schnell genug ist.
  - Gemma-4-Audio auf diesem Host. Der Speicher reicht nicht, und Ollama ist zu alt.
  - Hotword-Boosting mit Parakeet.
- **Parallele Recherchenotizen.** Die Gemma- und Parakeet-Notizen mit allen Einzelquellen lagen
  im Session-Scratchpad und sind nicht Teil des Repos. Die tragenden Quellen sind oben verlinkt.

## 7. Nachstellen

```sh
# Modell + Runtime (Linux x64)
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-ultra-int8.tar.bz2
tar xjf sherpa-onnx-nemo-parakeet-tdt-0.6b-ultra-int8.tar.bz2
mkdir stt && cd stt && bun add sherpa-onnx-node@2.0.1

# Testclips: HF datasets-server rows API
#   fixie-ai/common_voice_17_0  config=de      split=test  offsets 0,500,…,2500 (je 10)
#   facebook/multilingual_librispeech config=german split=test offsets 0,1000,2000 (je 8)
# → ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le

# Erkennung (Kern des Bench-Skripts)
#   OfflineRecognizer.createAsync({ modelConfig: { transducer: {encoder, decoder, joiner},
#     tokens, numThreads: 8, provider: "cpu", modelType: "nemo_transducer" } })
#   stream.acceptWaveform(...); await rec.decodeAsync(stream)

# turbo-Vergleich gegen den laufenden Server
curl -s -F file=@clip.wav -F language=de http://127.0.0.1:9876/transcribe
```
