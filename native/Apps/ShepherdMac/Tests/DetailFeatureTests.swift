import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

/// `.serialized`: `DetailTabRegistry` is per-process state, same reason `DetailTabRegistryTests`
/// and `AppExtensionTests` are.
@MainActor
@Suite(.serialized)
struct DetailFeatureTests {
    init() { resetStreamSeams() }

    private func makeModel() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
    }

    private func remote(_ model: AppModel, _ label: String) throws -> ServerProfile {
        try model.addRemoteProfile(name: label, address: "https://\(label).example.ts.net")
    }

    @Test func installRegistersTheActivityTabAtOrderTen() {
        let app = makeModel()
        DetailFeature.install(app)

        let tab = DetailTabRegistry.tabs.first { $0.id == "activity" }
        #expect(tab != nil)
        #expect(tab?.order == 10)
        #expect(DetailTabRegistry.tabs.map(\.id).contains("prompt"))
    }

    @Test func installRegistersTheDiffTabAtOrderTwenty() {
        let app = makeModel()
        DetailFeature.install(app)

        let tab = DetailTabRegistry.tabs.first { $0.id == "diff" }
        #expect(tab != nil)
        #expect(tab?.order == 20)
    }

    @Test func installRegistersTheFilesTabAtOrderThirty() {
        let app = makeModel()
        DetailFeature.install(app)

        let tab = DetailTabRegistry.tabs.first { $0.id == "files" }
        #expect(tab != nil)
        #expect(tab?.order == 30)
    }

    @Test func installRegistersTheGitTabAtOrderForty() {
        let app = makeModel()
        DetailFeature.install(app)

        let tab = DetailTabRegistry.tabs.first { $0.id == "git" }
        #expect(tab != nil)
        #expect(tab?.order == 40)
        // Activity (10) before diff (20) before files (30) before git (40) before the built-in
        // prompt tab (1_000).
        #expect(DetailTabRegistry.tabs.map(\.id) == ["activity", "diff", "files", "git", "prompt"])
    }

    @Test func installBuildsTheModelImmediatelyWhenAStoreIsAlreadyLive() async throws {
        let app = makeModel()
        await app.activate(try remote(app, "one"))
        #expect(DetailFeature.model(app) == nil)

        DetailFeature.install(app)

        #expect(DetailFeature.model(app) != nil)
        app.teardown()
    }

    /// The brief's idempotency requirement: calling `install(_:)` a second (and third) time adds
    /// no second "activity" registration and builds no second `DetailModel` — the live instance
    /// an operator's tab is already reading from survives untouched.
    @Test func installIsIdempotent() async throws {
        let app = makeModel()
        DetailFeature.install(app)
        await app.activate(try remote(app, "two"))
        let first = try #require(DetailFeature.model(app))

        DetailFeature.install(app)
        DetailFeature.install(app)

        #expect(DetailTabRegistry.tabs.filter { $0.id == "activity" }.count == 1)
        #expect(DetailTabRegistry.tabs.filter { $0.id == "diff" }.count == 1)
        #expect(DetailTabRegistry.tabs.filter { $0.id == "files" }.count == 1)
        #expect(DetailTabRegistry.tabs.filter { $0.id == "git" }.count == 1)
        #expect(DetailFeature.model(app) === first)
        app.teardown()
    }

    @Test func aFreshActivationGetsItsOwnModelOncePerStore() async throws {
        let app = makeModel()
        DetailFeature.install(app)

        await app.activate(try remote(app, "three"))
        let firstModel = try #require(DetailFeature.model(app))

        await app.activate(try remote(app, "four"))
        let secondModel = try #require(DetailFeature.model(app))

        #expect(firstModel !== secondModel)
        app.teardown()
    }

    // MARK: - The identity a tab's load task keys on

    /// Session id alone is not enough: a profile switch builds a fresh `DetailModel` with empty
    /// caches, and a tab whose `.task(id:)` did not re-run for the same selected session would
    /// sit on a spinner nothing ever fills.
    @Test func theTaskKeyChangesWhenTheModelDoesEvenForTheSameSession() {
        let first = DetailModel(loaders: .stubbed())
        let second = DetailModel(loaders: .stubbed())

        #expect(DetailTaskKey(session: "s1", model: first) == DetailTaskKey(session: "s1", model: first))
        #expect(DetailTaskKey(session: "s1", model: first) != DetailTaskKey(session: "s1", model: second))
        #expect(DetailTaskKey(session: "s1", model: first) != DetailTaskKey(session: "s2", model: first))
    }

    // MARK: - The activity tab's state mapping

    @Test func theActivityPhaseMapsEveryLoadedState() {
        #expect(ActivityTabView.phase(for: .loading) == .loading)
        #expect(ActivityTabView.phase(for: .failed("nope")) == .failed("nope"))
        #expect(ActivityTabView.phase(for: .ready([])) == .empty(L.t("activity_empty")))
        let entry = ActivityEntry(ts: 1, tool: "Edit", summary: "did", status: .init(known: .ok))
        #expect(ActivityTabView.phase(for: .ready([entry])) == .content)
    }

    // MARK: - The diff tab's state mapping

    @Test func theDiffPhaseMapsEveryLoadedState() {
        #expect(DiffTabView.phase(for: .loading) == .loading)
        #expect(DiffTabView.phase(for: .failed("nope")) == .failed("nope"))

        let empty = DiffResult(
            base: "main", baseRef: "origin/main", head: nil, fetchFailed: false, truncated: false,
            files: [])
        // `diff_empty` names `baseRef` (the ref actually compared against), not `base`.
        #expect(
            DiffTabView.phase(for: .ready(.init(result: empty, notes: [])))
                == .empty(L.t("diff_empty", "origin/main")))

        var withFile = empty
        withFile.files = [
            DiffFile(
                path: "x.swift", status: .init(known: .modified), additions: 1, deletions: 0,
                binary: false, patch: "@@ -1 +1 @@\n-a\n+b")
        ]
        #expect(DiffTabView.phase(for: .ready(.init(result: withFile, notes: []))) == .content)
    }

    // MARK: - What a file with no parsed hunks shows

    /// A file whose headers parsed but whose hunks did not produces one `File`, zero hunks and
    /// an empty `UnifiedPatch.raw` — so the tab used to claim `diff_note_no_changes` for a file
    /// the list right beside it says has changes. Its own patch text is the answer.
    @Test func aFileWhoseHunksDidNotParseShowsItsPatchVerbatim() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ malformed @@\n-old\n+new"
        #expect(DiffTabView.verbatimText(parsed: UnifiedPatch.parse(patch), patch: patch) == patch)
    }

    /// Nothing parsed at all: the parser's own `raw` block is what gets shown.
    @Test func aWhollyUnparsedPatchShowsTheParsersRawBlock() {
        let parsed = UnifiedPatch.parse("not a patch at all")
        #expect(
            DiffTabView.verbatimText(parsed: parsed, patch: "not a patch at all")
                == "not a patch at all")
    }

    /// A pure rename or a mode-only change sends no patch text, and "no changes" is the truth.
    @Test func aFileWithNoPatchTextHasNothingToShowVerbatim() {
        let parsed = UnifiedPatch.parse("")
        #expect(DiffTabView.verbatimText(parsed: parsed, patch: nil) == nil)
        #expect(DiffTabView.verbatimText(parsed: parsed, patch: "") == nil)
        #expect(DiffTabView.verbatimText(parsed: parsed, patch: "  \n\n") == nil)
    }

    /// The whole point of finding the text: a diff whose patch changed for an ALREADY-LISTED
    /// path must re-render that path's hunks, which is what the layout recompute does.
    @Test func theLayoutFollowsAChangedPatchForAnAlreadyListedPath() {
        func result(_ patch: String) -> DiffResult {
            DiffResult(
                base: "main", baseRef: "origin/main", head: "shepherd/s1", fetchFailed: false,
                truncated: false,
                files: [
                    DiffFile(
                        path: "x.swift", status: .init(known: .modified), additions: 1,
                        deletions: 0, binary: false, patch: patch)
                ])
        }
        let before = DiffAnnotationLayout.partition(
            notes: [], files: result("@@ -1 +1 @@\n+a").files)
        let after = DiffAnnotationLayout.partition(
            notes: [], files: result("@@ -1 +1,2 @@\n+a\n+b").files)
        #expect(before.hunks["x.swift"]?.hunks.first?.lines.count == 1)
        #expect(after.hunks["x.swift"]?.hunks.first?.lines.count == 2)
        // …and the model stamps a new revision for exactly that change, which is what drives
        // the recompute — see `DetailModelTests.theDiffRevisionMovesOnlyWhenTheContentDoes`.
        #expect(result("@@ -1 +1 @@\n+a") != result("@@ -1 +1,2 @@\n+a\n+b"))
    }

    // MARK: - The files tab's state mapping

    @Test func theFilesPhaseMapsEveryLoadedState() {
        #expect(
            FilesTabView.phase(for: .loading, source: .scratchpad, listing: nil) == .loading)
        #expect(
            FilesTabView.phase(for: .failed("nope"), source: .scratchpad, listing: nil)
                == .failed(L.t("files_load_error")))
        #expect(
            FilesTabView.phase(for: .failed("nope"), source: .worktree, listing: nil)
                == .failed(L.t("files_worktree_load_error")))

        let empty = BrowseListing(path: "", parent: nil, entries: [])
        let ready = Loaded<DetailModel.FilesPayload>.ready(
            .init(source: .scratchpad, listing: empty))
        #expect(
            FilesTabView.phase(for: ready, source: .scratchpad, listing: empty)
                == .empty(L.t("files_empty")))

        let entry = BrowseEntry(name: "notes", _type: .init(known: .dir), path: "notes")
        let withEntries = BrowseListing(path: "", parent: nil, entries: [entry])
        #expect(
            FilesTabView.phase(for: ready, source: .scratchpad, listing: withEntries) == .content)

        // A `.ready` payload is still shown as loading when the view's `listing` filtered it out
        // because the payload belongs to the OTHER source — the caller's job, not `phase`'s.
        #expect(FilesTabView.phase(for: ready, source: .scratchpad, listing: nil) == .loading)
    }

    @Test func theActivityTabHasNoModelToRenderBeforeInstall() async throws {
        let app = makeModel()
        await app.activate(try remote(app, "five"))
        #expect(DetailFeature.model(app) == nil)
        app.teardown()
    }
}
