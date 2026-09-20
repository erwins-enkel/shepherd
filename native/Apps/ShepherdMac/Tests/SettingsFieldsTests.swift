import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
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
}
