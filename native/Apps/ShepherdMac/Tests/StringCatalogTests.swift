import Foundation
import Testing

/// Asserts the committed string catalog against the source-of-truth manifest.
/// Reads the file from the repo (via #filePath) rather than the built bundle so
/// the test is about the catalog, not about bundle plumbing.
struct StringCatalogTests {
    private static let catalogURL: URL = {
        // …/native/Apps/ShepherdMac/Tests/StringCatalogTests.swift
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // Tests
            .deletingLastPathComponent()      // ShepherdMac
            .appendingPathComponent("Resources/Localizable.xcstrings")
    }()

    private struct Catalog: Decodable {
        struct Entry: Decodable {
            struct Localization: Decodable {
                struct Unit: Decodable {
                    let state: String
                    let value: String
                }
                let stringUnit: Unit
            }
            let localizations: [String: Localization]
        }
        let sourceLanguage: String
        let version: String
        let strings: [String: Entry]
    }

    private static func load() throws -> Catalog {
        let data = try Data(contentsOf: catalogURL)
        return try JSONDecoder().decode(Catalog.self, from: data)
    }

    @Test func catalogIsVersion1EnglishSourced() throws {
        let catalog = try Self.load()
        #expect(catalog.version == "1.0")
        #expect(catalog.sourceLanguage == "en")
    }

    @Test func everyKeyHasTranslatedEnAndDe() throws {
        let catalog = try Self.load()
        // The exact key count is asserted by gen-strings.ts's own --check gate
        // (it fails the build if the manifest and the committed catalog
        // disagree); this test only needs to know every key the catalog does
        // carry has a translated en and de value.
        #expect(!catalog.strings.isEmpty)
        for (key, entry) in catalog.strings {
            guard let en = entry.localizations["en"], let de = entry.localizations["de"] else {
                Issue.record("\(key) is missing en or de")
                continue
            }
            #expect(en.stringUnit.state == "translated", "\(key) en not translated")
            #expect(de.stringUnit.state == "translated", "\(key) de not translated")
            #expect(!en.stringUnit.value.isEmpty, "\(key) en is empty")
            #expect(!de.stringUnit.value.isEmpty, "\(key) de is empty")
        }
    }

    @Test func placeholderIndicesMatchAcrossLocales() throws {
        let catalog = try Self.load()
        for (key, entry) in catalog.strings {
            guard let en = entry.localizations["en"], let de = entry.localizations["de"] else { continue }
            let enIndices = Self.placeholderIndices(en.stringUnit.value)
            let deIndices = Self.placeholderIndices(de.stringUnit.value)
            #expect(enIndices == deIndices, "\(key): en uses \(enIndices), de uses \(deIndices)")
        }
    }

    @Test func knownKeysCarryTheExpectedCopy() throws {
        let catalog = try Self.load()
        #expect(catalog.strings["native_welcome_local_title"]?.localizations["en"]?.stringUnit.value
            == "Run on this Mac")
        #expect(catalog.strings["native_welcome_remote_title"]?.localizations["de"]?.stringUnit.value
            == "Mit einem entfernten Server verbinden")
        #expect(catalog.strings["native_banner_mismatch"]?.localizations["en"]?.stringUnit.value
            == "Server and app versions differ — server %1$@, app %2$@. Some things may not work.")
    }

    /// Set of positional indices used by %N$@ placeholders.
    private static func placeholderIndices(_ value: String) -> Set<Int> {
        var found: Set<Int> = []
        let pattern = try! NSRegularExpression(pattern: "%(\\d+)\\$@")
        let range = NSRange(value.startIndex..., in: value)
        for match in pattern.matches(in: value, range: range) {
            if let r = Range(match.range(at: 1), in: value), let n = Int(value[r]) { found.insert(n) }
        }
        return found
    }
}
