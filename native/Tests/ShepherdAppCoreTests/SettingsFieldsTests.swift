import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore
extension CoreSeamTests {
@MainActor struct SettingsFieldsTests {
    @Test func descriptorsHaveUniqueKeysAndNeverBatch() throws {
        let fields = SettingsFields.all
        #expect(Set(fields.map(\.id)).count == fields.count)
        for field in fields {
            let input = field.kind == .number ? "2" : field.kind == .toggle ? "true" : "fixture"
            let patch = try #require(field.patch(input))
            let body = try #require(JSONSerialization.jsonObject(with:JSONEncoder().encode(patch)) as? [String:Any])
            #expect(body.count == 1); #expect(body[field.id] != nil)
        }
        #expect(fields.filter {$0.id.hasSuffix("Cli")}.count == 9)
        #expect(fields.contains {$0.id == "reducedPushMode"})
        #expect(fields.first {$0.id == "prReviewCyclesCap"}?.patch("not a number") == nil)
    }

    @Test func numericFieldsRejectNonFiniteInputAndPreserveFiniteValues() throws {
        for field in SettingsFields.all where field.kind == .number {
            for input in ["", "not a number", "nan", "inf", "-inf", "1e999"] {
                #expect(field.patch(input) == nil)
            }
            for input in ["0", "-1", "2.5"] {
                let patch = try #require(field.patch(input))
                let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
                #expect(body[field.id] as? Double == Double(input))
            }
        }
    }

    @Test func textFieldsPreserveServerAliasesAndEmptyValues() throws {
        for field in SettingsFields.all where field.kind == .text {
            for input in ["inherit", "default", "future-model-alias", ""] {
                let patch = try #require(field.patch(input))
                let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
                #expect(body.count == 1)
                #expect(body[field.id] as? String == input)
            }
        }
    }

    @Test func togglesCanDisableAndDescriptorTitlesResolve() throws {
        for field in SettingsFields.all {
            #expect(L.t(field.title) != String(describing: field.title))
            guard field.kind == .toggle else { continue }
            let patch = try #require(field.patch("false"))
            let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
            #expect(body.count == 1)
            #expect(body[field.id] as? Bool == false)
        }
    }

    @Test func successfulSaveAdoptsUnchangedNormalizedValue() async throws {
        let field = try #require(SettingsFields.all.first { $0.id == "usageHoldPct" })
        let settings = try settingsFixture()
        let snapshot = SettingsSnapshot(settings: settings,
            diagnostics: .init(checks: [], generatedAt: 1, overall: .init(known: .ok)), usage: nil, repos: [])
        var reconciled = false
        let model = SettingsModel(reads: .init(snapshot: { snapshot }, reconcile: { reconciled = true }))
        defer { model.teardown() }
        await model.load()
        let draft = SettingsFieldDraft()
        draft.text = "80.5"
        #expect(draft.canSave(field: field, payload: settings))
        draft.submit(field: field, model: model) { patch in
            #expect(patch.usageHoldPct == 80.5)
            return settings // PATCH floors to the same 80 already returned by GET.
        }
        while model.busy { await Task.yield() }
        #expect(reconciled)
        #expect(draft.text == field.value(settings))
        #expect(!draft.canSave(field: field, payload: settings))
    }

    @Test(arguments: [false, true])
    func rejectedSaveOrRefreshPreservesDraft(reconciliationFails: Bool) async throws {
        let field = try #require(SettingsFields.all.first { $0.id == "usageHoldPct" })
        let settings = try settingsFixture()
        let model = SettingsModel(reads: .init(snapshot: { throw ShepherdError.notFound },
            reconcile: { if reconciliationFails { throw ShepherdError.notFound } }))
        defer { model.teardown() }
        let draft = SettingsFieldDraft()
        draft.text = "80.5"
        draft.submit(field: field, model: model) { _ in
            if !reconciliationFails { throw ShepherdError.badRequest("rejected") }
            return settings
        }
        while model.busy { await Task.yield() }
        #expect(model.error != nil)
        #expect(draft.text == "80.5")
        #expect(draft.canSave(field: field, payload: settings))
    }

    private func settingsFixture() throws -> Components.Schemas.Settings {
        try JSONDecoder().decode(Components.Schemas.Settings.self, from: Data(#"{"repoRoot":"/repo","repoRootDisplay":"repo","firstRunPending":false,"defaultModel":"opus","defaultEffort":"default","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"en","usageHoldPct":80}"#.utf8))
    }

}
}
