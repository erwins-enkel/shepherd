# Changelog

## [1.45.0](https://github.com/erwins-enkel/shepherd/compare/v1.44.0...v1.45.0) (2026-07-23)


### Features

* **diagnostics:** add host_capacity resource-guardrail check ([#1832](https://github.com/erwins-enkel/shepherd/issues/1832)) ([6cb77de](https://github.com/erwins-enkel/shepherd/commit/6cb77de5bd77c1934297b05d055d0cda7e5288fd))
* **diagnostics:** herdr runtime-hygiene / Soll-Ist probe ([#1835](https://github.com/erwins-enkel/shepherd/issues/1835)) ([#1844](https://github.com/erwins-enkel/shepherd/issues/1844)) ([78dc7ec](https://github.com/erwins-enkel/shepherd/commit/78dc7ec0368be252024ab306f741fcfa6c5c8efc))
* **diagnostics:** one-click Fix for the host_capacity warning ([#1839](https://github.com/erwins-enkel/shepherd/issues/1839)) ([#1845](https://github.com/erwins-enkel/shepherd/issues/1845)) ([e1f90fd](https://github.com/erwins-enkel/shepherd/commit/e1f90fd7b10f69b2cb97cd5cc1434dc870ea2996))
* **files:** show New Task attachments in the session Scratchpad ([#1717](https://github.com/erwins-enkel/shepherd/issues/1717)) ([#1836](https://github.com/erwins-enkel/shepherd/issues/1836)) ([b2a2a8e](https://github.com/erwins-enkel/shepherd/commit/b2a2a8efa6dd2d2b978e23eec838490bf1aab36e))
* **herd:** make lifecycle groups collapsible on the desktop rail ([#1808](https://github.com/erwins-enkel/shepherd/issues/1808)) ([4bdf8dd](https://github.com/erwins-enkel/shepherd/commit/4bdf8dd123853b9ddecae382ffdf6ee4a0f4c828))
* **herdr:** one-click in-app downgrade to the highest supported version ([#1902](https://github.com/erwins-enkel/shepherd/issues/1902)) ([f16d114](https://github.com/erwins-enkel/shepherd/commit/f16d11492bb8bf8c778aef270b4f34520cbff6a4))
* **herdr:** support herdr 0.7.5 (protocol 17) agent spawning (epic [#1889](https://github.com/erwins-enkel/shepherd/issues/1889)) ([#1901](https://github.com/erwins-enkel/shepherd/issues/1901)) ([633dea4](https://github.com/erwins-enkel/shepherd/commit/633dea48477e6d6b07a03dcd1a7684b7929af1c6))
* **learnings:** permanently prune proposed learnings older than 3 days ([#1830](https://github.com/erwins-enkel/shepherd/issues/1830)) ([6c38fc5](https://github.com/erwins-enkel/shepherd/commit/6c38fc5d539086ac5ba3f1dfbd0841d632cc85d6))
* **review:** add opt-in Fowler code-smell lens to the session critic ([#1824](https://github.com/erwins-enkel/shepherd/issues/1824)) ([#1828](https://github.com/erwins-enkel/shepherd/issues/1828)) ([4d7420d](https://github.com/erwins-enkel/shepherd/commit/4d7420daf688ac25ddf92b4303b164bb3ad4c6de))
* **review:** feed approved plan + scope-creep lens to the critic ([#1812](https://github.com/erwins-enkel/shepherd/issues/1812)) ([#1826](https://github.com/erwins-enkel/shepherd/issues/1826)) ([c74e925](https://github.com/erwins-enkel/shepherd/commit/c74e9256e8bc51c0b5e66dbbaf0a28531cc3cfb4))
* **site:** replace HowItWorks step list with a pipeline animation ([#1878](https://github.com/erwins-enkel/shepherd/issues/1878)) ([51af6ea](https://github.com/erwins-enkel/shepherd/commit/51af6ea5ff8653c3319cef6989db262e0c81a18d))
* **tmp:** partial pnpm store reclaim (free unlinked content, not all-or-nothing) ([#1886](https://github.com/erwins-enkel/shepherd/issues/1886)) ([6f7b065](https://github.com/erwins-enkel/shepherd/commit/6f7b0653b787b0d0082f96a466efba218188fb14))
* **ui:** redesign settings as sidebar cockpit + mobile drill-in (5a/5b) ([#1903](https://github.com/erwins-enkel/shepherd/issues/1903)) ([e58f05b](https://github.com/erwins-enkel/shepherd/commit/e58f05ba1eb4016d9f64051edc79bd787e5989f1))
* **ui:** redesign the gear menu as a telemetry popover + rising sheet ([#1856](https://github.com/erwins-enkel/shepherd/issues/1856)) ([ffdd11f](https://github.com/erwins-enkel/shepherd/commit/ffdd11fc9ef2ba48c1de5fe83048e48a8c6b0df0))
* **ui:** redesign the new task modal into a single-view "calm form" layout ([#1854](https://github.com/erwins-enkel/shepherd/issues/1854)) ([91c43ce](https://github.com/erwins-enkel/shepherd/commit/91c43ce5d6e4335889d3dfc088132738a08ed722))
* **ui:** resizable Repos modal + repository sidebar with local persistence ([#1831](https://github.com/erwins-enkel/shepherd/issues/1831)) ([84f7924](https://github.com/erwins-enkel/shepherd/commit/84f7924a286db1d21ed3d9fc609f3f9f5ee6b507))
* **ui:** show Codex release notes in the update dialog ([#1865](https://github.com/erwins-enkel/shepherd/issues/1865)) ([e819b2d](https://github.com/erwins-enkel/shepherd/commit/e819b2d14075da2fdb2cff75982f6385a3701869))
* **ui:** show repository owners in picker ([#1913](https://github.com/erwins-enkel/shepherd/issues/1913)) ([322f31a](https://github.com/erwins-enkel/shepherd/commit/322f31aaee0a3fd71f62fe7db8231dc0bf92d602))
* **ui:** surface assigned-to-others plain issues ([#1694](https://github.com/erwins-enkel/shepherd/issues/1694)) ([#1837](https://github.com/erwins-enkel/shepherd/issues/1837)) ([9b12215](https://github.com/erwins-enkel/shepherd/commit/9b12215d6352544c818f5ef7406f3588799b5cb4))
* **ui:** unified session status bar across all session views ([#1822](https://github.com/erwins-enkel/shepherd/issues/1822)) ([7e386b8](https://github.com/erwins-enkel/shepherd/commit/7e386b8f0351742fbb3e67d30b852bf7c5b8333c))
* **uploads:** accept 250 MB screen-recording video attachments ([#1915](https://github.com/erwins-enkel/shepherd/issues/1915)) ([40119cd](https://github.com/erwins-enkel/shepherd/commit/40119cd737f04dba304903eb21fae66ed7a5aff0))


### Bug Fixes

* **automerge:** break the conflicting-PR rebase deadlock in autopilot ([#1847](https://github.com/erwins-enkel/shepherd/issues/1847)) ([f6e8868](https://github.com/erwins-enkel/shepherd/commit/f6e886848081bb85a0c09e611b09c52846cbb9b8))
* **critic:** make the epic landing-PR critic epic-aware ([#1761](https://github.com/erwins-enkel/shepherd/issues/1761)) ([#1843](https://github.com/erwins-enkel/shepherd/issues/1843)) ([dd52dbe](https://github.com/erwins-enkel/shepherd/commit/dd52dbe93552ff9562689ccfd0f3281b6792195e))
* **deps:** upgrade site + docs-site to Astro 7 ([#1861](https://github.com/erwins-enkel/shepherd/issues/1861)) ([4dc4180](https://github.com/erwins-enkel/shepherd/commit/4dc418080cc105a17ba2e4d82162b9c467f0ef8f))
* **diagnostics:** explain the host_capacity warning & link an actionable fix ([#1840](https://github.com/erwins-enkel/shepherd/issues/1840)) ([5157a44](https://github.com/erwins-enkel/shepherd/commit/5157a44526d205c25f05b1c60ea60f7cb114fccc))
* **epic:** dedupe epic-dag members so multi-line blockers don't break the panel ([#1833](https://github.com/erwins-enkel/shepherd/issues/1833)) ([90720f0](https://github.com/erwins-enkel/shepherd/commit/90720f0689244031290c1f3474cba1f5f69c9dcd))
* **epic:** rebase epic landing PR at open time + notify on genuine conflict ([#1842](https://github.com/erwins-enkel/shepherd/issues/1842)) ([c4dc2e5](https://github.com/erwins-enkel/shepherd/commit/c4dc2e5b550965a4e3e96de77152f7f828f6b23e))
* **herdr:** guard against unsupported herdr 0.7.5+ (agent spawning broken) ([#1887](https://github.com/erwins-enkel/shepherd/issues/1887)) ([39a6631](https://github.com/erwins-enkel/shepherd/commit/39a6631f9a0a48aea477fa861562ff71e761035c))
* **herdr:** pin the fresh-install path to the supported ceiling ([#1896](https://github.com/erwins-enkel/shepherd/issues/1896)) ([#1906](https://github.com/erwins-enkel/shepherd/issues/1906)) ([411c054](https://github.com/erwins-enkel/shepherd/commit/411c0540e4482241a812a9a96f4b35b85c23a11e))
* **plan-gate:** anchor the plan reviewer to the planner's tree ([#1863](https://github.com/erwins-enkel/shepherd/issues/1863)) ([868a196](https://github.com/erwins-enkel/shepherd/commit/868a19632d5eff33286eb278b0335faf1150b342))
* **recap:** recover Codex verdicts delivered as chat instead of a file ([#1827](https://github.com/erwins-enkel/shepherd/issues/1827)) ([b37ac90](https://github.com/erwins-enkel/shepherd/commit/b37ac90853096b8b1a77ada9092dcc0b8906bd08))
* **security:** move production /tmp paths off world-writable locations ([#1879](https://github.com/erwins-enkel/shepherd/issues/1879)) ([9a4d407](https://github.com/erwins-enkel/shepherd/commit/9a4d40787f51ff700dff1e13feb027c9dadc2152))
* **tabs:** transient helper tabs leak as Herdr shell husks until FD exhaustion ([#1858](https://github.com/erwins-enkel/shepherd/issues/1858)) ([341b430](https://github.com/erwins-enkel/shepherd/commit/341b43078ab496dabd662bc96df430b7a63f429f))
* **tmp:** point trusted agents at a disk-backed TMPDIR ([#1875](https://github.com/erwins-enkel/shepherd/issues/1875)) ([#1882](https://github.com/erwins-enkel/shepherd/issues/1882)) ([4588a73](https://github.com/erwins-enkel/shepherd/commit/4588a739fe7718a9cb48a66dddf36087f1944aed))
* **tmp:** reclaim forked pnpm stores + abandoned agent worktrees ([#1881](https://github.com/erwins-enkel/shepherd/issues/1881)) ([cfa87fa](https://github.com/erwins-enkel/shepherd/commit/cfa87fa89659899760db6d16a4946732c6ec2bcc)), closes [#1874](https://github.com/erwins-enkel/shepherd/issues/1874)
* **tmp:** warn on tmpfs inode pressure, steer agents off /tmp ([#1876](https://github.com/erwins-enkel/shepherd/issues/1876)) ([2f864a2](https://github.com/erwins-enkel/shepherd/commit/2f864a2eaa72bbb9ee239873ab75174a5e514abd))
* **ui:** bind an open epic's head and children into one group ([#1814](https://github.com/erwins-enkel/shepherd/issues/1814)) ([308d00f](https://github.com/erwins-enkel/shepherd/commit/308d00f88c8c2c615088f5c23264c77a3171053c))
* **ui:** keep new-task modal content above the iOS keyboard ([#1855](https://github.com/erwins-enkel/shepherd/issues/1855)) ([7287bd8](https://github.com/erwins-enkel/shepherd/commit/7287bd8243cdb8f3761434705c5a8ad9efe7be5e))
* **ui:** make GitRail's marked/dompurify imports dynamic ([#1846](https://github.com/erwins-enkel/shepherd/issues/1846)) ([d1b1f54](https://github.com/erwins-enkel/shepherd/commit/d1b1f540db754ea7acc93eb5ea416d2a097b95f4))
* **ui:** make the new-task modal usable on mobile (controls + issue picker) ([#1916](https://github.com/erwins-enkel/shepherd/issues/1916)) ([ccc2131](https://github.com/erwins-enkel/shepherd/commit/ccc21310d8f83a848d26bd9f335411ad50d04576))
* **ui:** make the pending-login auth banner visually unmissable ([#1851](https://github.com/erwins-enkel/shepherd/issues/1851)) ([7089980](https://github.com/erwins-enkel/shepherd/commit/70899801bde5f15bc4af8ce64088dbbb9a524a27))
* **ui:** reword provider-constraint callout to token/engine wording ([#1914](https://github.com/erwins-enkel/shepherd/issues/1914)) ([b6b16c7](https://github.com/erwins-enkel/shepherd/commit/b6b16c703a1904dc8608ec9153a703e98745c9d3))


### Documentation

* **media:** narrated explainer video (issue → merge, and why it stops) ([#1883](https://github.com/erwins-enkel/shepherd/issues/1883)) ([eb6d502](https://github.com/erwins-enkel/shepherd/commit/eb6d5028ea30af6e4bdd070f508e2676f70b39af))
* **readme:** embed the explainer as an inline player ([#1884](https://github.com/erwins-enkel/shepherd/issues/1884)) ([a914b9c](https://github.com/erwins-enkel/shepherd/commit/a914b9ccd0f4ef6a493057ce46a1b7156b8cf464))
* **research:** should Shepherd integrate with buzz? (not yet) ([#1904](https://github.com/erwins-enkel/shepherd/issues/1904)) ([24f6071](https://github.com/erwins-enkel/shepherd/commit/24f60719d2b03747b62c4d4b1cd3a92ebfd187f2))
* **research:** storyboard + tooling decision for a Shepherd explainer ([#1871](https://github.com/erwins-enkel/shepherd/issues/1871)) ([33995c4](https://github.com/erwins-enkel/shepherd/commit/33995c4890b2540f9fd183ac2a2de39de84948b8))
* **research:** take-aways from mattpocock/skills for reviewer briefings ([#1812](https://github.com/erwins-enkel/shepherd/issues/1812)) ([2f4f2c9](https://github.com/erwins-enkel/shepherd/commit/2f4f2c912659b617d44491b8961d9d1d744de9b0))
* sync docs to recent source changes ([#1811](https://github.com/erwins-enkel/shepherd/issues/1811)) ([c99d092](https://github.com/erwins-enkel/shepherd/commit/c99d09248d4e317aa76a3e3cf6d8cb10c626329d))

## [1.44.0](https://github.com/erwins-enkel/shepherd/compare/v1.43.0...v1.44.0) (2026-07-16)


### Features

* add Codex skill discovery ([#1706](https://github.com/erwins-enkel/shepherd/issues/1706)) ([f6a5134](https://github.com/erwins-enkel/shepherd/commit/f6a513417bce0b8ba30afdbe675dce90c3991ee7))
* add provider-aware skill picking ([#1689](https://github.com/erwins-enkel/shepherd/issues/1689)) ([98c7e4a](https://github.com/erwins-enkel/shepherd/commit/98c7e4ae53a10ca7f0bafbf059512fee01551b3f))
* **cardmenu:** offer Merge PR in the session-list right-click menu ([#1806](https://github.com/erwins-enkel/shepherd/issues/1806)) ([43709cb](https://github.com/erwins-enkel/shepherd/commit/43709cbf5dd0fc97f1d47f7ed0bfa5c2c60f9528))
* **diagnostics:** surface & one-click-fix untrusted claude folder-trust ([#1739](https://github.com/erwins-enkel/shepherd/issues/1739)) ([615be85](https://github.com/erwins-enkel/shepherd/commit/615be8509a0c4f236ff21c1cfc97807fc3f158e7))
* flag epics others are already working on in the backlog ([#1616](https://github.com/erwins-enkel/shepherd/issues/1616)) ([#1695](https://github.com/erwins-enkel/shepherd/issues/1695)) ([03abcb5](https://github.com/erwins-enkel/shepherd/commit/03abcb5c2347e25ac4521d0223c1fed303ede891))
* **herd:** explain lifecycle stages via header info tooltips + empty-state overview ([#1710](https://github.com/erwins-enkel/shepherd/issues/1710)) ([53ef8f6](https://github.com/erwins-enkel/shepherd/commit/53ef8f6709dad1bb9c145743b19f53d2c39dabbe))
* **hooks:** default SHEPHERD_HOOKS_INGEST on for fresh installs ([#740](https://github.com/erwins-enkel/shepherd/issues/740)) ([#1686](https://github.com/erwins-enkel/shepherd/issues/1686)) ([f7430c1](https://github.com/erwins-enkel/shepherd/commit/f7430c151148c8ee66d8ecab82f0c6a34ee76645))
* **learnings:** configure Distiller provider and cadence ([#1769](https://github.com/erwins-enkel/shepherd/issues/1769)) ([9773d7e](https://github.com/erwins-enkel/shepherd/commit/9773d7ed25e72e15ac7265137b15bc6ceda83326))
* **learnings:** make Learnings Optimizer provider-aware ([#1781](https://github.com/erwins-enkel/shepherd/issues/1781)) ([966389b](https://github.com/erwins-enkel/shepherd/commit/966389b6d86eedf9fa0d7f8cd8802d00b681d379))
* **learnings:** make merge suggester provider-aware ([#1783](https://github.com/erwins-enkel/shepherd/issues/1783)) ([b20aadf](https://github.com/erwins-enkel/shepherd/commit/b20aadf85cbb6f2ea4c30f59332ad322edde6b8a))
* **new-task:** preview image attachments ([#1719](https://github.com/erwins-enkel/shepherd/issues/1719)) ([f81e00d](https://github.com/erwins-enkel/shepherd/commit/f81e00d6b9665f9397d944c5cb849e47b855d60a))
* **newtask:** widen the New Task pane (520→760) + show two seed-from labels ([#1682](https://github.com/erwins-enkel/shepherd/issues/1682)) ([2849207](https://github.com/erwins-enkel/shepherd/commit/28492074d6a6793436575a3113b5e626fd120fd1))
* **recap:** explain missing session recaps and completion sources ([#1788](https://github.com/erwins-enkel/shepherd/issues/1788)) ([91bf74d](https://github.com/erwins-enkel/shepherd/commit/91bf74d1643b0a096fac60877b3681ffdcac78bc))
* **revive:** revive sessions stranded by a herdr daemon restart ([#1630](https://github.com/erwins-enkel/shepherd/issues/1630)) ([#1799](https://github.com/erwins-enkel/shepherd/issues/1799)) ([cae6191](https://github.com/erwins-enkel/shepherd/commit/cae6191846601a13310916a3ea3a308016633db0))
* **rundown:** make herd digest provider-aware ([#1779](https://github.com/erwins-enkel/shepherd/issues/1779)) ([e5c0a06](https://github.com/erwins-enkel/shepherd/commit/e5c0a067aea4d98b48685bba617f1fca6748682e))
* **settings:** choose a default model for each coding CLI ([#1736](https://github.com/erwins-enkel/shepherd/issues/1736)) ([2fcb0b1](https://github.com/erwins-enkel/shepherd/commit/2fcb0b130fb96a6c50bca024d95e93b5eac889b2))
* surface human review blocks ([#1709](https://github.com/erwins-enkel/shepherd/issues/1709)) ([800f584](https://github.com/erwins-enkel/shepherd/commit/800f584507411205d950ce347683a678abc89a90))
* **ui:** add decommission to command bar ([#1751](https://github.com/erwins-enkel/shepherd/issues/1751)) ([9a6cbcb](https://github.com/erwins-enkel/shepherd/commit/9a6cbcb3fa70d5a3be60d1ab45e967b5acb99060))
* **ui:** add filters to repos PRs view ([#1786](https://github.com/erwins-enkel/shepherd/issues/1786)) ([bfa19bd](https://github.com/erwins-enkel/shepherd/commit/bfa19bd77e8f4792bca546b9c651ff540db523fa))
* **ui:** add GPT-5.6 Codex model choices ([#1690](https://github.com/erwins-enkel/shepherd/issues/1690)) ([870083e](https://github.com/erwins-enkel/shepherd/commit/870083eb9a579cbedc4848a3ea317377e491b352))
* **ui:** align issue selector rows ([#1775](https://github.com/erwins-enkel/shepherd/issues/1775)) ([2388111](https://github.com/erwins-enkel/shepherd/commit/2388111a045051e5abe9e0035167c868322ccf9f))
* **ui:** experimental terminal font-size stepper in wrench menu ([#1696](https://github.com/erwins-enkel/shepherd/issues/1696)) ([1a7048f](https://github.com/erwins-enkel/shepherd/commit/1a7048f08c6948ae7b8aab73831bb6cc0f422ecd))
* **ui:** explain the activity heartbeat strip on hover ([#1704](https://github.com/erwins-enkel/shepherd/issues/1704)) ([db03d6a](https://github.com/erwins-enkel/shepherd/commit/db03d6a9df1a29e3eb849e56d7382824b42d7069))
* **ui:** fancier Diff tab via @pierre/diffs (split/unified, word-diff, sidebar) ([#1700](https://github.com/erwins-enkel/shepherd/issues/1700)) ([d72da77](https://github.com/erwins-enkel/shepherd/commit/d72da77a855f96f7e4ab277d422c249e747ad26f))
* **ui:** fold mobile lifecycle groups ([#1735](https://github.com/erwins-enkel/shepherd/issues/1735)) ([42d5e02](https://github.com/erwins-enkel/shepherd/commit/42d5e024966e289719da9d4e5a6030a4222ecd37))
* **ui:** global toggle to hide info tooltips ([#1756](https://github.com/erwins-enkel/shepherd/issues/1756)) ([c4f28d1](https://github.com/erwins-enkel/shepherd/commit/c4f28d123a6b1c33a138cec5e72b3fb369cb4876))
* **ui:** jump to sessions from auto-merge entries ([#1730](https://github.com/erwins-enkel/shepherd/issues/1730)) ([a7b5d1e](https://github.com/erwins-enkel/shepherd/commit/a7b5d1e552594d024aeaa852809a70efa068602d))
* **ui:** make Coding CLI settings sections collapsible ([#1774](https://github.com/erwins-enkel/shepherd/issues/1774)) ([6298d7f](https://github.com/erwins-enkel/shepherd/commit/6298d7f5e0dbd6e00501a6b16047973e8385d164))
* **ui:** open GitHub repo from chip ([#1697](https://github.com/erwins-enkel/shepherd/issues/1697)) ([c194ab6](https://github.com/erwins-enkel/shepherd/commit/c194ab667da3da0f74a6bc5ba0ac10ead6b4a2a9))
* **ui:** open repo automation from filter chip ([#1743](https://github.com/erwins-enkel/shepherd/issues/1743)) ([3fd63c9](https://github.com/erwins-enkel/shepherd/commit/3fd63c9473634405224c5c77c5b15fb3c9c4afef))
* **ui:** repair empty repos from new task ([#1711](https://github.com/erwins-enkel/shepherd/issues/1711)) ([f46f0d1](https://github.com/erwins-enkel/shepherd/commit/f46f0d17ffbbcb8ffb3d717abffba876670315e5))
* **ui:** right-click context menu on issue rows (open · details · inject steers) ([#1692](https://github.com/erwins-enkel/shepherd/issues/1692)) ([c5e408a](https://github.com/erwins-enkel/shepherd/commit/c5e408a648895ae778209fd5cf1eba00e62f48ca))
* **ui:** show capacity reset times in task dialog ([#1685](https://github.com/erwins-enkel/shepherd/issues/1685)) ([47d97c1](https://github.com/erwins-enkel/shepherd/commit/47d97c16b863b1bfa93a6fca95ce6fcdf6e80891))
* **ui:** show reviewer CLI + model on the in-flight plan-review button ([#1715](https://github.com/erwins-enkel/shepherd/issues/1715)) ([a05acfa](https://github.com/erwins-enkel/shepherd/commit/a05acfa18f4d6cf879bac9b81cc5944f4ce5f493))
* **ui:** show reviewer model in review banner ([#1741](https://github.com/erwins-enkel/shepherd/issues/1741)) ([5f6b7a6](https://github.com/erwins-enkel/shepherd/commit/5f6b7a699a1b38e3f53585122e1cdf9f0977792d))
* **ui:** sortable Created column in Files tab ([#1701](https://github.com/erwins-enkel/shepherd/issues/1701)) ([cc20630](https://github.com/erwins-enkel/shepherd/commit/cc20630626949a0bc71a501b2e459baaa7bbdf73))
* **ui:** source per-line Diff-tab annotations (agent reasoning + critic findings) ([#1699](https://github.com/erwins-enkel/shepherd/issues/1699)) ([#1703](https://github.com/erwins-enkel/shepherd/issues/1703)) ([ba1fdf3](https://github.com/erwins-enkel/shepherd/commit/ba1fdf3a25477d34a62013ee9204520ed162637f))
* **ui:** surface single-cli skill constraints ([#1720](https://github.com/erwins-enkel/shepherd/issues/1720)) ([4b837ce](https://github.com/erwins-enkel/shepherd/commit/4b837ce8ad1ea491b09d417883dfd3454484547c))
* **ui:** toggle build queue from progress badge ([#1722](https://github.com/erwins-enkel/shepherd/issues/1722)) ([77dbcf2](https://github.com/erwins-enkel/shepherd/commit/77dbcf2b228cadc15b2a906107068d8a42916731))
* **update:** explain a dirty self-update repo and offer a safe discard ([#1782](https://github.com/erwins-enkel/shepherd/issues/1782)) ([b51cbc4](https://github.com/erwins-enkel/shepherd/commit/b51cbc4a06f542f8e94542f9d59e42599ec6d2e7))


### Bug Fixes

* codex reviewer 'agent host is busy' — confirm exec spawns by tab existence ([#1724](https://github.com/erwins-enkel/shepherd/issues/1724)) ([374a328](https://github.com/erwins-enkel/shepherd/commit/374a328a02477d5cb63526b891bff73068753c46))
* **codex-update:** show completed version transition ([#1797](https://github.com/erwins-enkel/shepherd/issues/1797)) ([5e9dd23](https://github.com/erwins-enkel/shepherd/commit/5e9dd23642f3e6cf2f3d7908642dce447477314c))
* **codex:** remember the update channel that actually advances codex ([#1749](https://github.com/erwins-enkel/shepherd/issues/1749)) ([c0f1b6f](https://github.com/erwins-enkel/shepherd/commit/c0f1b6f25f10f2f772cb40bb87b6421121bf5dbb))
* **codex:** restore weekly usage gauge ([#1707](https://github.com/erwins-enkel/shepherd/issues/1707)) ([402495f](https://github.com/erwins-enkel/shepherd/commit/402495fe6d43d472fcee3558db28cfc20f7b5d83))
* **critic:** make the epic-child critic epic-aware and ground it in the real base ([#1764](https://github.com/erwins-enkel/shepherd/issues/1764)) ([1b9f367](https://github.com/erwins-enkel/shepherd/commit/1b9f367de8df6c723b0b175fac35643673a5886e))
* don't report a slow-but-successful epic approve as a failure ([#1745](https://github.com/erwins-enkel/shepherd/issues/1745)) ([f1ab6cc](https://github.com/erwins-enkel/shepherd/commit/f1ab6cc77bbf48b95051ff3e99b7fdf0ca390198))
* guard incompatible Codex main models ([#1716](https://github.com/erwins-enkel/shepherd/issues/1716)) ([6e91bc9](https://github.com/erwins-enkel/shepherd/commit/6e91bc9176225ca138ee7c4d5f84730613780d2f))
* **herdr:** recognize wrapped Codex exec roles ([#1780](https://github.com/erwins-enkel/shepherd/issues/1780)) ([2bc104c](https://github.com/erwins-enkel/shepherd/commit/2bc104c01494af0b79c186fc8297d87f81245100))
* name plan-review failure causes + fix the reviewer-spawn read-back race ([#1714](https://github.com/erwins-enkel/shepherd/issues/1714)) ([f33b208](https://github.com/erwins-enkel/shepherd/commit/f33b2087f87a0b9d08833a5adc9867271ba343c8))
* **onboarding:** stop racing the Arch image's own keyring init ([#1758](https://github.com/erwins-enkel/shepherd/issues/1758)) ([9bbc096](https://github.com/erwins-enkel/shepherd/commit/9bbc0964f18ba0b06335c1fb80b7a34e47edcc57))
* **plan-gate:** forced re-review must deliver its findings ([#1759](https://github.com/erwins-enkel/shepherd/issues/1759)) ([#1760](https://github.com/erwins-enkel/shepherd/issues/1760)) ([7204e59](https://github.com/erwins-enkel/shepherd/commit/7204e59f193562d48294b1e6171a89e7883e682a))
* **plan-gate:** preserve codex reviewer verdicts ([#1768](https://github.com/erwins-enkel/shepherd/issues/1768)) ([3692573](https://github.com/erwins-enkel/shepherd/commit/36925737b1c20cd94c856b26aaf52fd0db22a846))
* **plan-gate:** resume an exited (Codex) planner before steering findings ([#1721](https://github.com/erwins-enkel/shepherd/issues/1721)) ([95f0bac](https://github.com/erwins-enkel/shepherd/commit/95f0bac15531cae5860e241d8809f4cde3d840b8))
* preserve plan reviewer launches ([#1742](https://github.com/erwins-enkel/shepherd/issues/1742)) ([66b35f0](https://github.com/erwins-enkel/shepherd/commit/66b35f0d2b0d093791e38e67b4c8bcd340fba7cf))
* **recap:** guard ChatGPT-account-incompatible Codex role models ([#1681](https://github.com/erwins-enkel/shepherd/issues/1681)) ([af35b69](https://github.com/erwins-enkel/shepherd/commit/af35b697d70706251bd7f3a581ebd60ebd21a3b6))
* **relaunch:** restore Autopilot override ([#1803](https://github.com/erwins-enkel/shepherd/issues/1803)) ([2eedfe7](https://github.com/erwins-enkel/shepherd/commit/2eedfe74d796a66c2d38a1dad18f1652ccff9276))
* **sandbox:** let codex aux roles start and authenticate inside the bwrap membrane ([#1802](https://github.com/erwins-enkel/shepherd/issues/1802)) ([5ffde28](https://github.com/erwins-enkel/shepherd/commit/5ffde28cb47ac9a063a7ecdfe5b269b2a365e50b))
* **spawn:** don't let a slash-leading issue title become a slash command ([#1804](https://github.com/erwins-enkel/shepherd/issues/1804)) ([0e48ecb](https://github.com/erwins-enkel/shepherd/commit/0e48ecb147be0feb67e957f9f11a95f751b3d772))
* **terminal:** scale xterm font size with iOS Dynamic Type ([#1801](https://github.com/erwins-enkel/shepherd/issues/1801)) ([8000776](https://github.com/erwins-enkel/shepherd/commit/8000776929f04a9afaed3205ffb492d593990be2))
* **ui:** add PR draft actions to the terminal rail ([#1733](https://github.com/erwins-enkel/shepherd/issues/1733)) ([0d89c3e](https://github.com/erwins-enkel/shepherd/commit/0d89c3e0647224817e39f83b8c5fd74ce3098cf4))
* **ui:** align mobile git rail button heights ([#1705](https://github.com/erwins-enkel/shepherd/issues/1705)) ([d8ae784](https://github.com/erwins-enkel/shepherd/commit/d8ae78484432290dd5e84f0c8e3cae45427b197a))
* **ui:** cap Diff file sidebar at 1/3, collapse paths keeping the filename ([#1702](https://github.com/erwins-enkel/shepherd/issues/1702)) ([bfcef29](https://github.com/erwins-enkel/shepherd/commit/bfcef299a771bbd579e1179ced406c835a450f54))
* **ui:** clarify scratchpad and worktree files ([#1718](https://github.com/erwins-enkel/shepherd/issues/1718)) ([2aa48b3](https://github.com/erwins-enkel/shepherd/commit/2aa48b335d8547f91c964de94bbdf218ed27594a))
* **ui:** explain session-card status chips on hover/tap ([#1712](https://github.com/erwins-enkel/shepherd/issues/1712)) ([b98dffe](https://github.com/erwins-enkel/shepherd/commit/b98dffe34bbe7f34d7af39b380b1116b6f6df39d))
* **ui:** focus prompt after repo selection ([#1776](https://github.com/erwins-enkel/shepherd/issues/1776)) ([832bd6f](https://github.com/erwins-enkel/shepherd/commit/832bd6fbebcd175b5437749319850fcf95f262c9))
* **ui:** group git-rail passive status, unify mobile tap-target heights ([#1791](https://github.com/erwins-enkel/shepherd/issues/1791)) ([ff8621d](https://github.com/erwins-enkel/shepherd/commit/ff8621d4390e5b9dbe47677aed3810d4afe0ea43))
* **ui:** improve command bar result relevance ([#1723](https://github.com/erwins-enkel/shepherd/issues/1723)) ([bd6833e](https://github.com/erwins-enkel/shepherd/commit/bd6833e798389fe0b1f8c755cca1c8bda28f9906))
* **ui:** improve epic draft readability ([#1778](https://github.com/erwins-enkel/shepherd/issues/1778)) ([ca2506a](https://github.com/erwins-enkel/shepherd/commit/ca2506a408398f92735dce28900314dfbe655c28))
* **ui:** inline epic run-settings labels ([#1746](https://github.com/erwins-enkel/shepherd/issues/1746)) ([a924077](https://github.com/erwins-enkel/shepherd/commit/a9240775c093b70229cc6da65fd68fdc700d591a))
* **ui:** keep drain cap/ceiling editable during an epic ([#1772](https://github.com/erwins-enkel/shepherd/issues/1772)) ([cda1b21](https://github.com/erwins-enkel/shepherd/commit/cda1b21076266354df5a6ef733c3294ef6dfacb9))
* **ui:** keep epic draft review actions reachable ([#1734](https://github.com/erwins-enkel/shepherd/issues/1734)) ([6c22a32](https://github.com/erwins-enkel/shepherd/commit/6c22a32b6d7aa4b086c9d86f180acbc4e79b7a5f))
* **ui:** move epic draft review into a modal ([#1747](https://github.com/erwins-enkel/shepherd/issues/1747)) ([8834c7c](https://github.com/erwins-enkel/shepherd/commit/8834c7c4577f3b4753fdde5137463a6779c7f549))
* **ui:** only escalate the review banner on real operator input ([#1765](https://github.com/erwins-enkel/shepherd/issues/1765)) ([7c0525d](https://github.com/erwins-enkel/shepherd/commit/7c0525d7723043d65479be41b278fd4760bd1d4f))
* **ui:** restore Up Next row density (inline START) ([#1784](https://github.com/erwins-enkel/shepherd/issues/1784)) ([52e7fe4](https://github.com/erwins-enkel/shepherd/commit/52e7fe4c7dcdcda371fe73905e1b0b1a993e77e4))
* **ui:** show build queue chip before approval ([#1748](https://github.com/erwins-enkel/shepherd/issues/1748)) ([4b05ff1](https://github.com/erwins-enkel/shepherd/commit/4b05ff171514923d6e2a997429e83f08724d152c))
* **ui:** show learnings in desktop menu ([#1789](https://github.com/erwins-enkel/shepherd/issues/1789)) ([4a36e89](https://github.com/erwins-enkel/shepherd/commit/4a36e890999d1571edecd5e053c5ef61bfd9749b))
* **ui:** show repo on Owed lens cards ([#1793](https://github.com/erwins-enkel/shepherd/issues/1793)) ([0538513](https://github.com/erwins-enkel/shepherd/commit/0538513b5bae68fb77288ca3f11e47bdfcf4f551))
* **ui:** sort clone-repo list alphabetically ([#1744](https://github.com/erwins-enkel/shepherd/issues/1744)) ([23ea6cb](https://github.com/erwins-enkel/shepherd/commit/23ea6cbb32c281941d4c46d56bf8cdfa76c97d81))
* **ui:** stop the mobile list card's meta footer overflowing the page ([#1807](https://github.com/erwins-enkel/shepherd/issues/1807)) ([7e37c1c](https://github.com/erwins-enkel/shepherd/commit/7e37c1c3089f2e41784186fafac1ac239b21fa62))
* **ui:** stop the reviewing amber border leaking into FINAL REVIEW ([#1766](https://github.com/erwins-enkel/shepherd/issues/1766)) ([ef443e4](https://github.com/erwins-enkel/shepherd/commit/ef443e408a1b4795dc417e7311ae4e3fc084699e))
* **ui:** stop the stalled-review pill pulsing an orange dot ([#1767](https://github.com/erwins-enkel/shepherd/issues/1767)) ([22381fc](https://github.com/erwins-enkel/shepherd/commit/22381fceafac0c061de43e8378ef3b4d3968dcd6))
* **ui:** wrap long toast action label instead of squishing message ([#1750](https://github.com/erwins-enkel/shepherd/issues/1750)) ([f146fbf](https://github.com/erwins-enkel/shepherd/commit/f146fbf01362c34a0cea605b1e5a04ac7bca0405))
* **up-next:** remove dead hide-blocked toggle; exclude blocked variants server-side ([#1792](https://github.com/erwins-enkel/shepherd/issues/1792)) ([fec4181](https://github.com/erwins-enkel/shepherd/commit/fec41818f4c3da0ac251c87b03e7c12c77d4f80f))
* **usage-probe:** pre-seed claude folder-trust to stop /usage wedge ([#1075](https://github.com/erwins-enkel/shepherd/issues/1075)) ([#1684](https://github.com/erwins-enkel/shepherd/issues/1684)) ([f2c6733](https://github.com/erwins-enkel/shepherd/commit/f2c6733f1189755be96b88100ef1764e33be80bd))
* **usage:** reconcile weekly gauge after a mid-window reset; hide dead credits ([#1798](https://github.com/erwins-enkel/shepherd/issues/1798)) ([eb996c9](https://github.com/erwins-enkel/shepherd/commit/eb996c9525fb0997ddd3dcf9b66ccd49afd98d92))


### Documentation

* **research:** assess termdraw integration (verdict: don't) [no-feature-entry] ([#1693](https://github.com/erwins-enkel/shepherd/issues/1693)) ([9f3b928](https://github.com/erwins-enkel/shepherd/commit/9f3b9282966413713aea921bb7f4ad52bfd6ad83))
* **research:** fancier Diff tab via diffs.com / hunk.dev ([#1691](https://github.com/erwins-enkel/shepherd/issues/1691)) ([ca79fb8](https://github.com/erwins-enkel/shepherd/commit/ca79fb8f593fcd839004e0ab1eb47c4e2d2c844d))
* sync docs to recent source changes ([#1737](https://github.com/erwins-enkel/shepherd/issues/1737)) ([d328658](https://github.com/erwins-enkel/shepherd/commit/d328658f77fe84517066031ee7f6287edbc191c5))
* sync docs to recent source changes ([#1773](https://github.com/erwins-enkel/shepherd/issues/1773)) ([82d7f95](https://github.com/erwins-enkel/shepherd/commit/82d7f950d4e74852939a31ca92740279cd5a3b7a))
* sync docs to recent source changes ([#1795](https://github.com/erwins-enkel/shepherd/issues/1795)) ([cb8379b](https://github.com/erwins-enkel/shepherd/commit/cb8379bed2422b8006771b19b4e8da65001b28a0))

## [1.43.0](https://github.com/erwins-enkel/shepherd/compare/v1.42.0...v1.43.0) (2026-07-12)


### Features

* add repo preview open mode ([#1534](https://github.com/erwins-enkel/shepherd/issues/1534)) ([423a8ab](https://github.com/erwins-enkel/shepherd/commit/423a8abb2f491f2ef1560f6cc88a8bc49dded326))
* add stalled plan repair menu ([#1531](https://github.com/erwins-enkel/shepherd/issues/1531)) ([bd4a43b](https://github.com/erwins-enkel/shepherd/commit/bd4a43b4420f8ce5efd447cb92cc102ca807e429))
* allow task file attachments ([#1487](https://github.com/erwins-enkel/shepherd/issues/1487)) ([45a71b5](https://github.com/erwins-enkel/shepherd/commit/45a71b54e0d48a312c6e44e52189582e0b6102dd))
* **drain:** agent repair session for a genuinely-red epic landing PR ([#1665](https://github.com/erwins-enkel/shepherd/issues/1665)) ([#1671](https://github.com/erwins-enkel/shepherd/issues/1671)) ([bc5cb74](https://github.com/erwins-enkel/shepherd/commit/bc5cb74e02107b8ae3eb40466bb2ea2ea4bb2d4b))
* **drain:** pre-warm epic landing CI via an early draft landing PR (default-off toggle) ([#1664](https://github.com/erwins-enkel/shepherd/issues/1664)) ([#1670](https://github.com/erwins-enkel/shepherd/issues/1670)) ([a044671](https://github.com/erwins-enkel/shepherd/commit/a04467130dce2872fbfb45048b37ff8dc3acd250))
* **drain:** surface + auto-rerun CI-failing epic landing PRs ([#1667](https://github.com/erwins-enkel/shepherd/issues/1667)) ([e827788](https://github.com/erwins-enkel/shepherd/commit/e8277889e730ab2a278ffdfcf41d8fd3cc179add))
* **epic-diagnosis:** command-bar entry to diagnose an unrecognized would-be epic ([#1657](https://github.com/erwins-enkel/shepherd/issues/1657)) ([#1669](https://github.com/erwins-enkel/shepherd/issues/1669)) ([1a5f8aa](https://github.com/erwins-enkel/shepherd/commit/1a5f8aaf755caea67158f00c971aab42d778a0eb))
* **epic:** allow provider-aware child continuation ([#1498](https://github.com/erwins-enkel/shepherd/issues/1498)) ([3fe7517](https://github.com/erwins-enkel/shepherd/commit/3fe75178db3a3166e0635855f28cc623fe013ea2))
* exclude dependency-blocked issues from Up Next, flag them in the Backlog ([#1653](https://github.com/erwins-enkel/shepherd/issues/1653)) ([bcff6ac](https://github.com/erwins-enkel/shepherd/commit/bcff6ac866965f0964961866bcaa577ee8db1263))
* **herd:** highlight cards awaiting the operator with a subtle wash ([#1595](https://github.com/erwins-enkel/shepherd/issues/1595)) ([e304ee5](https://github.com/erwins-enkel/shepherd/commit/e304ee5b4754b797673ace9671332e8dc50f087f))
* **herdr:** adopt native socket API behind HerdrDriver (opt-in reads, [#1529](https://github.com/erwins-enkel/shepherd/issues/1529)) ([#1554](https://github.com/erwins-enkel/shepherd/issues/1554)) ([3d49b8c](https://github.com/erwins-enkel/shepherd/commit/3d49b8ca99ed2b4135da06ce34d7b73bfdbc35f5))
* **herdr:** generate socket protocol types from api schema + drift/protocol gates ([#1529](https://github.com/erwins-enkel/shepherd/issues/1529)) ([#1637](https://github.com/erwins-enkel/shepherd/issues/1637)) ([ef7f915](https://github.com/erwins-enkel/shepherd/commit/ef7f915c17eff01f8175249b809eef7091a44afa))
* **herdr:** port `send` (steer) over the socket ([#1567](https://github.com/erwins-enkel/shepherd/issues/1567)) ([#1575](https://github.com/erwins-enkel/shepherd/issues/1575)) ([21b4b37](https://github.com/erwins-enkel/shepherd/commit/21b4b3738f394ab2bcde1f8eff37a22e70963e03))
* **herdr:** port start/stop/relabel/closeTab over the socket ([#1553](https://github.com/erwins-enkel/shepherd/issues/1553)) ([#1568](https://github.com/erwins-enkel/shepherd/issues/1568)) ([f4f34cc](https://github.com/erwins-enkel/shepherd/commit/f4f34cc1345d7c7f6b8cec5a393710adbaae1f26))
* **herdr:** stream the browser terminal over terminal session control ([#1529](https://github.com/erwins-enkel/shepherd/issues/1529)) ([#1620](https://github.com/erwins-enkel/shepherd/issues/1620)) ([94bcf73](https://github.com/erwins-enkel/shepherd/commit/94bcf73826d3d25c4f594c6d250425a9502cea73))
* inject operator language preference into spawned agent sessions ([#1586](https://github.com/erwins-enkel/shepherd/issues/1586)) ([#1615](https://github.com/erwins-enkel/shepherd/issues/1615)) ([fcb90a4](https://github.com/erwins-enkel/shepherd/commit/fcb90a445464e11a077dc257a666fcc78bae8312))
* **issues:** hide blocked-labeled issues across Up Next & backlog ([#1678](https://github.com/erwins-enkel/shepherd/issues/1678)) ([e8845aa](https://github.com/erwins-enkel/shepherd/commit/e8845aa22bea8d6d0c9f7ac136bc50ee2ddef016))
* live review preview + dimmed terminal during in-flight reviews ([#1593](https://github.com/erwins-enkel/shepherd/issues/1593)) ([4eb390c](https://github.com/erwins-enkel/shepherd/commit/4eb390c045cb12cb9b5fd68f6907902e8e1af377))
* make epic authoring self-service: docs, diagnosis, and guarded creation flow (epic [#1504](https://github.com/erwins-enkel/shepherd/issues/1504)) ([#1661](https://github.com/erwins-enkel/shepherd/issues/1661)) ([c9572b9](https://github.com/erwins-enkel/shepherd/commit/c9572b91e81e8b3a8bc104c861feb002f94de426))
* make the manual plan re-review actually re-review (force seam) ([#1606](https://github.com/erwins-enkel/shepherd/issues/1606)) ([6a4fa10](https://github.com/erwins-enkel/shepherd/commit/6a4fa106bb4945e5ab94ea378a5db1ca514e6a2a))
* operator language mid-session persistence, classifier eval + remaining surfaces (epic [#1616](https://github.com/erwins-enkel/shepherd/issues/1616)) ([#1651](https://github.com/erwins-enkel/shepherd/issues/1651)) ([f88aedd](https://github.com/erwins-enkel/shepherd/commit/f88aeddef74df6204008fba1a397d3f5f6dbc771))
* plan-gate row CTAs — re-tier plan-rework + retry CI for ci-red ([#1629](https://github.com/erwins-enkel/shepherd/issues/1629)) ([#1652](https://github.com/erwins-enkel/shepherd/issues/1652)) ([321d64d](https://github.com/erwins-enkel/shepherd/commit/321d64d12e958a5be805ce98fae66fa737097945))
* **prompt:** worktree git-stash safety notice ([#1632](https://github.com/erwins-enkel/shepherd/issues/1632)) ([#1636](https://github.com/erwins-enkel/shepherd/issues/1636)) ([75accd2](https://github.com/erwins-enkel/shepherd/commit/75accd25564fbba2c01c7f11836a38fbb765213f))
* **repo-switcher:** add "add to filter" to repo chip menu ([#1521](https://github.com/erwins-enkel/shepherd/issues/1521)) ([b2885da](https://github.com/erwins-enkel/shepherd/commit/b2885da43df896c9c29b8140ad0524fa20ccb3d0))
* show session launch details in task tooltip ([#1501](https://github.com/erwins-enkel/shepherd/issues/1501)) ([21ba14a](https://github.com/erwins-enkel/shepherd/commit/21ba14af024fc7b60dbb0cc33456a215594a61a5))
* **ui:** add opt-in setting to skip Up Next coding-CLI picker ([#1511](https://github.com/erwins-enkel/shepherd/issues/1511)) ([aec6236](https://github.com/erwins-enkel/shepherd/commit/aec6236124aaf0a2d71a48095ed7b2f4e3a4db19))
* **ui:** add up next sorting ([#1495](https://github.com/erwins-enkel/shepherd/issues/1495)) ([c074f6c](https://github.com/erwins-enkel/shepherd/commit/c074f6c4cd427f92538e707f6cb5c419d48b19bb))
* **ui:** color issue label chips with their real forge colors ([#1677](https://github.com/erwins-enkel/shepherd/issues/1677)) ([da62dca](https://github.com/erwins-enkel/shepherd/commit/da62dca02ab3469140890e73f36b4cf8938c630d))
* **ui:** compare coding cli capacity ([#1492](https://github.com/erwins-enkel/shepherd/issues/1492)) ([0edfbd3](https://github.com/erwins-enkel/shepherd/commit/0edfbd3fea78a37af38e80a2872462fbe632a3cf))
* **ui:** make the Herd sidebar resizable ([#1601](https://github.com/erwins-enkel/shepherd/issues/1601)) ([dbb9fc0](https://github.com/erwins-enkel/shepherd/commit/dbb9fc092bc3c3f5d76b39437aaabce72f282e9f))
* **ui:** plan-gate row CTA follow-ups — idle self-heal, final-round badge, answer CTA ([#1610](https://github.com/erwins-enkel/shepherd/issues/1610)) ([#1631](https://github.com/erwins-enkel/shepherd/issues/1631)) ([21cbe3e](https://github.com/erwins-enkel/shepherd/commit/21cbe3edb1427445fee6a7e8004f52f497709f01))
* **ui:** reveal session task info on tap-and-hold ([#1608](https://github.com/erwins-enkel/shepherd/issues/1608)) ([f396269](https://github.com/erwins-enkel/shepherd/commit/f3962693f67b8700507553fd4738f73011160a7c))
* **ui:** show issue author and filter issues by author and label ([#1591](https://github.com/erwins-enkel/shepherd/issues/1591)) ([5283702](https://github.com/erwins-enkel/shepherd/commit/5283702d612498026ad153aa710b74124dec0f93))
* **ui:** surface each session's plan-gate reason + one-click action on the row ([#1561](https://github.com/erwins-enkel/shepherd/issues/1561)) ([#1611](https://github.com/erwins-enkel/shepherd/issues/1611)) ([c9a1b0a](https://github.com/erwins-enkel/shepherd/commit/c9a1b0aad58275c96b7ba31f6a9fb0fc6e3e6d5e))
* **ui:** warn on zero-dependency epics + surface the drain hold reason ([#1447](https://github.com/erwins-enkel/shepherd/issues/1447)) ([#1623](https://github.com/erwins-enkel/shepherd/issues/1623)) ([a05ce6c](https://github.com/erwins-enkel/shepherd/commit/a05ce6cac74c23324eb581c0f20d850a0cd55d0a))
* **viewport:** remove jump-to-latest key from mobile term controls ([#1515](https://github.com/erwins-enkel/shepherd/issues/1515)) ([2b855bc](https://github.com/erwins-enkel/shepherd/commit/2b855bcc78f970972331df5f177ae50092e69241))
* **viewport:** single-tap title folds header on touch ([#1525](https://github.com/erwins-enkel/shepherd/issues/1525)) ([aafbc77](https://github.com/erwins-enkel/shepherd/commit/aafbc776194bcbca97385a602c37cf809f678c93))
* **viewport:** single-tap title toggles git rail ([#1522](https://github.com/erwins-enkel/shepherd/issues/1522)) ([390a846](https://github.com/erwins-enkel/shepherd/commit/390a84630b40877f439827ff793f010d8273eb45))


### Bug Fixes

* auto-allow node's own tailnet host + accurate origin-block copy ([#1645](https://github.com/erwins-enkel/shepherd/issues/1645) Fix 2+3) ([#1649](https://github.com/erwins-enkel/shepherd/issues/1649)) ([686300f](https://github.com/erwins-enkel/shepherd/commit/686300f8e3d2519ab3c564e57c643722ae11d4f5))
* auto-allow Tailscale Service-fronted HUD hosts too ([#1645](https://github.com/erwins-enkel/shepherd/issues/1645) Fix 2/3) ([#1655](https://github.com/erwins-enkel/shepherd/issues/1655)) ([372a9f8](https://github.com/erwins-enkel/shepherd/commit/372a9f890e3bb2bc90a255d8ce0fba06f1f0681d))
* **build-queue:** arm reconcile gate on 1Hz running events, not the 15s sweep ([#1617](https://github.com/erwins-enkel/shepherd/issues/1617)) ([#1633](https://github.com/erwins-enkel/shepherd/issues/1633)) ([7b2eaa9](https://github.com/erwins-enkel/shepherd/commit/7b2eaa983ed10b7e0f4eceb98f36a46457c62d83))
* **build-queue:** flag working-but-unreported queues on the badge ([#1618](https://github.com/erwins-enkel/shepherd/issues/1618)) ([99021aa](https://github.com/erwins-enkel/shepherd/commit/99021aaba7d45f122068b4cbfdb9015e68c45c50))
* **buildqueue:** make the awaiting-approval state unmistakable ([#1592](https://github.com/erwins-enkel/shepherd/issues/1592)) ([d8cd873](https://github.com/erwins-enkel/shepherd/commit/d8cd873862442a32b834930c54b189f840ae0719))
* **codex:** update via `codex update` so standalone installs upgrade ([#1560](https://github.com/erwins-enkel/shepherd/issues/1560)) ([#1565](https://github.com/erwins-enkel/shepherd/issues/1565)) ([ce29353](https://github.com/erwins-enkel/shepherd/commit/ce29353437120d7e354c0dd6311e1f9ebe4ffef9))
* **diagnostics:** probe herdr server liveness, not just the binary ([#1559](https://github.com/erwins-enkel/shepherd/issues/1559)) ([#1562](https://github.com/erwins-enkel/shepherd/issues/1562)) ([5ce467c](https://github.com/erwins-enkel/shepherd/commit/5ce467c740ace3d9b6ee829801e6f8732705367f))
* **diagnostics:** self-heal false herdr "offline" verdict ([#1614](https://github.com/erwins-enkel/shepherd/issues/1614)) ([2ac1429](https://github.com/erwins-enkel/shepherd/commit/2ac1429c312c380a44ac6b80e2b02325c2958d5f))
* **doc-agent:** format docs with ignores off so PRs pass CI ([#1536](https://github.com/erwins-enkel/shepherd/issues/1536)) ([9c2ce27](https://github.com/erwins-enkel/shepherd/commit/9c2ce27e1b832c9bc764dc87562bc7d59e4f9799))
* **drain:** don't treat a stale critic verdict as "needs changes" ([#1662](https://github.com/erwins-enkel/shepherd/issues/1662)) ([20b3b3c](https://github.com/erwins-enkel/shepherd/commit/20b3b3c483f46bbe38ce0818579e3d7987dba4a3))
* **drain:** let Codex epics bypass Claude usage hold ([#1535](https://github.com/erwins-enkel/shepherd/issues/1535)) ([5ba8301](https://github.com/erwins-enkel/shepherd/commit/5ba83012a7e1fd8af754522b93f91730e6a6d53c))
* explain missing base refs on task create ([#1512](https://github.com/erwins-enkel/shepherd/issues/1512)) ([d942b88](https://github.com/erwins-enkel/shepherd/commit/d942b8861e44c0a25a326ea053f7a9e3593ab35f))
* **git:** cache the git-rail's live PR fetch so the session card shows it ([#1585](https://github.com/erwins-enkel/shepherd/issues/1585)) ([0daa471](https://github.com/erwins-enkel/shepherd/commit/0daa47157ce3a4dd2501e5e7c10f325bbb478bc4))
* **github:** flag codex PRs server-side off agentProvider ([#1518](https://github.com/erwins-enkel/shepherd/issues/1518)) ([ec955c8](https://github.com/erwins-enkel/shepherd/commit/ec955c8638a3b79dcb066229d0c8e342e5654400))
* **github:** keep REST signals alive during GraphQL backoff ([#1500](https://github.com/erwins-enkel/shepherd/issues/1500)) ([bbeb7e6](https://github.com/erwins-enkel/shepherd/commit/bbeb7e6bed190873b2dcac1e0a86fbdd53b2fad5))
* **herd:** drop moot ack button on terminal cards, verb-label merged manual-steps chip ([#1478](https://github.com/erwins-enkel/shepherd/issues/1478)) ([#1663](https://github.com/erwins-enkel/shepherd/issues/1663)) ([a8c1c74](https://github.com/erwins-enkel/shepherd/commit/a8c1c74e34a5d097cba0bb16cff11bf8b4b8ca78))
* **herdr:** gate socket terminal behind opt-in flag so scrolling works ([#1640](https://github.com/erwins-enkel/shepherd/issues/1640)) ([b7e865d](https://github.com/erwins-enkel/shepherd/commit/b7e865d2133b31e00226850968cbc11a842f289d))
* **herdr:** prefer HERDR_SESSION socket over inherited pane socket ([#1596](https://github.com/erwins-enkel/shepherd/issues/1596)) ([#1612](https://github.com/erwins-enkel/shepherd/issues/1612)) ([67792a2](https://github.com/erwins-enkel/shepherd/commit/67792a20bbd0b8bd350470d0a936d3870f1a0745))
* **herdr:** provision a running herdr daemon so the liveness check can go green ([#1574](https://github.com/erwins-enkel/shepherd/issues/1574)) ([#1580](https://github.com/erwins-enkel/shepherd/issues/1580)) ([a91ce9e](https://github.com/erwins-enkel/shepherd/commit/a91ce9e4788b55e26f6dd0e2d560dcda68ed8c22))
* **herdr:** recover herdr server after Update Herd ([#1558](https://github.com/erwins-enkel/shepherd/issues/1558)) ([#1563](https://github.com/erwins-enkel/shepherd/issues/1563)) ([5f580aa](https://github.com/erwins-enkel/shepherd/commit/5f580aa1ddd81c8f284dcc3e326625b2bb64c76e))
* **herdr:** reset-failed before restart in herdr_offline Fix path ([#1600](https://github.com/erwins-enkel/shepherd/issues/1600)) ([5f2dfa4](https://github.com/erwins-enkel/shepherd/commit/5f2dfa4a0c44e912837b0610c4ddb5451e48526b))
* **herdr:** update+handoff the running daemon on `herdr_outdated` ([#1578](https://github.com/erwins-enkel/shepherd/issues/1578)) ([#1603](https://github.com/erwins-enkel/shepherd/issues/1603)) ([12d96f0](https://github.com/erwins-enkel/shepherd/commit/12d96f03c2d069b6be79526f7785b9a892c77588))
* **learnings:** retype distiller/optimizer DI seams to =&gt; Promise&lt;void&gt; ([#1609](https://github.com/erwins-enkel/shepherd/issues/1609)) ([b6ce7c2](https://github.com/erwins-enkel/shepherd/commit/b6ce7c294efbba67a6c485e20b362f85152951f5))
* **onboarding:** failing optional remediation must not abort the apply ([#1577](https://github.com/erwins-enkel/shepherd/issues/1577)) ([#1599](https://github.com/erwins-enkel/shepherd/issues/1599)) ([3589725](https://github.com/erwins-enkel/shepherd/commit/3589725789d05623c8e29c3eacfa8ab1fa0a2050))
* **onboarding:** retry bun install on transient node-pty tarball flake ([#1602](https://github.com/erwins-enkel/shepherd/issues/1602)) ([#1605](https://github.com/erwins-enkel/shepherd/issues/1605)) ([720de06](https://github.com/erwins-enkel/shepherd/commit/720de066528032d71e027f189195b0ba211a48d0))
* **plan-gate:** surface unavailable plan artifacts ([#1494](https://github.com/erwins-enkel/shepherd/issues/1494)) ([cd6053a](https://github.com/erwins-enkel/shepherd/commit/cd6053a46a3d4f205e1f2f9a05c3424c336c5854))
* **reaper:** reap runaway orphans by env provenance, not cwd ([#1144](https://github.com/erwins-enkel/shepherd/issues/1144)) ([#1675](https://github.com/erwins-enkel/shepherd/issues/1675)) ([76b5642](https://github.com/erwins-enkel/shepherd/commit/76b5642a3b44c7f1fce9f16d1e561c9821781cf8))
* **recap:** handle Codex archive empty diffs ([#1509](https://github.com/erwins-enkel/shepherd/issues/1509)) ([c049a03](https://github.com/erwins-enkel/shepherd/commit/c049a038f85d00101353ee61c1be26582ce7fa39))
* **rework:** stop stalled/dismissed rework showing as REWORK RUNNING ([#1532](https://github.com/erwins-enkel/shepherd/issues/1532)) ([ca3e524](https://github.com/erwins-enkel/shepherd/commit/ca3e524315166b2e52cad8050e1636ec6d196645))
* **site:** add OpenAI footer trademark attribution ([#1528](https://github.com/erwins-enkel/shepherd/issues/1528)) ([a9b8b46](https://github.com/erwins-enkel/shepherd/commit/a9b8b46898afb6aedba4b87119c8c63fc3809c2c))
* **stepper:** explain the pipeline lamps on hover/focus and repair the legend ([#1587](https://github.com/erwins-enkel/shepherd/issues/1587)) ([151f540](https://github.com/erwins-enkel/shepherd/commit/151f54001ee3d8aec43469ffd8f8927eba88653f))
* **store:** hydrate pausedReason so paused landing epics stop churning reconcile ([#1668](https://github.com/erwins-enkel/shepherd/issues/1668)) ([0a0c8d6](https://github.com/erwins-enkel/shepherd/commit/0a0c8d6d0598a41996b11b3d42c14d35edf174c9))
* **tab-reaper:** bind helper labels + boot reap to shared constants ([#1147](https://github.com/erwins-enkel/shepherd/issues/1147)) ([#1673](https://github.com/erwins-enkel/shepherd/issues/1673)) ([6751ede](https://github.com/erwins-enkel/shepherd/commit/6751ede14a8fad9a9cec9917fea23a96729e982d))
* **test:** add preWarmEpicLandingCi to landing-repair RepoConfig literal ([#1674](https://github.com/erwins-enkel/shepherd/issues/1674)) ([d3fea1b](https://github.com/erwins-enkel/shepherd/commit/d3fea1b1be1a19cc56d39483b5832541b1356d77))
* **toasts:** unify auto-dismiss — dead-end failures 12s, sticky is explicit ([#1658](https://github.com/erwins-enkel/shepherd/issues/1658)) ([761bd2c](https://github.com/erwins-enkel/shepherd/commit/761bd2c3d759721b38ae2e1db00dfc5398d58512))
* **triage:** skip triage bot for repo-privileged authors ([#1499](https://github.com/erwins-enkel/shepherd/issues/1499)) ([5ed8f49](https://github.com/erwins-enkel/shepherd/commit/5ed8f49ff9a887048473d250cfdf055e191ab310))
* **ui:** avoid duplicate desktop session title ([#1488](https://github.com/erwins-enkel/shepherd/issues/1488)) ([21e0335](https://github.com/erwins-enkel/shepherd/commit/21e033572d87ae91a89e14953001587002323c9b))
* **ui:** clarify new task attachment copy ([#1489](https://github.com/erwins-enkel/shepherd/issues/1489)) ([07c7ca9](https://github.com/erwins-enkel/shepherd/commit/07c7ca9d385d7995f0a640929d48838b5ce903fa))
* **ui:** compact Up Next sort into icon menu, inline refresh ([#1516](https://github.com/erwins-enkel/shepherd/issues/1516)) ([bcba702](https://github.com/erwins-enkel/shepherd/commit/bcba702624b824410b4a0d3b1c5f5a31e7ce7018))
* **ui:** distinguish phone back control from queue pager ([#1502](https://github.com/erwins-enkel/shepherd/issues/1502)) ([35ed3f4](https://github.com/erwins-enkel/shepherd/commit/35ed3f4ccb48670b30dee31d9385be4a1cceeab3))
* **ui:** explain draft-mode sign-off ([#1530](https://github.com/erwins-enkel/shepherd/issues/1530)) ([601c0e4](https://github.com/erwins-enkel/shepherd/commit/601c0e460ed0908283d86f5368fab76f03d569a0))
* **ui:** explain epic start controls on hover ([#1548](https://github.com/erwins-enkel/shepherd/issues/1548)) ([08d5ed1](https://github.com/erwins-enkel/shepherd/commit/08d5ed1f5d749438143024e66b1ad078676379a3))
* **ui:** hide Codex usage in CLI picker when Codex absent ([#1508](https://github.com/erwins-enkel/shepherd/issues/1508)) ([aea9d7b](https://github.com/erwins-enkel/shepherd/commit/aea9d7bf74824c7aba36707b02b74d5a0a516062))
* **ui:** keep Up Next header on one line (no sort ⇅ wrap) ([#1523](https://github.com/erwins-enkel/shepherd/issues/1523)) ([c6802b1](https://github.com/erwins-enkel/shepherd/commit/c6802b12569cba5915af8048a1fd2ddfb1142cf5))
* **ui:** open top epic groups by default ([#1549](https://github.com/erwins-enkel/shepherd/issues/1549)) ([6a044b5](https://github.com/erwins-enkel/shepherd/commit/6a044b5e4cbf5f6d3731cc99244597bb665949d2))
* **ui:** pulse ready plan gate badge ([#1514](https://github.com/erwins-enkel/shepherd/issues/1514)) ([8423282](https://github.com/erwins-enkel/shepherd/commit/84232825d919ad572e124598a145c6612903cf87))
* **ui:** show both usage windows in remaining-room gauge ([#1589](https://github.com/erwins-enkel/shepherd/issues/1589)) ([388556e](https://github.com/erwins-enkel/shepherd/commit/388556e78187066b33edecba5c081b8e0720b53c))
* **ui:** silence Svelte 5 non-reactive/local-state warnings ([#1546](https://github.com/erwins-enkel/shepherd/issues/1546)) ([b538c72](https://github.com/erwins-enkel/shepherd/commit/b538c72e9f20dc3242c12fb32bef0226de1a6d17))
* **ui:** surface stalled plan actions ([#1524](https://github.com/erwins-enkel/shepherd/issues/1524)) ([77b9f02](https://github.com/erwins-enkel/shepherd/commit/77b9f0253f354366aaf6dd856120256d9e368511))
* **viewport:** cap review-in-flight banner so it can't bury the prompt ([#1619](https://github.com/erwins-enkel/shepherd/issues/1619)) ([fd8a528](https://github.com/erwins-enkel/shepherd/commit/fd8a52898238841727e043a00a9b29706a3c1711))


### Code Refactoring

* **ui:** optimize the two mobile session tab bars ([#1564](https://github.com/erwins-enkel/shepherd/issues/1564)) ([552fe37](https://github.com/erwins-enkel/shepherd/commit/552fe37c1202c16c1a79253dd17fb07f6e80c110))
* **ui:** remove all view mode; focus is the sole view ([#1557](https://github.com/erwins-enkel/shepherd/issues/1557)) ([950c0b8](https://github.com/erwins-enkel/shepherd/commit/950c0b8e541df93421a977eebbd5b805c62d6fd5))


### Documentation

* **design:** permit 6px on interactive controls within a chip row ([#1540](https://github.com/erwins-enkel/shepherd/issues/1540)) ([#1541](https://github.com/erwins-enkel/shepherd/issues/1541)) ([fc15aea](https://github.com/erwins-enkel/shepherd/commit/fc15aeaee5a9c6f4cb649c45d7434e0d9fdb742e))
* **design:** permit 6px semantically-accented status chips ([#1537](https://github.com/erwins-enkel/shepherd/issues/1537)) ([#1539](https://github.com/erwins-enkel/shepherd/issues/1539)) ([c966e43](https://github.com/erwins-enkel/shepherd/commit/c966e4382535082da97b5ddab5a7927890c7a78d))
* **readme:** add marketing screenshot ([#1552](https://github.com/erwins-enkel/shepherd/issues/1552)) ([2be7f83](https://github.com/erwins-enkel/shepherd/commit/2be7f83a1698ac5293be149ee9b8eaca0c431fc9))
* **spike:** adr [#1074](https://github.com/erwins-enkel/shepherd/issues/1074) keep worktreemgr over herdr worktrees (no-go) ([#1676](https://github.com/erwins-enkel/shepherd/issues/1676)) ([f25a3d5](https://github.com/erwins-enkel/shepherd/commit/f25a3d529bc7884f1247db00a8aa0312a6eaffc8))
* sync docs to recent source changes ([#1556](https://github.com/erwins-enkel/shepherd/issues/1556)) ([75eef20](https://github.com/erwins-enkel/shepherd/commit/75eef20f70f7e76ced96fe73b1614e3c2173b971))
* sync docs to recent source changes ([#1638](https://github.com/erwins-enkel/shepherd/issues/1638)) ([75dbefc](https://github.com/erwins-enkel/shepherd/commit/75dbefcd4b054c4bfd17a4b0af8f1b421b93290b))
* sync docs to recent source changes ([#1672](https://github.com/erwins-enkel/shepherd/issues/1672)) ([21caec4](https://github.com/erwins-enkel/shepherd/commit/21caec44bb80f2eb8a85cabaca4326b985b1aa97))

## [1.42.0](https://github.com/erwins-enkel/shepherd/compare/v1.41.0...v1.42.0) (2026-07-06)


### Features

* **ci:** manual dry-run dispatch for issue-triage testing ([#1462](https://github.com/erwins-enkel/shepherd/issues/1462)) ([1f756e5](https://github.com/erwins-enkel/shepherd/commit/1f756e5dc1a3a0dea80de30f548be3d0a5f9b68b))
* **ci:** triage newly-opened issues with a Haiku 4.5 bot ([#1458](https://github.com/erwins-enkel/shepherd/issues/1458)) ([74c1808](https://github.com/erwins-enkel/shepherd/commit/74c180804aa7b9c8d61cc18fbb84403cac4fcda6))
* compose-bar mic → local Whisper transcription (core hook for voice-whisper plugin) ([#76](https://github.com/erwins-enkel/shepherd/issues/76)) ([#1367](https://github.com/erwins-enkel/shepherd/issues/1367)) ([14034f7](https://github.com/erwins-enkel/shepherd/commit/14034f71a829135a4ec9cad04e6fbcae6c48eb31))
* **compose:** live read-along preview during local Whisper dictation (iOS MVP) ([#1379](https://github.com/erwins-enkel/shepherd/issues/1379)) ([d10fba9](https://github.com/erwins-enkel/shepherd/commit/d10fba9b45b00be742f1d71b6d2dc759bdb39474))
* **compose:** show transcription origin on the compose bar ([#1416](https://github.com/erwins-enkel/shepherd/issues/1416)) ([#1440](https://github.com/erwins-enkel/shepherd/issues/1440)) ([9683566](https://github.com/erwins-enkel/shepherd/commit/9683566c2bac1efee2b0d60a1ba44e34b41ab340))
* deliver plan-gate & research directives to Codex (TASK-413) ([#1232](https://github.com/erwins-enkel/shepherd/issues/1232)) ([b344229](https://github.com/erwins-enkel/shepherd/commit/b344229a221bae948d6084ec22cbcaa38ed2f6c8))
* **effort:** per-role effort matrix column + variant/compare picker control ([#1418](https://github.com/erwins-enkel/shepherd/issues/1418)) ([#1425](https://github.com/erwins-enkel/shepherd/issues/1425)) ([9e3d53b](https://github.com/erwins-enkel/shepherd/commit/9e3d53b4dc28e6106215b7bf085bb4dfa1d959c2))
* enable bring-back (restore) for isolated Codex sessions ([#1175](https://github.com/erwins-enkel/shepherd/issues/1175)) ([#1475](https://github.com/erwins-enkel/shepherd/issues/1475)) ([6c41b15](https://github.com/erwins-enkel/shepherd/commit/6c41b15ee451ea636f290319806e97f444c66ff6))
* **epics:** first-run walkthrough for a hands-off epic ([#1361](https://github.com/erwins-enkel/shepherd/issues/1361)) ([96f5373](https://github.com/erwins-enkel/shepherd/commit/96f5373ec75c3b5b773221c8035d7117b37e8412))
* expose reasoning effort (low…max) as a first-class control ([#1417](https://github.com/erwins-enkel/shepherd/issues/1417)) ([#1420](https://github.com/erwins-enkel/shepherd/issues/1420)) ([e25eca5](https://github.com/erwins-enkel/shepherd/commit/e25eca599cf293e95c9c3d34ce3b20018f6e3729))
* **extension:** add marquee (drag-rectangle) screenshot capture mode ([#1426](https://github.com/erwins-enkel/shepherd/issues/1426)) ([d8a88fd](https://github.com/erwins-enkel/shepherd/commit/d8a88fdffe2fb5d7e90e049f333956ffb4f05d31)), closes [#1423](https://github.com/erwins-enkel/shepherd/issues/1423)
* **extension:** allowlist the published Web Store ID (Task 5) ([#1383](https://github.com/erwins-enkel/shepherd/issues/1383)) ([0738cfe](https://github.com/erwins-enkel/shepherd/commit/0738cfea2712e70904b52cba4df8de02dad32d7b))
* **extension:** remove pairing step + add Chrome Web Store packaging ([#1365](https://github.com/erwins-enkel/shepherd/issues/1365)) ([4d0cfaf](https://github.com/erwins-enkel/shepherd/commit/4d0cfafe652b21996fe8621dcaa25bb27906d80d))
* harden Shepherd against prompt injection from issue/comment/PR content ([#1429](https://github.com/erwins-enkel/shepherd/issues/1429)) ([ee368b6](https://github.com/erwins-enkel/shepherd/commit/ee368b64c09811f6945a8d691c1bd4ddc0fc4b0a))
* **new-task:** support file attachments ([#1486](https://github.com/erwins-enkel/shepherd/issues/1486)) ([e1f03e1](https://github.com/erwins-enkel/shepherd/commit/e1f03e1408af03ae6914a2cc74d8fa84e9ba098e))
* **plugins:** activate installed plugins in-process without a restart ([#1377](https://github.com/erwins-enkel/shepherd/issues/1377)) ([631e0dc](https://github.com/erwins-enkel/shepherd/commit/631e0dc70866df037f27db8be138d3ed03ec3615))
* **plugins:** add repo link to settings ([#1479](https://github.com/erwins-enkel/shepherd/issues/1479)) ([ed19dca](https://github.com/erwins-enkel/shepherd/commit/ed19dcabe9dc8c2cc3ffd807b64a82fdb8204ce6))
* **plugins:** apply an available plugin update in place from the UI ([#1390](https://github.com/erwins-enkel/shepherd/issues/1390)) ([35cafd1](https://github.com/erwins-enkel/shepherd/commit/35cafd1b8af1ce959eed02607eed5b63078186e6))
* **plugins:** detect installed-plugin updates (informational) ([#1370](https://github.com/erwins-enkel/shepherd/issues/1370)) ([c9ce76b](https://github.com/erwins-enkel/shepherd/commit/c9ce76b07ad52e20dd08a88b1a75540eca63b58b))
* **plugins:** install plugins from the UI (Settings → Plugins) ([#1371](https://github.com/erwins-enkel/shepherd/issues/1371)) ([aa1c8b9](https://github.com/erwins-enkel/shepherd/commit/aa1c8b9a2487cad6b1cdc4c89145a49a822347e9))
* **plugins:** update state in the Plugins tab, on-demand check, diagnosable apply failures ([#1407](https://github.com/erwins-enkel/shepherd/issues/1407)) ([2ef9372](https://github.com/erwins-enkel/shepherd/commit/2ef93722cf22a4f894581a83e2e78480613d16fa))
* **readiness:** extend the AI-readiness analyzer to Rust/Cargo repos ([#1435](https://github.com/erwins-enkel/shepherd/issues/1435)) ([ef23c8e](https://github.com/erwins-enkel/shepherd/commit/ef23c8e806b1a38388c87a61c5d1437a64ec0a9d))
* **service:** inject epic-authoring notice on operator steer-time reply ([#1405](https://github.com/erwins-enkel/shepherd/issues/1405)) ([#1460](https://github.com/erwins-enkel/shepherd/issues/1460)) ([0fc3cb3](https://github.com/erwins-enkel/shepherd/commit/0fc3cb3c4b64da71cf81647502a68cd37709ff84))
* **settings:** one-click shepherd restart from settings and plugin banners ([#1411](https://github.com/erwins-enkel/shepherd/issues/1411)) ([e625308](https://github.com/erwins-enkel/shepherd/commit/e625308a18b1c9847a029947822bfd766b5c663d))
* **settings:** warn when critic effort lowered below high ([#1437](https://github.com/erwins-enkel/shepherd/issues/1437)) ([282ec7f](https://github.com/erwins-enkel/shepherd/commit/282ec7fdd309779296e3e2400aeff3178f222ccf)), closes [#1430](https://github.com/erwins-enkel/shepherd/issues/1430)
* show plan reviewer cli metadata ([#1464](https://github.com/erwins-enkel/shepherd/issues/1464)) ([e396c95](https://github.com/erwins-enkel/shepherd/commit/e396c95d18bf498ca737a982e34ca735666166c4))
* **site:** add Impressum page and link to Erwins Enkel ([#1364](https://github.com/erwins-enkel/shepherd/issues/1364)) ([3266dfe](https://github.com/erwins-enkel/shepherd/commit/3266dfedcf32aeb2e6bcc2fcbb0344de9da17b46))
* **site:** host Shepherd Capture privacy policy at /privacy ([#1375](https://github.com/erwins-enkel/shepherd/issues/1375)) ([b1b3c8d](https://github.com/erwins-enkel/shepherd/commit/b1b3c8d2337254d613b72a38de31f516056369b6))
* **skills:** add shepherd-epic-authoring skill for attended epic flows ([#1402](https://github.com/erwins-enkel/shepherd/issues/1402)) ([a307d6a](https://github.com/erwins-enkel/shepherd/commit/a307d6a25b7c422ddcc0ad44776084b4c4799732))
* **ui:** clickable banner for MCP OAuth auth URLs above the terminal ([#1436](https://github.com/erwins-enkel/shepherd/issues/1436)) ([b1f1add](https://github.com/erwins-enkel/shepherd/commit/b1f1adda035d7f6447f89b6cf5d5a63f4c55c79d))
* **ui:** files tab worktree/scratchpad source switch ([#1384](https://github.com/erwins-enkel/shepherd/issues/1384)) ([231cfe5](https://github.com/erwins-enkel/shepherd/commit/231cfe535629e675c22160fdcb2bb85b64eb03e4))
* **ui:** forward Claude's OSC 52 c-to-copy to the browser clipboard ([#1427](https://github.com/erwins-enkel/shepherd/issues/1427)) ([ed261cb](https://github.com/erwins-enkel/shepherd/commit/ed261cb1990b000b5264b09a59b7a96a89109fb2))
* **ui:** make epics in the backlog visible — sort to top, accent rows, real buttons ([#1374](https://github.com/erwins-enkel/shepherd/issues/1374)) ([c71bcf7](https://github.com/erwins-enkel/shepherd/commit/c71bcf7c9c687453c2c6fdb008980c25d7094af8))
* **ui:** merge PR from the badge popup when mergeable ([#1403](https://github.com/erwins-enkel/shepherd/issues/1403)) ([b213b9e](https://github.com/erwins-enkel/shepherd/commit/b213b9e030031a443df482ad3cfd039bb75fce82))
* **ui:** mic button on the New Task prompt ([#1433](https://github.com/erwins-enkel/shepherd/issues/1433)) ([#1454](https://github.com/erwins-enkel/shepherd/issues/1454)) ([d845cf2](https://github.com/erwins-enkel/shepherd/commit/d845cf2669f346bc993ae3cb4a6b783a8e4a9338))
* **ui:** promote the now-approved Shepherd Capture extension ([#1424](https://github.com/erwins-enkel/shepherd/issues/1424)) ([700772d](https://github.com/erwins-enkel/shepherd/commit/700772d3a8b1b0ea170c4d346becc9ee8903c5d4))
* **ui:** rotate compact usage gauges by provider ([#1469](https://github.com/erwins-enkel/shepherd/issues/1469)) ([c722291](https://github.com/erwins-enkel/shepherd/commit/c722291f566dc9fb8ef8b1a0104109bbb86378b6))
* **ui:** shift-click repo pills to combo-select multiple repos ([#1354](https://github.com/erwins-enkel/shepherd/issues/1354)) ([707e62f](https://github.com/erwins-enkel/shepherd/commit/707e62fdafa330a0e706f31724c89cb29f0216d9))
* **usage:** codex rate-limit gauges in usage popover like claude ([#1238](https://github.com/erwins-enkel/shepherd/issues/1238)) ([63636d3](https://github.com/erwins-enkel/shepherd/commit/63636d3cdce93028539ef0843f7c487c447c43ea))
* **usage:** label the popover usage sections per provider ([#1362](https://github.com/erwins-enkel/shepherd/issues/1362)) ([a940ffd](https://github.com/erwins-enkel/shepherd/commit/a940ffd75a471a5b598e46c2450987bc15bd0477))
* **usage:** surface Fable weekly sub-limit as its own bar ([#1352](https://github.com/erwins-enkel/shepherd/issues/1352)) ([ba1eed8](https://github.com/erwins-enkel/shepherd/commit/ba1eed8aaa24a61e1dabf4cc0697313c868818fa))
* **viewport:** add jump-to-session-start control ([#1344](https://github.com/erwins-enkel/shepherd/issues/1344)) ([be4aadf](https://github.com/erwins-enkel/shepherd/commit/be4aadffab84e676ec6e252c152843116d2afdfa))
* **viewport:** make review-in-flight banner prominent with a running-gear ([#1363](https://github.com/erwins-enkel/shepherd/issues/1363)) ([2c96c32](https://github.com/erwins-enkel/shepherd/commit/2c96c320b5066b94f3990b18f203b16f46b1421f))
* **viewport:** show a spinning-gear "CI running" banner in the terminal ([#1381](https://github.com/erwins-enkel/shepherd/issues/1381)) ([7a08a88](https://github.com/erwins-enkel/shepherd/commit/7a08a886db83c190a64aff38343b00f3c6dbc8ca))


### Bug Fixes

* **automation:** full-screen touch sheet + close button for repo automation panel ([#1444](https://github.com/erwins-enkel/shepherd/issues/1444)) ([72a7a86](https://github.com/erwins-enkel/shepherd/commit/72a7a8632c3775e672119fa64877f9c3feefdd83))
* **ci:** stop issue-triage no-op'ing valid classifications ([#1463](https://github.com/erwins-enkel/shepherd/issues/1463)) ([39e37ed](https://github.com/erwins-enkel/shepherd/commit/39e37ed5b9f9e95bc371bc7dad889d77499da7b6))
* **codex:** back off codex session-id capture + correct comments ([#1175](https://github.com/erwins-enkel/shepherd/issues/1175)) ([#1485](https://github.com/erwins-enkel/shepherd/issues/1485)) ([509cbbe](https://github.com/erwins-enkel/shepherd/commit/509cbbe61ed8958052ca19c19da1427f793424b9))
* **codex:** enable plan gate for new tasks ([#1346](https://github.com/erwins-enkel/shepherd/issues/1346)) ([f9b8677](https://github.com/erwins-enkel/shepherd/commit/f9b8677eacf8fda5605af4854e90dc50c750818f))
* **commandbar:** sync repo & status filter to the selected session ([#1366](https://github.com/erwins-enkel/shepherd/issues/1366)) ([4a4c998](https://github.com/erwins-enkel/shepherd/commit/4a4c99812f5d8e3cf8421beb2783562f08a830b0))
* **diagnostics:** retry gh auth probe, stop false "not logged in" ([#1459](https://github.com/erwins-enkel/shepherd/issues/1459)) ([a3275fd](https://github.com/erwins-enkel/shepherd/commit/a3275fd204b4cdf4d99e4f1127a246070a9b09bf))
* **drain:** gate extra-credit pause on imminent, not cumulative, spend ([#1376](https://github.com/erwins-enkel/shepherd/issues/1376)) ([09fbf15](https://github.com/erwins-enkel/shepherd/commit/09fbf1528cb2948cd23aa171ddf89181f05df335))
* **epic:** record epic_integrated on all merged-PR settle paths + reconcile sweep ([#1404](https://github.com/erwins-enkel/shepherd/issues/1404)) ([aa93d63](https://github.com/erwins-enkel/shepherd/commit/aa93d6352ba82b04e890e25c56b9ed8d841b03a4)), closes [#1401](https://github.com/erwins-enkel/shepherd/issues/1401)
* **extension:** strip manifest `key` from the Chrome Web Store zip ([#1378](https://github.com/erwins-enkel/shepherd/issues/1378)) ([34814d4](https://github.com/erwins-enkel/shepherd/commit/34814d4c28e3b16332489e841fa7876b05663f10))
* **forge:** dedupe statusCheckRollup to latest run per check ([#1388](https://github.com/erwins-enkel/shepherd/issues/1388)) ([ac80d8e](https://github.com/erwins-enkel/shepherd/commit/ac80d8e6a70eaa592c307b9325562d46f6547dc5)), closes [#1387](https://github.com/erwins-enkel/shepherd/issues/1387)
* **herdr-update:** recover via gated relaunch, not nonexistent `server start` ([#1410](https://github.com/erwins-enkel/shepherd/issues/1410)) ([#1471](https://github.com/erwins-enkel/shepherd/issues/1471)) ([426942f](https://github.com/erwins-enkel/shepherd/commit/426942fd6dea9c6fa0673bc2236e704c62b10350))
* make up next start capacity-aware ([#1472](https://github.com/erwins-enkel/shepherd/issues/1472)) ([ce44c4a](https://github.com/erwins-enkel/shepherd/commit/ce44c4a69fa4f916a59a84181482c9867c793e14))
* **onboarding:** refresh Arch keyring before pacman installs ([#1439](https://github.com/erwins-enkel/shepherd/issues/1439)) ([f3778f6](https://github.com/erwins-enkel/shepherd/commit/f3778f65b535f971c57dab472ba00b84adc32d05))
* **plan-gate:** clarify start-blocked states ([#1465](https://github.com/erwins-enkel/shepherd/issues/1465)) ([e802e55](https://github.com/erwins-enkel/shepherd/commit/e802e556138e7d05538e71ecee4e108422981ba9))
* **poller:** resolve transcripts under the session's spawn account ([#1438](https://github.com/erwins-enkel/shepherd/issues/1438)) ([775e195](https://github.com/erwins-enkel/shepherd/commit/775e195ac9a42a11ef87d1dcb3fcef69801a281a))
* **poller:** surface MCP OAuth auth-URL banner for done/idle sessions ([#1441](https://github.com/erwins-enkel/shepherd/issues/1441)) ([b36fa2e](https://github.com/erwins-enkel/shepherd/commit/b36fa2e0de07e647cae87db1b96b2c22bdf8bd11))
* **poller:** surface the Claude /login account-URL banner (PTY-only source) ([#1457](https://github.com/erwins-enkel/shepherd/issues/1457)) ([edf9bd7](https://github.com/erwins-enkel/shepherd/commit/edf9bd7d3aaff1ead7a7dbbee5bddbd4344fa169))
* **readiness:** prescribe stack-correct dependabot ecosystem in adopt prompt ([#1395](https://github.com/erwins-enkel/shepherd/issues/1395)) ([4c1849b](https://github.com/erwins-enkel/shepherd/commit/4c1849bc927d41bbc3b84373f4ca38ed48c5e611))
* recover the plugin-injected account when herdr restart re-drives a session ([#1432](https://github.com/erwins-enkel/shepherd/issues/1432)) ([ff1dcb1](https://github.com/erwins-enkel/shepherd/commit/ff1dcb1c60d510ff4f69a550e37ed3bdea492d5d))
* **server:** allowlist GET /api/sessions/:id/queue on agent ingress ([#1392](https://github.com/erwins-enkel/shepherd/issues/1392)) ([bfcba39](https://github.com/erwins-enkel/shepherd/commit/bfcba39ae2a834b93033a8f8dfe72a7760e65333))
* **service:** teach spawned agents Shepherd's epic-recognition contract ([#1394](https://github.com/erwins-enkel/shepherd/issues/1394)) ([a179bfa](https://github.com/erwins-enkel/shepherd/commit/a179bfa1ebf093092c226f6939c8d0cc6d2ee9bd))
* settings gear attention dot ([#1480](https://github.com/erwins-enkel/shepherd/issues/1480)) ([25dd456](https://github.com/erwins-enkel/shepherd/commit/25dd456f7c6428513a96049323fa0dbaea1d23e0))
* **ui:** add uninstall and restart plugin action ([#1467](https://github.com/erwins-enkel/shepherd/issues/1467)) ([14ec7e4](https://github.com/erwins-enkel/shepherd/commit/14ec7e4ea22a3c85a2cb71f6da74304925f94a3e))
* **ui:** disambiguate auto-address/auto-drain German names and rewrite their info texts ([#1443](https://github.com/erwins-enkel/shepherd/issues/1443)) ([120132e](https://github.com/erwins-enkel/shepherd/commit/120132e40e4c61a60b65ffc394fbc43b1c8ab45b))
* **ui:** group running rework sessions ([#1474](https://github.com/erwins-enkel/shepherd/issues/1474)) ([3bcda38](https://github.com/erwins-enkel/shepherd/commit/3bcda384eb44215b5fa81acda755e190657db13a))
* **ui:** land on the epic reliably when its badge is clicked ([#1445](https://github.com/erwins-enkel/shepherd/issues/1445)) ([3ae5617](https://github.com/erwins-enkel/shepherd/commit/3ae5617854145a8b54c957dd0b28679f1af2b164))
* **ui:** make the integrated-epics band say what actually happened ([#1406](https://github.com/erwins-enkel/shepherd/issues/1406)) ([8fcd7bd](https://github.com/erwins-enkel/shepherd/commit/8fcd7bd58983d0c41adea6877262f48a4debe73a))
* **ui:** pin the Repos modal to a fixed height, like the Settings modal ([#1415](https://github.com/erwins-enkel/shepherd/issues/1415)) ([3a7b48a](https://github.com/erwins-enkel/shepherd/commit/3a7b48af96c3d8df39bafd33fb12acdc88382b7a))
* **ui:** prioritize needs-input sessions in command bar ([#1466](https://github.com/erwins-enkel/shepherd/issues/1466)) ([74bda12](https://github.com/erwins-enkel/shepherd/commit/74bda1211501b4b1c6a34436cfcd1cef17da6bf0))
* **ui:** reflow terminal above review/CI banner instead of covering the prompt ([#1434](https://github.com/erwins-enkel/shepherd/issues/1434)) ([7bb2ad5](https://github.com/erwins-enkel/shepherd/commit/7bb2ad5d5ab37fdc764397268efc0abe57be63ab))
* **ui:** rename Coding CLI settings tab ([#1470](https://github.com/erwins-enkel/shepherd/issues/1470)) ([b278826](https://github.com/erwins-enkel/shepherd/commit/b278826515160ea56ac9b7a8604890d12873561d))
* **ui:** reorder new-task toggles, lock plan-gate/autopilot while Research on ([#1385](https://github.com/erwins-enkel/shepherd/issues/1385)) ([3e882bc](https://github.com/erwins-enkel/shepherd/commit/3e882bc7eeac2bcfce2bf85d0f5a9608882893a4))
* **ui:** replace dictate dots with mic icons ([#1484](https://github.com/erwins-enkel/shepherd/issues/1484)) ([c8ba207](https://github.com/erwins-enkel/shepherd/commit/c8ba2077a7f424510ec07732777dbc2020b3673f))
* **ui:** restore session rename affordances ([#1481](https://github.com/erwins-enkel/shepherd/issues/1481)) ([f464361](https://github.com/erwins-enkel/shepherd/commit/f4643617d0513810252e24fb04d67d2f927a6e8f))
* **ui:** resync epic/drain state on wake + socket reopen, soft-refresh backlog drawer ([#1399](https://github.com/erwins-enkel/shepherd/issues/1399)) ([a000f1f](https://github.com/erwins-enkel/shepherd/commit/a000f1f569a17c5813e454ef8c92440ed4ee520b))
* **ui:** show active rework terminal strip ([#1473](https://github.com/erwins-enkel/shepherd/issues/1473)) ([65740fe](https://github.com/erwins-enkel/shepherd/commit/65740fe2250080c8c070b9a23c6be275cdd9e624))
* **ui:** show Codex gauges in usage limits ([#1483](https://github.com/erwins-enkel/shepherd/issues/1483)) ([5c9e0eb](https://github.com/erwins-enkel/shepherd/commit/5c9e0eb22075427bd74df6c5bcf6fb2e2b38a472))
* **ui:** stabilize settings dialog tabs ([#1369](https://github.com/erwins-enkel/shepherd/issues/1369)) ([4a3fe44](https://github.com/erwins-enkel/shepherd/commit/4a3fe44704c9b7d0a6986a5d0c1498fa181ae920))
* **ui:** wrap RedrawMenu hint text within the popover ([#1372](https://github.com/erwins-enkel/shepherd/issues/1372)) ([ad9e111](https://github.com/erwins-enkel/shepherd/commit/ad9e11169a1d736316d6f2f64a07a08a8ceddaed))
* **up-next:** honor issue assignee (mine & unassigned) ([#1356](https://github.com/erwins-enkel/shepherd/issues/1356)) ([bd2a4b2](https://github.com/erwins-enkel/shepherd/commit/bd2a4b2aab62086619bc7f654e07488d6222d52d))
* **up-next:** recompute after start once the claim label lands ([#1355](https://github.com/erwins-enkel/shepherd/issues/1355)) ([8c052da](https://github.com/erwins-enkel/shepherd/commit/8c052daa640d91c654587ea9dae32e822b34ab6e))
* **viewport:** keep review-banner gear rotating under reduced-motion ([#1373](https://github.com/erwins-enkel/shepherd/issues/1373)) ([2b978fb](https://github.com/erwins-enkel/shepherd/commit/2b978fb543634b680f74c5914fabd78a7ba2281b))


### Code Refactoring

* **critic:** retire dead MAX_THINKING_TOKENS channel, --effort is sole reasoning lever ([#1431](https://github.com/erwins-enkel/shepherd/issues/1431)) ([c1ece20](https://github.com/erwins-enkel/shepherd/commit/c1ece203cb85b99d2227036cc455a5c626b80c56))
* **ui:** thin viewport footer hints; retire g/Alt+G needs-you nav ([#1409](https://github.com/erwins-enkel/shepherd/issues/1409)) ([d3e76a7](https://github.com/erwins-enkel/shepherd/commit/d3e76a7135d68b981560206ae03ef86615af621a))


### Documentation

* acknowledge Can Celik's herdr across README, docs site, landing page ([#1408](https://github.com/erwins-enkel/shepherd/issues/1408)) ([d4efa5b](https://github.com/erwins-enkel/shepherd/commit/d4efa5bf33429b3db68192564647885dd97ec96b))
* link Discussions from README badge + Status; add Q&A discussion form ([#1414](https://github.com/erwins-enkel/shepherd/issues/1414)) ([9dfe4c5](https://github.com/erwins-enkel/shepherd/commit/9dfe4c5d4acba2c3cb9f9b621e4eb14eaed040f8))
* **readme:** add CI, release, license badges ([#1413](https://github.com/erwins-enkel/shepherd/issues/1413)) ([0667f9b](https://github.com/erwins-enkel/shepherd/commit/0667f9bd6de3511510531773ddcd34e2d110ff23))
* **readme:** repo is public — retitle external-testers section, drop private-repo workarounds ([#1449](https://github.com/erwins-enkel/shepherd/issues/1449)) ([4f8b7fd](https://github.com/erwins-enkel/shepherd/commit/4f8b7fd7960bc420cc89ccc2ef67ad1e211bbff4))
* **research:** chrome web store readiness for capture extension ([#1359](https://github.com/erwins-enkel/shepherd/issues/1359)) ([0a5181f](https://github.com/erwins-enkel/shepherd/commit/0a5181f3a7b66a4396d724a3601dc4834ba654ed))
* sync docs to recent source changes ([#1398](https://github.com/erwins-enkel/shepherd/issues/1398)) ([2cb9283](https://github.com/erwins-enkel/shepherd/commit/2cb9283bb32c5e9ded5e78073c023e9cada1fe0e))
* **telemetry:** research report on optimizing Aptabase integration ([#1380](https://github.com/erwins-enkel/shepherd/issues/1380)) ([5147eec](https://github.com/erwins-enkel/shepherd/commit/5147eec90efed149c6fd9e57dd209fa739878d5e))

## [1.41.0](https://github.com/erwins-enkel/shepherd/compare/v1.40.0...v1.41.0) (2026-07-02)


### Features

* **prs:** flag PRs with workflows awaiting approval ([#1328](https://github.com/erwins-enkel/shepherd/issues/1328)) ([976591b](https://github.com/erwins-enkel/shepherd/commit/976591b0237c9651536855cf8d0474e82aaa7c79))
* **sites:** add Vercel Web Analytics to docs + marketing sites ([#1321](https://github.com/erwins-enkel/shepherd/issues/1321)) ([69eec2f](https://github.com/erwins-enkel/shepherd/commit/69eec2f5c1b3ec23128e5c3c2ea89afa2bbd0bc6))
* **sites:** track marketing CTA custom events via Vercel Analytics ([#1323](https://github.com/erwins-enkel/shepherd/issues/1323)) ([a7b48e2](https://github.com/erwins-enkel/shepherd/commit/a7b48e251efe7fecbd4dee17d8c28974c14a17f1))
* **telemetry:** anonymous opt-in usage telemetry via Aptabase ([#1331](https://github.com/erwins-enkel/shepherd/issues/1331)) ([8831d0c](https://github.com/erwins-enkel/shepherd/commit/8831d0c61c2780746f7cb8f73b7ceb6f754cdf9f))
* **telemetry:** wire session_created / epic_drained / pr_opened events ([#1329](https://github.com/erwins-enkel/shepherd/issues/1329)) ([#1342](https://github.com/erwins-enkel/shepherd/issues/1342)) ([fe4fa08](https://github.com/erwins-enkel/shepherd/commit/fe4fa085dab39412a23f7970893f71fefd9b57e0))
* **ui:** ambient browser-tab state signaling ([#1327](https://github.com/erwins-enkel/shepherd/issues/1327)) ([#1333](https://github.com/erwins-enkel/shepherd/issues/1333)) ([bbcac08](https://github.com/erwins-enkel/shepherd/commit/bbcac0818d45ece1e6e997c62b390f6b26fd8af8))
* **ui:** command bar — Cmd/Ctrl+K quick-switcher for sessions, repos & lenses ([#1334](https://github.com/erwins-enkel/shepherd/issues/1334)) ([#1337](https://github.com/erwins-enkel/shepherd/issues/1337)) ([722c3db](https://github.com/erwins-enkel/shepherd/commit/722c3dbf4d8b3d6b305921269b25bae9e0ae0837))
* **ui:** command bar v2 — docs search + actions registry ([#1338](https://github.com/erwins-enkel/shepherd/issues/1338)) ([#1343](https://github.com/erwins-enkel/shepherd/issues/1343)) ([bacec92](https://github.com/erwins-enkel/shepherd/commit/bacec92949acfa0a2a2585670f203ceddcbce4a9))
* **ui:** command-bar search field in top bar; unify docs + learnings ([#1351](https://github.com/erwins-enkel/shepherd/issues/1351)) ([37c6289](https://github.com/erwins-enkel/shepherd/commit/37c62897c32fcfe0e8ef144e45dd1dd52525b5c7))
* **ui:** complete ambient tab signal — progress ring + glyph ticker + toggle ([#1341](https://github.com/erwins-enkel/shepherd/issues/1341)) ([aabbf69](https://github.com/erwins-enkel/shepherd/commit/aabbf69eed96c9da77dd82882ba3cfaeda303b5c))
* **ui:** count unanswered plan-gate questions in the ambient tab signal ([#1332](https://github.com/erwins-enkel/shepherd/issues/1332)) ([#1339](https://github.com/erwins-enkel/shepherd/issues/1339)) ([6318426](https://github.com/erwins-enkel/shepherd/commit/6318426bbcddf6034ad8b705f3b58b6fe5e0798f))
* **ui:** filter session list from command bar repo results ([#1348](https://github.com/erwins-enkel/shepherd/issues/1348)) ([e443ca3](https://github.com/erwins-enkel/shepherd/commit/e443ca39ebe3e846de7392a95d470f3c80286aec))
* **ui:** fuzzy matching for the command bar ([#1345](https://github.com/erwins-enkel/shepherd/issues/1345)) ([a9f8ade](https://github.com/erwins-enkel/shepherd/commit/a9f8ade5e82c2df3f96b999159174799f6b63486))
* **ui:** hold Alt to jump to command-bar results by number ([#1349](https://github.com/erwins-enkel/shepherd/issues/1349)) ([49e6c7f](https://github.com/erwins-enkel/shepherd/commit/49e6c7feb3fb215b5ea87477b9f50b87a8410bca))


### Bug Fixes

* **boot:** de-dupe near-boot tmp-sweep + quiet two spurious log lines ([#1317](https://github.com/erwins-enkel/shepherd/issues/1317)) ([3004462](https://github.com/erwins-enkel/shepherd/commit/300446286794bb0ce9e7ee61b05c75b2a00bd59f))
* **macos:** chmod node-pty spawn-helper after install so PTY spawns ([#1318](https://github.com/erwins-enkel/shepherd/issues/1318)) ([1782234](https://github.com/erwins-enkel/shepherd/commit/1782234b80bbf8ddb43d49bd4cbc82f01505a3c3))
* make PR badge menu click-only ([#1300](https://github.com/erwins-enkel/shepherd/issues/1300)) ([40aa2d7](https://github.com/erwins-enkel/shepherd/commit/40aa2d7f101fca14713725ccce20f8664822417f))
* **onboarding-harness:** boot past [#1313](https://github.com/erwins-enkel/shepherd/issues/1313) herdr fail-fast in seeded scenarios ([#1324](https://github.com/erwins-enkel/shepherd/issues/1324)) ([fea4a5c](https://github.com/erwins-enkel/shepherd/commit/fea4a5c0c381d27a4f60b7f240767beabba567fa)), closes [#1322](https://github.com/erwins-enkel/shepherd/issues/1322)
* **owed:** scope Owed lens list + badge to the active repo chip ([#1330](https://github.com/erwins-enkel/shepherd/issues/1330)) ([298d7af](https://github.com/erwins-enkel/shepherd/commit/298d7af1696dad38e8cefab253ae716c95a45492))
* **preview:** clarify tailnet preview setup contract ([#1340](https://github.com/erwins-enkel/shepherd/issues/1340)) ([c7feeeb](https://github.com/erwins-enkel/shepherd/commit/c7feeeb308c756841524f1f8f59c5ba28072d559))
* **security:** resolve CodeQL alerts — table escaping, error exposure, url guard ([#1325](https://github.com/erwins-enkel/shepherd/issues/1325)) ([29f7be5](https://github.com/erwins-enkel/shepherd/commit/29f7be5b9368768e3fa8b95f074df7bc02cc7ab7))
* **telemetry:** normalize locale to Aptabase's 10-char limit ([#1335](https://github.com/erwins-enkel/shepherd/issues/1335)) ([60d0af6](https://github.com/erwins-enkel/shepherd/commit/60d0af6d453f409380239ea6f42a1ded13f66b2e))
* **tmp-sweep:** skip non-git work-dir folders in worktree prune ([#1315](https://github.com/erwins-enkel/shepherd/issues/1315)) ([73a5b69](https://github.com/erwins-enkel/shepherd/commit/73a5b69c03c2202a1232584670fdc9bcc026175d))


### Documentation

* document operator password login ([#1350](https://github.com/erwins-enkel/shepherd/issues/1350)) ([4d1bfa7](https://github.com/erwins-enkel/shepherd/commit/4d1bfa7a9cdd784b200e0b12cf7079f7795ffb8a))
* **research:** tab-based state & operator-awareness signaling ([#1326](https://github.com/erwins-enkel/shepherd/issues/1326)) ([33e96a7](https://github.com/erwins-enkel/shepherd/commit/33e96a73efe2229f9111fdea642de8ccad7e9fa2))
* surface recent features (command bar, tab signal, plugins) across demo, docs & marketing ([#1347](https://github.com/erwins-enkel/shepherd/issues/1347)) ([72eb009](https://github.com/erwins-enkel/shepherd/commit/72eb00920d50debba17d5f3f489491617f0118e1))

## [1.40.0](https://github.com/erwins-enkel/shepherd/compare/v1.39.1...v1.40.0) (2026-07-01)


### Features

* optimize first-run experience (herdr fail-fast + repo-root gate + onboarding picker) ([#1313](https://github.com/erwins-enkel/shepherd/issues/1313)) ([3343c08](https://github.com/erwins-enkel/shepherd/commit/3343c08de33767d34dd3d1ad9dd4b0eab23a0353))


### Bug Fixes

* **install:** show install dir in first-run output so operator can cd to start ([#1314](https://github.com/erwins-enkel/shepherd/issues/1314)) ([5af60a3](https://github.com/erwins-enkel/shepherd/commit/5af60a3ce2e79a93157f008ad2b762cb6f21fe32))
* **viewport:** lift jump-to-latest button clear of review-in-flight banner ([#1311](https://github.com/erwins-enkel/shepherd/issues/1311)) ([57df1f4](https://github.com/erwins-enkel/shepherd/commit/57df1f47fc36bcfa0f74d518f37f851dc6226341))


### Documentation

* **issue-templates:** enrich for public contributors + add docs & PR templates ([#1309](https://github.com/erwins-enkel/shepherd/issues/1309)) ([c7e5352](https://github.com/erwins-enkel/shepherd/commit/c7e5352061babd8ff9740949019d3bd322093673))

## [1.39.1](https://github.com/erwins-enkel/shepherd/compare/v1.39.0...v1.39.1) (2026-07-01)


### Code Refactoring

* **poller:** extract per-session stall/liveness state machine into SessionLiveness ([#1095](https://github.com/erwins-enkel/shepherd/issues/1095)) ([#1306](https://github.com/erwins-enkel/shepherd/issues/1306)) ([bdd7d2a](https://github.com/erwins-enkel/shepherd/commit/bdd7d2a48445d33d7e73a503576cb7490dff7621))

## [1.39.0](https://github.com/erwins-enkel/shepherd/compare/v1.38.0...v1.39.0) (2026-07-01)


### Features

* **compare:** run a task on multiple models/CLIs and compare the results ([#1227](https://github.com/erwins-enkel/shepherd/issues/1227)) ([f38bc10](https://github.com/erwins-enkel/shepherd/commit/f38bc10733dc654a2f179cb3e7c2ae0b69024764))
* **deploy:** size-cap shepherd.log via logrotate timer ([#1212](https://github.com/erwins-enkel/shepherd/issues/1212)) ([#1215](https://github.com/erwins-enkel/shepherd/issues/1215)) ([7bfc482](https://github.com/erwins-enkel/shepherd/commit/7bfc4827c0b4f91d3b71f035413ecbecec64955d))
* **new-task:** hide hidden repos in repo picker, reveal on search ([#1266](https://github.com/erwins-enkel/shepherd/issues/1266)) ([c815bd1](https://github.com/erwins-enkel/shepherd/commit/c815bd1c49b3fa8a41e03d967dbf6a6e2712bc3f))
* **owed:** count badge on OWED lens + agent notice to declare manual steps ([#1259](https://github.com/erwins-enkel/shepherd/issues/1259)) ([916e6f2](https://github.com/erwins-enkel/shepherd/commit/916e6f225182641dacd0d7962647103b21fa5ebd))
* **owed:** link the manual-steps chip to its Owed-lens details ([#1277](https://github.com/erwins-enkel/shepherd/issues/1277)) ([77d351d](https://github.com/erwins-enkel/shepherd/commit/77d351d585137fa7fac6f01e48230ede406456ee))
* **plugins:** allow plugins to add a single gear-menu item ([#1202](https://github.com/erwins-enkel/shepherd/issues/1202)) ([1f21237](https://github.com/erwins-enkel/shepherd/commit/1f21237d04473caf37e6f832d6cdde9f970883ee))
* **plugins:** bind a routed credentialDir into the reviewer sandbox ([#1213](https://github.com/erwins-enkel/shepherd/issues/1213)) ([#1217](https://github.com/erwins-enkel/shepherd/issues/1217)) ([b69529a](https://github.com/erwins-enkel/shepherd/commit/b69529a1591e80a84e67757490cdb80ec06afe90))
* **plugins:** fire onSpawn for review/plan-gate/doc-agent/standalone-critic spawns ([#1205](https://github.com/erwins-enkel/shepherd/issues/1205)) ([#1208](https://github.com/erwins-enkel/shepherd/issues/1208)) ([1fb2d4d](https://github.com/erwins-enkel/shepherd/commit/1fb2d4d53a5abd829220de2ef081f4f065e2ae65))
* **plugins:** interactive action-button node for publishUI ([#1210](https://github.com/erwins-enkel/shepherd/issues/1210)) ([4d48948](https://github.com/erwins-enkel/shepherd/commit/4d48948b45cca8fdd491b0d71d3facccc6df7739))
* **settings:** provider-agnostic per-role agent environments + usage-aware downgrade ([e7931c7](https://github.com/erwins-enkel/shepherd/commit/e7931c7e80d069fb9f70676ff48cb9244f99b5ce))
* **site:** full-width release banner + install command in hero ([#1288](https://github.com/erwins-enkel/shepherd/issues/1288)) ([45a6514](https://github.com/erwins-enkel/shepherd/commit/45a6514035aafb039b36ae58455de8f254e446c6))
* **site:** real product screenshot in the hero ([#1286](https://github.com/erwins-enkel/shepherd/issues/1286)) ([d9161ea](https://github.com/erwins-enkel/shepherd/commit/d9161eaca3b3941979dd903c2a577db3d6cc3f5f))
* **site:** surface the live demo (demo.shepherd.run) ([#1285](https://github.com/erwins-enkel/shepherd/issues/1285)) ([fabefc4](https://github.com/erwins-enkel/shepherd/commit/fabefc4b8298efd55b75334cbd3d578d49de5b3c))
* **steers:** bind saved steers (quick buttons) to specific repos ([#1287](https://github.com/erwins-enkel/shepherd/issues/1287)) ([b52a958](https://github.com/erwins-enkel/shepherd/commit/b52a958a574f9e284c424e88cf8921f0ce9d35b9))
* **steers:** right-click a steer chip to run or edit it ([#1237](https://github.com/erwins-enkel/shepherd/issues/1237)) ([0e4b9d6](https://github.com/erwins-enkel/shepherd/commit/0e4b9d64b9678d53811e80c46310d19745b99d4a))
* **ui:** add alt+tab / alt+] to jump to next session, alt+shift+tab / alt+[ to prev ([#1293](https://github.com/erwins-enkel/shepherd/issues/1293)) ([9916b1e](https://github.com/erwins-enkel/shepherd/commit/9916b1ea485c95bd8930f0de91e85f7d0d2aa572))
* **ui:** add model cost guidance ([#1302](https://github.com/erwins-enkel/shepherd/issues/1302)) ([f8235a1](https://github.com/erwins-enkel/shepherd/commit/f8235a1199ba6d5e3b9fb8be61a442fc3055fe41))
* **ui:** continue sessions with cli handoff ([#1295](https://github.com/erwins-enkel/shepherd/issues/1295)) ([51bfa58](https://github.com/erwins-enkel/shepherd/commit/51bfa5844e305331416a3f0fb36edd53267778db))
* **ui:** copy task-id with its repo/branch/worktree facts for agents ([#1228](https://github.com/erwins-enkel/shepherd/issues/1228)) ([d5e3af1](https://github.com/erwins-enkel/shepherd/commit/d5e3af189b3e8b3c61a36d2ae4d10e7900b696a8))
* **ui:** marketing demo mode (live, hostless, fake backend) ([#1281](https://github.com/erwins-enkel/shepherd/issues/1281)) ([d96e593](https://github.com/erwins-enkel/shepherd/commit/d96e5934e883a4349e7d237c5335b1d6530d8938))
* **ui:** pin repo filter chips ([#1278](https://github.com/erwins-enkel/shepherd/issues/1278)) ([04c0c7e](https://github.com/erwins-enkel/shepherd/commit/04c0c7e4e7c98de26fc4cfd0fcd602f99780e050))
* **update:** add codex CLI update check + apply, like herdr ([#1225](https://github.com/erwins-enkel/shepherd/issues/1225)) ([5b95982](https://github.com/erwins-enkel/shepherd/commit/5b95982bec54f16c324518083123c0d35ea9d354))
* upload arbitrary binary files to a session's scratchpad via the Files tab ([#1258](https://github.com/erwins-enkel/shepherd/issues/1258)) ([#1261](https://github.com/erwins-enkel/shepherd/issues/1261)) ([decdca0](https://github.com/erwins-enkel/shepherd/commit/decdca0178c4f1ca1f52d1c97e31e505c28052a9))
* **usage:** add Timeline tab — day×hour token-usage heatmap ([#1269](https://github.com/erwins-enkel/shepherd/issues/1269)) ([046f1c1](https://github.com/erwins-enkel/shepherd/commit/046f1c152c1d6ba81ebf3c2c04927397278c0d6d))
* **usage:** surface GitHub REST + GraphQL rate limits ([#1239](https://github.com/erwins-enkel/shepherd/issues/1239)) ([2d4e346](https://github.com/erwins-enkel/shepherd/commit/2d4e3468d1c7fe89ff46b791b58f5897db7ed513))
* **viewport:** combine decommission & local fast-forward in post-merge toast ([#1226](https://github.com/erwins-enkel/shepherd/issues/1226)) ([7537e2e](https://github.com/erwins-enkel/shepherd/commit/7537e2e2ecf17a8dc970f68b3e3cf16ea0d59b77))


### Bug Fixes

* **autopilot:** align codex full-auto recovery ([#1279](https://github.com/erwins-enkel/shepherd/issues/1279)) ([713197d](https://github.com/erwins-enkel/shepherd/commit/713197dcfb8c1136af087ad1cc6220ec44495062))
* **checks:** treat no-CI GitHub repos as CI-cleared across the autonomous pipeline ([#1200](https://github.com/erwins-enkel/shepherd/issues/1200)) ([af0a302](https://github.com/erwins-enkel/shepherd/commit/af0a30269e433e55380d333e3ebb66f8d82c84f8))
* **ci:** cap ui browser-test concurrency to stop flaky OOM (exit 137) ([#1263](https://github.com/erwins-enkel/shepherd/issues/1263)) ([ed53979](https://github.com/erwins-enkel/shepherd/commit/ed5397928860e2689f96d8a557367dc518dd4308))
* **deploy:** self-contained log rotation — drop external logrotate dep ([#1212](https://github.com/erwins-enkel/shepherd/issues/1212)) ([#1262](https://github.com/erwins-enkel/shepherd/issues/1262)) ([4585299](https://github.com/erwins-enkel/shepherd/commit/4585299be186b6d50d89756e7cc8a47bc485a794))
* **doc-agent:** fail-closed on prettier failure — abort run + visible error outcome ([#1260](https://github.com/erwins-enkel/shepherd/issues/1260)) ([6b49296](https://github.com/erwins-enkel/shepherd/commit/6b49296b54ef28b6cd3ff4ea97a7e5b39427120b))
* **epic:** lead landing merge subject with conventional type ([#1207](https://github.com/erwins-enkel/shepherd/issues/1207)) ([907291e](https://github.com/erwins-enkel/shepherd/commit/907291e29e87959f81e1b27721e35413782906c3)), closes [#1206](https://github.com/erwins-enkel/shepherd/issues/1206)
* **files:** make whole Files tab the drop zone for uploads ([#1270](https://github.com/erwins-enkel/shepherd/issues/1270)) ([dd39c8e](https://github.com/erwins-enkel/shepherd/commit/dd39c8e3180f5fd9fa57baf861d86138be2fc233))
* **gitrail:** surface forge-error fallback so the PR rail never renders empty ([#1244](https://github.com/erwins-enkel/shepherd/issues/1244)) ([d599151](https://github.com/erwins-enkel/shepherd/commit/d599151267eb9f83fe047cb63e4843b66045e265))
* **i18n:** unify session-teardown wording on "Stilllegen/Decommission" ([#1224](https://github.com/erwins-enkel/shepherd/issues/1224)) ([55cbdc9](https://github.com/erwins-enkel/shepherd/commit/55cbdc988b3e028a58c23f96ee6ebec246552fe3))
* **issues:** surface fetch failure in IssuesPanel instead of empty state ([#1221](https://github.com/erwins-enkel/shepherd/issues/1221)) ([fca8d32](https://github.com/erwins-enkel/shepherd/commit/fca8d32f2e30cd2787e5dd666347d4a778fe3bfa))
* keep PR polling alive under GitHub GraphQL limits ([#1289](https://github.com/erwins-enkel/shepherd/issues/1289)) ([11d07ae](https://github.com/erwins-enkel/shepherd/commit/11d07aeb6c28cc195db2eab0191b6284b78b955f))
* **learnings:** explain distill/suggest-merges actions with an info tooltip ([#1216](https://github.com/erwins-enkel/shepherd/issues/1216)) ([614fc0e](https://github.com/erwins-enkel/shepherd/commit/614fc0e8f05287f3c626042de7d9926f66529575))
* **prettier:** ignore .shepherd-* session artifacts ([#1218](https://github.com/erwins-enkel/shepherd/issues/1218)) ([cca3f3f](https://github.com/erwins-enkel/shepherd/commit/cca3f3f9c3d4a2021535d00af603325ac3e05963))
* prevent Claude model aliases on Codex spawns ([#1251](https://github.com/erwins-enkel/shepherd/issues/1251)) ([3a4542a](https://github.com/erwins-enkel/shepherd/commit/3a4542aa13d28324a1a157f360e487b40f66a757))
* **prs:** evict open-PR snapshot on merge so the panel drops the merged PR ([#1271](https://github.com/erwins-enkel/shepherd/issues/1271)) ([9b73a09](https://github.com/erwins-enkel/shepherd/commit/9b73a09435b483664693ca613ee071b1a829c05b))
* respect codex attended autopilot setting ([#1294](https://github.com/erwins-enkel/shepherd/issues/1294)) ([b64c423](https://github.com/erwins-enkel/shepherd/commit/b64c423ddcb870998732caae50b70719c43a3aa6))
* **review:** fail-fast dead critic + surface onSpawn-abort reason ([#1211](https://github.com/erwins-enkel/shepherd/issues/1211)) ([7f7e5cd](https://github.com/erwins-enkel/shepherd/commit/7f7e5cd99e6b5fc641de7c2a10da7c87f8f68947))
* **review:** gate verdict finalize on process liveness, not agentStatus ([#1219](https://github.com/erwins-enkel/shepherd/issues/1219)) ([421df7e](https://github.com/erwins-enkel/shepherd/commit/421df7e956894f9667e5e3244cd41baaa133d753))
* **session:** replace agent in same worktree ([#1274](https://github.com/erwins-enkel/shepherd/issues/1274)) ([2a610cc](https://github.com/erwins-enkel/shepherd/commit/2a610ccc66fbcc020821d5c3da8b3eaf3a29078c))
* **settings:** correct What's-New sinceVersion + tighten downgrade scope docs ([44c0a83](https://github.com/erwins-enkel/shepherd/commit/44c0a8319e2bcc2e798a7811ead9a2ea6bdd1eea))
* **settings:** make mobile section dropdown recognizable ([#1204](https://github.com/erwins-enkel/shepherd/issues/1204)) ([d3cd85e](https://github.com/erwins-enkel/shepherd/commit/d3cd85e7bbe225033e9311c55e9bed9cbf2569c6))
* **settings:** make role api-key fail-closed gate provider-aware ([98159e3](https://github.com/erwins-enkel/shepherd/commit/98159e392ed486609f979812be78d55ffd8f5020))
* **settings:** match usage-downgrade load fallback to the 70 seed ([c256101](https://github.com/erwins-enkel/shepherd/commit/c256101edc39e1465fb29fc06ac8e9297587352e))
* **settings:** never usage-downgrade on unknown usage at downgradePct=0 ([afc4072](https://github.com/erwins-enkel/shepherd/commit/afc407222dcc4be9b1f5d7780cf82968b4af4cb7))
* **settings:** offer only concrete aliases in the usage-downgrade model picker ([3789b7f](https://github.com/erwins-enkel/shepherd/commit/3789b7f51d45ffaecf324970cd805c832f5cfb9c))
* **settings:** seed usage-downgrade threshold (70) below hold (80) ([e007739](https://github.com/erwins-enkel/shepherd/commit/e00773939189df74f9f182762250604b4ca3d25f))
* **settings:** shorten CLIs tab + widen modal so desktop tabs fit one row ([#1214](https://github.com/erwins-enkel/shepherd/issues/1214)) ([ce2a938](https://github.com/erwins-enkel/shepherd/commit/ce2a938363d39893e22e24d252ef512bbc707dac))
* **spawn:** strip NUL bytes from transient-agent prompt argv ([#1235](https://github.com/erwins-enkel/shepherd/issues/1235)) ([#1236](https://github.com/erwins-enkel/shepherd/issues/1236)) ([a44b929](https://github.com/erwins-enkel/shepherd/commit/a44b929b6b1377171d3c3d7659929d55ec3eb21a))
* **ui:** add Owed lens to mobile herd tab row (HerdSegRow) ([#1272](https://github.com/erwins-enkel/shepherd/issues/1272)) ([f3733c5](https://github.com/erwins-enkel/shepherd/commit/f3733c545e66197c7a204adb505d35634005bbd8))
* **ui:** align dev proxy port env ([#1275](https://github.com/erwins-enkel/shepherd/issues/1275)) ([e98f9cc](https://github.com/erwins-enkel/shepherd/commit/e98f9cce047ace6a704f9d74e6b2b94a1ae191f6))
* **ui:** demo ribbon no longer overlaps the desktop bottom bar ([#1284](https://github.com/erwins-enkel/shepherd/issues/1284)) ([a1b3957](https://github.com/erwins-enkel/shepherd/commit/a1b3957c88bf9edb5a7849be7156bbb965969e8c))
* **ui:** explain Learnings action buttons in intro ([#1301](https://github.com/erwins-enkel/shepherd/issues/1301)) ([de35af4](https://github.com/erwins-enkel/shepherd/commit/de35af4df162f7da1600ec22df2ce022a3e74640))
* **ui:** filter learnings by attention repo chip ([#1280](https://github.com/erwins-enkel/shepherd/issues/1280)) ([a2a9cf6](https://github.com/erwins-enkel/shepherd/commit/a2a9cf646706686feecb14baf7a8752710964ea0))
* **ui:** pick available coding cli on usage hold ([#1283](https://github.com/erwins-enkel/shepherd/issues/1283)) ([5ebbe45](https://github.com/erwins-enkel/shepherd/commit/5ebbe45dc2818c5661b25671f350d6524622d21f))
* **ui:** render terminal via WebGL to fix selection offset on HiDPI ([#1296](https://github.com/erwins-enkel/shepherd/issues/1296)) ([a3a13f7](https://github.com/erwins-enkel/shepherd/commit/a3a13f7bf93576c6f89a7df04652348dd21a3375))
* **ui:** route short viewports to mobile layout (fold split-landscape) ([#1252](https://github.com/erwins-enkel/shepherd/issues/1252)) ([75db183](https://github.com/erwins-enkel/shepherd/commit/75db183b56abc4e60a70ec7f12b3350942f32ba9))
* **ui:** scroll plugin gear-item card to panel top, not center ([#1254](https://github.com/erwins-enkel/shepherd/issues/1254)) ([#1255](https://github.com/erwins-enkel/shepherd/issues/1255)) ([0ee77b6](https://github.com/erwins-enkel/shepherd/commit/0ee77b650b98e34716ef73754b519af794739d2d))
* **ui:** trim trailing whitespace on terminal copy + fix selection offset ([#1291](https://github.com/erwins-enkel/shepherd/issues/1291)) ([c839b90](https://github.com/erwins-enkel/shepherd/commit/c839b90919541b2da4c242f5cf91b11c365b1ab9))
* **upnext:** apply repo filter to the Up Next (NÄCHSTES) lens ([#1220](https://github.com/erwins-enkel/shepherd/issues/1220)) ([cc2cbff](https://github.com/erwins-enkel/shepherd/commit/cc2cbff77fe5c512bbbcc126e2622425c03dbe70))
* **upnext:** surface fetch failure instead of false "all caught up" ([#1231](https://github.com/erwins-enkel/shepherd/issues/1231)) ([7321f94](https://github.com/erwins-enkel/shepherd/commit/7321f9417563e493b7e87b31c9a8eaaea6fc1d4d))


### Performance Improvements

* **forge:** unify the duplicate per-repo open-PR queries behind one cached snapshot ([#1253](https://github.com/erwins-enkel/shepherd/issues/1253)) ([4ff03c9](https://github.com/erwins-enkel/shepherd/commit/4ff03c9a4ec357472f318b1bd6ca0bac7c176bbd))
* **polling:** reduce GitHub GraphQL polling pressure ([#1230](https://github.com/erwins-enkel/shepherd/issues/1230)) ([#1234](https://github.com/erwins-enkel/shepherd/issues/1234)) ([5de839e](https://github.com/erwins-enkel/shepherd/commit/5de839ecfd4aa6fcc15b6095cac57c78c844442a))
* **pr-poller:** batch PR polling per-repo (collapse full-sweep fan-out) ([#1242](https://github.com/erwins-enkel/shepherd/issues/1242)) ([ba84aa7](https://github.com/erwins-enkel/shepherd/commit/ba84aa74ff8582506622146f392ce8b8600f9904))
* **pr-poller:** batch the fast sweep per-repo (drop fastBatch cap/round-robin) ([#1241](https://github.com/erwins-enkel/shepherd/issues/1241)) ([#1250](https://github.com/erwins-enkel/shepherd/issues/1250)) ([a22bd78](https://github.com/erwins-enkel/shepherd/commit/a22bd78e8215f18520f3b09779988cec2d163c55))
* **ui:** lazy-import Shiki in CodeBlock to fix INEFFECTIVE_DYNAMIC_IMPORT ([#1265](https://github.com/erwins-enkel/shepherd/issues/1265)) ([fe0edc3](https://github.com/erwins-enkel/shepherd/commit/fe0edc373d9ab22a3bd11990bd30b213284df964))


### Code Refactoring

* **ui:** drop sequence-number prefix from announcement fragments ([#1303](https://github.com/erwins-enkel/shepherd/issues/1303)) ([e20082a](https://github.com/erwins-enkel/shepherd/commit/e20082a9f9dc2eabb17106e62bcbf8c9d177c39e))
* **ui:** fragment feature announcements ([#1299](https://github.com/erwins-enkel/shepherd/issues/1299)) ([36ec83c](https://github.com/erwins-enkel/shepherd/commit/36ec83c1f583472df48b1008a55d3f56ca9e219e))
* **ui:** remove unused needs-you header button and triage drawer ([#1223](https://github.com/erwins-enkel/shepherd/issues/1223)) ([11bd206](https://github.com/erwins-enkel/shepherd/commit/11bd20698c7cd34ae599512df2e7633e7b32d919))


### Documentation

* **install:** external-tester install for the private repo ([#1290](https://github.com/erwins-enkel/shepherd/issues/1290)) ([58dbdb5](https://github.com/erwins-enkel/shepherd/commit/58dbdb59d88e51b936ba8c936ff3e0e271613e5f))
* list Plugins in the front-page and getting-started topic lists ([#1203](https://github.com/erwins-enkel/shepherd/issues/1203)) ([6c0477b](https://github.com/erwins-enkel/shepherd/commit/6c0477b9d527cafbff55d8f6659ee4f9bdc43ad8))
* **research:** MCP parity across Claude and Codex runtimes ([#1243](https://github.com/erwins-enkel/shepherd/issues/1243)) ([5514df6](https://github.com/erwins-enkel/shepherd/commit/5514df64ae4bddb20eb67aa2b62ab62557ff125b))
* **site:** refresh landing page + README to current feature set ([#1273](https://github.com/erwins-enkel/shepherd/issues/1273)) ([630fa5b](https://github.com/erwins-enkel/shepherd/commit/630fa5bd2ddb2cfc0b06913b70018addba2f8954))
* sync docs to recent source changes ([#1245](https://github.com/erwins-enkel/shepherd/issues/1245)) ([529d4ec](https://github.com/erwins-enkel/shepherd/commit/529d4ec8863146bdd456047270c95d16f389e7c4))
* sync docs to recent source changes ([#1256](https://github.com/erwins-enkel/shepherd/issues/1256)) ([228b0e2](https://github.com/erwins-enkel/shepherd/commit/228b0e28116d050c0228731d288b3fc07ea70a02))

## [1.38.0](https://github.com/erwins-enkel/shepherd/compare/v1.37.0...v1.38.0) (2026-06-28)


### Features

* Autopilot bis zum PR für Codex-Sessions (Alpha) ([#1140](https://github.com/erwins-enkel/shepherd/issues/1140)) ([e2d6a5b](https://github.com/erwins-enkel/shepherd/commit/e2d6a5b19f2e2c993470b58b94de45e3ef3b0387))
* **codex:** support model selection ([#1091](https://github.com/erwins-enkel/shepherd/issues/1091)) ([56ef947](https://github.com/erwins-enkel/shepherd/commit/56ef947b0ac5596281b3fb827096c65cd1fea8e3))
* **held:** edit held tasks via the original New Task dialog ([#1146](https://github.com/erwins-enkel/shepherd/issues/1146)) ([6d0755a](https://github.com/erwins-enkel/shepherd/commit/6d0755a7b5aa414bf48055d1bef21ee73fbe8e03))
* hide repos from the Backlog repos panel ([#1165](https://github.com/erwins-enkel/shepherd/issues/1165)) ([16e9be1](https://github.com/erwins-enkel/shepherd/commit/16e9be1485cf88f53b0af69e9c376bff6c9fa1cf))
* **hold:** park plugin-refused New Tasks in the hold queue instead of losing them ([#1187](https://github.com/erwins-enkel/shepherd/issues/1187)) ([b6e0d03](https://github.com/erwins-enkel/shepherd/commit/b6e0d03233e4cb88f69566f738be95e19d72c0b7))
* **orchestration:** one ordered 'what happens next' seam for the autonomous engine ([#1094](https://github.com/erwins-enkel/shepherd/issues/1094)) ([#1170](https://github.com/erwins-enkel/shepherd/issues/1170)) ([9124026](https://github.com/erwins-enkel/shepherd/commit/9124026a13479ca1d30173bf1f523e8950587051))
* plugin UI widgets — Phase 0 declarative descriptor (publishUI) → whitelisted Svelte registry ([#1185](https://github.com/erwins-enkel/shepherd/issues/1185)) ([#1188](https://github.com/erwins-enkel/shepherd/issues/1188)) ([0fecb71](https://github.com/erwins-enkel/shepherd/commit/0fecb71726a4f6bd108f9334758b55f1457f79bb))
* **plugin-ui:** host renderers for graphical node types (gauge, sparkline, time-series, bar-chart, timeline) ([#1189](https://github.com/erwins-enkel/shepherd/issues/1189)) ([#1190](https://github.com/erwins-enkel/shepherd/issues/1190)) ([095d431](https://github.com/erwins-enkel/shepherd/commit/095d4310eb3768502630760804b346d90e37c3d4))
* server-side plugin architecture for private/out-of-repo extensions ([#1124](https://github.com/erwins-enkel/shepherd/issues/1124)) ([#1152](https://github.com/erwins-enkel/shepherd/issues/1152)) ([4a33da0](https://github.com/erwins-enkel/shepherd/commit/4a33da02f273c4b2767ebe60432c2f3a24edf683))
* **sessions:** bring back a marked-as-done session from the Done lens ([#1174](https://github.com/erwins-enkel/shepherd/issues/1174)) ([b2405ab](https://github.com/erwins-enkel/shepherd/commit/b2405ab27cb1194f0ded64c1e06699f3d44faa9e))
* show codex usage in topbar ([#1101](https://github.com/erwins-enkel/shepherd/issues/1101)) ([b38be44](https://github.com/erwins-enkel/shepherd/commit/b38be44962295f7606e2930119a77ebe7013802d))
* **ui:** "+ Add repo" entry point in the Backlog repos panel ([#1171](https://github.com/erwins-enkel/shepherd/issues/1171)) ([#1183](https://github.com/erwins-enkel/shepherd/issues/1183)) ([7a5da72](https://github.com/erwins-enkel/shepherd/commit/7a5da722593a872e606dbe87ab9c7b6be1dc4695))
* **ui:** add auto-start toggle to held-tasks popover ([#1117](https://github.com/erwins-enkel/shepherd/issues/1117)) ([f6023b6](https://github.com/erwins-enkel/shepherd/commit/f6023b6b583fbe70221df9e5c7a18c601f2063b4))
* **ui:** click plan diagrams to inspect them near-fullscreen + wider plan on desktop ([#1139](https://github.com/erwins-enkel/shepherd/issues/1139)) ([2a2e13f](https://github.com/erwins-enkel/shepherd/commit/2a2e13f7e188d7b2572b936a93ceaa6b92686b2d))
* **ui:** clickable task-id menu with copy + AI prompt recommendation ([#1106](https://github.com/erwins-enkel/shepherd/issues/1106)) ([5c2ed85](https://github.com/erwins-enkel/shepherd/commit/5c2ed85c768cdb23a17b9919aa0e8785362337e8))
* **ui:** hand off held tasks across CLIs ([#1089](https://github.com/erwins-enkel/shepherd/issues/1089)) ([c954651](https://github.com/erwins-enkel/shepherd/commit/c954651940cfc3fe7b811e35f157cd1c4ff17f57))
* **ui:** list running sessions in herdr-update dialog with jump-to ([#1130](https://github.com/erwins-enkel/shepherd/issues/1130)) ([66baa03](https://github.com/erwins-enkel/shepherd/commit/66baa0307207ed91a15fc2ce8f83a1d2718aca32))
* **ui:** replace redundant BUSY label with a thin working line ([#1168](https://github.com/erwins-enkel/shepherd/issues/1168)) ([e40f5d3](https://github.com/erwins-enkel/shepherd/commit/e40f5d3c7f98a2dab0cffe76c40607961d765b7c))
* **up-next:** cross-repo ranked queue of un-started work ([#1169](https://github.com/erwins-enkel/shepherd/issues/1169)) ([#1172](https://github.com/erwins-enkel/shepherd/issues/1172)) ([48e1cff](https://github.com/erwins-enkel/shepherd/commit/48e1cff260fce825fb6ce31cd6ad24377d3e8a3f))
* **viewport:** read-only scratchpad file browser ([#1164](https://github.com/erwins-enkel/shepherd/issues/1164)) ([#1166](https://github.com/erwins-enkel/shepherd/issues/1166)) ([41219b4](https://github.com/erwins-enkel/shepherd/commit/41219b457a85d128246ae035ff772e35bf710e93))


### Bug Fixes

* **automation:** Auto-Abarbeitung-Regler inline unter den Schalter + Felddoku ([#1123](https://github.com/erwins-enkel/shepherd/issues/1123)) ([b5a9cae](https://github.com/erwins-enkel/shepherd/commit/b5a9cae4c15581df540a2836045d9eebbbf29aa4))
* **build-queue:** suppress reconcile nudge during plan gate ([#1197](https://github.com/erwins-enkel/shepherd/issues/1197)) ([aa24022](https://github.com/erwins-enkel/shepherd/commit/aa24022b84deb73182422e1699f8d248a974e407))
* **ci:** grant actions:read so doc-automerge can read statusCheckRollup ([#1195](https://github.com/erwins-enkel/shepherd/issues/1195)) ([928f5bd](https://github.com/erwins-enkel/shepherd/commit/928f5bdc831ec3b1bb5c3598da1bc68c656e8b25))
* **ci:** grant doc-automerge checks/statuses read scope ([#1163](https://github.com/erwins-enkel/shepherd/issues/1163)) ([f13a69b](https://github.com/erwins-enkel/shepherd/commit/f13a69b7cdb0e459f6d0f72e1d01cf12a80cb0e1))
* **codex:** resume sessions with codex CLI ([#1104](https://github.com/erwins-enkel/shepherd/issues/1104)) ([c800641](https://github.com/erwins-enkel/shepherd/commit/c8006412130a796194943225178315492397a625))
* **diagnostics:** detect codex cli alternative ([#1100](https://github.com/erwins-enkel/shepherd/issues/1100)) ([14563c4](https://github.com/erwins-enkel/shepherd/commit/14563c41f547b3b46571b8eb285212eed6e545de))
* **issues:** distinguish failed issue fetch from 'no open issues' ([#1161](https://github.com/erwins-enkel/shepherd/issues/1161)) ([ac9ca58](https://github.com/erwins-enkel/shepherd/commit/ac9ca583b8a79b2594b06fab3262fcc944b93f22))
* **learnings:** boot reapOrphans for __distill__/__optimize__/__merge__ helpers ([#1135](https://github.com/erwins-enkel/shepherd/issues/1135)) ([#1148](https://github.com/erwins-enkel/shepherd/issues/1148)) ([da50ab9](https://github.com/erwins-enkel/shepherd/commit/da50ab9796e6a284af863c5e587ac856b8daf43d))
* **onboarding:** unbreak harness + update.sh past the operator-auth gate ([#1112](https://github.com/erwins-enkel/shepherd/issues/1112)) ([#1149](https://github.com/erwins-enkel/shepherd/issues/1149)) ([d825fdb](https://github.com/erwins-enkel/shepherd/commit/d825fdb070a1309ba6418958b6f9c557bf30dfca))
* **orchestration:** fire auto plan-gate before the awaited drain chain ([#1193](https://github.com/erwins-enkel/shepherd/issues/1193)) ([#1196](https://github.com/erwins-enkel/shepherd/issues/1196)) ([27ab592](https://github.com/erwins-enkel/shepherd/commit/27ab59213eff7fb7139e2281966fa70d6918b6da))
* **plugins:** follow symlinked plugin dirs in the loader ([#1176](https://github.com/erwins-enkel/shepherd/issues/1176)) ([#1177](https://github.com/erwins-enkel/shepherd/issues/1177)) ([c2ccdc5](https://github.com/erwins-enkel/shepherd/commit/c2ccdc52266ca80e26ff1df3e543a15dcadc1bb7))
* **preview:** steer codex dev server starts ([#1099](https://github.com/erwins-enkel/shepherd/issues/1099)) ([82144a0](https://github.com/erwins-enkel/shepherd/commit/82144a0a043d6fad579b4f912573dff6ba5aeaa8))
* **reaper:** reap orphaned PPID-1 background jobs on worktree teardown ([#1133](https://github.com/erwins-enkel/shepherd/issues/1133)) ([#1143](https://github.com/erwins-enkel/shepherd/issues/1143)) ([895f9fa](https://github.com/erwins-enkel/shepherd/commit/895f9fa50631008358fae636ebb38bd8c45537e2))
* **tab-reaper:** boot-reap pr-critic + unclean-exit synchronous helper tabs ([#1136](https://github.com/erwins-enkel/shepherd/issues/1136)) ([#1157](https://github.com/erwins-enkel/shepherd/issues/1157)) ([adb08b0](https://github.com/erwins-enkel/shepherd/commit/adb08b08d3d1e0ccaed70f16b426883f05b8a609))
* **top-bar:** collapse tallies under overflow on unfolded foldables ([#1119](https://github.com/erwins-enkel/shepherd/issues/1119)) ([858dacf](https://github.com/erwins-enkel/shepherd/commit/858dacf627978a064cc2965ab01638024b871445))
* **top-bar:** equalize right-cluster box heights via shared token ([#1132](https://github.com/erwins-enkel/shepherd/issues/1132)) ([335405d](https://github.com/erwins-enkel/shepherd/commit/335405d953fd0a870e0eb9500e21b3112bc4f47f))
* **top-bar:** homogenize text size in mobile held popover ([#1116](https://github.com/erwins-enkel/shepherd/issues/1116)) ([3061dbc](https://github.com/erwins-enkel/shepherd/commit/3061dbc95df9413f4809952b082a7281e8040cbd))
* **ui:** clarify terminal selection hint ([#1098](https://github.com/erwins-enkel/shepherd/issues/1098)) ([4d47f71](https://github.com/erwins-enkel/shepherd/commit/4d47f71e6cf21ea7efc159f70be71f6beed6bb6d))
* **ui:** distinguish held vs update badges with hourglass/bolt icons ([#1122](https://github.com/erwins-enkel/shepherd/issues/1122)) ([0384733](https://github.com/erwins-enkel/shepherd/commit/03847334ffcb606e2a627a6f762f917ef6f00e39))
* **ui:** enlarge held-task popover buttons and dim+blur the app behind it ([#1145](https://github.com/erwins-enkel/shepherd/issues/1145)) ([862f58b](https://github.com/erwins-enkel/shepherd/commit/862f58b089cabb847cdcae7b2ea2969682a43f3f))
* **ui:** equalize compact NEEDS YOU + held-badge height ([#1115](https://github.com/erwins-enkel/shepherd/issues/1115)) ([0e16222](https://github.com/erwins-enkel/shepherd/commit/0e16222dda373ea1d80f0ea0905aa1e072416dcd))
* **ui:** follow herd repo filter onto a newly started task's repo ([#1118](https://github.com/erwins-enkel/shepherd/issues/1118)) ([c7d0dd4](https://github.com/erwins-enkel/shepherd/commit/c7d0dd4a1c271fc07185e00869e7c3cba1b79cdf))
* **ui:** gate automation toggles on their real dependencies ([#1162](https://github.com/erwins-enkel/shepherd/issues/1162)) ([3ddc70e](https://github.com/erwins-enkel/shepherd/commit/3ddc70e6e040c6571d984125aa7b3e5b8091c943))
* **ui:** heartbeat full width in compact herd sidebar ([#1114](https://github.com/erwins-enkel/shepherd/issues/1114)) ([fa9b9ef](https://github.com/erwins-enkel/shepherd/commit/fa9b9ef6c93255b9c57e4abf8b684706519b70b9))
* **ui:** height-lock top-bar left tallies to --topbar-ctl-h ([#1131](https://github.com/erwins-enkel/shepherd/issues/1131)) ([#1142](https://github.com/erwins-enkel/shepherd/issues/1142)) ([b8f82d0](https://github.com/erwins-enkel/shepherd/commit/b8f82d0091828b822298b619c08958942e13bd3e))
* **ui:** herd lens strip — icon-over-label tabs, fits the sidebar ([#1199](https://github.com/erwins-enkel/shepherd/issues/1199)) ([e095187](https://github.com/erwins-enkel/shepherd/commit/e09518705138a2eea60b4be080d2a4c0965af1c8))
* **ui:** honor default-CLI setting in New Task; restore gate/autopilot on switch-back ([#1097](https://github.com/erwins-enkel/shepherd/issues/1097)) ([4a5cf68](https://github.com/erwins-enkel/shepherd/commit/4a5cf687b2324097d173db0436c2eccf48857b3d))
* **ui:** keep running-sessions list visible in herdr-update dialog ([#1137](https://github.com/erwins-enkel/shepherd/issues/1137)) ([cdd9067](https://github.com/erwins-enkel/shepherd/commit/cdd9067a82e66b33890c1be92a51ee343bb484a8))
* **ui:** make held tasks mobile dialog fullscreen ([#1103](https://github.com/erwins-enkel/shepherd/issues/1103)) ([253b467](https://github.com/erwins-enkel/shepherd/commit/253b4673afc4837fe7c655050516249b1feab907))
* **ui:** order Settings above feedback links in mobile gear sheet ([#1113](https://github.com/erwins-enkel/shepherd/issues/1113)) ([a48d1b3](https://github.com/erwins-enkel/shepherd/commit/a48d1b36ac8cf45eea6c0c8fc0dbb95ce33abe02))
* **ui:** remove redundant working-line spinner from session cards ([#1179](https://github.com/erwins-enkel/shepherd/issues/1179)) ([f93b5a1](https://github.com/erwins-enkel/shepherd/commit/f93b5a11acc47155bb8bd6bde07e7d9f1ffcd778))
* **ui:** responsive settings tabs + reorder, surface Plugins on mobile ([#1178](https://github.com/erwins-enkel/shepherd/issues/1178)) ([c0a612d](https://github.com/erwins-enkel/shepherd/commit/c0a612d6046db1f5950214ea1142b3e4b49c1a25))
* **ui:** show in-flight state on held-task spawn/discard buttons ([#1128](https://github.com/erwins-enkel/shepherd/issues/1128)) ([781429a](https://github.com/erwins-enkel/shepherd/commit/781429a89c1f3eb11e420678d71e3358cc4f3cd0))
* **ui:** single post-merge toast, drop auto local-checkout offer ([#1121](https://github.com/erwins-enkel/shepherd/issues/1121)) ([2d2e321](https://github.com/erwins-enkel/shepherd/commit/2d2e3211fd60f0bde6a2f9251ebf1044f2b3b078))
* **ui:** surface held-task spawn/discard failures inline ([#1105](https://github.com/erwins-enkel/shepherd/issues/1105)) ([3189a2f](https://github.com/erwins-enkel/shepherd/commit/3189a2f5d3a949556cb0209824acbef4ba3448c2))
* **ui:** surface the real cause when a held task fails to start ([#1129](https://github.com/erwins-enkel/shepherd/issues/1129)) ([3391788](https://github.com/erwins-enkel/shepherd/commit/3391788af73258ff191754f29fc5c5c9b2cd83ad))
* **ui:** tidy stale Codex autopilot copy + exclude research from unavailable badge ([#1181](https://github.com/erwins-enkel/shepherd/issues/1181)) ([8568f9a](https://github.com/erwins-enkel/shepherd/commit/8568f9a0bee1a5ab55723aa56a40c65dc402d3b2)), closes [#1173](https://github.com/erwins-enkel/shepherd/issues/1173)
* **up-next:** exclude hidden repos from the ranked queue ([#1186](https://github.com/erwins-enkel/shepherd/issues/1186)) ([1a6bf60](https://github.com/erwins-enkel/shepherd/commit/1a6bf601b21822c89b45984db50bdb0cb652dd48))
* **uploads:** copy staged images into worktree so held-task spawns survive retries ([#1138](https://github.com/erwins-enkel/shepherd/issues/1138)) ([c0cc9ad](https://github.com/erwins-enkel/shepherd/commit/c0cc9ad59bd949aa3fc56db244552f6262223b7d))


### Performance Improvements

* **ci:** cache prettier + eslint across runs to speed up lint ([#1192](https://github.com/erwins-enkel/shepherd/issues/1192)) ([#1194](https://github.com/erwins-enkel/shepherd/issues/1194)) ([88b25f2](https://github.com/erwins-enkel/shepherd/commit/88b25f2fd8810ed09a86e8c323203fe521ec8824))


### Code Refactoring

* **forge:** push backlog-counts + lightweight checks behind GitForge seam ([#1184](https://github.com/erwins-enkel/shepherd/issues/1184)) ([da14b5b](https://github.com/erwins-enkel/shepherd/commit/da14b5bcb8d116667f5aac6d0beb4f4d584034c5))
* **learnings:** collapse route→store orchestration behind service seam ([#1092](https://github.com/erwins-enkel/shepherd/issues/1092)) ([#1150](https://github.com/erwins-enkel/shepherd/issues/1150)) ([56dc97a](https://github.com/erwins-enkel/shepherd/commit/56dc97a365e7bd4ba45e01f11af1cc4adae929e8))
* **spawn:** one transient-agent argv builder behind the 10 spawn sites ([#1093](https://github.com/erwins-enkel/shepherd/issues/1093)) ([#1151](https://github.com/erwins-enkel/shepherd/issues/1151)) ([85e127f](https://github.com/erwins-enkel/shepherd/commit/85e127f969b365fceb4236c7dd2f17d11b25ffa5))
* **ui:** rename Backlog pane to Repos ([#1127](https://github.com/erwins-enkel/shepherd/issues/1127)) ([d5d4972](https://github.com/erwins-enkel/shepherd/commit/d5d497201676a77bef7d6fffc5da06e6f162cc25))


### Documentation

* **research:** plugin-driven UI widgets — capability design ([#1182](https://github.com/erwins-enkel/shepherd/issues/1182)) ([c42e48a](https://github.com/erwins-enkel/shepherd/commit/c42e48a0a9772fdcc653a34c1ed048e1c259400d))
* sync docs to recent source changes ([#1111](https://github.com/erwins-enkel/shepherd/issues/1111)) ([77fcada](https://github.com/erwins-enkel/shepherd/commit/77fcada6d1c4180aa04ccdb5c9968f0791f2a688))
* sync docs to recent source changes ([#1158](https://github.com/erwins-enkel/shepherd/issues/1158)) ([3d205f1](https://github.com/erwins-enkel/shepherd/commit/3d205f18e71d9070521fa8af7aab0837f72b84e8))
* sync docs to recent source changes ([#1191](https://github.com/erwins-enkel/shepherd/issues/1191)) ([9d79cd1](https://github.com/erwins-enkel/shepherd/commit/9d79cd159b03fcbe1e52b114871bb6a3c961a3d5))

## [1.37.0](https://github.com/erwins-enkel/shepherd/compare/v1.36.0...v1.37.0) (2026-06-25)


### Features

* /why — per-session 'Why parked?' hold reason ([#1008](https://github.com/erwins-enkel/shepherd/issues/1008)) ([#1012](https://github.com/erwins-enkel/shepherd/issues/1012)) ([02ec26c](https://github.com/erwins-enkel/shepherd/commit/02ec26ca58b7346241a3a71b09a9855cad202f1c))
* add shepherd-onboarding skill (existing + greenfield paths) ([#1024](https://github.com/erwins-enkel/shepherd/issues/1024)) ([f5167f5](https://github.com/erwins-enkel/shepherd/commit/f5167f5f6744800901c98334bc157cf96448e349))
* **auth:** single-operator password → session-cookie auth; close the WS/PTY gap ([#1081](https://github.com/erwins-enkel/shepherd/issues/1081)) ([aea24de](https://github.com/erwins-enkel/shepherd/commit/aea24def823c4976e8913906a7628463cdb6ba79))
* **automation:** confirm automation settings on first task for a new repo ([#1025](https://github.com/erwins-enkel/shepherd/issues/1025)) ([#1031](https://github.com/erwins-enkel/shepherd/issues/1031)) ([a316bc0](https://github.com/erwins-enkel/shepherd/commit/a316bc0735cedd955b53eaab1b3e6f08d1440f04))
* **autopilot:** pre-completion verification gate for drain sessions ([#1009](https://github.com/erwins-enkel/shepherd/issues/1009)) ([#1010](https://github.com/erwins-enkel/shepherd/issues/1010)) ([1a67724](https://github.com/erwins-enkel/shepherd/commit/1a67724bc6d5cb309ad83abfb0352aaf00c27ad8))
* **autopilot:** rebase idle review-passed non-mergeable PR (non-full-auto) ([#1064](https://github.com/erwins-enkel/shepherd/issues/1064)) ([2b3e16c](https://github.com/erwins-enkel/shepherd/commit/2b3e16caaf6cf495a4ac2e09319e5bfefe9275e1))
* **backlog:** show per-issue assignees when mine & unassigned filter is off ([#1046](https://github.com/erwins-enkel/shepherd/issues/1046)) ([276d534](https://github.com/erwins-enkel/shepherd/commit/276d5341e465112462c13cd51b51a50536ca6419))
* **backup:** automated hourly SQLite backups + restore + staleness alert ([#1080](https://github.com/erwins-enkel/shepherd/issues/1080)) ([#1082](https://github.com/erwins-enkel/shepherd/issues/1082)) ([3209c32](https://github.com/erwins-enkel/shepherd/commit/3209c32c22cbf736a3b0478d971af1054d42b507))
* **codex:** add Codex coding CLI alpha path ([#1086](https://github.com/erwins-enkel/shepherd/issues/1086)) ([f5c7e3c](https://github.com/erwins-enkel/shepherd/commit/f5c7e3ce21e7b893d28c7b2861037c3450f6aafd))
* **drain:** auto-rebase behind/conflicting epic landing PRs ([#1071](https://github.com/erwins-enkel/shepherd/issues/1071)) ([#1073](https://github.com/erwins-enkel/shepherd/issues/1073)) ([f6bf371](https://github.com/erwins-enkel/shepherd/commit/f6bf371479315513d99a509cce4836bbdc907299))
* **epic:** opt-in auto-land of integrated epics ([#1044](https://github.com/erwins-enkel/shepherd/issues/1044)) ([#1053](https://github.com/erwins-enkel/shepherd/issues/1053)) ([9879cf4](https://github.com/erwins-enkel/shepherd/commit/9879cf41b63ffafa9e4f709fc81e48bed8830e81))
* **epic:** surface + manually land integrated-but-unlanded epics ([#1039](https://github.com/erwins-enkel/shepherd/issues/1039)) ([#1049](https://github.com/erwins-enkel/shepherd/issues/1049)) ([399262c](https://github.com/erwins-enkel/shepherd/commit/399262ca45f319ce871d1a5d9440f07a2c50172a))
* **plan-gate:** log plan-blocks capture for [#804](https://github.com/erwins-enkel/shepherd/issues/804) activation tracking ([#995](https://github.com/erwins-enkel/shepherd/issues/995)) ([a86ad53](https://github.com/erwins-enkel/shepherd/commit/a86ad536271ba6433062975a30f158b1a31a4ea7))
* **rundown:** surface integrated-but-unlanded epics as Tier-1 items ([#1045](https://github.com/erwins-enkel/shepherd/issues/1045)) ([#1052](https://github.com/erwins-enkel/shepherd/issues/1052)) ([f6709ca](https://github.com/erwins-enkel/shepherd/commit/f6709cae77b2e84d7dcfc0fd0c5b90812530445a))
* **spawn:** pull issue comments into a task spawned from an issue ([#1034](https://github.com/erwins-enkel/shepherd/issues/1034)) ([4a3d0de](https://github.com/erwins-enkel/shepherd/commit/4a3d0ded7ea59def76c5c41c1d83d030b0ef16dc))
* **tui:** make Shepherd compatible with Claude Code fullscreen renderer (opt-in) ([#1055](https://github.com/erwins-enkel/shepherd/issues/1055)) ([9eb1a61](https://github.com/erwins-enkel/shepherd/commit/9eb1a61d859c4d1873384d936a09b6aabb1a1f2f))
* **usage:** break down satellite passes by type in Overhead lens ([#998](https://github.com/erwins-enkel/shepherd/issues/998)) ([5090b87](https://github.com/erwins-enkel/shepherd/commit/5090b8772b7cc9249284bb1d160763247ade85bd))
* **usage:** show task short name in breakdown, not just its ID ([#1016](https://github.com/erwins-enkel/shepherd/issues/1016)) ([b26cbdf](https://github.com/erwins-enkel/shepherd/commit/b26cbdf8adbc410282ca4a11ab41ebb943766445))
* **viewport:** non-blocking review-in-flight terminal banner + operator-keystroke seam ([#1027](https://github.com/erwins-enkel/shepherd/issues/1027)) ([166e9c8](https://github.com/erwins-enkel/shepherd/commit/166e9c81691c03192b6823156212db14249c1815))
* **viewport:** offer to decommission a session after a manual PR merge ([#1062](https://github.com/erwins-enkel/shepherd/issues/1062)) ([458fdd9](https://github.com/erwins-enkel/shepherd/commit/458fdd9307c1fe6bbca6476fb85ce31ec9dd6ef9))
* **viewport:** pinned ⤓ jump-to-latest key on mobile control bar ([#1063](https://github.com/erwins-enkel/shepherd/issues/1063)) ([4e227cb](https://github.com/erwins-enkel/shepherd/commit/4e227cbc4b8cbb0e854a59d7cb67e7c3d66c30b1))


### Bug Fixes

* **broadcast:** honest delivered/queued/unreachable feedback ([#1041](https://github.com/erwins-enkel/shepherd/issues/1041)) ([0a8d3ea](https://github.com/erwins-enkel/shepherd/commit/0a8d3eaccf57de1ab3e60c0f37d06cec0b64b193))
* **build-queue:** resolve short/prefix step ids; loud 4xx on mismatch ([#1011](https://github.com/erwins-enkel/shepherd/issues/1011)) ([#1013](https://github.com/erwins-enkel/shepherd/issues/1013)) ([2116619](https://github.com/erwins-enkel/shepherd/commit/21166195c41dbe13eb5860ac6a16e585502a5079))
* **build-queue:** stable step ids across re-PUT ([#1014](https://github.com/erwins-enkel/shepherd/issues/1014)) ([#1015](https://github.com/erwins-enkel/shepherd/issues/1015)) ([655333b](https://github.com/erwins-enkel/shepherd/commit/655333beb7a2c7b433b754054cd627eab579d2c9))
* **buildqueue:** truthful queue header — auto/operator approval + run-state ([#1084](https://github.com/erwins-enkel/shepherd/issues/1084)) ([1d261ef](https://github.com/erwins-enkel/shepherd/commit/1d261ef50365783f4cdb3f2b6f7a6cc75877b668))
* **ci:** onboarding-release-gate reads via release-please App token ([#1004](https://github.com/erwins-enkel/shepherd/issues/1004)) ([9c14f3d](https://github.com/erwins-enkel/shepherd/commit/9c14f3dab858ff54ca7d7a3fddcb0145d1b892a5))
* **ci:** onboarding-release-gate uses REST issues API, not gh issue list ([#996](https://github.com/erwins-enkel/shepherd/issues/996)) ([dbd3e29](https://github.com/erwins-enkel/shepherd/commit/dbd3e291393de8f61b5078c665df08579673b4cd))
* **critic:** don't persist a post-merge error verdict as REVIEW ERR ([#1057](https://github.com/erwins-enkel/shepherd/issues/1057)) ([73e48e6](https://github.com/erwins-enkel/shepherd/commit/73e48e6bddf18c2ca337cc7cda4a3ca05ccbe02c))
* **diff:** diff against the PR's real base, not session.baseBranch ([#1078](https://github.com/erwins-enkel/shepherd/issues/1078)) ([f344680](https://github.com/erwins-enkel/shepherd/commit/f3446808739fd42ff7708cfcab71f37af2493127))
* **epic:** kick drain on Start so first sub-issue session surfaces live ([#1026](https://github.com/erwins-enkel/shepherd/issues/1026)) ([248abb1](https://github.com/erwins-enkel/shepherd/commit/248abb11b8760e27b797bb8a71b6d9c0f789deea))
* **epic:** never close integrated epic child out-of-band on merged-PR teardown ([#1037](https://github.com/erwins-enkel/shepherd/issues/1037)) ([#1040](https://github.com/erwins-enkel/shepherd/issues/1040)) ([461c2b8](https://github.com/erwins-enkel/shepherd/commit/461c2b8ac00644f14500eebeaebe41dce978206b))
* **forge:** re-probe negative forge resolution after TTL ([#1023](https://github.com/erwins-enkel/shepherd/issues/1023)) ([#1028](https://github.com/erwins-enkel/shepherd/issues/1028)) ([0f287f5](https://github.com/erwins-enkel/shepherd/commit/0f287f592a7a57259420fa1d499cb67d9c6f3827))
* **glossary:** activation-only inline disclosure so tooltip never obscures content ([#1001](https://github.com/erwins-enkel/shepherd/issues/1001)) ([536dcfc](https://github.com/erwins-enkel/shepherd/commit/536dcfc4352044e13a6b5dd404074a1b1ac56fbd))
* **glossary:** hide closed floating tooltip so it stops obscuring content ([#1006](https://github.com/erwins-enkel/shepherd/issues/1006)) ([eaa9900](https://github.com/erwins-enkel/shepherd/commit/eaa990053a57cda7f1f41d031cedd6314bf4eecc))
* **held:** emit session:new on held-task spawn so the Herd refreshes ([#1018](https://github.com/erwins-enkel/shepherd/issues/1018)) ([287bca4](https://github.com/erwins-enkel/shepherd/commit/287bca4e8011a029e32e8ba8d4d6025bc9025202))
* **held:** re-stamp drain claim when a held task with a linked issue spawns ([#1019](https://github.com/erwins-enkel/shepherd/issues/1019)) ([c8cb87c](https://github.com/erwins-enkel/shepherd/commit/c8cb87c5c9539f4b8e32a96c7fa70c3d39cddfdf))
* **held:** re-sync held count on tab-return so badge isn't stale after deploy ([#1021](https://github.com/erwins-enkel/shepherd/issues/1021)) ([ed71fa6](https://github.com/erwins-enkel/shepherd/commit/ed71fa632a9a71088a4ddb31ef85f86b1ce5e1dc))
* **herdr:** pin classic renderer for spawned claude agents ([#1042](https://github.com/erwins-enkel/shepherd/issues/1042)) ([d8af59c](https://github.com/erwins-enkel/shepherd/commit/d8af59c9a476f83722b38c91532b507e1d142112))
* **ingress:** pin agent-ingress port so live sessions survive restarts ([#1083](https://github.com/erwins-enkel/shepherd/issues/1083)) ([#1085](https://github.com/erwins-enkel/shepherd/issues/1085)) ([254cca2](https://github.com/erwins-enkel/shepherd/commit/254cca249086de37807ee57ceb861c7aa75198cd))
* **pre-push:** terminate linter argv with `--` to block flag smuggling ([#1035](https://github.com/erwins-enkel/shepherd/issues/1035)) ([#1036](https://github.com/erwins-enkel/shepherd/issues/1036)) ([8a4372b](https://github.com/erwins-enkel/shepherd/commit/8a4372b13f63ac5a49058a5bf99f510183ef7bab))
* **recap:** make expanded recap scrollable instead of clipping ([#1029](https://github.com/erwins-enkel/shepherd/issues/1029)) ([ec5a721](https://github.com/erwins-enkel/shepherd/commit/ec5a721ae69f41ff605260edb3fffe583393c463))
* **review:** zero-context patch-id so a clean rebase skips critic re-review ([#1067](https://github.com/erwins-enkel/shepherd/issues/1067)) ([78f8e2c](https://github.com/erwins-enkel/shepherd/commit/78f8e2c74062c6f69752f58de469bec33c8dbca1))
* **top-bar:** center count in compact held-tasks badge ([#1017](https://github.com/erwins-enkel/shepherd/issues/1017)) ([2dd0a0d](https://github.com/erwins-enkel/shepherd/commit/2dd0a0d54f531a1e293a7b5d59f02577d78d7eb2))
* **top-bar:** reachable + working usage refresh, compact desktop cluster ([#1005](https://github.com/erwins-enkel/shepherd/issues/1005)) ([535f589](https://github.com/erwins-enkel/shepherd/commit/535f589480452669d97c1f02d8de913b2b5f64d4))
* **usage-hold:** hold manual tasks at threshold even when herd is idle ([#1038](https://github.com/erwins-enkel/shepherd/issues/1038)) ([b598a13](https://github.com/erwins-enkel/shepherd/commit/b598a13377145dc64e3a5d05185ecea8ed02d00e))
* **usage:** extra-credits bar renders full-width to match 5h/weekly gauges ([#1000](https://github.com/erwins-enkel/shepherd/issues/1000)) ([377293f](https://github.com/erwins-enkel/shepherd/commit/377293febab74a691b8278c3a643187b27ea685b))
* **usage:** re-capture extra-credit panel on /usage scrape ([#1058](https://github.com/erwins-enkel/shepherd/issues/1058)) ([a95c329](https://github.com/erwins-enkel/shepherd/commit/a95c3293e8ed6fe522ac32428ac88d0ad4ad5a64))
* **usage:** read the real credits panel past the /usage-credits menu text ([#1072](https://github.com/erwins-enkel/shepherd/issues/1072)) ([ec0d097](https://github.com/erwins-enkel/shepherd/commit/ec0d09731aca24d719ff97332cdb353fe3862da4))


### Performance Improvements

* **pre-push:** parallelize hook into lanes; scope lint to push delta ([#1030](https://github.com/erwins-enkel/shepherd/issues/1030)) ([#1033](https://github.com/erwins-enkel/shepherd/issues/1033)) ([ce156ad](https://github.com/erwins-enkel/shepherd/commit/ce156addb3c36b38d232069738a3488c33bf4432))


### Code Refactoring

* **repo-switcher:** remove dedicated per-repo learnings bar ([#999](https://github.com/erwins-enkel/shepherd/issues/999)) ([a6ecf76](https://github.com/erwins-enkel/shepherd/commit/a6ecf7639e01ef8d28664a4f51ad49c7586e6230))


### Documentation

* **research:** scan dirge agent for borrowable ideas ([#1007](https://github.com/erwins-enkel/shepherd/issues/1007)) ([6cf8dfa](https://github.com/erwins-enkel/shepherd/commit/6cf8dfaaf4ae1c03b82232ba920e6d3a8a77d982))
* **spike:** [#1043](https://github.com/erwins-enkel/shepherd/issues/1043) fullscreen-renderer alt-screen read is GO ([#1048](https://github.com/erwins-enkel/shepherd/issues/1048)) ([9665671](https://github.com/erwins-enkel/shepherd/commit/9665671364a02881444f2b0922bc83152cfab1ac))
* sync docs to recent source changes ([#1051](https://github.com/erwins-enkel/shepherd/issues/1051)) ([9c0525b](https://github.com/erwins-enkel/shepherd/commit/9c0525b1613f2b0a7cf452b0b5a8a4381d4fcf56))
* sync docs to recent source changes ([#1065](https://github.com/erwins-enkel/shepherd/issues/1065)) ([afaeefc](https://github.com/erwins-enkel/shepherd/commit/afaeefc58fa366f79f09e116d10e2a72964e76e6))
* sync docs to recent source changes ([#1077](https://github.com/erwins-enkel/shepherd/issues/1077)) ([4997b5d](https://github.com/erwins-enkel/shepherd/commit/4997b5d8baa5afd1a79b04530cb6e5d7d266da12))

## [1.36.0](https://github.com/erwins-enkel/shepherd/compare/v1.35.0...v1.36.0) (2026-06-22)


### Features

* **doc-agent:** re-target doc updates onto the open code PR (kill the double-PR) ([#956](https://github.com/erwins-enkel/shepherd/issues/956)) ([#958](https://github.com/erwins-enkel/shepherd/issues/958)) ([a5e6442](https://github.com/erwins-enkel/shepherd/commit/a5e644227cfdd490025c57face5a415f76e1abbf))
* **doc-agent:** soak rollout phases + durable run tracking ([#905](https://github.com/erwins-enkel/shepherd/issues/905)) ([#924](https://github.com/erwins-enkel/shepherd/issues/924)) ([24f3822](https://github.com/erwins-enkel/shepherd/commit/24f3822d0efb0f74bd1d8ecb7a20737233f0f730))
* **doc-agent:** UI surface — Backlog trigger button + run/PR badge ([#906](https://github.com/erwins-enkel/shepherd/issues/906)) ([#939](https://github.com/erwins-enkel/shepherd/issues/939)) ([e82d164](https://github.com/erwins-enkel/shepherd/commit/e82d164b15b5e00d1aebf3a4e28cf59ecd3fbd8b))
* **docs:** doc-agent nightly + merge-triggered cadence ([#904](https://github.com/erwins-enkel/shepherd/issues/904)) ([#920](https://github.com/erwins-enkel/shepherd/issues/920)) ([6b3a730](https://github.com/erwins-enkel/shepherd/commit/6b3a7305eb235c540632dfdca96ca0398f4c4ebd))
* **feedback:** in-app bug reporting & feedback → prefilled GitHub issue forms ([#971](https://github.com/erwins-enkel/shepherd/issues/971)) ([#974](https://github.com/erwins-enkel/shepherd/issues/974)) ([5b7469e](https://github.com/erwins-enkel/shepherd/commit/5b7469efeda86e92c3ef89ca05f30bb3b7b92b8b))
* **learnings:** auto-trial strong proposals — drain the manual approval gate ([#925](https://github.com/erwins-enkel/shepherd/issues/925)) ([#946](https://github.com/erwins-enkel/shepherd/issues/946)) ([f97cee0](https://github.com/erwins-enkel/shepherd/commit/f97cee03463a817650692112e2b9cdbb0b4c1aa5))
* **site:** refresh landing highlights for 1.35 features ([#929](https://github.com/erwins-enkel/shepherd/issues/929)) ([fd29019](https://github.com/erwins-enkel/shepherd/commit/fd290193fae02390af743f92fe1e5e5e8df826ef))
* **site:** showcase the herdr/Shepherd split — redeploy without disturbing the herd ([#962](https://github.com/erwins-enkel/shepherd/issues/962)) ([d3c26c3](https://github.com/erwins-enkel/shepherd/commit/d3c26c3efa7f95aa27d23d80ab60f354dae624c4))
* **top-bar:** add documentation link to the bar and gear menu ([#969](https://github.com/erwins-enkel/shepherd/issues/969)) ([2a4d219](https://github.com/erwins-enkel/shepherd/commit/2a4d219723301405cd3bb05c538d18a4557c0670))
* **ui:** /usage token-spend dashboard — Phase 0 visual prototype ([#943](https://github.com/erwins-enkel/shepherd/issues/943)) ([#954](https://github.com/erwins-enkel/shepherd/issues/954)) ([1e2792c](https://github.com/erwins-enkel/shepherd/commit/1e2792cc61cddf27692059a533cfb01d460de0e3))
* **ui:** re-target terminal to the chosen repo's session on repo switch ([#970](https://github.com/erwins-enkel/shepherd/issues/970)) ([bdebc0d](https://github.com/erwins-enkel/shepherd/commit/bdebc0d47cdffb0b58bc6824b50da29905d22e53))
* **usage:** backfill pre-existing archived sessions into session_usage ([#965](https://github.com/erwins-enkel/shepherd/issues/965)) ([#987](https://github.com/erwins-enkel/shepherd/issues/987)) ([be3d908](https://github.com/erwins-enkel/shepherd/commit/be3d908b88dd547fcccea89725b07f08f1a43bf5))
* **usage:** live burn-rate projections for the Limits lens ([#966](https://github.com/erwins-enkel/shepherd/issues/966)) ([#985](https://github.com/erwins-enkel/shepherd/issues/985)) ([bf94cc2](https://github.com/erwins-enkel/shepherd/commit/bf94cc22d71a69cb55bfc114b06df31a9d72c9dd))
* **usage:** per-task $ in the Spend lens (top consuming tasks) ([#980](https://github.com/erwins-enkel/shepherd/issues/980)) ([#990](https://github.com/erwins-enkel/shepherd/issues/990)) ([91901c5](https://github.com/erwins-enkel/shepherd/commit/91901c57559c07aa3c403a982eed1a4e33b427ff))
* **usage:** persist a cap-scrape timeline for a true Limits trend ([#973](https://github.com/erwins-enkel/shepherd/issues/973)) ([#989](https://github.com/erwins-enkel/shepherd/issues/989)) ([3d56dac](https://github.com/erwins-enkel/shepherd/commit/3d56dacbbd8df5dd618e1b82b13d1e99b1f1eb2c))
* **usage:** Phase 1 — /usage persistence + aggregation + breakdown API ([#968](https://github.com/erwins-enkel/shepherd/issues/968)) ([34dbf9a](https://github.com/erwins-enkel/shepherd/commit/34dbf9a481316629ff641c7940c9c16b1acd6a6e))
* **usage:** Phase 2 — wire /usage to real data + mode-aware $ + top-bar entry ([#953](https://github.com/erwins-enkel/shepherd/issues/953)) ([#982](https://github.com/erwins-enkel/shepherd/issues/982)) ([cf70696](https://github.com/erwins-enkel/shepherd/commit/cf7069674978ae8709d01ec3b9a3854f2eba183d))


### Bug Fixes

* **design-system:** render live GlossaryText in glossary recipe ([#941](https://github.com/erwins-enkel/shepherd/issues/941)) ([ca29496](https://github.com/erwins-enkel/shepherd/commit/ca29496cec45efd07433b1c4e1a6e843abb97261)), closes [#938](https://github.com/erwins-enkel/shepherd/issues/938)
* **doc-agent:** prettier-format staged docs before commit ([#930](https://github.com/erwins-enkel/shepherd/issues/930)) ([9b41d55](https://github.com/erwins-enkel/shepherd/commit/9b41d55172fc1e4cc17af3f3233cf6348cf11cf9))
* **doc-agent:** roll up nightly docs sync onto the open docs PR (never &gt;1) ([#963](https://github.com/erwins-enkel/shepherd/issues/963)) ([7a2f2bf](https://github.com/erwins-enkel/shepherd/commit/7a2f2bfcf24a113e92cfdb69a6eaf7f34b6e0499))
* **feedback:** clear feedback dialog fields on each open ([#978](https://github.com/erwins-enkel/shepherd/issues/978)) ([44271a3](https://github.com/erwins-enkel/shepherd/commit/44271a3311b14772bcebe27123fa71a6990e54bc))
* **glossary:** anchor popovers with fixed strategy so they track their trigger when scrolled ([#975](https://github.com/erwins-enkel/shepherd/issues/975)) ([3485808](https://github.com/erwins-enkel/shepherd/commit/3485808c8232970b17cd05a4397e66f19653c265))
* **learnings:** block reverted-to-proposed trial from re-auto-trialing ([#945](https://github.com/erwins-enkel/shepherd/issues/945)) ([#960](https://github.com/erwins-enkel/shepherd/issues/960)) ([ed52cb3](https://github.com/erwins-enkel/shepherd/commit/ed52cb335caf3904b1806f9a8cbd7e5df2ae5acc))
* **learnings:** make synced CLAUDE.md block prettier-stable ([#928](https://github.com/erwins-enkel/shepherd/issues/928)) ([a178b0d](https://github.com/erwins-enkel/shepherd/commit/a178b0d5a41ce0b978529aaa94131f0bb8ea9b33))
* **learnings:** prettier-stabilize synced CLAUDE.md under proseWrap:always ([#935](https://github.com/erwins-enkel/shepherd/issues/935)) ([#947](https://github.com/erwins-enkel/shepherd/issues/947)) ([f2425f9](https://github.com/erwins-enkel/shepherd/commit/f2425f91565a4697cf1b9850d9e767b6a6d58a6f))
* **onboarding:** repoint claude-missing to rockylinux/9 + de-gate launch failures only ([#926](https://github.com/erwins-enkel/shepherd/issues/926)) ([#933](https://github.com/erwins-enkel/shepherd/issues/933)) ([7acc13f](https://github.com/erwins-enkel/shepherd/commit/7acc13f113069c2c39f9d7f2dd3a0b40694aa5b9))
* **plan-panel:** full-bleed plan view on phones, drop recap-only inferred badge ([#988](https://github.com/erwins-enkel/shepherd/issues/988)) ([925cdff](https://github.com/erwins-enkel/shepherd/commit/925cdff95678310ee215a228de99ab30f4c2ab55))
* **seed-picker:** stop issue labels crushing the title ([#984](https://github.com/erwins-enkel/shepherd/issues/984)) ([66ca975](https://github.com/erwins-enkel/shepherd/commit/66ca97559001178bc58230361519f47b68a0e299))
* **top-bar:** explain why tasks are held and enlarge the popover for readability ([#983](https://github.com/erwins-enkel/shepherd/issues/983)) ([add701a](https://github.com/erwins-enkel/shepherd/commit/add701a21927f890b33b4c9fdaaa819caa6db783))
* **top-bar:** keep docs reachable when the bar link folds under overflow ([#972](https://github.com/erwins-enkel/shepherd/issues/972)) ([1af3285](https://github.com/erwins-enkel/shepherd/commit/1af3285ab540154baee13e88f4c9ae644f8258df))
* **top-bar:** polish Extra Credits detail card ([#951](https://github.com/erwins-enkel/shepherd/issues/951)) ([0a77742](https://github.com/erwins-enkel/shepherd/commit/0a777422c3b94cd0ed0cdebbaf978442345025d2))
* **ui:** demote push sub-headings below the section label ([#934](https://github.com/erwins-enkel/shepherd/issues/934)) ([fc870b8](https://github.com/erwins-enkel/shepherd/commit/fc870b8d1ecb183b7a81931aa85bbcb7e73f049a))
* **ui:** give relaunch's armed confirm a visible hot state so it reads as click-again ([#981](https://github.com/erwins-enkel/shepherd/issues/981)) ([79b2845](https://github.com/erwins-enkel/shepherd/commit/79b28455fb32073446be2c601401e0c1ff0cb587))
* **ui:** glossary definition opens inline on touch, not over content ([#931](https://github.com/erwins-enkel/shepherd/issues/931)) ([277d195](https://github.com/erwins-enkel/shepherd/commit/277d195ac98d9606559a29dad5e3564075af1a81))
* **ui:** label the repo-switcher learnings indicator (✦ LEARNINGS/TRIM + count) ([#922](https://github.com/erwins-enkel/shepherd/issues/922)) ([25aef7b](https://github.com/erwins-enkel/shepherd/commit/25aef7b4a7e6478b6c683ef6a0019b86b448a908))
* **ui:** remove heartbeat-bar hover reveal of last-run command ([#942](https://github.com/erwins-enkel/shepherd/issues/942)) ([ea7fcc3](https://github.com/erwins-enkel/shepherd/commit/ea7fcc33b4237f41cab58bb5dd7fa9f70056702a))
* **usage:** mobile UX pass — %-only cache, info-icon glossary, stacked rows, close button ([#986](https://github.com/erwins-enkel/shepherd/issues/986)) ([c38b45d](https://github.com/erwins-enkel/shepherd/commit/c38b45ded66347567f5cd986660861e1b5b1082d))
* **usage:** mobile-friendly Usage title bar with prominent back button ([#993](https://github.com/erwins-enkel/shepherd/issues/993)) ([b71f266](https://github.com/erwins-enkel/shepherd/commit/b71f2663c2e201e391b8faf12c8c1c4d0b47b7be))
* **viewport:** strip redundant shepherd/ prefix from header branch label ([#961](https://github.com/erwins-enkel/shepherd/issues/961)) ([db4c98e](https://github.com/erwins-enkel/shepherd/commit/db4c98efaea0beda233118db09bd3d28af922d68))
* **visual-blocks:** stop Mermaid error graphic leaking into the UI ([#976](https://github.com/erwins-enkel/shepherd/issues/976)) ([144183f](https://github.com/erwins-enkel/shepherd/commit/144183f53b14dfbf0d71f75f40004cedcb05120a))


### Performance Improvements

* **usage:** per-record windowing of persisted history + continuous rollup ([#992](https://github.com/erwins-enkel/shepherd/issues/992)) ([f439f76](https://github.com/erwins-enkel/shepherd/commit/f439f76a979b7b6fc7b8d0fa14b8c62b8dced0c2))


### Code Refactoring

* extract shared spawn/membrane tail across reviewer-style services ([#937](https://github.com/erwins-enkel/shepherd/issues/937)) ([#949](https://github.com/erwins-enkel/shepherd/issues/949)) ([f78b0bb](https://github.com/erwins-enkel/shepherd/commit/f78b0bb328a07f3da5fa35c1d84b442f5c1c3999))
* **ui:** split LearningsDrawer into learnings-drawer/, drop fallow grandfather ([#855](https://github.com/erwins-enkel/shepherd/issues/855)) ([#923](https://github.com/erwins-enkel/shepherd/issues/923)) ([51999d0](https://github.com/erwins-enkel/shepherd/commit/51999d0daf83efecc4f619d36a1aebd9279aefef))
* **usage:** open Usage as a dim/blur modal, remove /usage route ([#991](https://github.com/erwins-enkel/shepherd/issues/991)) ([5620b29](https://github.com/erwins-enkel/shepherd/commit/5620b29ecf234ce293c0f11ef7aca9aab1760765))


### Documentation

* sync docs to recent source changes ([#959](https://github.com/erwins-enkel/shepherd/issues/959)) ([9e20f20](https://github.com/erwins-enkel/shepherd/commit/9e20f20a77db92d45c6e01f5df11289eeb32dd40))
* sync docs to recent source changes ([#994](https://github.com/erwins-enkel/shepherd/issues/994)) ([15e0255](https://github.com/erwins-enkel/shepherd/commit/15e025516f01d2f03d5600c3ae1cb691f2e79481))

## [1.35.0](https://github.com/erwins-enkel/shepherd/compare/v1.34.0...v1.35.0) (2026-06-20)


### Features

* **activity:** deterministic visual feed + surfaced recap ([#808](https://github.com/erwins-enkel/shepherd/issues/808)) ([#812](https://github.com/erwins-enkel/shepherd/issues/812)) ([36bb75e](https://github.com/erwins-enkel/shepherd/commit/36bb75e9d125ce329c6882170791f1d97a3299a5))
* **backlog:** standalone Fast-forward action for selected repo ([#861](https://github.com/erwins-enkel/shepherd/issues/861)) ([#864](https://github.com/erwins-enkel/shepherd/issues/864)) ([e30278f](https://github.com/erwins-enkel/shepherd/commit/e30278f370b07bf28a3436c524ac999773b2c461))
* **gitrail:** open the linked issue from the rail ([#884](https://github.com/erwins-enkel/shepherd/issues/884)) ([17baf0d](https://github.com/erwins-enkel/shepherd/commit/17baf0d9c434c4f1b58ecd80a0b4d05fd7db7abc))
* **herd:** ready lens hides tasks waiting on other parties ([#863](https://github.com/erwins-enkel/shepherd/issues/863)) ([1c625de](https://github.com/erwins-enkel/shepherd/commit/1c625de85d74bc15d469a18be6446027a6dfd32c))
* **learnings:** background merge-suggestions + cross-repo recurrence ([#843](https://github.com/erwins-enkel/shepherd/issues/843)) ([#873](https://github.com/erwins-enkel/shepherd/issues/873)) ([#876](https://github.com/erwins-enkel/shepherd/issues/876)) ([a3f4bb6](https://github.com/erwins-enkel/shepherd/commit/a3f4bb67cd67c4835bcaf071d5ba0969825e86aa))
* **learnings:** capture-time semantic merge + composite ranking (Phase 2, [#841](https://github.com/erwins-enkel/shepherd/issues/841)) ([#866](https://github.com/erwins-enkel/shepherd/issues/866)) ([81092c7](https://github.com/erwins-enkel/shepherd/commit/81092c7f22dd98d5cac41f9aa62b3b628a19c1fb))
* **learnings:** effectiveness loop + safe auto-retire (Phase 1, [#840](https://github.com/erwins-enkel/shepherd/issues/840)) ([#853](https://github.com/erwins-enkel/shepherd/issues/853)) ([4e8db72](https://github.com/erwins-enkel/shepherd/commit/4e8db72e24dae49f3dcdd27e8d2a6eec139ab8aa))
* **learnings:** one-click promote a cross-repo rule to global CLAUDE.md ([#872](https://github.com/erwins-enkel/shepherd/issues/872)) ([#895](https://github.com/erwins-enkel/shepherd/issues/895)) ([e0b9b1f](https://github.com/erwins-enkel/shepherd/commit/e0b9b1fa236425ab17b879228074566a3467ef90))
* **learnings:** push notification for auto-retire ([#852](https://github.com/erwins-enkel/shepherd/issues/852)) ([#889](https://github.com/erwins-enkel/shepherd/issues/889)) ([ae51252](https://github.com/erwins-enkel/shepherd/commit/ae512520c421487c8ff90e59d8b766c943093e61))
* **learnings:** scoped (glob-based) injection (Phase 3, [#842](https://github.com/erwins-enkel/shepherd/issues/842)) ([#869](https://github.com/erwins-enkel/shepherd/issues/869)) ([57bbf33](https://github.com/erwins-enkel/shepherd/commit/57bbf33134e27005fce64beaf5cc5d6a1a40bff9))
* **learnings:** show repo emoji/symbol in drawer group headers ([#870](https://github.com/erwins-enkel/shepherd/issues/870)) ([7dcb2f7](https://github.com/erwins-enkel/shepherd/commit/7dcb2f7c967419a10b18ba7570e86feeb4906cd4))
* lightweight repo mode — local-only git, merge branches locally at task completion ([#807](https://github.com/erwins-enkel/shepherd/issues/807)) ([#819](https://github.com/erwins-enkel/shepherd/issues/819)) ([b87ffd9](https://github.com/erwins-enkel/shepherd/commit/b87ffd9227c63edaf9525a796c19364cff53c67b))
* one-session-one-PR invariant directive ([#839](https://github.com/erwins-enkel/shepherd/issues/839)) ([#844](https://github.com/erwins-enkel/shepherd/issues/844)) ([fd54393](https://github.com/erwins-enkel/shepherd/commit/fd543934cbb593f802e5ca0a91f30521a442b831))
* **plan:** question-form answer round-trip ([#803](https://github.com/erwins-enkel/shepherd/issues/803)) ([#805](https://github.com/erwins-enkel/shepherd/issues/805)) ([3dcf965](https://github.com/erwins-enkel/shepherd/commit/3dcf9652102f01ab5893224574c2432b93a484c6))
* reduced push notifications mode (ready-after-5s only) ([#896](https://github.com/erwins-enkel/shepherd/issues/896)) ([#903](https://github.com/erwins-enkel/shepherd/issues/903)) ([bc251a3](https://github.com/erwins-enkel/shepherd/commit/bc251a3eae3dd9872bedeb1e97c0c75e8d370293))
* **site,docs:** cross-link landing ↔ docs site ([#913](https://github.com/erwins-enkel/shepherd/issues/913)) ([#918](https://github.com/erwins-enkel/shepherd/issues/918)) ([fdeee84](https://github.com/erwins-enkel/shepherd/commit/fdeee8442406e994cb73ccb0a754a6d81bf72590))
* **site:** show pre-release notice on landing hero ([#813](https://github.com/erwins-enkel/shepherd/issues/813)) ([ecfabde](https://github.com/erwins-enkel/shepherd/commit/ecfabdefa84ed2ddbc8f89a5e319cb37f38983db))
* **site:** surface /commands portability + visual plans/recaps on landing ([#823](https://github.com/erwins-enkel/shepherd/issues/823)) ([fa7b5a0](https://github.com/erwins-enkel/shepherd/commit/fa7b5a0ba0579b331ae83c96ecae8c279b1df1ce))
* **ui:** add "hide in progress" issue filter (shepherd:active) ([#865](https://github.com/erwins-enkel/shepherd/issues/865)) ([ce7436d](https://github.com/erwins-enkel/shepherd/commit/ce7436d733db6ce2eb60a3907d8c6484c07c6519))
* **ui:** collapse New-Task/Backlog issue filters into a Filters popover ([#912](https://github.com/erwins-enkel/shepherd/issues/912)) ([b6ff7b4](https://github.com/erwins-enkel/shepherd/commit/b6ff7b47263215554ce4fe825506659c54a94fab))
* **ui:** expose 1M-context Opus & Sonnet in model pickers ([#836](https://github.com/erwins-enkel/shepherd/issues/836)) ([0f08d97](https://github.com/erwins-enkel/shepherd/commit/0f08d97e9d75e64f1cbde255395efef74bbd29b1))
* **ui:** expose per-repo automation settings in Backlog (no task needed) ([#829](https://github.com/erwins-enkel/shepherd/issues/829)) ([9d31eaa](https://github.com/erwins-enkel/shepherd/commit/9d31eaab040775c105beda2136287c1fbcd6f674))
* **ui:** filter issue lists to mine + unassigned ([#824](https://github.com/erwins-enkel/shepherd/issues/824)) ([#827](https://github.com/erwins-enkel/shepherd/issues/827)) ([bc96515](https://github.com/erwins-enkel/shepherd/commit/bc96515a8536cc1637f04cf9098288270f0a7ce1))
* **ui:** hide native sub-issues by default in backlog + new-task issue lists ([#891](https://github.com/erwins-enkel/shepherd/issues/891)) ([5700e6a](https://github.com/erwins-enkel/shepherd/commit/5700e6a51e706754a1d9d1f7637d3eefca9c6dc3))
* **ui:** respect iOS system Text Size (Dynamic Type) in the PWA ([#888](https://github.com/erwins-enkel/shepherd/issues/888)) ([294e66b](https://github.com/erwins-enkel/shepherd/commit/294e66bfc201f6dda972561f766367b4902bb2bb))
* usage-aware task holding (Part A of [#825](https://github.com/erwins-enkel/shepherd/issues/825)) ([#830](https://github.com/erwins-enkel/shepherd/issues/830)) ([0cd35b3](https://github.com/erwins-enkel/shepherd/commit/0cd35b38f2fd333db40462c7744383f9d36925f9))
* usage-halt detection + global retry (Part B of [#825](https://github.com/erwins-enkel/shepherd/issues/825)) ([#835](https://github.com/erwins-enkel/shepherd/issues/835)) ([b33cfae](https://github.com/erwins-enkel/shepherd/commit/b33cfae8aa251235d05044bacdc31b0c7de34773))


### Bug Fixes

* **build-queue:** keep step status in sync with real progress ([#821](https://github.com/erwins-enkel/shepherd/issues/821)) ([82533d7](https://github.com/erwins-enkel/shepherd/commit/82533d75b71194f97de9b98beff490d0864afdf4))
* **docs:** make TypeDoc API build self-contained for Vercel ([#914](https://github.com/erwins-enkel/shepherd/issues/914)) ([5a7d4a7](https://github.com/erwins-enkel/shepherd/commit/5a7d4a7ea26e8fefe9472cd47ad6d3e61a548113))
* **drain:** emit session:new on auto-spawn so Herd refreshes live ([#883](https://github.com/erwins-enkel/shepherd/issues/883)) ([3141083](https://github.com/erwins-enkel/shepherd/commit/3141083cb560e7a3747d30d7b2b79264d3067275))
* **epics:** hide markdown epic-dag sub-issues in backlog, not just native ones ([#900](https://github.com/erwins-enkel/shepherd/issues/900)) ([05c1264](https://github.com/erwins-enkel/shepherd/commit/05c12647deaa050fcbbe078017818830dc8c0562))
* **epic:** show real title+url for queued markdown-epic issues ([#899](https://github.com/erwins-enkel/shepherd/issues/899)) ([b6c2d9d](https://github.com/erwins-enkel/shepherd/commit/b6c2d9dac4eef919654e0e59d84a0c15b09a8eba))
* **git-rail:** hide Open PR button when autopilot is on ([#811](https://github.com/erwins-enkel/shepherd/issues/811)) ([b20952d](https://github.com/erwins-enkel/shepherd/commit/b20952dbfc5242194440a53e2edd3c97c45c5c3a))
* guard against Fable being globally unavailable (argv-only opus[1m] fallback + toggle) ([#846](https://github.com/erwins-enkel/shepherd/issues/846)) ([11c8f9f](https://github.com/erwins-enkel/shepherd/commit/11c8f9fffd0fcd8cc639e14bdb7ea03ed36a1736))
* **herd:** hide CI-running tasks from the Ready lens ([#867](https://github.com/erwins-enkel/shepherd/issues/867)) ([dad8428](https://github.com/erwins-enkel/shepherd/commit/dad842880479d09b4960486182d72c9f447834f5))
* **learnings:** stop content bleeding above sticky group header ([#818](https://github.com/erwins-enkel/shepherd/issues/818)) ([4456e1f](https://github.com/erwins-enkel/shepherd/commit/4456e1f81817b5eb39acca6519c76c052b97fc26))
* **onboarding-harness:** seed forge repo so gh probe reports error ([#860](https://github.com/erwins-enkel/shepherd/issues/860)) ([#862](https://github.com/erwins-enkel/shepherd/issues/862)) ([f11e932](https://github.com/erwins-enkel/shepherd/commit/f11e932a14dd9262b7cfe3e8a1ed60b7e095a2b5))
* **plan:** keep read-only PLAN chip off session cards; legible in top bar ([#820](https://github.com/erwins-enkel/shepherd/issues/820)) ([2381019](https://github.com/erwins-enkel/shepherd/commit/2381019e1c03cbf35f7a641450e191b679e9c5ed))
* **plan:** re-open signed-off plan read-only during execution ([#809](https://github.com/erwins-enkel/shepherd/issues/809)) ([#814](https://github.com/erwins-enkel/shepherd/issues/814)) ([5c63977](https://github.com/erwins-enkel/shepherd/commit/5c63977e799a43fd121153304f58e435ce11085a))
* **recap:** recover prose-wrapped + variant verdicts; log recap failures ([#834](https://github.com/erwins-enkel/shepherd/issues/834)) ([826889c](https://github.com/erwins-enkel/shepherd/commit/826889c91ee33560cafa41b018df41096f3e4321))
* **recap:** repair malformed verdict JSON + fail fast instead of 5-min hang ([#822](https://github.com/erwins-enkel/shepherd/issues/822)) ([#826](https://github.com/erwins-enkel/shepherd/issues/826)) ([69a6bfb](https://github.com/erwins-enkel/shepherd/commit/69a6bfb299fd387d014f3b11607a0acd6e80421d))
* **task:** base new tasks off the repo default branch, not the current checkout ([#828](https://github.com/erwins-enkel/shepherd/issues/828)) ([4e32643](https://github.com/erwins-enkel/shepherd/commit/4e32643f8912ef44f4baf5deb2a11c0cb052b17b))
* **test:** de-flake pre-push — cross-process resource collisions (refs [#817](https://github.com/erwins-enkel/shepherd/issues/817)) ([#887](https://github.com/erwins-enkel/shepherd/issues/887)) ([f7fff4b](https://github.com/erwins-enkel/shepherd/commit/f7fff4bf8ce8ae2a9b7e6c51658c315274089133))
* **toasts:** inset mobile banner above the action bar ([#810](https://github.com/erwins-enkel/shepherd/issues/810)) ([#816](https://github.com/erwins-enkel/shepherd/issues/816)) ([434b660](https://github.com/erwins-enkel/shepherd/commit/434b660e1291c173335c3b2bb2d11ada8c9eda12))
* **ui:** de-dupe learnings count + drop underline in repo filter rail ([#910](https://github.com/erwins-enkel/shepherd/issues/910)) ([ee6b8f5](https://github.com/erwins-enkel/shepherd/commit/ee6b8f5e2791cffb4536e715b112f379ccad8666))
* **ui:** hide keyboard-combo hints on coarse-pointer devices ([#917](https://github.com/erwins-enkel/shepherd/issues/917)) ([d2a7888](https://github.com/erwins-enkel/shepherd/commit/d2a78884ff3a0cb237c52ca477a90518761b6619))
* **ui:** make linked issue clickable in Done view ([#894](https://github.com/erwins-enkel/shepherd/issues/894)) ([b6eb3c2](https://github.com/erwins-enkel/shepherd/commit/b6eb3c2d7ea6435d8d656cec27390d6f9b20722f))
* **ui:** measure-drive top-bar compaction on touch-desktop (fix foldable overflow) ([#919](https://github.com/erwins-enkel/shepherd/issues/919)) ([f9f3ce3](https://github.com/erwins-enkel/shepherd/commit/f9f3ce3daa7152a2fc89f83d0f2463adff2eacf3))
* **ui:** restore space between recap annotation label + note ([#901](https://github.com/erwins-enkel/shepherd/issues/901)) ([4eb2dac](https://github.com/erwins-enkel/shepherd/commit/4eb2dac3fb7be46178da13d679efd4e70853749d))
* **ui:** sticky filter bar fully covers scrolling rows in SEED FROM picker ([#857](https://github.com/erwins-enkel/shepherd/issues/857)) ([03b7f32](https://github.com/erwins-enkel/shepherd/commit/03b7f3210d7be7743775a7d273226c9feb1cfd26))
* **ui:** wrap herd filter row in compact layout so Rundown stays in bounds ([#831](https://github.com/erwins-enkel/shepherd/issues/831)) ([90e6792](https://github.com/erwins-enkel/shepherd/commit/90e67924ed797976bb3404a17c6a02bf5893efe6))


### Code Refactoring

* **ui:** drop inert fallow complexity markers ([#833](https://github.com/erwins-enkel/shepherd/issues/833)) ([fba7372](https://github.com/erwins-enkel/shepherd/commit/fba73727e2b95b95a68169fd70b0190e36467207)), closes [#832](https://github.com/erwins-enkel/shepherd/issues/832)
* **ui:** drop THE HERD title in compact layout to save vertical space ([#916](https://github.com/erwins-enkel/shepherd/issues/916)) ([1427f35](https://github.com/erwins-enkel/shepherd/commit/1427f3583e7185812f8879f388e1c34ae140db84))
* **ui:** extract page/AppOverlays from +page, drop fallow grandfather ([#855](https://github.com/erwins-enkel/shepherd/issues/855)) ([#915](https://github.com/erwins-enkel/shepherd/issues/915)) ([77ace8d](https://github.com/erwins-enkel/shepherd/commit/77ace8da86a4d08e20eaefa1a972a5db5c1165ce))
* **ui:** split 4 near-bar Svelte templates, delete their fallow grandfathers ([#855](https://github.com/erwins-enkel/shepherd/issues/855)) ([#868](https://github.com/erwins-enkel/shepherd/issues/868)) ([255bf99](https://github.com/erwins-enkel/shepherd/commit/255bf99f0d709ae0a64954b352412691b690f18e))
* **ui:** split Herd.svelte template into herd/ children, drop fallow grandfather ([#855](https://github.com/erwins-enkel/shepherd/issues/855)) ([#911](https://github.com/erwins-enkel/shepherd/issues/911)) ([bc0a0a7](https://github.com/erwins-enkel/shepherd/commit/bc0a0a7c74884670ce4788e305d7596e271b9141))
* **ui:** split IssuesPanel + BacklogView templates, drop fallow grandfathers ([#855](https://github.com/erwins-enkel/shepherd/issues/855)) ([#874](https://github.com/erwins-enkel/shepherd/issues/874)) ([3029319](https://github.com/erwins-enkel/shepherd/commit/3029319232bc0893c11b5f6b8c6c096d947c8fc9))
* **ui:** split TopBar template into top-bar/ children, drop its fallow grandfather ([#855](https://github.com/erwins-enkel/shepherd/issues/855)) ([#898](https://github.com/erwins-enkel/shepherd/issues/898)) ([b21a109](https://github.com/erwins-enkel/shepherd/commit/b21a109c781e6b211ee16441b4a73e1914b819b6))
* **ui:** split UnitRow + GitRail templates, drop 2 fallow grandfathers ([#855](https://github.com/erwins-enkel/shepherd/issues/855)) ([#893](https://github.com/erwins-enkel/shepherd/issues/893)) ([f33e470](https://github.com/erwins-enkel/shepherd/commit/f33e47060816e655d639422a25fda07e96539b61))
* **ui:** split Viewport.svelte template, tighten its fallow grandfather ([#855](https://github.com/erwins-enkel/shepherd/issues/855)) ([#858](https://github.com/erwins-enkel/shepherd/issues/858)) ([69e86f2](https://github.com/erwins-enkel/shepherd/commit/69e86f2f15579699ce31643cf827f04eec83e974))


### Documentation

* **research:** evaluate claude-swap multi-account integration ([#815](https://github.com/erwins-enkel/shepherd/issues/815)) ([c8ecd6c](https://github.com/erwins-enkel/shepherd/commit/c8ecd6c8cdc89cd45c22d5e706770961e6119e07))
* **research:** managing learnings at scale (auto-prune, decay, dedup, effectiveness retirement) ([#837](https://github.com/erwins-enkel/shepherd/issues/837)) ([78c3660](https://github.com/erwins-enkel/shepherd/commit/78c36602ecc6a48164f818793947459eb65e6954))

## [1.34.0](https://github.com/erwins-enkel/shepherd/compare/v1.33.0...v1.34.0) (2026-06-19)


### Features

* freshen task base branch from upstream at launch ([#766](https://github.com/erwins-enkel/shepherd/issues/766)) ([663585d](https://github.com/erwins-enkel/shepherd/commit/663585d584ef0ae7a01373a79e9b313e806b6e05))
* **learnings:** one-click optimize for not-working house rules ([#780](https://github.com/erwins-enkel/shepherd/issues/780)) ([e605e61](https://github.com/erwins-enkel/shepherd/commit/e605e61f42d5f2d6c65ec1fd1f03cf000f2e6a22))
* **learnings:** triage layer — budget visibility + sticky repo separation ([#796](https://github.com/erwins-enkel/shepherd/issues/796)) ([#800](https://github.com/erwins-enkel/shepherd/issues/800)) ([79138ad](https://github.com/erwins-enkel/shepherd/commit/79138adf0486665d838e432ccad44189ec0c7460))
* **plan:** native visual plans — VisualReview in PlanPanel + question-form block ([#799](https://github.com/erwins-enkel/shepherd/issues/799)) ([#802](https://github.com/erwins-enkel/shepherd/issues/802)) ([46c3913](https://github.com/erwins-enkel/shepherd/commit/46c3913dbee4c6853857437d71aa53d9f0c8ff9a))
* **recap:** native visual recap blocks — Phase 1 ([#773](https://github.com/erwins-enkel/shepherd/issues/773)) ([#781](https://github.com/erwins-enkel/shepherd/issues/781)) ([84216a1](https://github.com/erwins-enkel/shepherd/commit/84216a1414b0ceef6d5e035911dd831e2a4675ff))
* **recap:** native visual recap cards — Phase 2 ([#773](https://github.com/erwins-enkel/shepherd/issues/773)) ([#789](https://github.com/erwins-enkel/shepherd/issues/789)) ([459e83f](https://github.com/erwins-enkel/shepherd/commit/459e83fafe5ac342a961f4b3ad254658aa86fae2))
* **recap:** native visual recap Phase 3 — mermaid + wireframe blocks ([#773](https://github.com/erwins-enkel/shepherd/issues/773)) ([#797](https://github.com/erwins-enkel/shepherd/issues/797)) ([8b3f335](https://github.com/erwins-enkel/shepherd/commit/8b3f335c6590a6a8a5250080ee1bbeae79e284a6))
* **ui:** collapsible build-queue panel ([#779](https://github.com/erwins-enkel/shepherd/issues/779)) ([6ff47e7](https://github.com/erwins-enkel/shepherd/commit/6ff47e778797e447bc3cca169b18e7eba933ef6d))
* **ui:** declutter mobile PWA header ([#720](https://github.com/erwins-enkel/shepherd/issues/720)) ([#760](https://github.com/erwins-enkel/shepherd/issues/760)) ([196553e](https://github.com/erwins-enkel/shepherd/commit/196553e42b68deecd0bccc6523ad68a3ed437af0))
* **ui:** keyboard repo switching in New Task pane ([#765](https://github.com/erwins-enkel/shepherd/issues/765)) ([7c1aae5](https://github.com/erwins-enkel/shepherd/commit/7c1aae5b6061aaf3b55346b2dede267f5c5ddeba))
* **ui:** show build-queue progress on session cards ([#778](https://github.com/erwins-enkel/shepherd/issues/778)) ([b37cda4](https://github.com/erwins-enkel/shepherd/commit/b37cda4ae6cd1f6189895db6411758b314cc5109))


### Bug Fixes

* **ci:** pin fallow to 2.97.0 to stop template-complexity gate tripping on large UI files ([#757](https://github.com/erwins-enkel/shepherd/issues/757)) ([b716dae](https://github.com/erwins-enkel/shepherd/commit/b716dae349ba5f3e5c5c6611a8ad4f7790e6645f)), closes [#756](https://github.com/erwins-enkel/shepherd/issues/756)
* **design:** add --status-warn caution token + adopt caution consumers ([#774](https://github.com/erwins-enkel/shepherd/issues/774)) ([78b1e67](https://github.com/erwins-enkel/shepherd/commit/78b1e676fde00d4ec8b3f1065143f36907e91c42))
* **namer:** refine LLM-renames truncated prompts; tighten deterministic gate ([#775](https://github.com/erwins-enkel/shepherd/issues/775)) ([97600a3](https://github.com/erwins-enkel/shepherd/commit/97600a35e54f5f62fbb6fd86cacdcd5647916cd2))
* **sandbox:** carve out writable session-env so critic Bash/git works under bwrap ([#791](https://github.com/erwins-enkel/shepherd/issues/791)) ([dd60ccc](https://github.com/erwins-enkel/shepherd/commit/dd60ccc8ca1c196a4d69210571d90ffe8e8bfe0d))
* **ui:** add hover explainer to repo pill learnings (✦) count ([#763](https://github.com/erwins-enkel/shepherd/issues/763)) ([7fd13ff](https://github.com/erwins-enkel/shepherd/commit/7fd13ffabf0ac55f107c7eaaab2c618caae77b97))
* **ui:** armed decommission solid-fill, drop crammed "?" adornment ([#767](https://github.com/erwins-enkel/shepherd/issues/767)-followup) ([#785](https://github.com/erwins-enkel/shepherd/issues/785)) ([0936e32](https://github.com/erwins-enkel/shepherd/commit/0936e320a6fd7708f0931959e9708e4b0a06932a))
* **ui:** collapse mobile settings-gear pips into one severity dot ([#782](https://github.com/erwins-enkel/shepherd/issues/782)) ([e49c8c6](https://github.com/erwins-enkel/shepherd/commit/e49c8c69972899b384d56c05c28bbd6ca8309cbe))
* **ui:** distinguish over-budget "Trim" state from pending learnings in TopBar chip ([#777](https://github.com/erwins-enkel/shepherd/issues/777)) ([eafd83a](https://github.com/erwins-enkel/shepherd/commit/eafd83a6e7e7b7b0dfb19e5e36f6b74dca3a68d9))
* **ui:** escape closes repo picker, not the whole New Task modal ([#765](https://github.com/erwins-enkel/shepherd/issues/765)) [no-feature-entry] ([#772](https://github.com/erwins-enkel/shepherd/issues/772)) ([249cf77](https://github.com/erwins-enkel/shepherd/commit/249cf77e85dfb85a29b723668826501d903d9f80))
* **ui:** expand collapsed build queue on click anywhere in header ([#787](https://github.com/erwins-enkel/shepherd/issues/787)) ([b32fd52](https://github.com/erwins-enkel/shepherd/commit/b32fd52d33acc36405901bcf4faedf486d5f728b))
* **ui:** portal mobile gear sheet out of transformed header ([#784](https://github.com/erwins-enkel/shepherd/issues/784)) ([bfc30ee](https://github.com/erwins-enkel/shepherd/commit/bfc30ee4b670a2efae003ca3c2ba092c0511dd4b))
* **ui:** quiet redraw control to an icon-only wrench ([#768](https://github.com/erwins-enkel/shepherd/issues/768)) ([13ca999](https://github.com/erwins-enkel/shepherd/commit/13ca999d242f094ab4ab195080ac1130f7b75f3b))
* **ui:** restore discoverable learnings approval via a global TopBar button ([#769](https://github.com/erwins-enkel/shepherd/issues/769)) ([f0f6407](https://github.com/erwins-enkel/shepherd/commit/f0f6407626383e7da653ab34649ba0b592c918cc))
* **ui:** scroll New Task pane when it outgrows the viewport ([#795](https://github.com/erwins-enkel/shepherd/issues/795)) ([799a87f](https://github.com/erwins-enkel/shepherd/commit/799a87fb2e18618716268d6a6010d49247fdd70b))
* **ui:** shared .icon-btn recipe + recognisable SVG terminal-header controls ([#767](https://github.com/erwins-enkel/shepherd/issues/767)) ([#776](https://github.com/erwins-enkel/shepherd/issues/776)) ([de04bd8](https://github.com/erwins-enkel/shepherd/commit/de04bd8b80da5e633aa737d11e2f97526dd863f7))
* **ui:** single-row build-queue badge to match sibling height ([#783](https://github.com/erwins-enkel/shepherd/issues/783)) ([df179c2](https://github.com/erwins-enkel/shepherd/commit/df179c2c0314fa36ba9039af87f4492c22355ac5))
* **ui:** tidy learnings drawer header gap + injected-rule button wrap ([#786](https://github.com/erwins-enkel/shepherd/issues/786)) ([8a21513](https://github.com/erwins-enkel/shepherd/commit/8a21513d12ed11fc6d41e8aca30d6367425324d6))
* **ui:** usage gauge goes red above 90% ([#788](https://github.com/erwins-enkel/shepherd/issues/788)) ([4d88708](https://github.com/erwins-enkel/shepherd/commit/4d887080763c5fd918c998fc12ee6048753a6d30))
* **worktree:** abort instead of silent non-isolated fallback ([#790](https://github.com/erwins-enkel/shepherd/issues/790)) ([#792](https://github.com/erwins-enkel/shepherd/issues/792)) ([482209d](https://github.com/erwins-enkel/shepherd/commit/482209d30fdef694355d060c77bd57ea4063224c))
* **worktree:** suffix past leftover branches instead of failing create ([#801](https://github.com/erwins-enkel/shepherd/issues/801)) ([15c964e](https://github.com/erwins-enkel/shepherd/commit/15c964e326aded77f49312b64d5162d03d1295b8))


### Code Refactoring

* **ui:** drop redundant top-bar rundown button [no-feature-entry] ([#764](https://github.com/erwins-enkel/shepherd/issues/764)) ([571f3b8](https://github.com/erwins-enkel/shepherd/commit/571f3b8637d8a4d35b91156c146e016f8a642f01))


### Documentation

* **research:** native visual plan/recap design for Shepherd [no-feature-entry] ([#771](https://github.com/erwins-enkel/shepherd/issues/771)) ([63e2f2b](https://github.com/erwins-enkel/shepherd/commit/63e2f2bb7303b2c30ce76ed32a555930c73748e9))
* **research:** UX pass on the learnings pane ([#794](https://github.com/erwins-enkel/shepherd/issues/794)) ([1e19e4d](https://github.com/erwins-enkel/shepherd/commit/1e19e4dbe836bc712c6f5d13eb4c18b04eabde9b))

## [1.33.0](https://github.com/erwins-enkel/shepherd/compare/v1.32.0...v1.33.0) (2026-06-17)


### Features

* **gitrail:** first-class manual plan-review trigger ([#753](https://github.com/erwins-enkel/shepherd/issues/753)) ([#754](https://github.com/erwins-enkel/shepherd/issues/754)) ([39cddba](https://github.com/erwins-enkel/shepherd/commit/39cddba7aae2ae1d1c2ef3858df7b7cd10eb71a9))
* **gitrail:** manual critic-review trigger ([#745](https://github.com/erwins-enkel/shepherd/issues/745)) ([85383cf](https://github.com/erwins-enkel/shepherd/commit/85383cf34d2a1ba03dbc233ffaf71b2b00cb571d))
* **repos:** list cloneable GitHub repos in the clone dialog ([#744](https://github.com/erwins-enkel/shepherd/issues/744)) ([29a0ab6](https://github.com/erwins-enkel/shepherd/commit/29a0ab6aa4ea7b054a80563b535742bf0338f41e))
* **site:** shepherd.run landing page (Astro static) ([#741](https://github.com/erwins-enkel/shepherd/issues/741)) ([bc1c3da](https://github.com/erwins-enkel/shepherd/commit/bc1c3da526414a8f5074ecfa1fc96266e5ef04b0))
* surface quota-exhausted sessions as a 'needs you' nudge ([#755](https://github.com/erwins-enkel/shepherd/issues/755)) ([c53a4f1](https://github.com/erwins-enkel/shepherd/commit/c53a4f1c64a9281226b34139e41135347e5ee7e7))
* **topbar:** relative reset countdown on usage gauges ([#746](https://github.com/erwins-enkel/shepherd/issues/746)) ([321a746](https://github.com/erwins-enkel/shepherd/commit/321a7461b42f9bb3bb3dc2f1e15266a5b9fff3be))


### Bug Fixes

* **critic:** bind herdr/worktree in reapRun so critic teardown can't crash ([#748](https://github.com/erwins-enkel/shepherd/issues/748)) ([1f7ddc4](https://github.com/erwins-enkel/shepherd/commit/1f7ddc41dbb47c104051f8847914b772d62b36d6))
* **learnings:** restore distiller — unique agent name, bounded concurrency, fail-closed health ([#750](https://github.com/erwins-enkel/shepherd/issues/750)) ([79e5e6e](https://github.com/erwins-enkel/shepherd/commit/79e5e6e7e5ae86fe9985aba3def109ac4fa7b363))
* **onboarding-harness:** 4GiB profile cap clears claude-installer OOM; surface install RAM floor ([#749](https://github.com/erwins-enkel/shepherd/issues/749)) ([#752](https://github.com/erwins-enkel/shepherd/issues/752)) ([c174828](https://github.com/erwins-enkel/shepherd/commit/c174828dffcb7d21c473337af1503f74f2e0d2e0))
* **review:** reap orphaned reviewers across restart to stop recurring REVIEW ERR ([#751](https://github.com/erwins-enkel/shepherd/issues/751)) ([41b420e](https://github.com/erwins-enkel/shepherd/commit/41b420e7efde6cca2700db7f2284de564b086658))
* **tmp-sweep:** reap stale fallow caches + prune orphaned worktree records ([#742](https://github.com/erwins-enkel/shepherd/issues/742)) ([22bf7f8](https://github.com/erwins-enkel/shepherd/commit/22bf7f84600251e02546326dedee07631e935c09))

## [1.32.0](https://github.com/erwins-enkel/shepherd/compare/v1.31.0...v1.32.0) (2026-06-16)


### Features

* **hooks:** live sub-agent fan-out in the HUD (SubagentStart/Stop) — phase 3 ([#710](https://github.com/erwins-enkel/shepherd/issues/710)) ([#723](https://github.com/erwins-enkel/shepherd/issues/723)) ([82f832d](https://github.com/erwins-enkel/shepherd/commit/82f832dfe24601b907d9b859344fd061a8338ff4))
* **hooks:** measure Stop→herdr-done window (observe-only); drop SessionEnd consume ([#713](https://github.com/erwins-enkel/shepherd/issues/713)) ([#733](https://github.com/erwins-enkel/shepherd/issues/733)) ([daeb944](https://github.com/erwins-enkel/shepherd/commit/daeb9449a543156bf421262129d7bd035106617a))
* **hooks:** push-based agent-info ingestion via Claude Code hooks — Phase 0 + 1 ([#704](https://github.com/erwins-enkel/shepherd/issues/704)) ([fdf62ad](https://github.com/erwins-enkel/shepherd/commit/fdf62adbb1f1713f99acb5018542db9c9b477d40))
* **hooks:** reach Shepherd from inside the autonomous egress netns ([#711](https://github.com/erwins-enkel/shepherd/issues/711)) ([#738](https://github.com/erwins-enkel/shepherd/issues/738)) ([953b6c5](https://github.com/erwins-enkel/shepherd/commit/953b6c5299f92152a43025c72b5f8074217a7cf3))
* **hooks:** sessionStart consumed; stop/sessionEnd observe-only — phase 2 ([#709](https://github.com/erwins-enkel/shepherd/issues/709)) ([#718](https://github.com/erwins-enkel/shepherd/issues/718)) ([7e498d8](https://github.com/erwins-enkel/shepherd/commit/7e498d8dc334411e836e0b4c623919d805374384))
* in-app DIAGNOSE one-click Fix + keystone src/remediations.ts ([#703](https://github.com/erwins-enkel/shepherd/issues/703)) ([#707](https://github.com/erwins-enkel/shepherd/issues/707)) ([29c16fa](https://github.com/erwins-enkel/shepherd/commit/29c16fa71a3613707a5dda6e12448e024bcb7e1e))
* **installer:** DIAGNOSE doc-links + full systemd-lifecycle e2e ([#725](https://github.com/erwins-enkel/shepherd/issues/725)) ([#734](https://github.com/erwins-enkel/shepherd/issues/734)) ([a402802](https://github.com/erwins-enkel/shepherd/commit/a4028021bbde41be488b25feea15125fafd0625a))
* **installer:** shepherd.run vanity install redirect via Vercel (Phase 1) ([#736](https://github.com/erwins-enkel/shepherd/issues/736)) ([e907db1](https://github.com/erwins-enkel/shepherd/commit/e907db1074f0e30c02a0cbc84377c2f9a7e2ed02))
* **installer:** Surface A curl|bash bootstrap + Phase-4 e2e gate ([#706](https://github.com/erwins-enkel/shepherd/issues/706)) ([#724](https://github.com/erwins-enkel/shepherd/issues/724)) ([fdc3765](https://github.com/erwins-enkel/shepherd/commit/fdc3765952ebbd0594b23c4ad81275169e3f444d))
* **newtask:** info tooltips for run options + visible repo autopilot default ([#698](https://github.com/erwins-enkel/shepherd/issues/698)) ([146ead2](https://github.com/erwins-enkel/shepherd/commit/146ead2872d65814c9ad9d19e3cb828fa18ff77c))
* **newtask:** per-task Autopilot override in the New Task dialog ([#696](https://github.com/erwins-enkel/shepherd/issues/696)) ([94e2018](https://github.com/erwins-enkel/shepherd/commit/94e2018e2afb079c0c0ab62516c54f3e9175a628))
* **repos:** add "Sync fork with upstream" action to fork repos ([#737](https://github.com/erwins-enkel/shepherd/issues/737)) ([eff45a7](https://github.com/erwins-enkel/shepherd/commit/eff45a760316cd19d6c4aab8182f4b1f568f581f))
* **rundown:** herd rundown — synthesized cross-session attention digest ([#693](https://github.com/erwins-enkel/shepherd/issues/693)) ([#700](https://github.com/erwins-enkel/shepherd/issues/700)) ([07ff6b6](https://github.com/erwins-enkel/shepherd/commit/07ff6b6380944aa64e489fa5117a3ef0d3593213))


### Bug Fixes

* **automation-panel:** centered modal sheet + blurred scrim on touch ([#695](https://github.com/erwins-enkel/shepherd/issues/695)) ([abed809](https://github.com/erwins-enkel/shepherd/commit/abed80992ffb08e95e0d0d4e3c559e368c232e58))
* **backlog:** pin search fields flush so list doesn't bleed above them ([#717](https://github.com/erwins-enkel/shepherd/issues/717)) ([5cb2f13](https://github.com/erwins-enkel/shepherd/commit/5cb2f13609e0d06d668d919958605e25882fac68))
* **newtask:** ticking Research also unticks Autopilot to PR ([#702](https://github.com/erwins-enkel/shepherd/issues/702)) ([0da705c](https://github.com/erwins-enkel/shepherd/commit/0da705c141da44aa7eb8b63f2a4af25ce1cda454))
* **onboarding-harness:** clear git-missing + herdr-missing nightly harness errors ([#732](https://github.com/erwins-enkel/shepherd/issues/732)) ([1df8dc6](https://github.com/erwins-enkel/shepherd/commit/1df8dc6acf3ffbb93c826828b66e4f0d8e5c8719))
* **onboarding-harness:** green git-missing via cross-distro git remediation ([#735](https://github.com/erwins-enkel/shepherd/issues/735)) ([240c709](https://github.com/erwins-enkel/shepherd/commit/240c709d77deee681a64d4701e68374af4c2d1df))
* **repos:** use Shepherd's own repo as fork placeholder example ([#694](https://github.com/erwins-enkel/shepherd/issues/694)) ([9a91321](https://github.com/erwins-enkel/shepherd/commit/9a9132170195a343b688d322cf9d7be4042592fb))
* **rundown:** make ☰ RUNDOWN button toggle the lens off on re-click ([#729](https://github.com/erwins-enkel/shepherd/issues/729)) ([97726a5](https://github.com/erwins-enkel/shepherd/commit/97726a51df0befa388ce2cf66c688ca8291da96b))
* **settings:** show theme, contrast & about metadata on desktop too ([#705](https://github.com/erwins-enkel/shepherd/issues/705)) ([7cea13d](https://github.com/erwins-enkel/shepherd/commit/7cea13d7ec6715e0e8dbd1f540cf2b8fad942e47))
* **tab-reaper:** husk detection + worktree GC under herdr 0.7 pane-persistence ([#721](https://github.com/erwins-enkel/shepherd/issues/721)) ([#726](https://github.com/erwins-enkel/shepherd/issues/726)) ([abe66f2](https://github.com/erwins-enkel/shepherd/commit/abe66f24eba1e52427a61992ff189f03d6f48b4b))
* **ui:** drop THE HERD label on mobile; move rundown next to settings cog ([#722](https://github.com/erwins-enkel/shepherd/issues/722)) ([375f51b](https://github.com/erwins-enkel/shepherd/commit/375f51ba629de587322968e108bc08dc510f0494))
* **whatsnew:** lock background scroll so the drawer doesn't scroll the page ([#728](https://github.com/erwins-enkel/shepherd/issues/728)) ([8c21126](https://github.com/erwins-enkel/shepherd/commit/8c211263fdd81beae0ef61a012f3d4875b2a4d9b))


### Code Refactoring

* **tab-reaper:** retire herdr-0.6 fallback + positional-id machinery ([#714](https://github.com/erwins-enkel/shepherd/issues/714)) ([#731](https://github.com/erwins-enkel/shepherd/issues/731)) ([504933d](https://github.com/erwins-enkel/shepherd/commit/504933d9f7919b60c072aada3243c51ae52064c9))


### Documentation

* **merge-train:** never move home-base HEAD; rebase in scratch worktree ([#716](https://github.com/erwins-enkel/shepherd/issues/716)) ([f55a1ae](https://github.com/erwins-enkel/shepherd/commit/f55a1ae84647b4a17cd2ad9221358f1b494876c2))
* **research:** expanded Claude Code hooks for richer agent info ingestion ([#701](https://github.com/erwins-enkel/shepherd/issues/701)) ([845010f](https://github.com/erwins-enkel/shepherd/commit/845010ff5e78d7e107eabc5af533aae5628ea540))
* **research:** installer investigation — reuse diagnostics/remediation layer ([#699](https://github.com/erwins-enkel/shepherd/issues/699)) ([4690adb](https://github.com/erwins-enkel/shepherd/commit/4690adbfd117241cd0753972505e3a2355a63325))
* **research:** mobile PWA header/nav study for iPhone 14 [no-feature-entry] ([#719](https://github.com/erwins-enkel/shepherd/issues/719)) ([850449f](https://github.com/erwins-enkel/shepherd/commit/850449fbcc0461cc4f96a8dd22382c5fd6dfe335))
* **tab-reaper:** correct positional-id comments for herdr 0.7 stable ids + add 0.7-id reap test ([#715](https://github.com/erwins-enkel/shepherd/issues/715)) ([c4d15af](https://github.com/erwins-enkel/shepherd/commit/c4d15afd046013d0a8d7c0390adfc6f659dbadce))

## [1.31.0](https://github.com/erwins-enkel/shepherd/compare/v1.30.0...v1.31.0) (2026-06-14)


### Features

* **backlog:** link repo name to its forge in detail-pane headers ([#691](https://github.com/erwins-enkel/shepherd/issues/691)) ([b1cce28](https://github.com/erwins-enkel/shepherd/commit/b1cce286d585e3957c404052e2598a41d76120e4))
* **glossary:** inline term tooltips for UI jargon (internal + Wikipedia) ([#683](https://github.com/erwins-enkel/shepherd/issues/683)) ([112ed56](https://github.com/erwins-enkel/shepherd/commit/112ed5601d91e4e63c8a4a023990a22ba38d4810))
* **newproject:** let users pick the GitHub owner (personal or org) ([#690](https://github.com/erwins-enkel/shepherd/issues/690)) ([50d104a](https://github.com/erwins-enkel/shepherd/commit/50d104a2376d27c16f55533f12f5a32a0f8c2ffe))
* **repos:** add "Fork a GitHub repo" with upstream-aware forge ([#687](https://github.com/erwins-enkel/shepherd/issues/687)) ([9e0fd4f](https://github.com/erwins-enkel/shepherd/commit/9e0fd4f81a8412c029ef67543466bd236ed24f36))


### Bug Fixes

* **merge-train:** launch driver with autopilot off regardless of repo default ([#686](https://github.com/erwins-enkel/shepherd/issues/686)) ([5e9d105](https://github.com/erwins-enkel/shepherd/commit/5e9d105b76e0685dfdd4057cd3520ba0b55b4e6f))
* **merge-train:** server-derived participant marking that doesn't lose the status marker ([#689](https://github.com/erwins-enkel/shepherd/issues/689)) ([c37f018](https://github.com/erwins-enkel/shepherd/commit/c37f018cd8769d0ba9338ca00b1580346c411aa1))
* **onboarding-harness:** classify pre-detection throws as HARNESS ERROR, not detection gaps ([#684](https://github.com/erwins-enkel/shepherd/issues/684)) ([bc4c91a](https://github.com/erwins-enkel/shepherd/commit/bc4c91a1e5a0ab9da929d01b632221b15155d611))


### Documentation

* **research:** effort/maturity analysis + open-source launch plan ([#688](https://github.com/erwins-enkel/shepherd/issues/688)) ([0a0aa82](https://github.com/erwins-enkel/shepherd/commit/0a0aa8249b2194db56306cf59687297fe3df6715))

## [1.30.0](https://github.com/erwins-enkel/shepherd/compare/v1.29.0...v1.30.0) (2026-06-14)


### Features

* **auth:** ship API-key auth mode (footing B) as a first-class opt-in ([#660](https://github.com/erwins-enkel/shepherd/issues/660)) ([#664](https://github.com/erwins-enkel/shepherd/issues/664)) ([f79796b](https://github.com/erwins-enkel/shepherd/commit/f79796b5df17868f465b81ecf8f63028dba05c44))
* **auth:** verify-key step for api-key auth ([#671](https://github.com/erwins-enkel/shepherd/issues/671)) ([#681](https://github.com/erwins-enkel/shepherd/issues/681)) ([5002aff](https://github.com/erwins-enkel/shepherd/commit/5002affd894bcc34ddc892eeb831439b07449f41))
* **epic:** epic-branch guardrails + migration checkpoint — close out [#645](https://github.com/erwins-enkel/shepherd/issues/645) learnings ([#677](https://github.com/erwins-enkel/shepherd/issues/677)) ([59673e2](https://github.com/erwins-enkel/shepherd/commit/59673e2a98fdc3ec400db532c37b6dae6b50b0eb))
* **epic:** land the epic via a final epic/#→default PR ([#635](https://github.com/erwins-enkel/shepherd/issues/635)) ([#661](https://github.com/erwins-enkel/shepherd/issues/661)) ([ee33482](https://github.com/erwins-enkel/shepherd/commit/ee334822f59dc663198d08b8dbae5fa14120bf76))
* **onboarding-harness:** commit status + release gate (CI traceability) ([#672](https://github.com/erwins-enkel/shepherd/issues/672)) ([147d0cb](https://github.com/erwins-enkel/shepherd/commit/147d0cb42674ce129f961943455127980c1f96f0))
* **onboarding-harness:** file a rolling GitHub issue on nightly regressions ([#670](https://github.com/erwins-enkel/shepherd/issues/670)) ([7ddef15](https://github.com/erwins-enkel/shepherd/commit/7ddef150f3826fce2e3dd36ee11f39f87b935aa8))
* **readiness:** PM-aware install commands in the prescription ([#675](https://github.com/erwins-enkel/shepherd/issues/675)) ([bbe8827](https://github.com/erwins-enkel/shepherd/commit/bbe88277fcaded4d56bfbebe641071d24878064a))
* **recap:** durable session recap + in-app Done lens ([#665](https://github.com/erwins-enkel/shepherd/issues/665)) ([e00b1b3](https://github.com/erwins-enkel/shepherd/commit/e00b1b3727ad1ae099fc6f926f2c0daf2277fbcf))
* **ui:** add version + README/docs link to the mobile gear menu ([#676](https://github.com/erwins-enkel/shepherd/issues/676)) ([ec29f40](https://github.com/erwins-enkel/shepherd/commit/ec29f40c14c5149d37a24303dd5e034d1723e2b1))
* **ui:** detect PWA install state in Diagnostics, nudge mobile users to install ([#662](https://github.com/erwins-enkel/shepherd/issues/662)) ([#667](https://github.com/erwins-enkel/shepherd/issues/667)) ([9018bf3](https://github.com/erwins-enkel/shepherd/commit/9018bf3f2df3cbc5876b8e14948088960dc2d8ed))
* **ui:** make Claude's suggested slash commands tappable in the terminal ([#680](https://github.com/erwins-enkel/shepherd/issues/680)) ([c736c6c](https://github.com/erwins-enkel/shepherd/commit/c736c6cb75506ac750977bbfc1292513a6601b93))
* **ui:** surface theme & contrast in the mobile gear menu ([#658](https://github.com/erwins-enkel/shepherd/issues/658)) ([18bd693](https://github.com/erwins-enkel/shepherd/commit/18bd6931c2223856c6b5af1658123c1c0beac7e0))


### Bug Fixes

* **onboarding-harness:** make the harness actually run end-to-end ([#663](https://github.com/erwins-enkel/shepherd/issues/663)) ([0fff07e](https://github.com/erwins-enkel/shepherd/commit/0fff07e25d21085adb5279dca1a76a119193e734))
* **onboarding-harness:** make the release gate fresh-green + deterministic-scoped ([#674](https://github.com/erwins-enkel/shepherd/issues/674)) ([6940127](https://github.com/erwins-enkel/shepherd/commit/694012780cebf158d0804cefe1669af147e64993))
* **plan-panel:** canonical top bar + full-bleed sheet on mobile ([#679](https://github.com/erwins-enkel/shepherd/issues/679)) ([03ce5da](https://github.com/erwins-enkel/shepherd/commit/03ce5da8edd0154f30149bbd3e08549e01e04ac8))
* **recap:** explain why a finished session has no recap ([#682](https://github.com/erwins-enkel/shepherd/issues/682)) ([eea1f60](https://github.com/erwins-enkel/shepherd/commit/eea1f601115d0d5f5d27f15d752727484a9bcfac))
* **ui:** full-bleed terminal view on phones, drop side borders ([#659](https://github.com/erwins-enkel/shepherd/issues/659)) ([1a34294](https://github.com/erwins-enkel/shepherd/commit/1a3429443f8f11e51cffada8daf5f84964ff1f9d))
* **ui:** merge REPO label into New Task head row on mobile ([#653](https://github.com/erwins-enkel/shepherd/issues/653)) ([6be9312](https://github.com/erwins-enkel/shepherd/commit/6be9312c51e1eff3690896b7ad42915ac92103f1))
* **viewport:** windowed fling velocity for smoother mobile terminal scroll ([#655](https://github.com/erwins-enkel/shepherd/issues/655)) ([730fa5d](https://github.com/erwins-enkel/shepherd/commit/730fa5def14c04b48bcde9a72e32df1922dbe986))
* Zeit-Popover stops claiming 'Du bist dran!' while a PR awaits the merger ([#539](https://github.com/erwins-enkel/shepherd/issues/539)) ([#650](https://github.com/erwins-enkel/shepherd/issues/650)) ([5301ae0](https://github.com/erwins-enkel/shepherd/commit/5301ae09efbf6f668ead6b9b050f67cc5fca09c0))


### Documentation

* de-stale egress "not yet implemented" claims ([#601](https://github.com/erwins-enkel/shepherd/issues/601) shipped [#551](https://github.com/erwins-enkel/shepherd/issues/551)) ([#652](https://github.com/erwins-enkel/shepherd/issues/652)) ([affff31](https://github.com/erwins-enkel/shepherd/commit/affff31122ee016fb2b262ddf236c36097ea5250))
* **research:** claude/anthropic tos compliance audit of shepherd ([#646](https://github.com/erwins-enkel/shepherd/issues/646)) ([19ef801](https://github.com/erwins-enkel/shepherd/commit/19ef801c0ff8299c53d34ac67d1c0cf0b1cd43ac))
* **sandbox:** close audit R3/R4 residuals — document in-membrane token readability + attended/research egress posture ([#648](https://github.com/erwins-enkel/shepherd/issues/648)) ([#654](https://github.com/erwins-enkel/shepherd/issues/654)) ([ce6a450](https://github.com/erwins-enkel/shepherd/commit/ce6a4501258905dfa9eade68d8f5543d76d89a62))
* **tos:** frame interactive-puppeting as position; offer sanctioned auth path (R1, [#647](https://github.com/erwins-enkel/shepherd/issues/647)) ([#657](https://github.com/erwins-enkel/shepherd/issues/657)) ([1e63204](https://github.com/erwins-enkel/shepherd/commit/1e63204ee27087a63368abda8653f3d4cc3c13e6))

## [1.29.0](https://github.com/erwins-enkel/shepherd/compare/v1.28.0...v1.29.0) (2026-06-13)


### Features

* integrated-epics band — finished epics stop vanishing ([#642](https://github.com/erwins-enkel/shepherd/issues/642)) ([ef65503](https://github.com/erwins-enkel/shepherd/commit/ef65503e3567608479c5485b9682d9e11d73b575))
* **onboarding-harness:** Incus-based onboarding challenge & regression framework ([#644](https://github.com/erwins-enkel/shepherd/issues/644)) ([40f2b50](https://github.com/erwins-enkel/shepherd/commit/40f2b50f0e703d4a6a30066cd85edfdb80bdbd7e))
* **recap:** session recap card — LLM merge-decision summary at the bottom of a finished task ([#640](https://github.com/erwins-enkel/shepherd/issues/640)) ([67c7228](https://github.com/erwins-enkel/shepherd/commit/67c7228c801ee7e52ccf4b0e44874f34aead2d66))
* **research:** attended research task kind (web research → report PR or issue) ([#297](https://github.com/erwins-enkel/shepherd/issues/297), F9) ([#637](https://github.com/erwins-enkel/shepherd/issues/637)) ([ef27e9b](https://github.com/erwins-enkel/shepherd/commit/ef27e9bf1ad7b2261b16352fc5ed630be2c4f130))
* **ui:** opt-in colourblind status markers, hidden by default ([#641](https://github.com/erwins-enkel/shepherd/issues/641)) ([3ddff48](https://github.com/erwins-enkel/shepherd/commit/3ddff48cc593c1a5479fd063b56899f2115fd101))


### Bug Fixes

* **autopilot:** stand down CI-fix loop while a session is in a merge train ([#643](https://github.com/erwins-enkel/shepherd/issues/643)) ([871f09e](https://github.com/erwins-enkel/shepherd/commit/871f09e35b50942783354a6f0c98e781a6e5a965))
* **diagnostics:** accurate Tailscale check — detect Service-fronted HUD, fix copy ([#634](https://github.com/erwins-enkel/shepherd/issues/634)) ([3a07940](https://github.com/erwins-enkel/shepherd/commit/3a0794007307d21be5ab5c1ea50a6aa8ac84d399))
* **merge-train:** confirm before launching a merge train ([#632](https://github.com/erwins-enkel/shepherd/issues/632)) ([d3254c3](https://github.com/erwins-enkel/shepherd/commit/d3254c3ece91b8318730621b40c9e9da443161da))
* **plan-gate:** unique per-run reviewer worktree path; GC stale review worktrees ([#631](https://github.com/erwins-enkel/shepherd/issues/631)) ([#638](https://github.com/erwins-enkel/shepherd/issues/638)) ([d04fad6](https://github.com/erwins-enkel/shepherd/commit/d04fad6d852218350146c0c8b6ad9c7e8030500b))
* **steers:** expand the focused steer to a full-width edit mode ([#639](https://github.com/erwins-enkel/shepherd/issues/639)) ([cc7c106](https://github.com/erwins-enkel/shepherd/commit/cc7c1064a8b916b8be903e15c67f3325ce3151cd))
* **ui:** drop redundant PR merged/closed badge when Stepper shows terminal chip ([#633](https://github.com/erwins-enkel/shepherd/issues/633)) ([6c4b5ea](https://github.com/erwins-enkel/shepherd/commit/6c4b5eaec6d539286229c00ff7841a264edc7d45))

## [1.28.0](https://github.com/erwins-enkel/shepherd/compare/v1.27.0...v1.28.0) (2026-06-13)


### Features

* **backlog:** show PR target branch when it isn't the repo default ([#610](https://github.com/erwins-enkel/shepherd/issues/610)) ([c76ecf2](https://github.com/erwins-enkel/shepherd/commit/c76ecf28fa52f8c87a9bcda86a1428c5b63e802c))
* **critic:** extended thinking budget for the PR critics ([#604](https://github.com/erwins-enkel/shepherd/issues/604)) ([#624](https://github.com/erwins-enkel/shepherd/issues/624)) ([11f0d57](https://github.com/erwins-enkel/shepherd/commit/11f0d57c1418ce7e236c37f8df3997950600df26))
* **critic:** informational-only latent-defect lens ([#599](https://github.com/erwins-enkel/shepherd/issues/599)) ([ce195af](https://github.com/erwins-enkel/shepherd/commit/ce195af46bbf598fefff8d4b4439e8fb92311012))
* **critic:** standalone repo-level PR critic for Seer-style every-PR coverage ([#596](https://github.com/erwins-enkel/shepherd/issues/596)) ([#612](https://github.com/erwins-enkel/shepherd/issues/612)) ([7d7a9fd](https://github.com/erwins-enkel/shepherd/commit/7d7a9fde86023636044dbaead557327e731d49d8))
* **diagnostics:** environment readiness diagnostics + health indicator + onboarding ([#626](https://github.com/erwins-enkel/shepherd/issues/626)) ([7cea58a](https://github.com/erwins-enkel/shepherd/commit/7cea58ab94f57e947770e3c5c7d82a1931c238fd))
* **epic:** land epics in one piece — integration branch + done-on-merge gate (Stage A) ([#618](https://github.com/erwins-enkel/shepherd/issues/618)) ([c9d1790](https://github.com/erwins-enkel/shepherd/commit/c9d17905d669a14549a1cb886f224380702e6842))
* **epic:** ordered, DAG-aware GitHub-issue queues (Epic Runner) ([#571](https://github.com/erwins-enkel/shepherd/issues/571)) ([7956a4b](https://github.com/erwins-enkel/shepherd/commit/7956a4bdf6f888b9067c6168934893dd6089bfca))
* **model:** per-repo default-model override ([#620](https://github.com/erwins-enkel/shepherd/issues/620)) ([bad91e9](https://github.com/erwins-enkel/shepherd/commit/bad91e9eac52dfa37d9dd731cabc85b344a24f21))
* **readiness:** bun-aware Dependabot config + dependency-automation guardrail ([#602](https://github.com/erwins-enkel/shepherd/issues/602)) ([b67f899](https://github.com/erwins-enkel/shepherd/commit/b67f8994ffb570694615241da4311f0a752ea366))
* **sandbox:** network egress allowlist for autonomous agents ([#551](https://github.com/erwins-enkel/shepherd/issues/551)) ([#601](https://github.com/erwins-enkel/shepherd/issues/601)) ([c80b596](https://github.com/erwins-enkel/shepherd/commit/c80b5962aba5350a5f7916130fa4f5ff2d564d0b))
* **settings:** surface high-contrast toggle on mobile for sunlight readability ([#625](https://github.com/erwins-enkel/shepherd/issues/625)) ([f0352a7](https://github.com/erwins-enkel/shepherd/commit/f0352a7be2f6a0414703a93a567aa3e7d1cca56a))
* surface native GitHub sub-issues in the backlog issues selector ([#584](https://github.com/erwins-enkel/shepherd/issues/584)) ([fe1dd16](https://github.com/erwins-enkel/shepherd/commit/fe1dd165ec6c3fb121ad4fee59c9ea118346c712))
* **ui:** expand steer prompt field on focus + slash-command picker ([#619](https://github.com/erwins-enkel/shepherd/issues/619)) ([dd13e16](https://github.com/erwins-enkel/shepherd/commit/dd13e1614719d3cc78b3bb6b934b15bcf8559d36))
* **ui:** group epic sub-issue sessions under an EPIC headline ([#613](https://github.com/erwins-enkel/shepherd/issues/613)) ([f969806](https://github.com/erwins-enkel/shepherd/commit/f969806b9dd0dbcad6c7c906ab4db01970fc58f7))
* **ui:** make epic-seeded sessions discoverable with an EPIC progress badge ([#585](https://github.com/erwins-enkel/shepherd/issues/585)) ([7f54b36](https://github.com/erwins-enkel/shepherd/commit/7f54b36b4c39b9d5f76c3eb5a87c6b84b7dad868))
* **usage:** surface paid extra-credit overage (gauge, alert, drain guard, push) ([#622](https://github.com/erwins-enkel/shepherd/issues/622)) ([c08dc21](https://github.com/erwins-enkel/shepherd/commit/c08dc217c7db56068bcc3534cc457c3ca6a38707))


### Bug Fixes

* **autopilot:** re-engage idle full-auto sessions stuck on red CI ([#611](https://github.com/erwins-enkel/shepherd/issues/611)) ([a59c3bb](https://github.com/erwins-enkel/shepherd/commit/a59c3bb2f39378eea468b47e6e20ffc466fcd987))
* **backlog:** keep repo name readable with compact numbers-only counts ([#605](https://github.com/erwins-enkel/shepherd/issues/605)) ([d231359](https://github.com/erwins-enkel/shepherd/commit/d2313595c94e16f69a566a3b49d4ae1cc543a21c))
* **backlog:** pin icon replaces PINNED text pill so repo name fits ([#590](https://github.com/erwins-enkel/shepherd/issues/590)) ([f23b8ec](https://github.com/erwins-enkel/shepherd/commit/f23b8ec90d6ba2ac00ebf2583b1770864705ffab))
* **backlog:** two-row repo filter bar so "Filter repos…" stops truncating ([#572](https://github.com/erwins-enkel/shepherd/issues/572)) ([ba2f4f6](https://github.com/erwins-enkel/shepherd/commit/ba2f4f66840eed6448be2933925593c85d5bbc08))
* **ci-runner:** self-heal watchdog restarts dead rootless-docker egress ([#589](https://github.com/erwins-enkel/shepherd/issues/589)) ([eb5f2a8](https://github.com/erwins-enkel/shepherd/commit/eb5f2a83c817447ef407e7d0e2ed910e64193519))
* **ci:** correct release-please CI framing; skip verify/hygiene on its PR ([#587](https://github.com/erwins-enkel/shepherd/issues/587)) ([472de11](https://github.com/erwins-enkel/shepherd/commit/472de11f98a4d54dfaa1d132701a2e3b21bc99b0))
* **criticbadge:** compact streak label replaces wide composite suffix ([#577](https://github.com/erwins-enkel/shepherd/issues/577)) ([473f370](https://github.com/erwins-enkel/shepherd/commit/473f37076ad581a4e618e31fd1c48a23ebc61876))
* **critic:** verify against code, cite file:line, not plausibility ([#597](https://github.com/erwins-enkel/shepherd/issues/597)) ([#603](https://github.com/erwins-enkel/shepherd/issues/603)) ([11e0ab3](https://github.com/erwins-enkel/shepherd/commit/11e0ab3d655d95a260d6da7fbfac55350d74c882))
* **epic:** guard all manual-spawn paths against epic-parent issues ([#609](https://github.com/erwins-enkel/shepherd/issues/609)) ([b1795df](https://github.com/erwins-enkel/shepherd/commit/b1795dfed5b3685b6b4feb6a91303755156fbfc6))
* **herd:** move collapse control to a slim right-edge tab so it stops wrapping ([#579](https://github.com/erwins-enkel/shepherd/issues/579)) ([5adbb84](https://github.com/erwins-enkel/shepherd/commit/5adbb847d73d694c9c02443ce46e070521f59809))
* **herd:** order ready-to-merge before merging in the rail ([#598](https://github.com/erwins-enkel/shepherd/issues/598)) ([e6920bb](https://github.com/erwins-enkel/shepherd/commit/e6920bb50a542f8f0024dd0b1789a131eb969812))
* **herd:** pin card clock top-right + free the badge rail in the desktop sidebar ([#582](https://github.com/erwins-enkel/shepherd/issues/582)) ([ee6d946](https://github.com/erwins-enkel/shepherd/commit/ee6d946e1c99e9a5de85e7bb120e1426d10c040b))
* **newtask:** two-row run-settings layout so plan-gate explainer reads on one line ([#593](https://github.com/erwins-enkel/shepherd/issues/593)) ([7fd3187](https://github.com/erwins-enkel/shepherd/commit/7fd3187f3bdd56bc988ed46a89b5f197e706e2aa))
* **plan-gate:** re-adopt in-flight plan reviews orphaned by a restart ([#630](https://github.com/erwins-enkel/shepherd/issues/630)) ([ff78480](https://github.com/erwins-enkel/shepherd/commit/ff78480061ea0bc0afbba9c8886f4dc902a11bfa))
* **relaunch:** show carried image in relaunch-elsewhere composer (no double, no loss) ([#583](https://github.com/erwins-enkel/shepherd/issues/583)) ([3152b1e](https://github.com/erwins-enkel/shepherd/commit/3152b1e32d94865a22049a7ec1a65d0b8760e936))
* **review:** center the verdict popover as a modal sheet on touch + add modal focus semantics ([#586](https://github.com/erwins-enkel/shepherd/issues/586)) ([f665376](https://github.com/erwins-enkel/shepherd/commit/f66537673298a881936902da47fbe62e4ec86887))
* **review:** scope the PR critic to the PR's own diff against a fresh base ([#573](https://github.com/erwins-enkel/shepherd/issues/573)) ([6a17799](https://github.com/erwins-enkel/shepherd/commit/6a1779951838c1bc4c2c20aac11771efe26fe446))
* **review:** stop spawned reviewers hanging on the .mcp.json MCP-approval gate (+ issue context) ([#600](https://github.com/erwins-enkel/shepherd/issues/600)) ([cf8545f](https://github.com/erwins-enkel/shepherd/commit/cf8545f8335cb84358fcfb71228fa7c3513d5bb7))
* **toasts:** visual auto-dismiss countdown for timed info toasts ([#578](https://github.com/erwins-enkel/shepherd/issues/578)) ([6168829](https://github.com/erwins-enkel/shepherd/commit/6168829d1019812791c1224332b7ff0456d1d0be))
* **ui:** epic header overflow on the unfolded-foldable sidebar ([#629](https://github.com/erwins-enkel/shepherd/issues/629)) ([9da3132](https://github.com/erwins-enkel/shepherd/commit/9da3132ca66aa24e4e5f8585ffa5f89cbdbd8b09))
* **ui:** inherit repo plan-gate when composer box untouched ([#616](https://github.com/erwins-enkel/shepherd/issues/616)) ([e530f6c](https://github.com/erwins-enkel/shepherd/commit/e530f6cdd5b62092aeaf56d60ab3f0515c90e604))
* **ui:** one pulse for in-progress + cohesive amber streak badge ([#594](https://github.com/erwins-enkel/shepherd/issues/594)) ([c014a43](https://github.com/erwins-enkel/shepherd/commit/c014a43d047c609ee215b4651866b9ffd5d6331e))
* **ui:** portal plan-gate popover to body so it escapes the swipe row's transform ([#628](https://github.com/erwins-enkel/shepherd/issues/628)) ([9a36e68](https://github.com/erwins-enkel/shepherd/commit/9a36e68fe53842c18f092071d5484d0a30d09133))
* **ui:** right-align the redraw menu under its trigger ([#617](https://github.com/erwins-enkel/shepherd/issues/617)) ([cc2a9fe](https://github.com/erwins-enkel/shepherd/commit/cc2a9fef2239ab9dbd091bc7803c1daf4c2e926a))
* **ui:** suppress 1Password autofill icon on free-text textareas ([#580](https://github.com/erwins-enkel/shepherd/issues/580)) ([69ac75c](https://github.com/erwins-enkel/shepherd/commit/69ac75c2d29968799a7135c8894169b3cee04394))
* **viewport:** full-width rename editor with explicit cancel/confirm buttons ([#588](https://github.com/erwins-enkel/shepherd/issues/588)) ([27779c3](https://github.com/erwins-enkel/shepherd/commit/27779c3e22cd03771483db283f181e11c9b27310))
* **viewport:** rename input takes the title's slot in place; drop pencil button ([#581](https://github.com/erwins-enkel/shepherd/issues/581)) ([6cf5a3f](https://github.com/erwins-enkel/shepherd/commit/6cf5a3f388bb1ab1779ff0b444228f05f522ce22))
* **viewport:** shorten mobile autopilot pill to AP ON ([#575](https://github.com/erwins-enkel/shepherd/issues/575)) ([b69b097](https://github.com/erwins-enkel/shepherd/commit/b69b09738edf2bdbde3319409d268d403983a2d1))
* **viewport:** shrink compact strip decommission to icon-only ✕ ([#615](https://github.com/erwins-enkel/shepherd/issues/615)) ([71f494e](https://github.com/erwins-enkel/shepherd/commit/71f494e99bd8316cffe29afbb548ec3df724165e))
* **viewport:** smooth mobile terminal scrolling + surface jump-to-bottom ([#621](https://github.com/erwins-enkel/shepherd/issues/621)) ([4d50669](https://github.com/erwins-enkel/shepherd/commit/4d50669b788c842a87d1cf363e5fd56d1c338533))


### Code Refactoring

* **automation:** move lengthy sandbox explanation behind a tap-to-open ⓘ ([#614](https://github.com/erwins-enkel/shepherd/issues/614)) ([53e232d](https://github.com/erwins-enkel/shepherd/commit/53e232d9260bc11e4e4aa2ed1065cc24dc9711bb))
* **pr-badge:** drop NO PR pill; none state renders nothing ([#592](https://github.com/erwins-enkel/shepherd/issues/592)) ([d2b05eb](https://github.com/erwins-enkel/shepherd/commit/d2b05ebbb7c5d33bcb5a0859eda3a53e7f97fdd0))

## [1.27.0](https://github.com/erwins-enkel/shepherd/compare/v1.26.0...v1.27.0) (2026-06-12)


### Features

* **relaunch:** relaunch a task into a different repo ([#563](https://github.com/erwins-enkel/shepherd/issues/563)) ([28c13ea](https://github.com/erwins-enkel/shepherd/commit/28c13ea3ab1fd5fd206a0329e6451717389c2912))
* **steerbar:** Edit-steers pencil fills the slot when ABC is hidden ([#568](https://github.com/erwins-enkel/shepherd/issues/568)) ([54b80ef](https://github.com/erwins-enkel/shepherd/commit/54b80efd7e2a4d7f09933d58ee50074f0c01ec60))
* **viewport:** rename session by double-tapping the header title ([#569](https://github.com/erwins-enkel/shepherd/issues/569)) ([d5eb333](https://github.com/erwins-enkel/shepherd/commit/d5eb33383064f0114731428657a8c5e7bf7a0cf9))


### Bug Fixes

* **backlog:** subdue release/Dependabot PR badges, brighten code PR count ([#559](https://github.com/erwins-enkel/shepherd/issues/559)) ([cf1ef0f](https://github.com/erwins-enkel/shepherd/commit/cf1ef0f5fb590ad71d125352e3a9949d44b7b309))
* **gitrail:** explain why Merge is disabled + stop over-blocking on non-required checks ([#562](https://github.com/erwins-enkel/shepherd/issues/562)) ([3b39893](https://github.com/erwins-enkel/shepherd/commit/3b39893535d9af9136d0e705f906ee80294ec221))
* **herd:** drop badge rail to its own row in narrow sidebar ([#566](https://github.com/erwins-enkel/shepherd/issues/566)) ([fe14b3d](https://github.com/erwins-enkel/shepherd/commit/fe14b3dec918bcb0096e8b7a193edc8f1a4ab261))
* **hud:** address impeccable audit findings (a11y, perf, responsive, copy) ([#570](https://github.com/erwins-enkel/shepherd/issues/570)) ([43eedde](https://github.com/erwins-enkel/shepherd/commit/43eedde7ac2f959cc0e211eddf16c8448c5daeb8))
* **hud:** tighten HUD against its own design system (3 critique fixes) ([#567](https://github.com/erwins-enkel/shepherd/issues/567)) ([fdd399d](https://github.com/erwins-enkel/shepherd/commit/fdd399d8dc329f2f187c1ee1ef008b4e15c69b7c))
* **tmp:** bound /tmp tmpfs inode use from spawned agents ([#560](https://github.com/erwins-enkel/shepherd/issues/560)) ([#564](https://github.com/erwins-enkel/shepherd/issues/564)) ([11b54ea](https://github.com/erwins-enkel/shepherd/commit/11b54ea60e147cc7d6b464f0cad7947ec0b1a772))
* **whatsnew:** newest release first + mobile layout rework ([#558](https://github.com/erwins-enkel/shepherd/issues/558)) ([86cb083](https://github.com/erwins-enkel/shepherd/commit/86cb08361d28996435a8afe362ea55054437cbb0))


### Code Refactoring

* **ui:** set automation pill apart + drop redundant autopilot ON pip ([#565](https://github.com/erwins-enkel/shepherd/issues/565)) ([458ca0b](https://github.com/erwins-enkel/shepherd/commit/458ca0b5337fb22894a0ffa2f6a7f43741fc6328))

## [1.26.0](https://github.com/erwins-enkel/shepherd/compare/v1.25.0...v1.26.0) (2026-06-11)


### Features

* **backlog:** differentiate code PRs from Dependabot & release-please PRs ([#555](https://github.com/erwins-enkel/shepherd/issues/555)) ([cccc40d](https://github.com/erwins-enkel/shepherd/commit/cccc40d4529b52bc09a26fb90eb0a5c10703cf4a))
* **backlog:** type-to-filter search in the repo list filter bar ([#556](https://github.com/erwins-enkel/shepherd/issues/556)) ([0832bae](https://github.com/erwins-enkel/shepherd/commit/0832bae3eccb7a2cfdb25c64ab9cb499700de188))
* hide Shepherd's session artifacts — auto local git-exclude + opt-in committed .gitignore PR ([#535](https://github.com/erwins-enkel/shepherd/issues/535)) ([383abcc](https://github.com/erwins-enkel/shepherd/commit/383abcc0b2ad14b38d8e3ea3f5153b2c4d3457d6))
* **relaunch:** respawn a task with the same prompt + current settings ([#550](https://github.com/erwins-enkel/shepherd/issues/550)) ([7a2857e](https://github.com/erwins-enkel/shepherd/commit/7a2857e3ca0258af97db87ff00b76892c375845d))


### Bug Fixes

* **herd:** drop redundant repo-filter underline + keep filter alive at one repo ([#557](https://github.com/erwins-enkel/shepherd/issues/557)) ([62e9dfa](https://github.com/erwins-enkel/shepherd/commit/62e9dfac38544a2f7ded122839bf99e2d87e1394))
* **reposelect:** open dropdown with cursor on the selected repo, not the pinned one ([#548](https://github.com/erwins-enkel/shepherd/issues/548)) ([02edff5](https://github.com/erwins-enkel/shepherd/commit/02edff5b44990b064aaed0376157b61a980cb285))
* **steers:** keep delete button inline in saved-steers rows ([#553](https://github.com/erwins-enkel/shepherd/issues/553)) ([1fbfdb6](https://github.com/erwins-enkel/shepherd/commit/1fbfdb632369381e0f88e36c1cb88b91a6957c3b))
* **toasts:** restore draining countdown as full-width top bar on mobile ([#549](https://github.com/erwins-enkel/shepherd/issues/549)) ([98992c9](https://github.com/erwins-enkel/shepherd/commit/98992c9c0085aaa29602fe8e54d582fcf672725e))
* **viewport:** scope mobile page-swipe to the terminal body so the top action bar is reachable ([#552](https://github.com/erwins-enkel/shepherd/issues/552)) ([c4e08c3](https://github.com/erwins-enkel/shepherd/commit/c4e08c3a3851c8fc7b0c932a623635603674ceee))

## [1.25.0](https://github.com/erwins-enkel/shepherd/compare/v1.24.0...v1.25.0) (2026-06-11)


### Features

* **herdr-update:** link upstream release notes for multi-version jumps ([#542](https://github.com/erwins-enkel/shepherd/issues/542)) ([0d60b30](https://github.com/erwins-enkel/shepherd/commit/0d60b305d69a2d60a10e79a26eb7f7595476db47))
* **herd:** replace REPO STATUS band with a repo-filter chip rail ([#538](https://github.com/erwins-enkel/shepherd/issues/538)) ([5790b1c](https://github.com/erwins-enkel/shepherd/commit/5790b1ce5d12a1d50c7eb74fc4a0d6d5affea243))
* **issue-log:** post waiting/merged workflow comments on the backlog issue ([#541](https://github.com/erwins-enkel/shepherd/issues/541)) ([f727171](https://github.com/erwins-enkel/shepherd/commit/f727171a3cf8993a3519933491dd500ebe4ba25d))
* **ui:** collapsible herd sidebar on touch-primary wide devices ([#529](https://github.com/erwins-enkel/shepherd/issues/529)) ([471d7cf](https://github.com/erwins-enkel/shepherd/commit/471d7cf61dd496ab59c67d5365cfbefc3f8ffb87))
* **viewport:** redraw menu with squished-history repair variants ([#540](https://github.com/erwins-enkel/shepherd/issues/540)) ([49c74cb](https://github.com/erwins-enkel/shepherd/commit/49c74cb1e9f2491e81c7de958df1adc9817b965c))


### Bug Fixes

* **cards:** make REVIEWING / NEEDS YOU / WAITING badges mutually exclusive ([#532](https://github.com/erwins-enkel/shepherd/issues/532)) ([980619c](https://github.com/erwins-enkel/shepherd/commit/980619c6af824db95e515a4300950681066c78e8))
* **projects:** stop new-project route test from creating real GitHub repos ([#533](https://github.com/erwins-enkel/shepherd/issues/533)) ([e6b7637](https://github.com/erwins-enkel/shepherd/commit/e6b76376ef1df5960bb2b2461a6fabd15a7121f8))
* **queue-strip:** render repo-status filter as project-icon chips ([#528](https://github.com/erwins-enkel/shepherd/issues/528)) ([f8fa5a7](https://github.com/erwins-enkel/shepherd/commit/f8fa5a785e69fd39ad45c2c1aa1971644b0ef6b0))
* **steerbar:** show ABC labels toggle only when a label is collapsed ([#545](https://github.com/erwins-enkel/shepherd/issues/545)) ([58f59dd](https://github.com/erwins-enkel/shepherd/commit/58f59dd9047ce727d5db3fb338787aa781c72e73))
* **toasts:** full-width bottom banner with draining undo fill on phones ([#536](https://github.com/erwins-enkel/shepherd/issues/536)) ([d95b197](https://github.com/erwins-enkel/shepherd/commit/d95b1971dfae27a77a1336d7334de1d3f7bf1743))
* **ui:** clear read-only message when a mutation is blocked by preview origin ([#543](https://github.com/erwins-enkel/shepherd/issues/543)) ([fd05e55](https://github.com/erwins-enkel/shepherd/commit/fd05e55acbdf485e27e2b18807f9a03842132214))
* **ui:** drop side borders on mobile selected card and full-bleed the top bar ([#537](https://github.com/erwins-enkel/shepherd/issues/537)) ([032f842](https://github.com/erwins-enkel/shepherd/commit/032f8427d7f4d36023b242bb7c6aa27bf4b7be58))
* **ui:** scope session-card time popover to the wall-clock hover ([#531](https://github.com/erwins-enkel/shepherd/issues/531)) ([af46dd6](https://github.com/erwins-enkel/shepherd/commit/af46dd620402155961b0bdd9db96ec7bde26dba5))
* **viewport:** clarify keynav legend needs Alt from terminal ([#530](https://github.com/erwins-enkel/shepherd/issues/530)) ([dde9262](https://github.com/erwins-enkel/shepherd/commit/dde92623457439ede4c7842eff8773dd8b3e6ddb))
* **viewport:** keep mobile state-badge strip on one scrollable row ([#544](https://github.com/erwins-enkel/shepherd/issues/544)) ([54a6a9d](https://github.com/erwins-enkel/shepherd/commit/54a6a9dd465d91b15936c931e0d696aa98028538))

## [1.24.0](https://github.com/erwins-enkel/shepherd/compare/v1.23.0...v1.24.0) (2026-06-10)


### Features

* **critic:** bound per-streak review spawns + prove patch-id rebase-skip ([#501](https://github.com/erwins-enkel/shepherd/issues/501)) ([#517](https://github.com/erwins-enkel/shepherd/issues/517)) ([5b9c1c3](https://github.com/erwins-enkel/shepherd/commit/5b9c1c3281073257f9d80ba93175716c1008287a))
* persist reviewer/plan-gate session-ids + token totals for exact cost attribution ([#502](https://github.com/erwins-enkel/shepherd/issues/502)) ([#516](https://github.com/erwins-enkel/shepherd/issues/516)) ([6235892](https://github.com/erwins-enkel/shepherd/commit/6235892eebc0a98d82607c04ad2a99924c4bd10c))
* **projects:** create new project from Shepherd (git init + GitHub + PRD kickoff) ([#527](https://github.com/erwins-enkel/shepherd/issues/527)) ([2e14f68](https://github.com/erwins-enkel/shepherd/commit/2e14f6884cef295941cf04c5aca15c21c108da89))
* **spawn:** disable claude.ai connector MCP servers in agent spawns ([#515](https://github.com/erwins-enkel/shepherd/issues/515)) ([191eed8](https://github.com/erwins-enkel/shepherd/commit/191eed869a4934139f2fbb77df4981c2f1b12325)), closes [#509](https://github.com/erwins-enkel/shepherd/issues/509)
* **steers:** ABC toggle to reveal steer labels on the compact mobile bar ([#520](https://github.com/erwins-enkel/shepherd/issues/520)) ([e7f4431](https://github.com/erwins-enkel/shepherd/commit/e7f443152ad719e1d584b131d851857ac2563295))
* **ui:** detailed desktop usage-gauge hover card ([#523](https://github.com/erwins-enkel/shepherd/issues/523)) ([2a067e6](https://github.com/erwins-enkel/shepherd/commit/2a067e6e7ed171a6f3d8620b53c18bb1739d41e9))
* **ui:** time-breakdown hover popover on session cards ([#525](https://github.com/erwins-enkel/shepherd/issues/525)) ([0b958b2](https://github.com/erwins-enkel/shepherd/commit/0b958b2bdc46b550721f365241f9e3f0dd6e78a1))


### Bug Fixes

* **herd:** show the session's model on cards instead of the herdr session name ([#519](https://github.com/erwins-enkel/shepherd/issues/519)) ([60b9220](https://github.com/erwins-enkel/shepherd/commit/60b922033835ba9758bb7d8927c43ac7b99c3469))
* **topbar:** idle gear opens settings directly instead of a one-item menu ([#514](https://github.com/erwins-enkel/shepherd/issues/514)) ([51cc2fa](https://github.com/erwins-enkel/shepherd/commit/51cc2fa61e54d73b3678497569e5691487929158))
* **usage:** correct cache-write churn diagnostic — FullRecache + CacheWcost% ([#500](https://github.com/erwins-enkel/shepherd/issues/500)) ([#522](https://github.com/erwins-enkel/shepherd/issues/522)) ([18a9c19](https://github.com/erwins-enkel/shepherd/commit/18a9c19b6d0a738e4522fe8daa7962f96fa87afe))

## [1.23.0](https://github.com/erwins-enkel/shepherd/compare/v1.22.0...v1.23.0) (2026-06-10)


### Features

* **herd:** full-bleed session list on mobile ([#512](https://github.com/erwins-enkel/shepherd/issues/512)) ([07f31af](https://github.com/erwins-enkel/shepherd/commit/07f31af1faa902210a8c1ad7387cf2801befb10d))
* **herd:** inline repo emoji replaces repo line on session cards ([#493](https://github.com/erwins-enkel/shepherd/issues/493)) ([de613a3](https://github.com/erwins-enkel/shepherd/commit/de613a3ee80ea57e597cef693d6104519aa7d6f8))
* **keynav:** session switching that survives terminal focus ([#507](https://github.com/erwins-enkel/shepherd/issues/507)) ([eb43f0b](https://github.com/erwins-enkel/shepherd/commit/eb43f0ba76950b55a5b484a2ef0ae7dd47cc1e70))
* **model:** persistent operator-configurable default model ([#498](https://github.com/erwins-enkel/shepherd/issues/498)) ([721dc8c](https://github.com/erwins-enkel/shepherd/commit/721dc8ce810b2a1fd7cb5541d08a1d467c8152e2))
* **newtask:** plan-gate prominent neben kompaktem model-select auf desktop ([#487](https://github.com/erwins-enkel/shepherd/issues/487)) ([f581d1e](https://github.com/erwins-enkel/shepherd/commit/f581d1edb701eae604c6f1d6a7997d8a1a44ed5d))
* **preview:** demand the tailnet HTTPS URL in the dev-server start steer ([#494](https://github.com/erwins-enkel/shepherd/issues/494)) ([9bf5ee2](https://github.com/erwins-enkel/shepherd/commit/9bf5ee2984d98b6dbcce6215227203e8ce573e28))
* **preview:** opt-in idle-stop + force-stop to reclaim dev-server RAM ([#474](https://github.com/erwins-enkel/shepherd/issues/474)) ([947c411](https://github.com/erwins-enkel/shepherd/commit/947c41131510bafd5805eb631482e87de9ef2bbe))
* **push:** warn once per window when 5h usage crosses 80% ([#491](https://github.com/erwins-enkel/shepherd/issues/491)) ([fd59144](https://github.com/erwins-enkel/shepherd/commit/fd5914496bc758e511981cd0fdd21c73afcebd3c))
* **spawn:** strip skill catalog + plugins from auto-spawned agent context ([#499](https://github.com/erwins-enkel/shepherd/issues/499)) ([#510](https://github.com/erwins-enkel/shepherd/issues/510)) ([302084c](https://github.com/erwins-enkel/shepherd/commit/302084c172caceb3fc89afe0804013b1eb0c7f15))
* **steers:** issue actions unified with steers — emoji + space-adaptive labels ([#490](https://github.com/erwins-enkel/shepherd/issues/490)) ([7873fb0](https://github.com/erwins-enkel/shepherd/commit/7873fb0cf2e0916ff94c8ed1c4a10fc7c8d0ce4b))
* **stepper:** planning-aware stage bar with verdict tints + hover legend ([#505](https://github.com/erwins-enkel/shepherd/issues/505)) ([22cdc2a](https://github.com/erwins-enkel/shepherd/commit/22cdc2a0b9be23e23181a8680e3635a6b49e3646))
* **ui:** desktop decommission for non-ready sessions ([#506](https://github.com/erwins-enkel/shepherd/issues/506)) ([60eb8bf](https://github.com/erwins-enkel/shepherd/commit/60eb8bf27ec6e223f8b19cd5d663d401e83e78aa))
* **viewport:** repo emoji replaces repo name in phone terminal header ([#513](https://github.com/erwins-enkel/shepherd/issues/513)) ([8d2241a](https://github.com/erwins-enkel/shepherd/commit/8d2241a8e40b13b928fa206b7498fc212b2f3610))
* **viewport:** slim the header bar — icon-only controls, glyph status, Issues tab removed ([#484](https://github.com/erwins-enkel/shepherd/issues/484)) ([#497](https://github.com/erwins-enkel/shepherd/issues/497)) ([39d6014](https://github.com/erwins-enkel/shepherd/commit/39d601431e04ffb255a91042a461099cdada97b9))


### Bug Fixes

* stop false "needs you" badge + blocked display while the agent is actively working ([#511](https://github.com/erwins-enkel/shepherd/issues/511)) ([5028296](https://github.com/erwins-enkel/shepherd/commit/50282964714770fe12dea94aedd2bd13f7bfdfce))
* **theme:** replace font-dependent toggle glyphs with inline SVG icons ([#503](https://github.com/erwins-enkel/shepherd/issues/503)) ([e06d8b1](https://github.com/erwins-enkel/shepherd/commit/e06d8b1cbba3264aaf25e2c830497d83c4f4ba45))
* **toasts:** auto-dismiss update-main offer after 15s, pause on hover/focus ([#508](https://github.com/erwins-enkel/shepherd/issues/508)) ([48a66b3](https://github.com/erwins-enkel/shepherd/commit/48a66b3678c2340642cd242edfacb70b73f71782))
* **usage:** stop limit windows stealing values from truncated TUI frames ([#495](https://github.com/erwins-enkel/shepherd/issues/495)) ([2ceee15](https://github.com/erwins-enkel/shepherd/commit/2ceee1506bfc64f83c8bc2f37a0ab2b9531e258a))
* **viewport:** size mobile fold chevron up to icon scale ([#492](https://github.com/erwins-enkel/shepherd/issues/492)) ([8391a67](https://github.com/erwins-enkel/shepherd/commit/8391a67d68dcb2a131f96899865dd0bd155206c9))


### Documentation

* **readme:** drop stale tank/ directory note ([#489](https://github.com/erwins-enkel/shepherd/issues/489)) ([c07bdc1](https://github.com/erwins-enkel/shepherd/commit/c07bdc123ebb72b335cc6a12f2d85719ef964380))

## [1.22.0](https://github.com/erwins-enkel/shepherd/compare/v1.21.0...v1.22.0) (2026-06-09)


### Features

* **backlog:** add search field to filter the issues list ([#480](https://github.com/erwins-enkel/shepherd/issues/480)) ([24d5e23](https://github.com/erwins-enkel/shepherd/commit/24d5e23c2cd6a9fd5c4e1ce4ee02537ae9b8b298))
* **backlog:** pin the three most recently worked-on repos atop the repo list ([#479](https://github.com/erwins-enkel/shepherd/issues/479)) ([caa4981](https://github.com/erwins-enkel/shepherd/commit/caa4981ef912e2beaac0e34f81394c6a776f8da5))
* **hud:** design-critique fixes + herd keyboard navigation ([#485](https://github.com/erwins-enkel/shepherd/issues/485)) ([ed685e8](https://github.com/erwins-enkel/shepherd/commit/ed685e83e0777540cf8c7b53ac212b79f72044e8))
* **product:** lead with the two-pillar story — opinionated, best-practice mission control ([#486](https://github.com/erwins-enkel/shepherd/issues/486)) ([9c72965](https://github.com/erwins-enkel/shepherd/commit/9c7296575e701d09abfa42a79e2362fa3fb558a1))
* **topbar:** clickable tallies filter sessions by status ([#478](https://github.com/erwins-enkel/shepherd/issues/478)) ([1e16814](https://github.com/erwins-enkel/shepherd/commit/1e168146cda192d32def439943e6dcb746ebcbfb))
* **whats-new:** show release version and date per entry ([#472](https://github.com/erwins-enkel/shepherd/issues/472)) ([328e70d](https://github.com/erwins-enkel/shepherd/commit/328e70d974b4305f908bdb0285053e897a32a7ab))


### Bug Fixes

* **automation:** clamp popover height to space below its anchor ([#473](https://github.com/erwins-enkel/shepherd/issues/473)) ([07c2ce7](https://github.com/erwins-enkel/shepherd/commit/07c2ce7f1919369628f9ab0659cd3a8d7a07e507))
* **readiness:** detect JS/TS subprojects when package.json is not at the repo root ([#475](https://github.com/erwins-enkel/shepherd/issues/475)) ([5c8ada8](https://github.com/erwins-enkel/shepherd/commit/5c8ada89e35fde827cbddbd927a4280497662577))
* **repo-select:** make keyboard cursor visible in repo picker ([#477](https://github.com/erwins-enkel/shepherd/issues/477)) ([f337c6f](https://github.com/erwins-enkel/shepherd/commit/f337c6fb00ffb662d18eb1e1f3f68fdc0be820a4))
* **topbar:** enlarge gear icon and drop its border ([#476](https://github.com/erwins-enkel/shepherd/issues/476)) ([5e4f29f](https://github.com/erwins-enkel/shepherd/commit/5e4f29f12273aa4abf7da94779f84ffd49e2ec84))
* **ui:** hide the To-Do tab unless the repo has a TODO.md ([#471](https://github.com/erwins-enkel/shepherd/issues/471)) ([3740f6e](https://github.com/erwins-enkel/shepherd/commit/3740f6e2ba58fb6b25209ca55916eea6e6ab1328))
* **ui:** HUD UI audit fixes — light theme, mobile iOS, perf, design doctrine ([#481](https://github.com/erwins-enkel/shepherd/issues/481)) ([ef98a6a](https://github.com/erwins-enkel/shepherd/commit/ef98a6adc99804895a139a629dadc0c37d1c7dea))
* **viewport:** offer resume only when the claude process is actually gone ([#483](https://github.com/erwins-enkel/shepherd/issues/483)) ([3749a36](https://github.com/erwins-enkel/shepherd/commit/3749a36d569ec1b5f6321358f7e44ce92ab071d1))

## [1.21.0](https://github.com/erwins-enkel/shepherd/compare/v1.20.0...v1.21.0) (2026-06-09)


### Features

* **models:** add Claude Fable 5 with a launch celebration ([#466](https://github.com/erwins-enkel/shepherd/issues/466)) ([ff3db76](https://github.com/erwins-enkel/shepherd/commit/ff3db76ede8e7c420d407f24e5e309da7287067d))
* **preview:** dynamic tailscale serve registration for preview ports ([#403](https://github.com/erwins-enkel/shepherd/issues/403)) ([#463](https://github.com/erwins-enkel/shepherd/issues/463)) ([fc98f70](https://github.com/erwins-enkel/shepherd/commit/fc98f702588f638a40cb0951b1d88ed670f58d7e))
* **repo-select:** zuletzt bearbeitete Repos oben im Picker anheften ([#469](https://github.com/erwins-enkel/shepherd/issues/469)) ([c0bcf1e](https://github.com/erwins-enkel/shepherd/commit/c0bcf1e2539d438df2734d4a0a6bd6901aa93ef2))
* **ui:** highlight shepherd:active label in New Task issue list ([#457](https://github.com/erwins-enkel/shepherd/issues/457)) ([1a00619](https://github.com/erwins-enkel/shepherd/commit/1a00619ae024bfc5db0a1755b46c2b4b26968438))


### Bug Fixes

* **buildqueue:** bound queue list so touch-scroll isn't trapped on mobile ([#458](https://github.com/erwins-enkel/shepherd/issues/458)) ([99fe1e3](https://github.com/erwins-enkel/shepherd/commit/99fe1e3582586b13918fd690cdfb927f48fb7cb4))
* **newtask:** preselect the active repo filter when composing a task ([#467](https://github.com/erwins-enkel/shepherd/issues/467)) ([99775f2](https://github.com/erwins-enkel/shepherd/commit/99775f27633598520e328394ae2f92e0fa75befc))
* **queue-strip:** hide repo-status band when it carries no value; stop full-width stretch ([#468](https://github.com/erwins-enkel/shepherd/issues/468)) ([d5bf2a2](https://github.com/erwins-enkel/shepherd/commit/d5bf2a213d074e10f4c5cbc00e5bfe34aea916e9))
* **queue-strip:** show only repos with a running agent in the status band ([#459](https://github.com/erwins-enkel/shepherd/issues/459)) ([0937a34](https://github.com/erwins-enkel/shepherd/commit/0937a34c2b2d72012bd4c3e2a648b86284a70d4f))
* **ui:** make terminal jump-to-bottom button more prominent on desktop ([#460](https://github.com/erwins-enkel/shepherd/issues/460)) ([12a520f](https://github.com/erwins-enkel/shepherd/commit/12a520f1c341720bd7f6983e60be1efb0b72f940))
* **ui:** open the card menu on touch long-press ([#462](https://github.com/erwins-enkel/shepherd/issues/462)) ([3d19e01](https://github.com/erwins-enkel/shepherd/commit/3d19e01fcf00daad4437489e2754f44c483fbb24))
* **ui:** rename repo-row drain indicator from 'auto' to 'agents' ([#461](https://github.com/erwins-enkel/shepherd/issues/461)) ([dce083e](https://github.com/erwins-enkel/shepherd/commit/dce083e72d6d89dd99d0532e3e21719ae3f75b79))
* **ui:** scroll mobile viewport tabs, pin Start-dev-server control ([#465](https://github.com/erwins-enkel/shepherd/issues/465)) ([e8628f3](https://github.com/erwins-enkel/shepherd/commit/e8628f33ae0b9804972d5c0c006ceea9b270b6f4))

## [1.20.0](https://github.com/erwins-enkel/shepherd/compare/v1.19.0...v1.20.0) (2026-06-09)


### Features

* agent-declared `.shepherd-preview` port hint ([#397](https://github.com/erwins-enkel/shepherd/issues/397)) ([#448](https://github.com/erwins-enkel/shepherd/issues/448)) ([56609ee](https://github.com/erwins-enkel/shepherd/commit/56609ee484e20ba8fcc506ea521356a1e2ee8d46))
* **automation:** clickable ⓘ help with full explanation per function ([#438](https://github.com/erwins-enkel/shepherd/issues/438)) ([ff78853](https://github.com/erwins-enkel/shepherd/commit/ff788535eeedea5907418f282fda48b623ea4b43))
* draft-mode PRs held until sign-off (human / critic / either) ([#444](https://github.com/erwins-enkel/shepherd/issues/444)) ([a7d622c](https://github.com/erwins-enkel/shepherd/commit/a7d622c576812ade7bb4aae05a87fa6176080054))
* **herd:** per-repo reviewer/merger roles — "your turn" only when it really is ([#434](https://github.com/erwins-enkel/shepherd/issues/434)) ([6c51efc](https://github.com/erwins-enkel/shepherd/commit/6c51efce6b767085d228813e7635db1e3cf33af9))
* live app preview URL per agent ([#345](https://github.com/erwins-enkel/shepherd/issues/345)) ([#415](https://github.com/erwins-enkel/shepherd/issues/415)) ([e91663d](https://github.com/erwins-enkel/shepherd/commit/e91663dc6f8caa57ab9e404425d8dd0d08f61e7c))
* **merge-train:** offer local-checkout update after a merge-train run completes ([#439](https://github.com/erwins-enkel/shepherd/issues/439)) ([e9fd2d9](https://github.com/erwins-enkel/shepherd/commit/e9fd2d97d93a56061cec4495cc45522feeec0f68))
* offer to update local checkout after a PR merge ([#427](https://github.com/erwins-enkel/shepherd/issues/427)) ([935abc0](https://github.com/erwins-enkel/shepherd/commit/935abc0aba8e8b8f66c1643b154dbe86d535a7fd))
* **plan-gate:** planning agent asks questions actively, not parked in the plan ([#454](https://github.com/erwins-enkel/shepherd/issues/454)) ([224453b](https://github.com/erwins-enkel/shepherd/commit/224453bcd8171efabf88d808c41d02a9999e4c3e))
* **preview:** operator-triggered "Start dev server" from the HUD ([#446](https://github.com/erwins-enkel/shepherd/issues/446)) ([#453](https://github.com/erwins-enkel/shepherd/issues/453)) ([54c057a](https://github.com/erwins-enkel/shepherd/commit/54c057a6c7b7e3903eb3fd239375afb64ce85e11))
* split review cap into separate PR + plan review caps ([#404](https://github.com/erwins-enkel/shepherd/issues/404)) ([38127ea](https://github.com/erwins-enkel/shepherd/commit/38127ea3f815ca6cc5f184ede19f0a561204f106))
* **ui:** add ^U quick-tap shortcut to control palette ([#409](https://github.com/erwins-enkel/shepherd/issues/409)) ([e753b69](https://github.com/erwins-enkel/shepherd/commit/e753b69d42a4a2b42a1da67d0fc122966e8f7ea5))
* **ui:** foldable header on mobile to reclaim terminal space ([#416](https://github.com/erwins-enkel/shepherd/issues/416)) ([07cbd1b](https://github.com/erwins-enkel/shepherd/commit/07cbd1b023c5c6c0488a18298eeafc015b93334f))
* **ui:** highlight shepherd:active label in backlog issue list ([#440](https://github.com/erwins-enkel/shepherd/issues/440)) ([3d4ee34](https://github.com/erwins-enkel/shepherd/commit/3d4ee341c366bb7cd2ef2691c951598d674f0ecc))
* **ui:** launch a merge train from a backlog PR multi-selection ([#436](https://github.com/erwins-enkel/shepherd/issues/436)) ([11ccd0d](https://github.com/erwins-enkel/shepherd/commit/11ccd0dfb6c6c411681b0957ceeb29e0d506d01e))
* **ui:** nudge users to star Shepherd on GitHub after a few days ([#442](https://github.com/erwins-enkel/shepherd/issues/442)) ([4ca8d93](https://github.com/erwins-enkel/shepherd/commit/4ca8d93cd0ee75d9fa06803cc17bc4d8cd017395))
* **ui:** repo selector leads New Task form + named on submit ([#420](https://github.com/erwins-enkel/shepherd/issues/420)) ([010e459](https://github.com/erwins-enkel/shepherd/commit/010e459011ea12b8bd28e0d22f7df411e395f76a))
* **ui:** resume a parked session from a header button + card right-click ([#445](https://github.com/erwins-enkel/shepherd/issues/445)) ([a01e3b0](https://github.com/erwins-enkel/shepherd/commit/a01e3b0211a6943dc678c12faaa92ababac3467c))
* **ui:** show per-repo learnings in the repo status row, drop top-bar badge ([#432](https://github.com/erwins-enkel/shepherd/issues/432)) ([d91786b](https://github.com/erwins-enkel/shepherd/commit/d91786be9a826cab33d50126c0ee77b06bd2bfdd))
* **ui:** stack repo-status rows and make them a herd filter ([#443](https://github.com/erwins-enkel/shepherd/issues/443)) ([598f5a8](https://github.com/erwins-enkel/shepherd/commit/598f5a85bedfcf08d132915a6fbce5acfb312114))
* **ui:** surface the critic's live activity in the badge tooltip ([#431](https://github.com/erwins-enkel/shepherd/issues/431)) ([9c5cecf](https://github.com/erwins-enkel/shepherd/commit/9c5cecf90d701d4e075a05d3e053e903d0ad2481))


### Bug Fixes

* **a11y:** row/tile clickable surface as overlay button, not a wrapping &lt;button&gt; ([#412](https://github.com/erwins-enkel/shepherd/issues/412)) ([#433](https://github.com/erwins-enkel/shepherd/issues/433)) ([eb86a32](https://github.com/erwins-enkel/shepherd/commit/eb86a325178ef315a4b2e17d5744bce03a97dbfa))
* **ci:** bump runner image Node 20 -&gt; 22 to match ubuntu-latest ([#422](https://github.com/erwins-enkel/shepherd/issues/422)) ([caeb7d2](https://github.com/erwins-enkel/shepherd/commit/caeb7d2f3a08f16d1da3a3f45baa509c5a73a417))
* **ci:** install Node 20 in the self-hosted runner image ([#419](https://github.com/erwins-enkel/shepherd/issues/419)) ([b1e6d36](https://github.com/erwins-enkel/shepherd/commit/b1e6d3689c5e27f53fb2834a7acf945173e79ed6))
* **drain:** close stale-cache claim race for multi-person queue sharing + docs ([#435](https://github.com/erwins-enkel/shepherd/issues/435)) ([12c266a](https://github.com/erwins-enkel/shepherd/commit/12c266ac863ee9dcd0f625d88a78f831148edf9c))
* eliminate intermittent 1-3s web-terminal input freezes (event-loop starvation) ([#437](https://github.com/erwins-enkel/shepherd/issues/437)) ([5bbea2e](https://github.com/erwins-enkel/shepherd/commit/5bbea2ee540556f54705457ff75005ae920980ad))
* **extension:** persist routing rules — snapshot $state before chrome.storage ([#456](https://github.com/erwins-enkel/shepherd/issues/456)) ([ac00593](https://github.com/erwins-enkel/shepherd/commit/ac00593509eeb10c1df5464036ac275fab622036))
* **herdr:** protocol-bump update no longer kills sessions + Resume when herdr is down ([#413](https://github.com/erwins-enkel/shepherd/issues/413)) ([0cf4c69](https://github.com/erwins-enkel/shepherd/commit/0cf4c695a6429d5a846e4f41a0d8fc81664aa5c0))
* merge-train sessions stuck on pulsing 'merging' tag, never flip to merged ([#455](https://github.com/erwins-enkel/shepherd/issues/455)) ([e1dd709](https://github.com/erwins-enkel/shepherd/commit/e1dd70963c6d019259cde92da3fe8138acc505b1))
* **plan-gate:** give 'Review plan now' visible feedback ([#428](https://github.com/erwins-enkel/shepherd/issues/428)) ([dda9679](https://github.com/erwins-enkel/shepherd/commit/dda9679b65c5ac04ea5bb61f54766bb97e0cc65f))
* **plan-gate:** isolate plan-reviewer worktree per session ([#417](https://github.com/erwins-enkel/shepherd/issues/417)) ([0bced1f](https://github.com/erwins-enkel/shepherd/commit/0bced1fd0ec809d0f4f559744bdf51afc7b6e919))
* **poller:** restore per-agent heartbeat + stall after CC stopped live-writing transcripts ([#441](https://github.com/erwins-enkel/shepherd/issues/441)) ([be6ae84](https://github.com/erwins-enkel/shepherd/commit/be6ae84735c71a89fb5ac178d704b8b951a28e4f))
* **preview:** reach live preview when the HUD is fronted on a different Tailscale identity than the agents ([#447](https://github.com/erwins-enkel/shepherd/issues/447)) ([#452](https://github.com/erwins-enkel/shepherd/issues/452)) ([03ec599](https://github.com/erwins-enkel/shepherd/commit/03ec59967a497666c3cef0df28a7b9bfbdce3b21))
* **review:** isolate reviewer agents from MCP via --safe-mode ([#421](https://github.com/erwins-enkel/shepherd/issues/421)) ([0391284](https://github.com/erwins-enkel/shepherd/commit/039128464ef9cf3c71204688ab06c31c8b68ec3d))
* stop plan-gate and PR-critic badges from competing on a card ([#425](https://github.com/erwins-enkel/shepherd/issues/425)) ([c60e2b6](https://github.com/erwins-enkel/shepherd/commit/c60e2b6ab5e15c239395b20afadb16e8e2cf99da))
* **store:** monotonic task designations — never reuse a number after prune ([#449](https://github.com/erwins-enkel/shepherd/issues/449)) ([5f420c5](https://github.com/erwins-enkel/shepherd/commit/5f420c5bf3d46dd31fc08bb790370bbe59e79474))
* **ui:** dim+blur the app behind every dialog and drawer ([#424](https://github.com/erwins-enkel/shepherd/issues/424)) ([b9f1ac0](https://github.com/erwins-enkel/shepherd/commit/b9f1ac0d93ba76b28bbd128d7e21ab125ac4014f))
* **ui:** exclude in-review sessions from Ready filter + merge-train ([#406](https://github.com/erwins-enkel/shepherd/issues/406)) ([3d6d721](https://github.com/erwins-enkel/shepherd/commit/3d6d721d534af2f9608e593e509ca8ff68ada3b2))
* **ui:** explain Erkenntnisse via badge tooltip and panel intro ([#414](https://github.com/erwins-enkel/shepherd/issues/414)) ([38fd6dd](https://github.com/erwins-enkel/shepherd/commit/38fd6dd87b32b186c69555ef5bf1b21a2d2f329a))
* **ui:** granular PR/issue open-age chip instead of "0 d" same-day ([#451](https://github.com/erwins-enkel/shepherd/issues/451)) ([e2f4ddc](https://github.com/erwins-enkel/shepherd/commit/e2f4ddca169498582a7108cbf86af2b88bfd754c))
* **ui:** heartbeat strip spans full card width, consistent across badges ([#450](https://github.com/erwins-enkel/shepherd/issues/450)) ([01d5fb5](https://github.com/erwins-enkel/shepherd/commit/01d5fb595a5959d95a77b9c78c5a71de446c8d5e))
* **ui:** let desktop shell fill viewport width instead of capping at 1480px ([#411](https://github.com/erwins-enkel/shepherd/issues/411)) ([d83bf56](https://github.com/erwins-enkel/shepherd/commit/d83bf5644aeb90d680a8e6e1bc48284088d85fd6))
* **ui:** pin mobile action bar to viewport bottom ([#418](https://github.com/erwins-enkel/shepherd/issues/418)) ([1a74c36](https://github.com/erwins-enkel/shepherd/commit/1a74c36f2b9cea60048c3c0a66b9334613aa8c71))
* **ui:** stop truncating repo name on New Task submit button ([#430](https://github.com/erwins-enkel/shepherd/issues/430)) ([aac92c6](https://github.com/erwins-enkel/shepherd/commit/aac92c6de7cf23ca51a2ea16fdab6ff87af0d699))
* **ui:** tappable Set button for custom repo emoji (mobile) ([#410](https://github.com/erwins-enkel/shepherd/issues/410)) ([8110784](https://github.com/erwins-enkel/shepherd/commit/81107849b95e95ce81a0468b111576d705237b6f))
* **ui:** terminal Shift+Enter newline + copyable selection ([#429](https://github.com/erwins-enkel/shepherd/issues/429)) ([092c8e9](https://github.com/erwins-enkel/shepherd/commit/092c8e966ce2bc44e59c09b2de6edc7542d1e3e0))


### Documentation

* **research:** graphify follow-up — preloading graph won't cut mean time-to-plan/impl ([#407](https://github.com/erwins-enkel/shepherd/issues/407)) ([401b337](https://github.com/erwins-enkel/shepherd/commit/401b337c15d6239dda71deef4658842c0cf44559))

## [1.19.0](https://github.com/erwins-enkel/shepherd/compare/v1.18.0...v1.19.0) (2026-06-09)


### Features

* **drain:** label linked issues shepherd:active on task creation ([#401](https://github.com/erwins-enkel/shepherd/issues/401)) ([36e8e78](https://github.com/erwins-enkel/shepherd/commit/36e8e784aa8f366a18d79c178286e9200d7bc40d))
* **extension:** keyboard shortcut + branded toolbar icons ([#343](https://github.com/erwins-enkel/shepherd/issues/343)) ([#395](https://github.com/erwins-enkel/shepherd/issues/395)) ([2296cf6](https://github.com/erwins-enkel/shepherd/commit/2296cf649bb7cf303809864573256e2e536237ca))
* **extension:** Shepherd Capture — connection & pairing UX ([#402](https://github.com/erwins-enkel/shepherd/issues/402)) ([6798084](https://github.com/erwins-enkel/shepherd/commit/67980846696b99326846d171aaac71d15ef0f70a))


### Bug Fixes

* **mobile:** keep the herd-list action bar on-screen (document-scroll shell) ([#392](https://github.com/erwins-enkel/shepherd/issues/392)) ([91a9957](https://github.com/erwins-enkel/shepherd/commit/91a9957376ef4c96dba7be06e48ab55a394756c3))
* **ui:** merge train always skips the plan gate ([#390](https://github.com/erwins-enkel/shepherd/issues/390)) ([0096c28](https://github.com/erwins-enkel/shepherd/commit/0096c28303c81f7410b67219aab464ad0b4bfa1f))
* **ui:** merging badge pulses text not a bleeding halo ([#389](https://github.com/erwins-enkel/shepherd/issues/389)) ([40262aa](https://github.com/erwins-enkel/shepherd/commit/40262aaca684ec3e23419cbff7960016bd777294))
* **ui:** plan review pulses the automation pill + plan-gate toggle ([#400](https://github.com/erwins-enkel/shepherd/issues/400)) ([79b74ea](https://github.com/erwins-enkel/shepherd/commit/79b74ea3895336a0f11369216335ed4fe7049a25))
* **ui:** resync reconciles critic + plan-gate reviewing latches ([#391](https://github.com/erwins-enkel/shepherd/issues/391)) ([c49e69c](https://github.com/erwins-enkel/shepherd/commit/c49e69c5f82d096ede640c304d2862680c356db7))


### Documentation

* **research:** spike [#350](https://github.com/erwins-enkel/shepherd/issues/350) — evaluate Graphify as agent memory layer (verdict: park) ([#394](https://github.com/erwins-enkel/shepherd/issues/394)) ([70518e2](https://github.com/erwins-enkel/shepherd/commit/70518e2d3c5e57f50848c6a38659c179af10c008))

## [1.18.0](https://github.com/erwins-enkel/shepherd/compare/v1.17.0...v1.18.0) (2026-06-08)


### Features

* agent-authored, self-revising build queue ([#346](https://github.com/erwins-enkel/shepherd/issues/346)) ([#376](https://github.com/erwins-enkel/shepherd/issues/376)) ([bebbb69](https://github.com/erwins-enkel/shepherd/commit/bebbb69595f0d08342563a46d0f47b728d5a6db1))
* **backlog:** filter repo list by has-issues / has-PRs ([#386](https://github.com/erwins-enkel/shepherd/issues/386)) ([6d0f911](https://github.com/erwins-enkel/shepherd/commit/6d0f911a9de2aa03f4a5b32c865a2330be461968))
* **extension:** capture delivery targets + URL→repo routing ([#379](https://github.com/erwins-enkel/shepherd/issues/379)) ([13a3955](https://github.com/erwins-enkel/shepherd/commit/13a39552abbc34b8957c06c503f77d7c8119a563))
* **extension:** capture fidelity — element picker + full-page stitch ([#381](https://github.com/erwins-enkel/shepherd/issues/381)) ([0c6b5fa](https://github.com/erwins-enkel/shepherd/commit/0c6b5fac4e09b492b828e9a17eace48d52301bf1))
* pre-execution plan gate (grill + adversarial plan review) before autonomous runs ([#348](https://github.com/erwins-enkel/shepherd/issues/348)) ([#375](https://github.com/erwins-enkel/shepherd/issues/375)) ([de58ee9](https://github.com/erwins-enkel/shepherd/commit/de58ee967f3ecaf4c07a8caa28d7fcaf9e27a5de))


### Bug Fixes

* **extension:** open options page reliably from popup ([#380](https://github.com/erwins-enkel/shepherd/issues/380)) ([707ee38](https://github.com/erwins-enkel/shepherd/commit/707ee380e9f5ad156682e36a7f3086fd587ed31e))
* **extension:** tolerate non-array routingRules so capture doesn't crash ([#383](https://github.com/erwins-enkel/shepherd/issues/383)) ([ef038be](https://github.com/erwins-enkel/shepherd/commit/ef038becd28a2f6eda081869a421e0dcb7a5e787))
* **plan-gate:** auto-release approved plans under autopilot, not just drain-spawned ([#387](https://github.com/erwins-enkel/shepherd/issues/387)) ([60919a9](https://github.com/erwins-enkel/shepherd/commit/60919a9c479ebe94cdcd9a119a6f8c4bd46bc38b))
* **poller:** don't flip a session to MERGED on a reused branch name ([#378](https://github.com/erwins-enkel/shepherd/issues/378)) ([ea57153](https://github.com/erwins-enkel/shepherd/commit/ea571538ba7d62964b8cb2dc03d9b5c29bc82e2f))
* **ui:** scope plan-gate reviews into the Herd "Reviewing" group ([#385](https://github.com/erwins-enkel/shepherd/issues/385)) ([258ab87](https://github.com/erwins-enkel/shepherd/commit/258ab87e37f9f00a7d461c0cefdc8544c72fe0d2))
* **ui:** scrollable mobile backlog tab strip so close button never collides ([#388](https://github.com/erwins-enkel/shepherd/issues/388)) ([2ee910d](https://github.com/erwins-enkel/shepherd/commit/2ee910df0cd53f4fd642f33320df5bb5aad61aa7))
* **ui:** surface per-task plan-gate state in repo automation panel ([#382](https://github.com/erwins-enkel/shepherd/issues/382)) ([a959955](https://github.com/erwins-enkel/shepherd/commit/a959955b65f02c9dcc42dd283b661fcef034c1c4))

## [1.17.0](https://github.com/erwins-enkel/shepherd/compare/v1.16.0...v1.17.0) (2026-06-08)


### Features

* **autopilot:** complete verdict for non-PR tasks ([#358](https://github.com/erwins-enkel/shepherd/issues/358)) ([#363](https://github.com/erwins-enkel/shepherd/issues/363)) ([1c131f6](https://github.com/erwins-enkel/shepherd/commit/1c131f6bc8cb059d585fc31ba83acda01843b310))
* **extension:** remote (Tailscale) base URL via optional host permission ([#373](https://github.com/erwins-enkel/shepherd/issues/373)) ([82af33b](https://github.com/erwins-enkel/shepherd/commit/82af33be6501d360df1c73a64f27e05dde96c0de))
* **extension:** Shepherd Capture Phase 2 — capture signals (console/network/a11y) + per-signal toggles ([#344](https://github.com/erwins-enkel/shepherd/issues/344)) ([2ce8bff](https://github.com/erwins-enkel/shepherd/commit/2ce8bff78fe3ac4605e030071208ff8ea3c5917b))
* full-auto merge mode (optional, per-repo + per-session) ([#362](https://github.com/erwins-enkel/shepherd/issues/362)) ([2a161e3](https://github.com/erwins-enkel/shepherd/commit/2a161e3f7c20946186730f45169c029b416e6c75))
* **service:** inject Karpathy engineering posture into every spawn ([#353](https://github.com/erwins-enkel/shepherd/issues/353)) ([34cbebc](https://github.com/erwins-enkel/shepherd/commit/34cbebc06e579002b76e9a6f93bf963535f07c47))
* **spawn:** research-first notice in unattended system prompt ([#366](https://github.com/erwins-enkel/shepherd/issues/366)) ([991bfda](https://github.com/erwins-enkel/shepherd/commit/991bfda580b6d9aeaadf1f21d6d22c0b843692e1))
* **ui:** add AI-readiness analyzer Backlog mode ([#361](https://github.com/erwins-enkel/shepherd/issues/361)) ([#364](https://github.com/erwins-enkel/shepherd/issues/364)) ([dd34876](https://github.com/erwins-enkel/shepherd/commit/dd3487631fcb6b1c2393b162b38f0a753a11b358))
* **ui:** design-system reference page + agent directive vs UI drift ([#369](https://github.com/erwins-enkel/shepherd/issues/369)) ([e0c0a01](https://github.com/erwins-enkel/shepherd/commit/e0c0a012c27406e1d5d331842c3b7f4bca11d171))
* **ui:** make review-cycles cap a global setting ([#360](https://github.com/erwins-enkel/shepherd/issues/360)) ([1aafd43](https://github.com/erwins-enkel/shepherd/commit/1aafd4379396d10c746324938d510be78584d19e))
* **ui:** merge-train shortcut in Ready-to-merge section ([#359](https://github.com/erwins-enkel/shepherd/issues/359)) ([4e28190](https://github.com/erwins-enkel/shepherd/commit/4e28190b21f2e3d3de40d492ccd44064b2a5fb53))
* **ui:** show merge-train PRs as Merging in the session list ([#365](https://github.com/erwins-enkel/shepherd/issues/365)) ([1688796](https://github.com/erwins-enkel/shepherd/commit/1688796ceb4e01cc9995044d9f9e4ef710e3683f))


### Bug Fixes

* **autopilot:** recover red-CI PRs + seed directive so agents don't halt to ask ([#357](https://github.com/erwins-enkel/shepherd/issues/357)) ([5f904ac](https://github.com/erwins-enkel/shepherd/commit/5f904ac71ee01df2f8fcdb848b1e24423fe16af5))
* **backlog:** refresh counters + headline after merging a PR ([#354](https://github.com/erwins-enkel/shepherd/issues/354)) ([5b06e50](https://github.com/erwins-enkel/shepherd/commit/5b06e50d596f5be383f909a43e0bc847e525a35b))
* **hooks:** auto-install extension/ deps in fresh worktrees ([#355](https://github.com/erwins-enkel/shepherd/issues/355)) ([97f44c8](https://github.com/erwins-enkel/shepherd/commit/97f44c83ac1d1c1032f32dafd504bc09896f664f))
* **poller:** gate stall on live-terminal liveness, not transcript-silence alone ([#370](https://github.com/erwins-enkel/shepherd/issues/370)) ([3a65181](https://github.com/erwins-enkel/shepherd/commit/3a65181da73fbd142837871e535b99f53a90cac5))
* **ui:** center-align readiness score in ring ([#368](https://github.com/erwins-enkel/shepherd/issues/368)) ([472aaa7](https://github.com/erwins-enkel/shepherd/commit/472aaa7a1363846c7b7fdd6876485d78de8cfa55))
* **ui:** drop per-session full-auto merge toggle from session header ([#367](https://github.com/erwins-enkel/shepherd/issues/367)) ([b900027](https://github.com/erwins-enkel/shepherd/commit/b900027c6255fb6e1ac08a3d43caf0f6e3606280))
* **ui:** gear pip amber while working, red only when blocked ([#339](https://github.com/erwins-enkel/shepherd/issues/339)) ([4c4ea20](https://github.com/erwins-enkel/shepherd/commit/4c4ea2047be13aa2992b8faea8e3e89cd5be9c27))
* **ui:** let automation drain label field grow on narrow screens ([#356](https://github.com/erwins-enkel/shepherd/issues/356)) ([c645275](https://github.com/erwins-enkel/shepherd/commit/c6452755c7d0bee0f8cd08e2dc741e2985a3c596))
* **ui:** move backlog tab bar above detail pane on desktop ([#371](https://github.com/erwins-enkel/shepherd/issues/371)) ([3934627](https://github.com/erwins-enkel/shepherd/commit/3934627a86faef414ee2a3c07a68c07df91e5a2b))
* **ui:** scale session elapsed timer for multi-day runs ([#351](https://github.com/erwins-enkel/shepherd/issues/351)) ([555c378](https://github.com/erwins-enkel/shepherd/commit/555c378177da64fdf6b9d2a30ed9de84c263ab27))
* **ui:** show jump-to-bottom when agent output lands below a hair-scrolled pane ([#372](https://github.com/erwins-enkel/shepherd/issues/372)) ([7f1fc0e](https://github.com/erwins-enkel/shepherd/commit/7f1fc0e87311838ac408d662d9ea8b1880f64415))

## [1.16.0](https://github.com/erwins-enkel/shepherd/compare/v1.15.0...v1.16.0) (2026-06-04)


### Features

* **announce:** catalog entry for halt-the-herd e-stop ([#327](https://github.com/erwins-enkel/shepherd/issues/327)) ([#328](https://github.com/erwins-enkel/shepherd/issues/328)) ([157a32e](https://github.com/erwins-enkel/shepherd/commit/157a32e6790fbfc6458d588cea5ff2f64044eac2))
* **extension:** Shepherd Capture browser extension — Phase 1 MVP ([#308](https://github.com/erwins-enkel/shepherd/issues/308)) ([#336](https://github.com/erwins-enkel/shepherd/issues/336)) ([193e0eb](https://github.com/erwins-enkel/shepherd/commit/193e0ebbd773f52029d6fd506bd05cce08ccf06a))


### Bug Fixes

* **gitrail:** make critic verdict chip a real touch target on compact rail ([#329](https://github.com/erwins-enkel/shepherd/issues/329)) ([c305330](https://github.com/erwins-enkel/shepherd/commit/c3053300c935a6d71c9ed3b964eb93433590cec7))
* **gitrail:** match Ready toggle height to Reviewed chip on touch rail ([#333](https://github.com/erwins-enkel/shepherd/issues/333)) ([79b20d2](https://github.com/erwins-enkel/shepherd/commit/79b20d2f688759297026fd18a8738bba5f606ecb))
* **ui:** full-width heartbeat on touch too; command stays hover-only ([#335](https://github.com/erwins-enkel/shepherd/issues/335)) ([b4e8360](https://github.com/erwins-enkel/shepherd/commit/b4e83604e50d149817da61e837dd008a92adeedd))
* **ui:** full-width heartbeat strip; cmd snippet on hover ([#332](https://github.com/erwins-enkel/shepherd/issues/332)) ([87846ff](https://github.com/erwins-enkel/shepherd/commit/87846ffc85e7284da156ca65c84cc504f031782e))
* **ui:** move halt e-stop into the gear menu ([#337](https://github.com/erwins-enkel/shepherd/issues/337)) ([c057aa1](https://github.com/erwins-enkel/shepherd/commit/c057aa191d45f53d60e48f96187f4a7b5dda5524))
* **ui:** quiet halt button + two-step arm→confirm ([#330](https://github.com/erwins-enkel/shepherd/issues/330)) ([dd4452b](https://github.com/erwins-enkel/shepherd/commit/dd4452bd223508ecb073745e85cbb835961bd5fe))

## [1.15.0](https://github.com/erwins-enkel/shepherd/compare/v1.14.0...v1.15.0) (2026-06-04)


### Features

* enforce + document feature-announcements catalog upkeep ([#325](https://github.com/erwins-enkel/shepherd/issues/325)) ([b48df0e](https://github.com/erwins-enkel/shepherd/commit/b48df0e3121762d5323b150d49bfc3cd479d4796))
* **halt:** global "halt the herd" emergency stop ([#326](https://github.com/erwins-enkel/shepherd/issues/326)) ([d80a38a](https://github.com/erwins-enkel/shepherd/commit/d80a38a8278fde965f8895201ad75af9431d6b33))


### Bug Fixes

* **reconcile:** guard startup reconcile when herdr is down ([#315](https://github.com/erwins-enkel/shepherd/issues/315)) ([#324](https://github.com/erwins-enkel/shepherd/issues/324)) ([fd929ea](https://github.com/erwins-enkel/shepherd/commit/fd929ea539174301fae40564718e03e3567bf247))
* **ui:** keep top bar from overflowing on touch-desktop ([#322](https://github.com/erwins-enkel/shepherd/issues/322)) ([31decc9](https://github.com/erwins-enkel/shepherd/commit/31decc971c035f84a6550e74fe92a42d0822e06c))

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
