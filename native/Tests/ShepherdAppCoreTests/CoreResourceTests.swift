@testable import ShepherdAppCore
import Foundation
import Testing

extension CoreSeamTests {
struct CoreResourceTests {
    private struct Catalog: Decodable {
        struct Entry: Decodable {
            struct Localization: Decodable {
                struct Unit: Decodable { let value: String }
                let stringUnit: Unit
            }
            let localizations: [String: Localization]
        }
        let strings: [String: Entry]
    }

    @Test func everyCatalogEntryResolvesInBothLocales() throws {
        let catalogURL = try #require(
            CoreResources.bundle.url(forResource: "Localizable", withExtension: "xcstrings", subdirectory: "Catalog"))
        let catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: catalogURL))
        #expect(!catalog.strings.isEmpty)

        for language in ["en", "de"] {
            let directory = try #require(CoreResources.bundle.url(forResource: language, withExtension: "lproj"))
            let localized = try #require(Bundle(url: directory))
            for (key, entry) in catalog.strings {
                let expected = try #require(entry.localizations[language]?.stringUnit.value)
                #expect(
                    localized.localizedString(forKey: key, value: "__MISSING__", table: nil) == expected,
                    Comment(rawValue: "(language): (key)"))
            }
        }
    }
}
}
