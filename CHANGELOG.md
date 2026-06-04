# Changelog

## [1.14.0](https://github.com/erwins-enkel/shepherd/compare/v1.13.0...v1.14.0) (2026-06-04)


### Features

* **herdr-update:** update herdr without restarting shepherd (no more 502) ([#314](https://github.com/erwins-enkel/shepherd/issues/314)) ([9218f5a](https://github.com/erwins-enkel/shepherd/commit/9218f5a7213006ded08c71160bcfa4ebf3fa2f1d))
* **learnings:** evidence provenance + drawer readability + 💡 badge ([#319](https://github.com/erwins-enkel/shepherd/issues/319)) ([799b9d2](https://github.com/erwins-enkel/shepherd/commit/799b9d25b95603a9f9c9cc62d1b70255b76188a1))
* **ui:** per-agent activity heat-strip on session rows ([#316](https://github.com/erwins-enkel/shepherd/issues/316)) ([d8dbd14](https://github.com/erwins-enkel/shepherd/commit/d8dbd148c7f7de4a8c635fe1efd3aadcf04be267))


### Bug Fixes

* reattach sessions to herdr agents after a daemon restart ([#317](https://github.com/erwins-enkel/shepherd/issues/317)) ([b30d06a](https://github.com/erwins-enkel/shepherd/commit/b30d06ac3c62db983546f01da054e8d2fd90dd48))
* **ui:** show REVIEWING (not stale CHANGES) while the critic re-reviews ([#320](https://github.com/erwins-enkel/shepherd/issues/320)) ([b7b226f](https://github.com/erwins-enkel/shepherd/commit/b7b226f29bd209528fb68a501dd6c2cbcf822f23))
* **ui:** update modals — no row overlap on expand, full-height mobile sheet ([#318](https://github.com/erwins-enkel/shepherd/issues/318)) ([7686d14](https://github.com/erwins-enkel/shepherd/commit/7686d14c60a48ea156ddaea35e28d02bde7a195e))

## [1.13.0](https://github.com/erwins-enkel/shepherd/compare/v1.12.0...v1.13.0) (2026-06-04)


### Features

* **actions:** per-workflow run history in backlog Actions tab ([#236](https://github.com/erwins-enkel/shepherd/issues/236)) ([#310](https://github.com/erwins-enkel/shepherd/issues/310)) ([af6a2c1](https://github.com/erwins-enkel/shepherd/commit/af6a2c17856265c0d61eecc7795f486a4c1f4d9e))
* **drain:** autopilot never merges — retire ready PRs for human merge ([#309](https://github.com/erwins-enkel/shepherd/issues/309)) ([4915aca](https://github.com/erwins-enkel/shepherd/commit/4915aca085bc98fd2cd2b7f54d16d4956619e90b))
* **drain:** claim issues with a label to coordinate across instances ([#306](https://github.com/erwins-enkel/shepherd/issues/306)) ([2f6eb95](https://github.com/erwins-enkel/shepherd/commit/2f6eb95ad69469994998b867abcee128baa7f4ec))
* **drain:** list-view popover for queued backlog items ([#304](https://github.com/erwins-enkel/shepherd/issues/304)) ([e517f0e](https://github.com/erwins-enkel/shepherd/commit/e517f0ec89e12a26a72e7150a4f8123ccbb7f995))
* **emoji:** expand repo icon set + ranked search + keyboard nav ([#296](https://github.com/erwins-enkel/shepherd/issues/296)) ([1a3da2b](https://github.com/erwins-enkel/shepherd/commit/1a3da2bf670ceff53da662bcf5dbd167e28dd1c3))
* **forge:** list Gitea/Forgejo Actions runs in backlog tab ([#234](https://github.com/erwins-enkel/shepherd/issues/234)) ([#305](https://github.com/erwins-enkel/shepherd/issues/305)) ([7954922](https://github.com/erwins-enkel/shepherd/commit/79549225c40a9efc3e0802eb1666ab78b27626cb))
* opt-in [@dependabot](https://github.com/dependabot) rebase for stuck backlog PRs ([#303](https://github.com/erwins-enkel/shepherd/issues/303)) ([92da6b5](https://github.com/erwins-enkel/shepherd/commit/92da6b5dc416f191a67628d503331d56fc6b6d67))
* self-draining work queue (autonomous backlog drain) ([#300](https://github.com/erwins-enkel/shepherd/issues/300)) ([8b9a3bc](https://github.com/erwins-enkel/shepherd/commit/8b9a3bc47aae07451840c8a7fe83479ac64cf997))
* **ui:** feature discovery — What's-New panel + first-view coachmarks ([#292](https://github.com/erwins-enkel/shepherd/issues/292)) ([f4b95d1](https://github.com/erwins-enkel/shepherd/commit/f4b95d15f94a9b385d5caa21008492f04fdd3bd9))
* **ui:** per-agent heartbeat, current activity + pipeline-stage stepper on rows ([#311](https://github.com/erwins-enkel/shepherd/issues/311)) ([b9a6788](https://github.com/erwins-enkel/shepherd/commit/b9a67885a0774248b9a9f578436bec8ea9c0f5d2))
* **ui:** replace detail-panel toggle horde with AUTOMATION pill + panel ([#307](https://github.com/erwins-enkel/shepherd/issues/307)) ([e584db1](https://github.com/erwins-enkel/shepherd/commit/e584db1c2959d0ee2a61c254958a03755c2549e8))
* **ui:** type-scale tokens, git-toggle status dot, persistent steer-fail toast ([#313](https://github.com/erwins-enkel/shepherd/issues/313)) ([05b29c0](https://github.com/erwins-enkel/shepherd/commit/05b29c0bb5313e5dc41ba06821ed76de8f84b009))


### Bug Fixes

* **i18n:** shorten autopilot-paused badge label ([#302](https://github.com/erwins-enkel/shepherd/issues/302)) ([aaf69ba](https://github.com/erwins-enkel/shepherd/commit/aaf69ba2aa18bc90e2edda1f427462db4ac4970f))
* **ui:** resolve P1 & P2 findings from $impeccable audit (a11y, theming, responsive) ([#312](https://github.com/erwins-enkel/shepherd/issues/312)) ([8d6ae9c](https://github.com/erwins-enkel/shepherd/commit/8d6ae9ca5e31d340392b553f7667cb788e6de72a))

## [1.12.0](https://github.com/erwins-enkel/shepherd/compare/v1.11.0...v1.12.0) (2026-06-03)


### Features

* **autopilot:** opt-in pre-PR steering loop ([#290](https://github.com/erwins-enkel/shepherd/issues/290)) ([0cba707](https://github.com/erwins-enkel/shepherd/commit/0cba70720736615ac29b1c743f72d7c1746be9ab))
* **backlog:** failing-CI marker on Actions tab label ([#235](https://github.com/erwins-enkel/shepherd/issues/235)) ([#271](https://github.com/erwins-enkel/shepherd/issues/271)) ([45f6102](https://github.com/erwins-enkel/shepherd/commit/45f6102a283fe30c645bb152e77e2fc9b5a046bb))
* **critic:** dimmed FINAL badge while agent addresses last review round ([#285](https://github.com/erwins-enkel/shepherd/issues/285)) ([bbb0d1a](https://github.com/erwins-enkel/shepherd/commit/bbb0d1ae198855b41a85ade79a416495c7862697))
* **critic:** skip re-review on content-identical head changes (rebase-safe) ([#284](https://github.com/erwins-enkel/shepherd/issues/284)) ([46485ea](https://github.com/erwins-enkel/shepherd/commit/46485eaab4a6b14bc5d6001aa51245f4b4ea455f))
* **herdr-update:** persistent audit log + unconditional shepherd restart ([#274](https://github.com/erwins-enkel/shepherd/issues/274)) ([a95a762](https://github.com/erwins-enkel/shepherd/commit/a95a762e1fbf37aef22580542789453b07c5afee))
* **herdr-update:** render release notes as markdown ([#277](https://github.com/erwins-enkel/shepherd/issues/277)) ([c4e2a67](https://github.com/erwins-enkel/shepherd/commit/c4e2a670c1f49cb8eed632f4bbf8292d876d490a))
* **housekeeping:** prune old archived sessions on a daily sweep ([#287](https://github.com/erwins-enkel/shepherd/issues/287)) ([4a9700e](https://github.com/erwins-enkel/shepherd/commit/4a9700e2ed8d1aa734f5e36870a912bc694c4e96))
* **learnings:** close the flywheel — promote-to-CLAUDE.md PR + self-audit ([#228](https://github.com/erwins-enkel/shepherd/issues/228) PR2b) ([#273](https://github.com/erwins-enkel/shepherd/issues/273)) ([459a00d](https://github.com/erwins-enkel/shepherd/commit/459a00d383e1e7df9a8d9cfa3552711c05a5dca8))
* **learnings:** inject house rules via system prompt, XML-wrapped ([#278](https://github.com/erwins-enkel/shepherd/issues/278)) ([329b091](https://github.com/erwins-enkel/shepherd/commit/329b0912d1878aa75af3e986c4fddd9d578e5f42))
* **prs:** expand PR rollup dot into per-job CI breakdown ([#233](https://github.com/erwins-enkel/shepherd/issues/233)) ([#270](https://github.com/erwins-enkel/shepherd/issues/270)) ([a565b30](https://github.com/erwins-enkel/shepherd/commit/a565b301db03e3727d2e391f37577856063b0e21))
* **statuspip:** louder "needs you" marker — filled red badge ([#279](https://github.com/erwins-enkel/shepherd/issues/279)) ([d75483f](https://github.com/erwins-enkel/shepherd/commit/d75483f7fc88e82d28f9a04e225b3fbdd899d1da))


### Bug Fixes

* **critic:** don't steer findings into an agent after its PR merged ([#281](https://github.com/erwins-enkel/shepherd/issues/281)) ([775aa54](https://github.com/erwins-enkel/shepherd/commit/775aa543bbcb160cbafe1a2179c2e7e2249682d1))
* **gitrail:** make learning toggle show on/off state ([#282](https://github.com/erwins-enkel/shepherd/issues/282)) ([6bb60df](https://github.com/erwins-enkel/shepherd/commit/6bb60df3b792733c77e903d15fffadf9ccd15abf))
* **pr-poller:** fast-poll open PRs so the session list shows "CI running" ([#280](https://github.com/erwins-enkel/shepherd/issues/280)) ([2f58597](https://github.com/erwins-enkel/shepherd/commit/2f5859757af8ddab4284037230f9c21fbb63c03c))
* **steerbar:** align first steer chip under Tab key on mobile ([#289](https://github.com/erwins-enkel/shepherd/issues/289)) ([a076677](https://github.com/erwins-enkel/shepherd/commit/a07667741b6b83197388ab669e365a8c25568a7c))
* **tab-reaper:** reap orphaned distiller tabs ([#286](https://github.com/erwins-enkel/shepherd/issues/286)) ([fec9968](https://github.com/erwins-enkel/shepherd/commit/fec9968f242ec452d86dfd8d1036807a594643de))
* **viewport:** color PR toggle by CI+critic verdict, not mere PR existence ([#288](https://github.com/erwins-enkel/shepherd/issues/288)) ([5c96ca1](https://github.com/erwins-enkel/shepherd/commit/5c96ca15f40b261caca900a817a448d261347349))
* **viewport:** keep phone header identity row on one line ([#272](https://github.com/erwins-enkel/shepherd/issues/272)) ([aa18844](https://github.com/erwins-enkel/shepherd/commit/aa188445f366438930a70bfad24e07e490bb74b7))
* **viewport:** surface ready-to-merge toggle on desktop ([#283](https://github.com/erwins-enkel/shepherd/issues/283)) ([2c453b5](https://github.com/erwins-enkel/shepherd/commit/2c453b50189b32f877234b38bc9092a4ce13b546))

## [1.11.0](https://github.com/erwins-enkel/shepherd/compare/v1.10.0...v1.11.0) (2026-06-03)


### Features

* **actions:** re-run / cancel buttons per workflow run ([#232](https://github.com/erwins-enkel/shepherd/issues/232)) ([#264](https://github.com/erwins-enkel/shepherd/issues/264)) ([5a40ab3](https://github.com/erwins-enkel/shepherd/commit/5a40ab36529942d31a4b1f11017837f0c5bc02cd))
* **critic:** [#247](https://github.com/erwins-enkel/shepherd/issues/247) follow-up polish for auto-address loop ([#266](https://github.com/erwins-enkel/shepherd/issues/266)) ([0bb7282](https://github.com/erwins-enkel/shepherd/commit/0bb7282b3fab36fc28ee682f7761202862570446))
* **herd:** rename auto post-agent group "Waiting for merge" → "Your turn" ([#268](https://github.com/erwins-enkel/shepherd/issues/268)) ([63a2fa4](https://github.com/erwins-enkel/shepherd/commit/63a2fa472caff078719b0bf8d41db737bc8a7e88))
* **learnings:** bound injected house-rules block with operator-visible budget ([#253](https://github.com/erwins-enkel/shepherd/issues/253)) ([#265](https://github.com/erwins-enkel/shepherd/issues/265)) ([fd93bfa](https://github.com/erwins-enkel/shepherd/commit/fd93bfa816139c0962139cd2b517c781fd3aaa18))


### Bug Fixes

* **controlbar:** drop scrolling bar's left gutter so Esc→Tab gap isn't doubled ([#262](https://github.com/erwins-enkel/shepherd/issues/262)) ([521fc2e](https://github.com/erwins-enkel/shepherd/commit/521fc2e15b15d075e45c20ba950670e5078ce837))
* **herd:** keep in-loop agent out of "waiting for merge" during auto-correct ([#267](https://github.com/erwins-enkel/shepherd/issues/267)) ([b8098d5](https://github.com/erwins-enkel/shepherd/commit/b8098d5004f846c6f7c8d91d2d1b3c5fb49a6a59))
* **newtask:** seed issue title verbatim into task prompt so session names aren't nonsensical ([#263](https://github.com/erwins-enkel/shepherd/issues/263)) ([8318331](https://github.com/erwins-enkel/shepherd/commit/8318331a0adc1813002a178e68ed07fab75c0e9c))

## [1.10.0](https://github.com/erwins-enkel/shepherd/compare/v1.9.0...v1.10.0) (2026-06-03)


### Features

* **backlog:** live-poll Actions tab while runs pending ([#246](https://github.com/erwins-enkel/shepherd/issues/246)) ([af6c7c6](https://github.com/erwins-enkel/shepherd/commit/af6c7c65f781ce1085164184c42c9e27a2e7889d))
* **critic:** auto-address loop — agent fixes critic findings until clean ([#243](https://github.com/erwins-enkel/shepherd/issues/243)) ([d841735](https://github.com/erwins-enkel/shepherd/commit/d841735c23737f13b218282e8613e0bbefa6f5ae))
* **gitrail:** dim page behind review findings popover ([#259](https://github.com/erwins-enkel/shepherd/issues/259)) ([1325796](https://github.com/erwins-enkel/shepherd/commit/132579617d8feb76396839bf5bd186f597643868))
* **herd:** group open PRs by CI/merge state so done-but-waiting cards sort down ([#261](https://github.com/erwins-enkel/shepherd/issues/261)) ([df94f30](https://github.com/erwins-enkel/shepherd/commit/df94f30e922f56daad95fc8855fb63ac324ee441))
* **learnings:** close the flywheel — inject curated house rules into agents (PR2a) ([#249](https://github.com/erwins-enkel/shepherd/issues/249)) ([2517236](https://github.com/erwins-enkel/shepherd/commit/25172366aa827ef734a507909d28365a814be95e))
* **namer:** pre-warn agent + toast when branch auto-renames ([#255](https://github.com/erwins-enkel/shepherd/issues/255)) ([a71dc5d](https://github.com/erwins-enkel/shepherd/commit/a71dc5ddcd3418e184b592da43349948299c288a))
* **prune:** periodic local branch pruning for merged shepherd/* branches ([#257](https://github.com/erwins-enkel/shepherd/issues/257)) ([ccbbcff](https://github.com/erwins-enkel/shepherd/commit/ccbbcff046ee0f1210b397ea2ff46e4d88599309))


### Bug Fixes

* **backlog:** scope tab counts to selected repo + add Actions count ([#244](https://github.com/erwins-enkel/shepherd/issues/244)) ([ca91448](https://github.com/erwins-enkel/shepherd/commit/ca914489e03123e31713db56028b32109bfa026e))
* **controlbar:** scroll Tab/Space, freeze only Esc so portrait scroll window isn't 2 keys wide ([#256](https://github.com/erwins-enkel/shepherd/issues/256)) ([37711f6](https://github.com/erwins-enkel/shepherd/commit/37711f624d37d6e79929f462a15782918c388a98))
* **gitrail:** keep review send-to-agent button reachable on short viewports ([#248](https://github.com/erwins-enkel/shepherd/issues/248)) ([e2853b1](https://github.com/erwins-enkel/shepherd/commit/e2853b1fb9ffd8e76646dc76956325e59dc3ebe4))
* **pr-poller:** recognize PRs after an agent renames its branch ([#254](https://github.com/erwins-enkel/shepherd/issues/254)) ([c28c5c7](https://github.com/erwins-enkel/shepherd/commit/c28c5c73a3631dc6c95c06e5c61b5755ee7f472f))
* **steerbar:** align collapsed broadcast chip left edge with Esc key ([#258](https://github.com/erwins-enkel/shepherd/issues/258)) ([6266315](https://github.com/erwins-enkel/shepherd/commit/6266315d1ed597099294291f6c82b0aa634b0e0d))
* **steerbar:** match collapsed broadcast chip width to Esc key ([#251](https://github.com/erwins-enkel/shepherd/issues/251)) ([f746420](https://github.com/erwins-enkel/shepherd/commit/f7464208fcfeed9ee86e9c3bbd3f49ebe8001580))
* **steer:** bracketed-paste wrap so multi-line steers actually submit ([#260](https://github.com/erwins-enkel/shepherd/issues/260)) ([99effbd](https://github.com/erwins-enkel/shepherd/commit/99effbd820f5fbfb9e5dbcdec0f293298f558ef7))
* **ui:** resync data on tab return (mobile stale-after-wake) ([#252](https://github.com/erwins-enkel/shepherd/issues/252)) ([b6d0fe0](https://github.com/erwins-enkel/shepherd/commit/b6d0fe042698b950007d3192438a4dde464d8575))
* **viewport:** tighten mobile session-name cap so close button stays on row ([#250](https://github.com/erwins-enkel/shepherd/issues/250)) ([d7e611b](https://github.com/erwins-enkel/shepherd/commit/d7e611bffe08d8cff1af69cf52a9e23bbe84ca63))

## [1.9.0](https://github.com/erwins-enkel/shepherd/compare/v1.8.0...v1.9.0) (2026-06-03)


### Features

* **activity:** render Task* tools in the activity feed ([#219](https://github.com/erwins-enkel/shepherd/issues/219)) ([4105227](https://github.com/erwins-enkel/shepherd/commit/410522778939862f11712c06bcb49b48e78dd832))
* **backlog:** per-job GitHub Actions tab per repo ([#240](https://github.com/erwins-enkel/shepherd/issues/240)) ([bff9257](https://github.com/erwins-enkel/shepherd/commit/bff9257bd22b47083987e596b01720c98be037c2))
* **backlog:** push live counts over WS so overview never goes stale ([#230](https://github.com/erwins-enkel/shepherd/issues/230)) ([5765d6a](https://github.com/erwins-enkel/shepherd/commit/5765d6a8faee48a788997fbc60b8cbfd6aea69b7))
* **controlbar:** add Space key to mobile control bar ([#223](https://github.com/erwins-enkel/shepherd/issues/223)) ([34e4b0d](https://github.com/erwins-enkel/shepherd/commit/34e4b0d29ecf469852e23aba448597db38c9fc63))
* **learnings:** learnings flywheel — capture, distill, approve (PR1) ([#224](https://github.com/erwins-enkel/shepherd/issues/224)) ([006aedc](https://github.com/erwins-enkel/shepherd/commit/006aedc0778c409ff60ef8974bad2097b8f642ca))
* **namer:** LLM-comprehended session names (async refine) ([#218](https://github.com/erwins-enkel/shepherd/issues/218)) ([d09b0a5](https://github.com/erwins-enkel/shepherd/commit/d09b0a53dc9906874810471cdc3bed1698feda69))
* **sessions:** clear out all merged-branch sessions ([#221](https://github.com/erwins-enkel/shepherd/issues/221)) ([2340ea6](https://github.com/erwins-enkel/shepherd/commit/2340ea6c875e39a68c5298e76fd8d7d959077b67))
* **ui:** add WCAG high-contrast toggle to footer theme controls ([#226](https://github.com/erwins-enkel/shepherd/issues/226)) ([d5e9c7e](https://github.com/erwins-enkel/shepherd/commit/d5e9c7eb8aa83aca6bb5a8cd0b37553df709ec19))
* **ui:** expose version/SHA/repo in Settings for mobile ([#214](https://github.com/erwins-enkel/shepherd/issues/214)) ([7facfd7](https://github.com/erwins-enkel/shepherd/commit/7facfd76dbb03b435268858495f606b81d674813))
* **ui:** keyboard shortcuts for New Task (n) and Backlog (b) ([#225](https://github.com/erwins-enkel/shepherd/issues/225)) ([b2f6a57](https://github.com/erwins-enkel/shepherd/commit/b2f6a57a1948931e26c267a26db7f95075326e38))


### Bug Fixes

* **backlog:** make Issues/PRs toggle work on mobile ([#215](https://github.com/erwins-enkel/shepherd/issues/215)) ([ff0ff44](https://github.com/erwins-enkel/shepherd/commit/ff0ff440d8a22e02de32d8af16454f773c9ca0ae))
* **backlog:** show all open issues so list matches the count ([#239](https://github.com/erwins-enkel/shepherd/issues/239)) ([0834743](https://github.com/erwins-enkel/shepherd/commit/08347438b4f98ce7dda954c20d29597d3993e88c))
* **gitignore:** stop ignoring docs/superpowers ([#238](https://github.com/erwins-enkel/shepherd/issues/238)) ([929b68d](https://github.com/erwins-enkel/shepherd/commit/929b68d2e1be7a96de6ee20bb65f6c5b4dc6d810))
* **herdr-update:** stop herdr server before non-interactive update ([#241](https://github.com/erwins-enkel/shepherd/issues/241)) ([f88d607](https://github.com/erwins-enkel/shepherd/commit/f88d6075fd780ef06be83a0a0e70423d844b879b))
* **i18n:** rename EN status WORKING→BUSY to disambiguate from WAITING ([#216](https://github.com/erwins-enkel/shepherd/issues/216)) ([0b18564](https://github.com/erwins-enkel/shepherd/commit/0b18564661bc3324c848b59470fe87f41d26fda2))
* **topbar:** collapse Learnings badge to icon+count on mobile ([#237](https://github.com/erwins-enkel/shepherd/issues/237)) ([0feea23](https://github.com/erwins-enkel/shepherd/commit/0feea23bac60531d02550134d42ebbe847ac73bf))
* **ui:** retune blocked-header wash for light theme ([#217](https://github.com/erwins-enkel/shepherd/issues/217)) ([7cf48ef](https://github.com/erwins-enkel/shepherd/commit/7cf48ef3b4d61cf759a9a0fe6cab4ddb06a8558e))
* **viewport:** show jump-to-bottom when the agent owns the scroll ([#242](https://github.com/erwins-enkel/shepherd/issues/242)) ([9c669a2](https://github.com/erwins-enkel/shepherd/commit/9c669a2a0a6f197685293b27771f65c4cb066d25))

## [1.8.0](https://github.com/erwins-enkel/shepherd/compare/v1.7.0...v1.8.0) (2026-06-02)


### Features

* **backlog:** implement PRs tab (list, review-task, merge) ([#212](https://github.com/erwins-enkel/shepherd/issues/212)) ([20782d8](https://github.com/erwins-enkel/shepherd/commit/20782d81ba61aef7ecc5388fa06b3dc04db20125))
* **namer:** command-prefix strip, extra stopwords, herd-qualified collision names ([#209](https://github.com/erwins-enkel/shepherd/issues/209)) ([9342ead](https://github.com/erwins-enkel/shepherd/commit/9342ead8d9a8e6154c2566dbfd7dc57f96fbbe90)), closes [#200](https://github.com/erwins-enkel/shepherd/issues/200) [#208](https://github.com/erwins-enkel/shepherd/issues/208)


### Bug Fixes

* **ui:** impeccable audit follow-ups — a11y, side-stripe, touch targets, radii ([#211](https://github.com/erwins-enkel/shepherd/issues/211)) ([05f427c](https://github.com/erwins-enkel/shepherd/commit/05f427cc4b366a955452644a24491097bfbc2782))
* **ui:** impeccable critique fixes — status color, hairline stripe, mobile dvh, onboarding ([#213](https://github.com/erwins-enkel/shepherd/issues/213)) ([97039ba](https://github.com/erwins-enkel/shepherd/commit/97039bac3a58d634839c0d82bbb997d315736fcd))
* **ui:** impeccable polish — input focus tokens + phantom-token fixes ([#206](https://github.com/erwins-enkel/shepherd/issues/206)) ([603766c](https://github.com/erwins-enkel/shepherd/commit/603766c58b793e8f92cc14954aaa6b1666f65c0c))


### Code Refactoring

* **ui:** rename "PR running" group to "CI running" ([#210](https://github.com/erwins-enkel/shepherd/issues/210)) ([674ee85](https://github.com/erwins-enkel/shepherd/commit/674ee85ca7c3255b79cc5b3f4cea9a824bf4c30d))

## [1.7.0](https://github.com/erwins-enkel/shepherd/compare/v1.6.0...v1.7.0) (2026-06-02)


### Features

* **namer:** pick session names by specificity, not position ([#201](https://github.com/erwins-enkel/shepherd/issues/201)) ([58e1434](https://github.com/erwins-enkel/shepherd/commit/58e14344cc253ae3a276b95156d5b682eb8d559c))
* **push:** per-category notification selection ([#203](https://github.com/erwins-enkel/shepherd/issues/203)) ([fbe6fe8](https://github.com/erwins-enkel/shepherd/commit/fbe6fe8b237454fd28e6289cdef757c6884cf2f6))
* **slash:** recognize commands mid-text, not just at prompt start ([#205](https://github.com/erwins-enkel/shepherd/issues/205)) ([801ed61](https://github.com/erwins-enkel/shepherd/commit/801ed6116d404caacc6433567566e062db6fecf4))
* **ui:** ambient amber pulse on mobile header while agent works ([#202](https://github.com/erwins-enkel/shepherd/issues/202)) ([38276fc](https://github.com/erwins-enkel/shepherd/commit/38276fcf9a9db153395bc35a9a20e8ba1be72975))
* **ui:** dim a session while its decommission undo is offered ([#197](https://github.com/erwins-enkel/shepherd/issues/197)) ([16a3cac](https://github.com/erwins-enkel/shepherd/commit/16a3cac85e844f6876e26d8209e10d81916e8e8d))
* **ui:** group session list by PR-running and reviewer-running stages ([#204](https://github.com/erwins-enkel/shepherd/issues/204)) ([db4cb7f](https://github.com/erwins-enkel/shepherd/commit/db4cb7f73796426898ee48b41095bb83123fcd3e))


### Bug Fixes

* **ui:** close integration seams from the critique merge train ([#192](https://github.com/erwins-enkel/shepherd/issues/192)) ([ae6f8bd](https://github.com/erwins-enkel/shepherd/commit/ae6f8bd27b0bf5fe9d46957e5dd12920a4559c8b))
* **ui:** impeccable audit remediation — a11y, perf, theming, touch, copy ([#198](https://github.com/erwins-enkel/shepherd/issues/198)) ([4582656](https://github.com/erwins-enkel/shepherd/commit/4582656f72b4343abb2b16f65b99d8d752e20641))
* **ui:** stop compact herd cards crushing the agent name ([#195](https://github.com/erwins-enkel/shepherd/issues/195)) ([aad6c58](https://github.com/erwins-enkel/shepherd/commit/aad6c589dfb2852bcccfeb28f1538c197ef7dfc4))
* **ui:** tabbed settings modal so it never overflows viewport ([#196](https://github.com/erwins-enkel/shepherd/issues/196)) ([cb72883](https://github.com/erwins-enkel/shepherd/commit/cb728837729d99c236a050f44d03b8d658f2342b))
* **ui:** wrap detail header controls as a cluster on mobile ([#199](https://github.com/erwins-enkel/shepherd/issues/199)) ([1828c4a](https://github.com/erwins-enkel/shepherd/commit/1828c4a43bb454208c4683271e4a30fab87c025d))
* **viewport:** keep swipe-up compose reachable on unfolded foldables ([#193](https://github.com/erwins-enkel/shepherd/issues/193)) ([67d7076](https://github.com/erwins-enkel/shepherd/commit/67d70762beb6d366d9b58f65dbe028009482084d))

## [1.6.0](https://github.com/erwins-enkel/shepherd/compare/v1.5.0...v1.6.0) (2026-06-02)


### Features

* detect & terminate leftover subprocesses on session close ([#89](https://github.com/erwins-enkel/shepherd/issues/89)) ([#163](https://github.com/erwins-enkel/shepherd/issues/163)) ([8b2c396](https://github.com/erwins-enkel/shepherd/commit/8b2c396d9684205b5a9730fc471a667a5cfc746e))
* **onboard:** first-run empty-herd state + standard-command nudge ([#190](https://github.com/erwins-enkel/shepherd/issues/190)) ([7c33f03](https://github.com/erwins-enkel/shepherd/commit/7c33f039eadcdec7967a4b241f952a6ad012b0ee))
* **ui:** harden destructive actions with confirm + undo toasts ([#185](https://github.com/erwins-enkel/shepherd/issues/185)) ([b384842](https://github.com/erwins-enkel/shepherd/commit/b384842ebb47bec5bd7033bade21d990a81dde2e))
* **viewport:** group desktop git rail behind a PR disclosure ([#188](https://github.com/erwins-enkel/shepherd/issues/188)) ([5d6073b](https://github.com/erwins-enkel/shepherd/commit/5d6073b9a1789006ccd018076de82e2a7a695197))
* **viewport:** tappable pulsing "add notes" key on mobile control row ([#180](https://github.com/erwins-enkel/shepherd/issues/180)) ([fbeeea5](https://github.com/erwins-enkel/shepherd/commit/fbeeea57c7de9e041f36216f111b3e55a8f65953))


### Bug Fixes

* **badge:** lead MERGED badge with checkmark to match siblings ([#176](https://github.com/erwins-enkel/shepherd/issues/176)) ([1bd64fe](https://github.com/erwins-enkel/shepherd/commit/1bd64fed5748fd28eeaa38de6c172b5148b44fdd))
* **gitrail:** wrap markdown review findings (no horizontal scroll) ([#183](https://github.com/erwins-enkel/shepherd/issues/183)) ([cc5e3b2](https://github.com/erwins-enkel/shepherd/commit/cc5e3b2714d0fdd7b07623a16b0eab0ddf29d738))
* **herdr:** close tab on teardown + reap orphan helper tabs ([#186](https://github.com/erwins-enkel/shepherd/issues/186)) ([b4e94c3](https://github.com/erwins-enkel/shepherd/commit/b4e94c3d8d592ff4157940bd6993941be17606a2))
* **motion:** keep work-happening pulses under prefers-reduced-motion ([#191](https://github.com/erwins-enkel/shepherd/issues/191)) ([d083710](https://github.com/erwins-enkel/shepherd/commit/d083710f396d1fc8cb1eb5d4e3936187eaeddab8))
* **reaper:** don't flag shepherd server itself on session close ([#89](https://github.com/erwins-enkel/shepherd/issues/89)) ([#184](https://github.com/erwins-enkel/shepherd/issues/184)) ([b964659](https://github.com/erwins-enkel/shepherd/commit/b964659100062d09c0181af2a42df2d15705f6f3))
* **steerbar:** reliable gap between 📡 and broadcast label ([#178](https://github.com/erwins-enkel/shepherd/issues/178)) ([af64803](https://github.com/erwins-enkel/shepherd/commit/af64803a5fb063d35e2692e8ab6dc918e5e42afd))
* **topbar:** hide clock time on unfolded foldable when update badge shown ([#175](https://github.com/erwins-enkel/shepherd/issues/175)) ([7363e96](https://github.com/erwins-enkel/shepherd/commit/7363e9613e1b663ef1a685ebbd8b7c1e000a4c98))
* **topbar:** route self-update badge title through m.* (i18n) ([#179](https://github.com/erwins-enkel/shepherd/issues/179)) ([779a831](https://github.com/erwins-enkel/shepherd/commit/779a83132333079949ccfce3c9dda7e68993fbcc))
* **ui:** actionable error states + inline retry for git/task/broadcast ([#189](https://github.com/erwins-enkel/shepherd/issues/189)) ([3ec900c](https://github.com/erwins-enkel/shepherd/commit/3ec900c9d417856fce0dcdd8038899df706a906d))
* **usage-probe:** reap leftover herdr tabs so probes don't leak ([#182](https://github.com/erwins-enkel/shepherd/issues/182)) ([94f43b1](https://github.com/erwins-enkel/shepherd/commit/94f43b120a8dda524aff7e875ab4e7ac1fd926b7))
* **viewport:** let bottom button bars scroll without triggering agent swipe ([#171](https://github.com/erwins-enkel/shepherd/issues/171)) ([286bcf3](https://github.com/erwins-enkel/shepherd/commit/286bcf367168ee22b93ad394834a466acc4530d8))


### Performance Improvements

* **topbar:** drive gauge fill via scaleX instead of width ([#187](https://github.com/erwins-enkel/shepherd/issues/187)) ([af9ce75](https://github.com/erwins-enkel/shepherd/commit/af9ce75db92c3588f75bd12ea41a0ae4f32fbf33))


### Documentation

* add impeccable PRODUCT.md + DESIGN.md design context ([#181](https://github.com/erwins-enkel/shepherd/issues/181)) ([b9b8cc8](https://github.com/erwins-enkel/shepherd/commit/b9b8cc89b4dd52c208cf54f6f9609faff424f2b8))

## [1.5.0](https://github.com/erwins-enkel/shepherd/compare/v1.4.0...v1.5.0) (2026-06-01)


### Features

* **actionbar:** collapse source link to GitHub icon, keep buttons single-line ([#173](https://github.com/erwins-enkel/shepherd/issues/173)) ([273c6a3](https://github.com/erwins-enkel/shepherd/commit/273c6a322b0bde85c96cb73b14460e5915ce739a))
* **backlog:** one-click quick-launch with a configurable standard command ([#170](https://github.com/erwins-enkel/shepherd/issues/170)) ([09842f8](https://github.com/erwins-enkel/shepherd/commit/09842f8bd650662e887d244dce0ffb7c9d5209ad))
* **badge:** hide WAITING/IDLE status while critic is reviewing ([#150](https://github.com/erwins-enkel/shepherd/issues/150)) ([91e44fc](https://github.com/erwins-enkel/shepherd/commit/91e44fca4c8ac3a67bc30f555d4d8c90965a3ee6))
* **composebar:** inline slash-command autocomplete in terminal send box ([#165](https://github.com/erwins-enkel/shepherd/issues/165)) ([66ab369](https://github.com/erwins-enkel/shepherd/commit/66ab369141551a2e177f53b50fe7d65c0d46d2ca))
* **compose:** on-demand compose sheet — swipe-up + one-tap dictate ([#172](https://github.com/erwins-enkel/shepherd/issues/172)) ([c92a8bb](https://github.com/erwins-enkel/shepherd/commit/c92a8bb6732493b3557778fce901926884337493))
* **gitrail:** render critic findings as markdown ([#151](https://github.com/erwins-enkel/shepherd/issues/151)) ([1b7fbf1](https://github.com/erwins-enkel/shepherd/commit/1b7fbf1d0bb5a3b4077bc7b8a825ff7214c28728))
* **gitrail:** slim reviewer controls on done tasks ([#152](https://github.com/erwins-enkel/shepherd/issues/152)) ([de12726](https://github.com/erwins-enkel/shepherd/commit/de127261c80f6eb273035ffbcf53fcea1143e054))
* **herd:** add READY sidebar filter (sessions not actively working) ([#154](https://github.com/erwins-enkel/shepherd/issues/154)) ([a40332f](https://github.com/erwins-enkel/shepherd/commit/a40332f5c094472b909ebe01e8f7261d9f13fe28))
* **herd:** group merged-PR sessions in their own section ([#168](https://github.com/erwins-enkel/shepherd/issues/168)) ([ac7fa50](https://github.com/erwins-enkel/shepherd/commit/ac7fa50e27244b1f9c8831d2297b5741abd7ff02))
* **mobile:** swipe session row to decommission with confirm ([#142](https://github.com/erwins-enkel/shepherd/issues/142)) ([9ac064d](https://github.com/erwins-enkel/shepherd/commit/9ac064ddf738c2be90cf86782d0b8be0a79fb123))
* **newtask:** commands tab to seed installed slash commands ([#147](https://github.com/erwins-enkel/shepherd/issues/147)) ([46fa1e4](https://github.com/erwins-enkel/shepherd/commit/46fa1e451814087d51bdf8204f228726f0f6ace9))
* **newtask:** inline slash-command autocomplete in prompt field ([#157](https://github.com/erwins-enkel/shepherd/issues/157)) ([d7307cc](https://github.com/erwins-enkel/shepherd/commit/d7307ccc9d610c28094619d5fa492efd6bc6806c))
* **push:** push events for PR reviews + CI status ([#169](https://github.com/erwins-enkel/shepherd/issues/169)) ([b90fe0e](https://github.com/erwins-enkel/shepherd/commit/b90fe0e11a5a7a73972fe61c2600840c320448d3))
* **session:** rename a session by one click, propagating to git branch & PR ([#159](https://github.com/erwins-enkel/shepherd/issues/159)) ([78b9c79](https://github.com/erwins-enkel/shepherd/commit/78b9c79ba624898ade219e351b7b83bdaf3c16ac))
* **sessions:** manual "ready to merge" state ([#155](https://github.com/erwins-enkel/shepherd/issues/155)) ([030df98](https://github.com/erwins-enkel/shepherd/commit/030df98cd4c5ead2530e71996af050b1f30c1a56))
* **steerbar:** collapse broadcast chip to icon-only on mobile ([#166](https://github.com/erwins-enkel/shepherd/issues/166)) ([7c22e08](https://github.com/erwins-enkel/shepherd/commit/7c22e08dab312402e444019f9b414b185f35fbbb))
* **triage:** slide drawer out when all needs-you items are handled ([#156](https://github.com/erwins-enkel/shepherd/issues/156)) ([3cc3ec2](https://github.com/erwins-enkel/shepherd/commit/3cc3ec2eb4ad19d4afc1114b8a10dda3e25106f6))
* **ui:** cross-project backlog reachable while agents run + dedupe worktrees ([#140](https://github.com/erwins-enkel/shepherd/issues/140)) ([3a97d49](https://github.com/erwins-enkel/shepherd/commit/3a97d49b759c8707059c34e4d25f42b0eadbecc0))
* **ui:** regroup mobile control bar for one-thumb usability ([#143](https://github.com/erwins-enkel/shepherd/issues/143)) ([b83638e](https://github.com/erwins-enkel/shepherd/commit/b83638e94855bab80d27ec29803a4cadfc913186))
* **viewport:** promote decommission button once a PR exists ([#158](https://github.com/erwins-enkel/shepherd/issues/158)) ([8b7096e](https://github.com/erwins-enkel/shepherd/commit/8b7096eccf93dd7f79ecb8baafb7250fb72a4983))
* **viewport:** swipe left/right to switch agents on mobile ([#161](https://github.com/erwins-enkel/shepherd/issues/161)) ([387f1b0](https://github.com/erwins-enkel/shepherd/commit/387f1b051673b916f585d2447689b6e06812e9cb))
* **viewport:** swipe pane right to go back to list on mobile ([#141](https://github.com/erwins-enkel/shepherd/issues/141)) ([1ccc03b](https://github.com/erwins-enkel/shepherd/commit/1ccc03bc39a857633ab026e30b5538ec773f4ea3))


### Bug Fixes

* **gitrail:** close findings panel after sending review to agent ([#167](https://github.com/erwins-enkel/shepherd/issues/167)) ([42f5c07](https://github.com/erwins-enkel/shepherd/commit/42f5c07ba37c5452a9cd95a1a0607f8320620bd7))
* **settings:** scroll full-screen settings card on mobile ([#174](https://github.com/erwins-enkel/shepherd/issues/174)) ([2c3eeef](https://github.com/erwins-enkel/shepherd/commit/2c3eeefaec40777e7160514fd3751858cec9cd53))
* **ui:** make CI-pending dot actually pulse (opacity blink) ([#160](https://github.com/erwins-enkel/shepherd/issues/160)) ([506cf7a](https://github.com/erwins-enkel/shepherd/commit/506cf7a913b22d055bc4676bcc146116d4dedf0d))
* **ui:** nest PR CI dot in badge + green success status ([#148](https://github.com/erwins-enkel/shepherd/issues/148)) ([784835a](https://github.com/erwins-enkel/shepherd/commit/784835a884c13f339eea9db5cff8fbb3a788078e))
* **ui:** pulse CI-pending dot like other in-progress indicators ([#149](https://github.com/erwins-enkel/shepherd/issues/149)) ([3fa7bf4](https://github.com/erwins-enkel/shepherd/commit/3fa7bf4fe48286489f0d64f946eef58f4a02952f))
* **ui:** show issue title in new-task picker by capping labels at 3 ([#144](https://github.com/erwins-enkel/shepherd/issues/144)) ([a01c550](https://github.com/erwins-enkel/shepherd/commit/a01c550546fb3b269599111d24af93f887a951c0))
* **ui:** stop overusing amber on unit cards ([#153](https://github.com/erwins-enkel/shepherd/issues/153)) ([3d94d12](https://github.com/erwins-enkel/shepherd/commit/3d94d12ff409d3d942b39d943fb6fed2b5e17e8c))


### Performance Improvements

* **backlog:** async gh runner + background cache warmer ([#145](https://github.com/erwins-enkel/shepherd/issues/145)) ([a380127](https://github.com/erwins-enkel/shepherd/commit/a380127c23f2b7dce71dca45c1b0b17e000fcff4))


### Documentation

* **readme:** highlight local slash-command surface as a differentiator ([#164](https://github.com/erwins-enkel/shepherd/issues/164)) ([ccb2904](https://github.com/erwins-enkel/shepherd/commit/ccb2904aac3d3b3098bab7de6b327ef96a59cd00))

## [1.4.0](https://github.com/erwins-enkel/shepherd/compare/v1.3.0...v1.4.0) (2026-06-01)


### Features

* **backlog:** Backlog Deep Dive — Launchpad für die leere Übersicht ([#125](https://github.com/erwins-enkel/shepherd/issues/125)) ([ab58460](https://github.com/erwins-enkel/shepherd/commit/ab584601d77a75afe2bae99bd855095ba57f2f0f))
* **compose:** enter inserts newline on mobile, drop redundant ↵ button ([#129](https://github.com/erwins-enkel/shepherd/issues/129)) ([e6e1968](https://github.com/erwins-enkel/shepherd/commit/e6e1968bbc7778f582edf8db5ffe03fd00e95f0d))
* **gitrail:** add explanatory tooltip to critic toggle ([#130](https://github.com/erwins-enkel/shepherd/issues/130)) ([f83594b](https://github.com/erwins-enkel/shepherd/commit/f83594ba78be5f9b27d5a805d0195875978ab199))
* **gitrail:** view critic findings inline without opening PR ([#137](https://github.com/erwins-enkel/shepherd/issues/137)) ([10ba63a](https://github.com/erwins-enkel/shepherd/commit/10ba63a32a80ed6229cdca3358a7c0c366b6c8cb))
* **newtask:** attach issues by reference instead of dumping the body into the prompt ([#128](https://github.com/erwins-enkel/shepherd/issues/128)) ([11b2664](https://github.com/erwins-enkel/shepherd/commit/11b266400cfcf5bf50d0bdbddbeed814ac2047cd))
* **push:** swap placeholder crook icon for solid bell + monochrome badge ([#135](https://github.com/erwins-enkel/shepherd/issues/135)) ([c3f3402](https://github.com/erwins-enkel/shepherd/commit/c3f340293f4fa18eead31106e6ab967c37d49b17))
* **session:** disable Claude Code remote control by default in spawned sessions ([#124](https://github.com/erwins-enkel/shepherd/issues/124)) ([0c3a2ef](https://github.com/erwins-enkel/shepherd/commit/0c3a2ef357dbc5652e41b8f892706382ac5031db))
* **ui:** collapse terminal-focus header to one row on mobile ([#122](https://github.com/erwins-enkel/shepherd/issues/122)) ([f0a5cb5](https://github.com/erwins-enkel/shepherd/commit/f0a5cb52046ece22c2873fee8c55f7c99247ec10))
* **ui:** hint Shift/⌥-drag selects terminal text ([#117](https://github.com/erwins-enkel/shepherd/issues/117)) ([49b7afd](https://github.com/erwins-enkel/shepherd/commit/49b7afd89a9103fcf7c19de6f380de0f70432a13))
* **ui:** show CI status dot in session list PR badge ([#136](https://github.com/erwins-enkel/shepherd/issues/136)) ([af87b14](https://github.com/erwins-enkel/shepherd/commit/af87b14283389eef6074bd53ec790f8690da8667))
* **ui:** show in-progress critic badge in session list ([#134](https://github.com/erwins-enkel/shepherd/issues/134)) ([2e729a5](https://github.com/erwins-enkel/shepherd/commit/2e729a59663b88b0d15c41c176f56f4636cd2400))


### Bug Fixes

* **gitrail:** wrap whole buttons on mobile instead of squeezing labels ([#133](https://github.com/erwins-enkel/shepherd/issues/133)) ([ca5b796](https://github.com/erwins-enkel/shepherd/commit/ca5b796a0d57781d9d5ab51de2a25ab7ba2e517a))
* **newtask:** inset mobile prompt + align close button ([#127](https://github.com/erwins-enkel/shepherd/issues/127)) ([c0b462b](https://github.com/erwins-enkel/shepherd/commit/c0b462ba0a64ccadf9f8c068bd2f3fd1b2b1067c))
* **push:** always show notification on mobile; harden SW push handler ([#126](https://github.com/erwins-enkel/shepherd/issues/126)) ([8729e79](https://github.com/erwins-enkel/shepherd/commit/8729e7912fa3e49e30474e9cfa3b74718be0ea6b))
* **push:** suppress active-app banners server-side (works on Android) ([#138](https://github.com/erwins-enkel/shepherd/issues/138)) ([4d2538a](https://github.com/erwins-enkel/shepherd/commit/4d2538aaf5457a5d2cbdfe5ea733289e256409ce))
* **push:** suppress notifications while the app is in active use ([#121](https://github.com/erwins-enkel/shepherd/issues/121)) ([49239db](https://github.com/erwins-enkel/shepherd/commit/49239db0a2ab467e67f69b0d629e9969020b874f))
* **steer:** submit reply with a separate carriage return ([#132](https://github.com/erwins-enkel/shepherd/issues/132)) ([9bc8667](https://github.com/erwins-enkel/shepherd/commit/9bc866705797f9f785a612e928277e5a79f77f41))
* **ui:** move PR CI dot left of badge so right column aligns ([#139](https://github.com/erwins-enkel/shepherd/issues/139)) ([0d20926](https://github.com/erwins-enkel/shepherd/commit/0d209261b755b2bc25bc098d89704da109948042))
* **viewport:** route stray desktop Esc into the terminal ([#118](https://github.com/erwins-enkel/shepherd/issues/118)) ([4c385b2](https://github.com/erwins-enkel/shepherd/commit/4c385b2893c07e5dfb2ed250da5fe7644818abd8))
* **viewport:** unify "needs you" call-out with TopBar badge ([#131](https://github.com/erwins-enkel/shepherd/issues/131)) ([e1366f8](https://github.com/erwins-enkel/shepherd/commit/e1366f8c50cd90468804807fec416892603b24a0))


### Performance Improvements

* **viewport:** gate stray-Esc handler before DOM read + skip mid-IME ([#123](https://github.com/erwins-enkel/shepherd/issues/123)) ([629d15c](https://github.com/erwins-enkel/shepherd/commit/629d15cb176919f48a25b8d742cf7d83d2fefd71))

## [1.3.0](https://github.com/erwins-enkel/shepherd/compare/v1.2.0...v1.3.0) (2026-06-01)


### Features

* critic-on-PR — auto code review on CI-green PRs ([#80](https://github.com/erwins-enkel/shepherd/issues/80)) ([3e0ec0c](https://github.com/erwins-enkel/shepherd/commit/3e0ec0c222cdf6f536f91ff03a1a0ec85b022c0b))
* **namer:** keep 3 topical words to cut slug collisions ([#113](https://github.com/erwins-enkel/shepherd/issues/113)) ([4eacd1c](https://github.com/erwins-enkel/shepherd/commit/4eacd1c3d040d094ba520afbfc5df15cb71a7d95))
* poll PR status on agent-settle for instant badge ([#114](https://github.com/erwins-enkel/shepherd/issues/114)) ([32f28d6](https://github.com/erwins-enkel/shepherd/commit/32f28d6c3827ebb08d54db0fe84e3bd6845ca3f2))
* **skills:** merge-train — review open PRs & propose merge order ([#115](https://github.com/erwins-enkel/shepherd/issues/115)) ([726badd](https://github.com/erwins-enkel/shepherd/commit/726badd78b99bc33ddfc32e92fc0d4f82836a571))
* sync package.json version w/ release-please + show in footer ([#110](https://github.com/erwins-enkel/shepherd/issues/110)) ([4383767](https://github.com/erwins-enkel/shepherd/commit/438376792a7ea6bdd5d3b385b6d85fc9d7cb29e1))
* **ui:** make the in-app update reliable & readable on mobile ([#111](https://github.com/erwins-enkel/shepherd/issues/111)) ([2558c76](https://github.com/erwins-enkel/shepherd/commit/2558c765faaa783db3b6250c1e3f126a7df083bc))
* **ui:** reclaim phone session-header height for the terminal ([#104](https://github.com/erwins-enkel/shepherd/issues/104)) ([e76ebc4](https://github.com/erwins-enkel/shepherd/commit/e76ebc464788b14020b9d3a3ab1f290f61c00bca))
* **ui:** surface critic reviewing status + declutter detail header ([#112](https://github.com/erwins-enkel/shepherd/issues/112)) ([46b375b](https://github.com/erwins-enkel/shepherd/commit/46b375be2c457d97f25f979974952cec3374cddb))


### Bug Fixes

* **critic:** produce verdicts — fix arg-swallow, dontAsk Write, hook derail ([#116](https://github.com/erwins-enkel/shepherd/issues/116)) ([17100ab](https://github.com/erwins-enkel/shepherd/commit/17100abf7e6c7d0e706d8dc9b56b3a13205e4133))
* **herdr-update:** pass --handoff so protocol-bump updates survive running targets ([#109](https://github.com/erwins-enkel/shepherd/issues/109)) ([660e112](https://github.com/erwins-enkel/shepherd/commit/660e1123c937698964af68b4f81ed3d9bf1dd405))
* **ui:** auto-grow + scrollable, edge-to-edge prompt field on mobile ([#106](https://github.com/erwins-enkel/shepherd/issues/106)) ([51c2467](https://github.com/erwins-enkel/shepherd/commit/51c24674a1424d4b9b73193cfc7fb7081af65b57))
* **ui:** center close ✕ in its gutter on new-task sheet (mobile) ([#105](https://github.com/erwins-enkel/shepherd/issues/105)) ([db8198c](https://github.com/erwins-enkel/shepherd/commit/db8198c2579ee3821e38a5dc5206f571cc7f2256))
* **ui:** drop redundant frozen elapsed timer from session detail header ([#108](https://github.com/erwins-enkel/shepherd/issues/108)) ([6cbb84f](https://github.com/erwins-enkel/shepherd/commit/6cbb84f1cc52c4260de7cad6c519b080bd2fd59c))

## [1.2.0](https://github.com/erwins-enkel/shepherd/compare/v1.1.0...v1.2.0) (2026-06-01)


### Features

* **herdr-update:** stream live update log to the modal ([#100](https://github.com/erwins-enkel/shepherd/issues/100)) ([a43d3b4](https://github.com/erwins-enkel/shepherd/commit/a43d3b4fd2c5a192eb688c3707cf724cf9e1c544))
* **namer:** shorter, readable session names + demote TASK-NN on cards ([#83](https://github.com/erwins-enkel/shepherd/issues/83)) ([efcc31c](https://github.com/erwins-enkel/shepherd/commit/efcc31ca670195187ec6da6021a08ae727c9e3e9))
* **ui:** compact mobile new-task dialog + 'next needs you' header jump ([#87](https://github.com/erwins-enkel/shepherd/issues/87)) ([1f3175b](https://github.com/erwins-enkel/shepherd/commit/1f3175b95d4ad1f130fc06604ad08173ba349a6d))
* **ui:** jump into the console from "needs you" and page its queue on mobile ([#92](https://github.com/erwins-enkel/shepherd/issues/92)) ([9636e14](https://github.com/erwins-enkel/shepherd/commit/9636e1483f95aff5ae4ca0ac981798eb970d5668))
* **ui:** linkify URLs in terminal pane so they're tappable on mobile ([#86](https://github.com/erwins-enkel/shepherd/issues/86)) ([62af892](https://github.com/erwins-enkel/shepherd/commit/62af892c9e7764965172d42318cf54cb8c51fead))
* **ui:** one-tap dictation mic in the compose bar ([#103](https://github.com/erwins-enkel/shepherd/issues/103)) ([16af415](https://github.com/erwins-enkel/shepherd/commit/16af4152ac1f264d316015553557abb38584cd49))
* **ui:** show repo + task in top bar on phone detail view ([#96](https://github.com/erwins-enkel/shepherd/issues/96)) ([73c996f](https://github.com/erwins-enkel/shepherd/commit/73c996f47455c38c7af5990e7ab2cba62ca10272))
* **viewport:** add jump-to-bottom button when scrolled up in the terminal ([#91](https://github.com/erwins-enkel/shepherd/issues/91)) ([fe84eaf](https://github.com/erwins-enkel/shepherd/commit/fe84eafd6d7bd45e65dc89a3a5fb8522e287f81a))


### Bug Fixes

* **controlbar:** discriminate tap from drag so scrolling the key row doesn't fire a key ([#101](https://github.com/erwins-enkel/shepherd/issues/101)) ([9746980](https://github.com/erwins-enkel/shepherd/commit/974698017432a2900d37090d65478da0d4addb6c))
* **push:** valid default VAPID subject + 403 diagnostics + per-session debounce ([#102](https://github.com/erwins-enkel/shepherd/issues/102)) ([30b099e](https://github.com/erwins-enkel/shepherd/commit/30b099e9ee8904acf0d5895178ac213b274fa28a))
* **status:** relabel done state as WAITING/WARTET ([#94](https://github.com/erwins-enkel/shepherd/issues/94)) ([e111b5d](https://github.com/erwins-enkel/shepherd/commit/e111b5d169526b41cf1a840dfabac5bfc1ab0a0f))
* **steerbar:** discriminate tap from drag so scrolling the chip row doesn't fire a steer ([#88](https://github.com/erwins-enkel/shepherd/issues/88)) ([55fced2](https://github.com/erwins-enkel/shepherd/commit/55fced2c8093c07ad82d6d12982f2a64c3c46de8))
* **terminal:** allow text selection in xterm while an agent's TUI is active ([#85](https://github.com/erwins-enkel/shepherd/issues/85)) ([2e8684e](https://github.com/erwins-enkel/shepherd/commit/2e8684edc691a403f2979f29f94680747ab9fe2c))
* **ui:** align bun.lock spec with package.json so installs stay idempotent ([#98](https://github.com/erwins-enkel/shepherd/issues/98)) ([a6cd1df](https://github.com/erwins-enkel/shepherd/commit/a6cd1df89653f8659e0aa2b068252c4f034b011d))
* **update:** show the real reason a self-update fails (no more bare "error 409") ([#97](https://github.com/erwins-enkel/shepherd/issues/97)) ([6f773e3](https://github.com/erwins-enkel/shepherd/commit/6f773e349d53c78e4f5a658b3e6ffa94b662c42f))
* **viewport:** move mobile compose field below nav keys ([#93](https://github.com/erwins-enkel/shepherd/issues/93)) ([90c92fe](https://github.com/erwins-enkel/shepherd/commit/90c92feb2df69b86e4a629856e0ba78858109a31))


### Code Refactoring

* **namer:** drop Ollama, heuristic-only session names ([#99](https://github.com/erwins-enkel/shepherd/issues/99)) ([c8743eb](https://github.com/erwins-enkel/shepherd/commit/c8743ebb432c0d46ce5e10fdcad14640e61a3a36))

## [1.1.0](https://github.com/erwins-enkel/shepherd/compare/v1.0.0...v1.1.0) (2026-05-31)


### Features

* **herdr:** in-app herdr version update check with guarded apply ([#70](https://github.com/erwins-enkel/shepherd/issues/70)) ([b7a0f74](https://github.com/erwins-enkel/shepherd/commit/b7a0f74248e13a83fe94272c5dcba354881a5b9e))
* **mobile:** compose bar to fix terminal autocomplete duplication ([#74](https://github.com/erwins-enkel/shepherd/issues/74)) ([60de78b](https://github.com/erwins-enkel/shepherd/commit/60de78b0c9e755c78f3b6a9267a5f576ebd35efd))
* **newtask:** paste a screenshot (Cmd/Ctrl+V) to attach it ([#65](https://github.com/erwins-enkel/shepherd/issues/65)) ([9f89eb2](https://github.com/erwins-enkel/shepherd/commit/9f89eb2f010820f1ca6557ee6ea48e0e2f328aff))
* **session:** resume a finished session from the terminal pane ([#75](https://github.com/erwins-enkel/shepherd/issues/75)) ([0e0c7e9](https://github.com/erwins-enkel/shepherd/commit/0e0c7e9ed73abf4fb07432df131e654221f3729d))
* **ui:** autofocus the prompt field when the new-task dialog opens ([#79](https://github.com/erwins-enkel/shepherd/issues/79)) ([b4563d7](https://github.com/erwins-enkel/shepherd/commit/b4563d7e6bfe86d6e14000d777e41e81ddd517e4))
* **ui:** stronger active-agent highlight + tailnet dev access ([#68](https://github.com/erwins-enkel/shepherd/issues/68)) ([5064135](https://github.com/erwins-enkel/shepherd/commit/5064135d199701ac3cae6b9a18903e38144dff53))


### Bug Fixes

* **create:** dedupe agent name to prevent herdr collision 500 ([#69](https://github.com/erwins-enkel/shepherd/issues/69)) ([ccb5070](https://github.com/erwins-enkel/shepherd/commit/ccb507055313fb35289dfa7a100651928bbf9274))
* **herdr:** give each agent its own tab so HUD terminal is full-width ([#66](https://github.com/erwins-enkel/shepherd/issues/66)) ([0b007c1](https://github.com/erwins-enkel/shepherd/commit/0b007c1d43bd1195eb3fa9ccce9117aa199c0adb))
* **newtask:** New Task create after herdr 0.6 update + real error messages ([#72](https://github.com/erwins-enkel/shepherd/issues/72)) ([caa969b](https://github.com/erwins-enkel/shepherd/commit/caa969b3b4676aeac2e9c206a289a947b2f6d4f4))
* **stall:** clear flag on resumed activity + manual dismiss ([#64](https://github.com/erwins-enkel/shepherd/issues/64)) ([f97f745](https://github.com/erwins-enkel/shepherd/commit/f97f7456ce9945fb877ab5e926b9c4de8442ef97))
* **todo:** drop wrapped continuation lines on completed-item cleanup ([#81](https://github.com/erwins-enkel/shepherd/issues/81)) ([0da2137](https://github.com/erwins-enkel/shepherd/commit/0da2137989854a253bc47889fa7891fc89a698a5))
* **topbar:** keep mobile top bar on one line when "needs you" active ([#71](https://github.com/erwins-enkel/shepherd/issues/71)) ([cefa2bf](https://github.com/erwins-enkel/shepherd/commit/cefa2bf1fbd7017229353dd4022783617313a4f1))
* **ui:** i18n the update-available modal (was hardcoded German) ([#62](https://github.com/erwins-enkel/shepherd/issues/62)) ([7e98646](https://github.com/erwins-enkel/shepherd/commit/7e98646489ad017e651182e89ef031bf73c75e1d))
* **ui:** respect iOS safe-area insets on Dynamic Island iPhones ([#67](https://github.com/erwins-enkel/shepherd/issues/67)) ([062f35f](https://github.com/erwins-enkel/shepherd/commit/062f35fec8c0470f4cfeb848df2d42381e8e4234))
* **viewport:** open attach picker via onclick so it works on iOS ([#82](https://github.com/erwins-enkel/shepherd/issues/82)) ([9d8394d](https://github.com/erwins-enkel/shepherd/commit/9d8394daafa27b19ead9ed5cc9f7cbfcb1c43de7))


### Documentation

* tidy TODO roadmap after completed-item cleanup ([#77](https://github.com/erwins-enkel/shepherd/issues/77)) ([6f64557](https://github.com/erwins-enkel/shepherd/commit/6f645572d995a3c7c9e3983b07eb683947bdab80))

## 1.0.0 (2026-05-31)


### Features

* add Esc + Tab to mobile control-key bar ([7b88ace](https://github.com/erwins-enkel/shepherd/commit/7b88ace1a205ea27655c8649dca65085622c755b))
* backend serves built ui/ (spa fallback, traversal-safe) ([75d3ef6](https://github.com/erwins-enkel/shepherd/commit/75d3ef6e2f13a68c5a1d1629f2814e18d67938f5))
* blocked-triage queue — Needs-you drawer + one-tap reply ([#17](https://github.com/erwins-enkel/shepherd/issues/17)) ([b128443](https://github.com/erwins-enkel/shepherd/commit/b128443ac03da3c737fa57214a5be9d9ed297fef))
* decommission cleans up session worktree + merged branch ([70bc546](https://github.com/erwins-enkel/shepherd/commit/70bc546e21d65aca00e41979431b62a5bfd4da6b))
* deploy hardening — loopback bind + systemd user unit ([3d55f55](https://github.com/erwins-enkel/shepherd/commit/3d55f55a52216fa3af22d4cc0ee846d3b186e5de))
* event hub + status poller ([93ef268](https://github.com/erwins-enkel/shepherd/commit/93ef2685685cd27037dad896db009779f87f3d1a))
* **forge:** platform-agnostic git host abstraction (github + gitea/forgejo) ([7a98f8a](https://github.com/erwins-enkel/shepherd/commit/7a98f8a2c4a0d29b4491115b3d474f1ca9cc081f))
* **forge:** SHEPHERD_FORGES env-path for the forge map ([3cc2811](https://github.com/erwins-enkel/shepherd/commit/3cc281130420a6b8cd8348716e9e5fce14f4831e))
* **forge:** source forge map from config via SHEPHERD_FORGES ([c93843e](https://github.com/erwins-enkel/shepherd/commit/c93843eab259e61d0b0e9c0f5a7f85653157e4f8))
* git worktree manager with cwd fallback ([5cbea77](https://github.com/erwins-enkel/shepherd/commit/5cbea77b978718911cc5752fac5a6cdb910d5977))
* github issues endpoint + repo display path ([d8c94f7](https://github.com/erwins-enkel/shepherd/commit/d8c94f77cd95984251ac49da14ed61e3cc15422a))
* herdr cli driver (list/start/attach, state mapping) ([dc6af3c](https://github.com/erwins-enkel/shepherd/commit/dc6af3c359978c52ca9175647f3836a8359e0ad2))
* **icons:** per-project emoji icon picker (F12) ([#49](https://github.com/erwins-enkel/shepherd/issues/49)) ([386d8bf](https://github.com/erwins-enkel/shepherd/commit/386d8bf1ac0608ca908beccdf16b6da673900c80))
* mobile control-key bar (arrows, ^A/^E/^C/^D) ([12fe505](https://github.com/erwins-enkel/shepherd/commit/12fe5059050e3013e7068cd57e888eafc3bdfba7))
* ollama task namer with prompt fallback ([23282ea](https://github.com/erwins-enkel/shepherd/commit/23282ea3c125d33addb39e5d92bb9d2e5f623457))
* one-command deploy — `bun run update` ([2263f76](https://github.com/erwins-enkel/shepherd/commit/2263f76b41fd7b837d8c75b0c255a990851ad7ed))
* platform-agnostic git host buttons (open PR / merge / redeploy) ([87296bd](https://github.com/erwins-enkel/shepherd/commit/87296bd2a5bf07bd259545c8165e4db10eeb1b1e))
* pty bridge (node helper subprocess) + bun ws wiring (/pty, /events) ([88c2ff7](https://github.com/erwins-enkel/shepherd/commit/88c2ff730cdaf81198e26103181fca237bc5c5f4))
* **pty:** graceful single-owner handoff across devices ([3ee60aa](https://github.com/erwins-enkel/shepherd/commit/3ee60aaf12d6395e0b7ddf04e2ac219d62d768f7))
* **pty:** graceful single-owner terminal handoff across devices ([5e21fcc](https://github.com/erwins-enkel/shepherd/commit/5e21fcc87f40e5572eb106d8ded316a709862fcc))
* **push:** web push notifications on blocked/done (PWA) ([#43](https://github.com/erwins-enkel/shepherd/issues/43)) ([841bd9e](https://github.com/erwins-enkel/shepherd/commit/841bd9e3b0576c77fcdccae0aaf2a9828e7db38c))
* reconcile-on-boot + server entrypoint ([ddfcfa7](https://github.com/erwins-enkel/shepherd/commit/ddfcfa712e01140868fdcfab35f36d03b63bc0eb))
* repos list + per-project TODO.md read/write endpoints ([2c2596d](https://github.com/erwins-enkel/shepherd/commit/2c2596d8f84c24ce51e710dcf7c61bc516e12cb4))
* rest api for sessions ([527be64](https://github.com/erwins-enkel/shepherd/commit/527be64d960a264aac90b2caf863176a48baa401))
* **server:** /api/sessions/:id/git PR/merge/redeploy routes + forge config ([81cb7e6](https://github.com/erwins-enkel/shepherd/commit/81cb7e6d900b3c4d9f9212bfc4eebf2a02688fad))
* **server:** route POST /api/uploads ([723af03](https://github.com/erwins-enkel/shepherd/commit/723af034bdf8a6a241b02460bcfc6292e6059e27))
* **service:** move staged images into worktree, append paths to prompt ([53f17ca](https://github.com/erwins-enkel/shepherd/commit/53f17cabe02863ec447daf559d802afefd952c94))
* session service orchestrates spawn + archive ([67e6202](https://github.com/erwins-enkel/shepherd/commit/67e6202f1c56a0f152db9593f62e6c9a1fcdb90f))
* session store on bun:sqlite ([560c285](https://github.com/erwins-enkel/shepherd/commit/560c2859171cfe6fb8ae2bebde4e9c6c8b6f347d))
* **settings:** configurable repo root via gear + directory browser ([#9](https://github.com/erwins-enkel/shepherd/issues/9)) ([0e897fc](https://github.com/erwins-enkel/shepherd/commit/0e897fcd04814ccaef844852ad28ad67d8933871))
* **steers:** saved steers / broadcast canned prompts ([#31](https://github.com/erwins-enkel/shepherd/issues/31)) ([247ae3a](https://github.com/erwins-enkel/shepherd/commit/247ae3a0a5d09e82c23bbe73d6d53222c43d5e08))
* sweep abandoned staging uploads on startup ([ecb5889](https://github.com/erwins-enkel/shepherd/commit/ecb5889b771c707e5ded1983724e665a57f27745))
* **triage:** flag silent stalled agents as a needs-you reason ([#51](https://github.com/erwins-enkel/shepherd/issues/51)) ([6e8ad9c](https://github.com/erwins-enkel/shepherd/commit/6e8ad9c260e46a76518f9dd9d0510a8b45d49520))
* **ui/api:** uploadImage() + images in CreateInput ([420ba12](https://github.com/erwins-enkel/shepherd/commit/420ba12d6b112df9f9543d8ce6c4ea1ad090690f))
* **ui:** 44px unit-row tap targets on mobile ([f3a12ec](https://github.com/erwins-enkel/shepherd/commit/f3a12ec16b731505d646061777efdf3fe7ec0993))
* **ui:** add Enter key to mobile control bar ([ff77ec6](https://github.com/erwins-enkel/shepherd/commit/ff77ec6ab3a80b595693f603acb4f705bc9ed307))
* **ui:** add light/dark/system theme switcher ([b60ec6d](https://github.com/erwins-enkel/shepherd/commit/b60ec6dc6254f8afdd15d86e83993ab4e6810428))
* **ui:** agent activity feed from tool-use transcript ([#37](https://github.com/erwins-enkel/shepherd/issues/37)) ([ff6c377](https://github.com/erwins-enkel/shepherd/commit/ff6c37792406d834fc5c106d6d0446c534d6c137))
* **ui:** autocomplete repo picker (datalist from /api/repos) ([9b5927c](https://github.com/erwins-enkel/shepherd/commit/9b5927c18804d4ed89f46ebeeb8bebddcaa71036))
* **ui:** collapse top bar to hotter usage gauge on touch ([#52](https://github.com/erwins-enkel/shepherd/issues/52)) ([7518268](https://github.com/erwins-enkel/shepherd/commit/75182683595a96714670be4213faeca802992b9e))
* **ui:** compact topbar on mobile ([f3795a6](https://github.com/erwins-enkel/shepherd/commit/f3795a6980686ba1237db1dd717b5fd2570e74c5))
* **ui:** compact two-pane on touch devices (font 11 + narrower picker) ([75e5b96](https://github.com/erwins-enkel/shepherd/commit/75e5b96b0fe444e79e8880e45d55546702699c06))
* **ui:** compose shepherd hud page ([ddb97a2](https://github.com/erwins-enkel/shepherd/commit/ddb97a238b2d42adb1a57badb77f0a391d6820b4))
* **ui:** contextual git rail in Viewport header (open PR / merge / redeploy) ([04e7456](https://github.com/erwins-enkel/shepherd/commit/04e745602c37837d362976d83ff7e1e6b538f53b))
* **ui:** custom opaque repo dropdown (~/Work compaction), issues api ([85327cd](https://github.com/erwins-enkel/shepherd/commit/85327cd28f7a32ccb14e623c01df6457ccb2ea4b))
* **ui:** decommission button to archive a session ([c8f2e17](https://github.com/erwins-enkel/shepherd/commit/c8f2e17e9a0de9d067a4667d3c0ce5325db98288))
* **ui:** desktop hover tooltips for top-right HUD ([#29](https://github.com/erwins-enkel/shepherd/issues/29)) ([828870b](https://github.com/erwins-enkel/shepherd/commit/828870b6833b8025980b63e486b496e96074cef9))
* **ui:** drag-to-reorder saved steers in settings ([#47](https://github.com/erwins-enkel/shepherd/issues/47)) ([27b88fe](https://github.com/erwins-enkel/shepherd/commit/27b88fed6e50466931185572339f1b77ff79920f))
* **ui:** forward images through new-task submit ([b56ec9c](https://github.com/erwins-enkel/shepherd/commit/b56ec9ca065a2767424b809311f8c2aa06a7e585))
* **ui:** full-screen new-task sheet on mobile ([006cae7](https://github.com/erwins-enkel/shepherd/commit/006cae70befe14a5c6d867cd70255bfa4520bd08))
* **ui:** HerdGrid responsive tile grid for All view ([f5f0a50](https://github.com/erwins-enkel/shepherd/commit/f5f0a50776e12c07704fbcb3b77c982005db0812))
* **ui:** hud components (topbar, herd, unitrow, pip, newtask, actionbar) ([561fb15](https://github.com/erwins-enkel/shepherd/commit/561fb15f1fe9c7fefef50715ba5fe51575ae6563))
* **ui:** inline git diff review panel in the HUD ([#46](https://github.com/erwins-enkel/shepherd/issues/46)) ([f05056e](https://github.com/erwins-enkel/shepherd/commit/f05056eec2ce5d3a32a6608d19d8512579f50d95))
* **ui:** internationalize the app (Paraglide JS, EN + DE) ([#34](https://github.com/erwins-enkel/shepherd/issues/34)) ([427c6ea](https://github.com/erwins-enkel/shepherd/commit/427c6eaa5e0deebf55370265db8d391951d51d50))
* **ui:** issues viewport tab + new-task-from-issue ([01a82fd](https://github.com/erwins-enkel/shepherd/commit/01a82fdd431ead7dbdbf51d538e7c47ce0c846fd))
* **ui:** link issue # and title to GitHub, drop ↗ arrow ([#25](https://github.com/erwins-enkel/shepherd/issues/25)) ([929e623](https://github.com/erwins-enkel/shepherd/commit/929e623f664b1961d2034365e15ba25ea0d4f820))
* **ui:** live xterm viewport over /pty websocket ([bff1995](https://github.com/erwins-enkel/shepherd/commit/bff1995acc2a149ce1b1a344072c7f9cf67ca4aa))
* **ui:** mobile actionbar (new-task only, full-width) ([6cf3a9b](https://github.com/erwins-enkel/shepherd/commit/6cf3a9b0713abcf5f7bf8763491b15db0e24d4e0))
* **ui:** mobile viewport header (back nav, collapsed meta, tap-to-focus) ([4361550](https://github.com/erwins-enkel/shepherd/commit/43615508f8ca58e80092e56f0e1ff6591a4002db))
* **ui:** move theme switcher to action bar, add repo + git sha ([#23](https://github.com/erwins-enkel/shepherd/issues/23)) ([dbbec87](https://github.com/erwins-enkel/shepherd/commit/dbbec8776f2d4557eca9f29cf5b440458f20615c))
* **ui:** New Task image drop zone, attach button, chips ([6d3d108](https://github.com/erwins-enkel/shepherd/commit/6d3d1086dd076199f130908299eae2bda314504c))
* **ui:** new-task prompt sources (todo + issues seed the prompt) ([ba9cb68](https://github.com/erwins-enkel/shepherd/commit/ba9cb6822bba1ee2428fe3fbaf343da806b2653f))
* **ui:** paste an image into the terminal (Cmd/Ctrl+V) ([f4d5986](https://github.com/erwins-enkel/shepherd/commit/f4d598695f1dcd7006294872c4e969aea5fe6ace))
* **ui:** paste an image into the terminal (Cmd/Ctrl+V) ([12e00c9](https://github.com/erwins-enkel/shepherd/commit/12e00c94b275e94dfe60c10460d05299eb51f50a))
* **ui:** per-project TODO panel with Terminal|To-Do viewport tab ([2875884](https://github.com/erwins-enkel/shepherd/commit/28758849a43db0f54ca923a83a50ebe5389572f6))
* **ui:** per-session model picker (replaces static "claude-4" label) ([a463eae](https://github.com/erwins-enkel/shepherd/commit/a463eae17807ed289ad051bd54fc2e7dd12d2b5d))
* **ui:** reactive herd store + events websocket ([cbc85d2](https://github.com/erwins-enkel/shepherd/commit/cbc85d2e895cc1fdbaca9e2f0853e75489a26ba1))
* **ui:** read-only live terminal tile for All view ([dc90925](https://github.com/erwins-enkel/shepherd/commit/dc909255f019aedf17ef8624a0e4f1d8c8e8dbbf))
* **ui:** responsive nav controller (mobile drill-down) ([fc01f42](https://github.com/erwins-enkel/shepherd/commit/fc01f424a9941b833612675018c38d5b4c98e391))
* **ui:** sheep favicon + page title ([963871b](https://github.com/erwins-enkel/shepherd/commit/963871bb8bc1b1e9b3378cd20c0f89b2fa2ec8f5))
* **ui:** shepherd hud design tokens + motion ([73fea89](https://github.com/erwins-enkel/shepherd/commit/73fea899bdfa622f3314a7a128f3c401e0f15542))
* **ui:** show control bar on touch devices regardless of width ([c4ed412](https://github.com/erwins-enkel/shepherd/commit/c4ed412e43485d247a48542ea2a94d80b169cff6))
* **ui:** show full task name in compact session detail header ([#44](https://github.com/erwins-enkel/shepherd/issues/44)) ([262ba8a](https://github.com/erwins-enkel/shepherd/commit/262ba8a8fc29333fab264377702935c8e5ed0b5f))
* **ui:** show repo on session cards + focus terminal on select ([311e17a](https://github.com/erwins-enkel/shepherd/commit/311e17a2134fea1b452a7465b878bf899c072a8f))
* **ui:** show the repo on each session card ([e2bc309](https://github.com/erwins-enkel/shepherd/commit/e2bc309d312cbf2b2e39fdd05b9cbdfb56447330))
* **ui:** submit new task with Cmd/Ctrl+Enter and show shortcut hint ([#28](https://github.com/erwins-enkel/shepherd/issues/28)) ([eb4e5a8](https://github.com/erwins-enkel/shepherd/commit/eb4e5a89cc9b0397a62b7dc84686d5686f244cbd))
* **ui:** surface PR status in the session list ([#38](https://github.com/erwins-enkel/shepherd/issues/38)) ([ded94b0](https://github.com/erwins-enkel/shepherd/commit/ded94b053ab6bb8f4a4bbd85faa53f0368d73606))
* **ui:** terminal image drop + touch attach button → inject path ([34fc28b](https://github.com/erwins-enkel/shepherd/commit/34fc28bb832a15facb723ce47770ee08687395d8))
* **ui:** toggle desktop pane between Focus and All grid ([0155c79](https://github.com/erwins-enkel/shepherd/commit/0155c791676c4162fa69e32215652ef212bfb6bf))
* **ui:** touch base styles (tap-highlight, touch-action) ([db1e802](https://github.com/erwins-enkel/shepherd/commit/db1e802c2fa55e14a98ebbbe988a2a9363663285))
* **ui:** touch scroll + tap sizing in todo/issues panels ([076fe51](https://github.com/erwins-enkel/shepherd/commit/076fe512c6947794be44a745cf3f3c99734b0664))
* **ui:** touch-sized repo dropdown on mobile ([9392dd4](https://github.com/erwins-enkel/shepherd/commit/9392dd4e25d4416073cfe079a910135ae8d3e410))
* **ui:** types, rest client, format helpers ([51749f6](https://github.com/erwins-enkel/shepherd/commit/51749f64816e63930c7911d7312f1914378ea5fa))
* **ui:** wire All/Focus toggle buttons in ActionBar ([de71e4d](https://github.com/erwins-enkel/shepherd/commit/de71e4d0fb89c1e9ffdf9a68637cede4b4ae9826))
* **ui:** wrap sidebar prompt to 2 lines ([65e350f](https://github.com/erwins-enkel/shepherd/commit/65e350fa85791ca0d4c7dc2af3f06edbec9b1f7d))
* **ui:** wrap sidebar prompt to 2 lines ([8f85925](https://github.com/erwins-enkel/shepherd/commit/8f85925e647678ef256676d4a1e0e43a0a5501a6))
* **update:** in-app self-update from new commits on main ([#27](https://github.com/erwins-enkel/shepherd/issues/27)) ([a6c9bd9](https://github.com/erwins-enkel/shepherd/commit/a6c9bd9f09001bd61c29f2284c18a03dc27ccf0c))
* **uploads:** image upload helpers (mime/ext, staging, move, sweep) ([ab51455](https://github.com/erwins-enkel/shepherd/commit/ab51455188afaa50c85da678ff222de829cc0111))
* **uploads:** POST /api/uploads handler (worktree/staging dest) ([736de36](https://github.com/erwins-enkel/shepherd/commit/736de36f6fbff2cc6fb33eb3e6053646c723a4f0))
* usage gauges + per-session tokens (ui) + docs ([5956539](https://github.com/erwins-enkel/shepherd/commit/5956539b5d67bdc463a607982006500ca2fd3635))
* usage/cost tracking backend — per-session tokens + 5h/weekly limit calibration ([3f15a6b](https://github.com/erwins-enkel/shepherd/commit/3f15a6b271f1b9641eb1c14abb7a36ec0afa97a1))
* **validate:** validate optional images[] (staging containment, ≤10) ([bb9c63b](https://github.com/erwins-enkel/shepherd/commit/bb9c63bac99e65d9ddc4157f75004711cb757f21))


### Bug Fixes

* attach terminals at client size so background panes aren't mis-sized ([ed9b4ea](https://github.com/erwins-enkel/shepherd/commit/ed9b4ea0c779e7ed849f085efdc85f6e655d3709))
* attach terminals with --takeover so refresh bumps stale client ([1f3aa3b](https://github.com/erwins-enkel/shepherd/commit/1f3aa3bc28cc2f0eaa1258a728f1443a8c9fd977))
* clear 5 minor follow-ups (terminal scroll, MRU repo, branch dropdown, HEAD, todo cleanup) ([87eaee7](https://github.com/erwins-enkel/shepherd/commit/87eaee738c79a353eb1a25a58459d675452ff4b2))
* **config:** default repo-root ceiling to $HOME (was ~/Work) ([#57](https://github.com/erwins-enkel/shepherd/issues/57)) ([8b0c590](https://github.com/erwins-enkel/shepherd/commit/8b0c59090b94234219adfa12922700821c92c949))
* drive mobile terminal scroll via term.scrollLines ([6730506](https://github.com/erwins-enkel/shepherd/commit/673050619e9ba54390c43dced1b70ccf35cd5cd3))
* expand ~ in repoPath (400 on tilde paths); archive now stops the herdr agent ([03317bb](https://github.com/erwins-enkel/shepherd/commit/03317bb46274d67be1513ec37857582fcf2b4162))
* **forge:** gitea PrStatus title under exactOptionalPropertyTypes; prettier pass ([3a5e3d6](https://github.com/erwins-enkel/shepherd/commit/3a5e3d69709e251f15b47bd54fe54c751547fcb8))
* **forge:** tsc strict — import MergeMethod in github.ts; store.get stub returns null ([4323b33](https://github.com/erwins-enkel/shepherd/commit/4323b33a59ce218105779623f68af4572b902a87))
* **forge:** wire repo forge resolution into the running server ([a645ccd](https://github.com/erwins-enkel/shepherd/commit/a645ccdde65cd2344102a563ac3d57a38dd3adbc))
* **forge:** wire repo forge resolution into the running server ([a184fdb](https://github.com/erwins-enkel/shepherd/commit/a184fdbe99605b4dfddce850dddf04190f0aa416))
* handle claude session termination (ctrl-c) instead of reconnect-looping ([#30](https://github.com/erwins-enkel/shepherd/issues/30)) ([50e2d3b](https://github.com/erwins-enkel/shepherd/commit/50e2d3b7d6af802bb2505266e91a7f97da7bc629))
* **pty:** reliable image-path injection — bracketed paste + stdin demux ([672f578](https://github.com/erwins-enkel/shepherd/commit/672f57853a9d5ef386972dbf36590f4539fd0d49))
* **pty:** reopen finished-but-alive sessions instead of "session ended" ([#40](https://github.com/erwins-enkel/shepherd/issues/40)) ([4040bbc](https://github.com/erwins-enkel/shepherd/commit/4040bbc6b2a40a7a631e9db67dce092823dbe470))
* **pty:** resolve node binary robustly for the attach helper ([88caf1d](https://github.com/erwins-enkel/shepherd/commit/88caf1d9fb6f596204a6c0e1f23935350c068a52))
* **pty:** resolve node binary robustly for the attach helper ([18682cd](https://github.com/erwins-enkel/shepherd/commit/18682cdf44d1e23050c7bb64947047025a8fe7da))
* **pty:** stop mobile terminal reconnect loop on resize storms ([75ba3e9](https://github.com/erwins-enkel/shepherd/commit/75ba3e9bf3b73034988dcaded53c4de0897a771c))
* **pty:** stop mobile terminal reconnect loop on resize storms ([33a8195](https://github.com/erwins-enkel/shepherd/commit/33a8195c1f7bdbf8d1402bfb7dfa4bc9e5f23fc8))
* **push:** stall-specific notification body (was generic input prompt) ([#53](https://github.com/erwins-enkel/shepherd/issues/53)) ([b8fd0c0](https://github.com/erwins-enkel/shepherd/commit/b8fd0c014a7c8e28e53222eb7199f93dbadc193e))
* scroll mobile terminal by forwarding touch drags as wheel events ([1c04264](https://github.com/erwins-enkel/shepherd/commit/1c04264fc51fc5411f8cf12dd177df626b490286))
* **security:** enforce origin on ws upgrades (cswsh), validate terminalId ([ef18234](https://github.com/erwins-enkel/shepherd/commit/ef1823451bbcb222d441f44fc718e274fd875f6b))
* **security:** realpath containment in safeRepoDir (symlink escape) + no-follow TODO.md write ([9e41ceb](https://github.com/erwins-enkel/shepherd/commit/9e41cebfea0df10c721af26be0f4ada684479e69))
* **security:** validate input, origin allowlist (csrf), repo-root confinement, optional token ([a9e8ac9](https://github.com/erwins-enkel/shepherd/commit/a9e8ac9b2a68c4bc75002a4d2a0f35e93b8a6dae))
* stop infinite effect loop in Viewport (conn $state self-dependency) ([07ecb94](https://github.com/erwins-enkel/shepherd/commit/07ecb943138e6671128e316b1676d8f7ae71879f))
* touch-drag scroll in mobile terminal ([83023c0](https://github.com/erwins-enkel/shepherd/commit/83023c0d8a2027dc57bab6f35b7490553d07c163))
* **types:** restore root strict tsc after wave merges ([7020db9](https://github.com/erwins-enkel/shepherd/commit/7020db9236bfa755a8bc86b5d3993e2cf57c0722))
* **types:** restore root strict tsc after wave merges ([4d0a4cf](https://github.com/erwins-enkel/shepherd/commit/4d0a4cf5542ee9481828b84c99bb210d04fc4bf6))
* **ui:** anchor Open-PR popover to button on desktop ([#22](https://github.com/erwins-enkel/shepherd/issues/22)) ([3969863](https://github.com/erwins-enkel/shepherd/commit/3969863f49605a8088788e3845f0cbc4730d164f))
* **ui:** cancel pending rAF in UnitTile teardown ([80e9be0](https://github.com/erwins-enkel/shepherd/commit/80e9be0f3c255642a71b69503e108ecce6871cbc))
* **ui:** collapse UNIT- stem on cramped sidebar ([381a6b3](https://github.com/erwins-enkel/shepherd/commit/381a6b3a2f717ac39f719d959ab37addb6344a4b))
* **ui:** collapse UNIT- stem on cramped sidebar ([124c289](https://github.com/erwins-enkel/shepherd/commit/124c28952d5c226e1e7b6997ebc540c4742fd329))
* **ui:** compact viewport header on touch devices so decommission button fits ([2804436](https://github.com/erwins-enkel/shepherd/commit/2804436ef17d5e3a7f1d22dba3b3d843be3d2fc3))
* **ui:** condensed mobile tallies + repo-select truncation (no h-overflow) ([49fdb87](https://github.com/erwins-enkel/shepherd/commit/49fdb8758a75f63812181d851ee3636c8f116477))
* **ui:** default to terminal tab on session switch ([a317886](https://github.com/erwins-enkel/shepherd/commit/a3178860508091e3b505e0b838305544bace190d))
* **ui:** distinct active toggle style + aria-pressed on All/Focus ([050586f](https://github.com/erwins-enkel/shepherd/commit/050586fb1cbb6dc5471eac8192241b6655789947))
* **ui:** enforce xterm contrast floor in light mode for legibility ([#58](https://github.com/erwins-enkel/shepherd/issues/58)) ([dd1ab24](https://github.com/erwins-enkel/shepherd/commit/dd1ab243aa7a0aacfb628d5a1bfbfbb9d0e0f9b6))
* **ui:** ensure HerdGrid scrolls with tall herds ([36a5734](https://github.com/erwins-enkel/shepherd/commit/36a5734b6e2720efc7ac61ec599e6b93c5bcfde3))
* **ui:** fill pane with HerdGrid empty state ([6da3fab](https://github.com/erwins-enkel/shepherd/commit/6da3fab8f4cabc9f2bcadf5ac2c68952d15d1dc5))
* **ui:** focus the terminal when selecting a unit on desktop ([d779ed3](https://github.com/erwins-enkel/shepherd/commit/d779ed36cdcc0964bbf633cb1dd0213469f1e42f))
* **ui:** guard terminal refit while mount hidden ([#36](https://github.com/erwins-enkel/shepherd/issues/36)) ([31d8583](https://github.com/erwins-enkel/shepherd/commit/31d8583ec2db39fd0e2d654c7e13f651cc9b381b))
* **ui:** hide clock time on mobile, keep connection dot ([#32](https://github.com/erwins-enkel/shepherd/issues/32)) ([4f42565](https://github.com/erwins-enkel/shepherd/commit/4f425654b2d25f8f13d4f47b848b3329dbad5048))
* **ui:** hide Mission Control label on touch HUDs ([#42](https://github.com/erwins-enkel/shepherd/issues/42)) ([452dde6](https://github.com/erwins-enkel/shepherd/commit/452dde62d362468e5711beacb7bd9ddc7a02d740))
* **ui:** keep decommission button on row with long task names ([#48](https://github.com/erwins-enkel/shepherd/issues/48)) ([dceb8b5](https://github.com/erwins-enkel/shepherd/commit/dceb8b58ddfc5646f4787b6d2b220d862d7fed1c))
* **ui:** make empty-herd "New Task" text open the new-task modal ([#56](https://github.com/erwins-enkel/shepherd/issues/56)) ([4183147](https://github.com/erwins-enkel/shepherd/commit/418314799b213d9dee3442f36930c6b13cfcae62))
* **ui:** make mobile key row actually scroll horizontally ([fbe2731](https://github.com/erwins-enkel/shepherd/commit/fbe2731b13f3c82e2895c2cfd4210b9dff5c8b06))
* **ui:** null-safety in todo.ts (unblocks root tsc) + mobile-size new-task model select ([7c0eb2a](https://github.com/erwins-enkel/shepherd/commit/7c0eb2a7637e1d25fc54c742e0ef56980c3789c4))
* **ui:** optimize mobile touch targets, wrapping & scrolling ([#35](https://github.com/erwins-enkel/shepherd/issues/35)) ([67a2df7](https://github.com/erwins-enkel/shepherd/commit/67a2df791de0260588f914ba9d7d15d0cb143103))
* **ui:** prevent NEEDS YOU badge wrapping on portrait ([#33](https://github.com/erwins-enkel/shepherd/issues/33)) ([e702446](https://github.com/erwins-enkel/shepherd/commit/e702446c5711159b065951cbba03f60e0c556463))
* **ui:** rearrange todo items by status on toggle ([21be98c](https://github.com/erwins-enkel/shepherd/commit/21be98c87bdb74996c1bd0c5605e4c3f2270e62c))
* **ui:** reconnect PTY on tab refocus + auto-retry ([8332111](https://github.com/erwins-enkel/shepherd/commit/8332111652bd4454646f3a48519394ced308a863))
* **ui:** shift+enter inserts newline in terminal ([#26](https://github.com/erwins-enkel/shepherd/issues/26)) ([64ef1ef](https://github.com/erwins-enkel/shepherd/commit/64ef1efbf35057fa114613c340f0f6a3d65a3c7e))
* **ui:** show git rail on compact layouts (mobile + unfolded fold) ([5e481eb](https://github.com/erwins-enkel/shepherd/commit/5e481eb15cb73c93cd2a99f5010f683fcdf8768d))
* **ui:** show git rail on mobile + unfolded fold ([7f48c79](https://github.com/erwins-enkel/shepherd/commit/7f48c791d7c53ab86c92d457f72fb6b1f5768201))
* **ui:** shrink mobile terminal font 12-&gt;11 ([ee1620c](https://github.com/erwins-enkel/shepherd/commit/ee1620ccf66289157f9d0c6667aa044c39e98a4b))
* **ui:** shrink mobile terminal font 13-&gt;12 ([ff9b148](https://github.com/erwins-enkel/shepherd/commit/ff9b148f23873de916b45f02a44dda62143cc752))
* **ui:** stop status churn from resetting tab + recycling PTY ([97703a4](https://github.com/erwins-enkel/shepherd/commit/97703a4a152dc26f59bf4c49ec952d42ac1b520f))
* **ui:** theme-aware gradient + elevation for limits popover ([#54](https://github.com/erwins-enkel/shepherd/issues/54)) ([fb92857](https://github.com/erwins-enkel/shepherd/commit/fb92857d4e216b85ad17317a61109d231a8b526a))
* **ui:** theme-aware terminal output in triage drawer ([#45](https://github.com/erwins-enkel/shepherd/issues/45)) ([db58b6d](https://github.com/erwins-enkel/shepherd/commit/db58b6db8834fd9df8013f58efdecb7fd200466d))
* **ui:** truncate sidebar session name so it doesn't collide with status badge ([307ce98](https://github.com/erwins-enkel/shepherd/commit/307ce98539151984a01cbaf2c94d84765e7979a8))
* **ui:** use 100dvh so + New Task stays on-screen on foldables ([a4293c8](https://github.com/erwins-enkel/shepherd/commit/a4293c847831a3c12e0565e7c9952baffe29d06b))
* **ui:** widen terminal, compact session picker ([cc6f117](https://github.com/erwins-enkel/shepherd/commit/cc6f117b156bcf470ef7aa91ac33ef7eb234b2e2))
* **validate:** reject duplicate image paths ([375ca78](https://github.com/erwins-enkel/shepherd/commit/375ca783d44318ae334aa5973a163f5ec8320dc1))


### Code Refactoring

* address final review (origin order, pty-bridge test, dead code) ([0a6b7b5](https://github.com/erwins-enkel/shepherd/commit/0a6b7b5bab417a7294c09d2c3619ddfecfe138d8))
* **issues:** route /api/issues through the forge; drop src/github.ts ([c19f0c3](https://github.com/erwins-enkel/shepherd/commit/c19f0c3f3a6004c62338817bc5301741f05f4289))
* rename Tank → Shepherd (brand, env vars, branch prefix, HUD) ([7f82c15](https://github.com/erwins-enkel/shepherd/commit/7f82c1569705af46bedee9991e65d2ef0cc1949b))
* **ui:** rename UNIT designation to TASK ([#39](https://github.com/erwins-enkel/shepherd/issues/39)) ([ac6429d](https://github.com/erwins-enkel/shepherd/commit/ac6429d8f9283940f3fa505bc116d894805593e0))


### Documentation

* 280px tile min-width ([1548da6](https://github.com/erwins-enkel/shepherd/commit/1548da633644d0187f2971754567c857e8257827))
* add README ([245f639](https://github.com/erwins-enkel/shepherd/commit/245f639c2b435665d55456bcea07e8b35fd90927))
* add TODO.md roadmap (tracks feature requests incl. v5 responsive) ([ff6e5b1](https://github.com/erwins-enkel/shepherd/commit/ff6e5b134f270aa8286a42c7fe23b0b18d9276e8))
* **api:** document external task submission via POST /api/sessions ([#55](https://github.com/erwins-enkel/shepherd/issues/55)) ([4f4ebd8](https://github.com/erwins-enkel/shepherd/commit/4f4ebd8de9c310a88ba4648febd88889152eb7a6))
* document forges.json + git host buttons; tick TODO item ([352f7ac](https://github.com/erwins-enkel/shepherd/commit/352f7ac114f695b7c4d3f64419675f775eafacc7))
* image drag-drop + mobile upload design spec ([1bd1667](https://github.com/erwins-enkel/shepherd/commit/1bd1667aac6a3df5f449dca9fcd9cafc485e0d47))
* image drag-drop + mobile upload implementation plan ([27b0121](https://github.com/erwins-enkel/shepherd/commit/27b012174f710fd26d4d08259cfb6bde9d7febbf))
* implementation plan for All/Focus view modes ([f9fc412](https://github.com/erwins-enkel/shepherd/commit/f9fc4129940112b9aaf003b8009ef651615bba47))
* move Done section to bottom of TODO.md (open items first) ([a581263](https://github.com/erwins-enkel/shepherd/commit/a58126322d4534a315a3fda316f314dc74b16342))
* note per-package deps install for checks in fresh worktrees ([ddbfc22](https://github.com/erwins-enkel/shepherd/commit/ddbfc22a1772f6eb26fec5f45fdfb649c53b10af))
* revise plan task 9 for node-pty helper subprocess (p0 finding) ([0ee6886](https://github.com/erwins-enkel/shepherd/commit/0ee6886481fe3fa1f2b1be92540f253f8d0b5efd))
* roadmap update + ignore agent worktrees ([#41](https://github.com/erwins-enkel/shepherd/issues/41)) ([38c718a](https://github.com/erwins-enkel/shepherd/commit/38c718a6b12f7ab4e4bbd094d2b60c7f6851b63c))
* shepherd v4 plan — prompt sources (todo + issues) + picker polish ([107a2d0](https://github.com/erwins-enkel/shepherd/commit/107a2d00dc27697b8fedbda805799f0471a7adfc))
* shepherd v5 design — responsive/mobile drill-down ([da26d83](https://github.com/erwins-enkel/shepherd/commit/da26d837b08c6f2d82b2ea87ba3eb00332c07b05))
* shepherd v5 implementation plan (responsive/mobile) ([af8bae3](https://github.com/erwins-enkel/shepherd/commit/af8bae3de7bbf935a9a30c2521cd7ac6c6f7db36))
* spec — usage/cost tracking from ~/.claude JSONL ([71bb0b8](https://github.com/erwins-enkel/shepherd/commit/71bb0b8af5d3428e0c1c5b01f7b726aada71a908))
* spec for All/Focus view modes ([e5b0c97](https://github.com/erwins-enkel/shepherd/commit/e5b0c9712291de71a75fba11b7ed6d6cbe222323))
* spec for mobile control-key bar ([70f8545](https://github.com/erwins-enkel/shepherd/commit/70f8545bc87647bee98de719ac42ce5fe570464f))
* spec for platform-agnostic git host buttons (PR/merge/redeploy) ([515c42b](https://github.com/erwins-enkel/shepherd/commit/515c42bec9b78412b83b75c11a527533cba38f05))
* sync TODO.md with shipped state + PRD drift ([3ffec4f](https://github.com/erwins-enkel/shepherd/commit/3ffec4f6065c1ab92630a03f62f1ec3140c6e549))
* tank v1 design spec, PRD, and HUD mockup ([32b5818](https://github.com/erwins-enkel/shepherd/commit/32b581831364a29fa772be0814b9fe161a1a76b8))
* tank v1 implementation plan (spike + headless core) ([0195b4a](https://github.com/erwins-enkel/shepherd/commit/0195b4ad2d10f3e8f4f7a04354f768881a63cf3d))
* tank v2 HUD UI implementation plan ([dcd6674](https://github.com/erwins-enkel/shepherd/commit/dcd6674e1efe61d54a5856ddbe377d0410ecd208))
* tank v3 plan — repo picker + per-project TODO ([be181ca](https://github.com/erwins-enkel/shepherd/commit/be181caff0fb49e789a6e5d65f6c08a508dcfecd))
* TODO.md — v4/v5 done, decommission shipped, new backlog items ([1b1bf3c](https://github.com/erwins-enkel/shepherd/commit/1b1bf3cb85ae7c623411da167106e55fd4213751))
