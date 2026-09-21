import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
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
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
    }

    private func remote(_ model: AppModel, _ label: String) throws -> ServerProfile {
        try model.addRemoteProfile(name: label, address: "https://\(label).example.ts.net")
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

    // MARK: - The diff tab's state mapping

    // MARK: - What a file with no parsed hunks shows

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

}
}
