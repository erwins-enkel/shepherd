@testable import ShepherdAppCore
import Foundation
import Testing

extension CoreSeamTests {
struct CoreResourceTests {
    private enum ValidationError: Error, Equatable {
        case missingCatalog
        case missingLocale(String)
        case invalidLocaleBundle(String)
        case missingValue(String, String)
    }

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

    private static func validateAllCatalogEntries(in bundle: Bundle) throws {
        guard let catalogURL = bundle.url(
            forResource: "Localizable", withExtension: "xcstrings", subdirectory: "Catalog")
        else { throw ValidationError.missingCatalog }
        let catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: catalogURL))
        #expect(!catalog.strings.isEmpty)

        for language in ["en", "de"] {
            guard let directory = bundle.url(forResource: language, withExtension: "lproj")
            else { throw ValidationError.missingLocale(language) }
            guard let localized = Bundle(url: directory)
            else { throw ValidationError.invalidLocaleBundle(language) }
            for (key, entry) in catalog.strings {
                guard let expected = entry.localizations[language]?.stringUnit.value
                else { throw ValidationError.missingValue(language, key) }
                let actual = localized.localizedString(forKey: key, value: "__MISSING__", table: nil)
                guard actual != "__MISSING__" else { throw ValidationError.missingValue(language, key) }
                #expect(actual == expected, Comment(rawValue: "\(language): \(key)"))
            }
        }
    }

    @Test func everyCatalogEntryResolvesInBothLocales() throws {
        try Self.validateAllCatalogEntries(in: CoreResources.bundle)

        let fileManager = FileManager.default
        let fixtureURL = fileManager.temporaryDirectory
            .appendingPathComponent("CoreResourceTests-\(UUID().uuidString)")
            .appendingPathExtension("bundle")
        defer { try? fileManager.removeItem(at: fixtureURL) }
        try fileManager.createDirectory(at: fixtureURL, withIntermediateDirectories: false)
        let info = [
            "CFBundleIdentifier": "CoreResourceTests.missing-de",
            "CFBundlePackageType": "BNDL"
        ]
        let infoData = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try infoData.write(to: fixtureURL.appendingPathComponent("Info.plist"))

        let catalogDirectory = try #require(
            CoreResources.bundle.url(forResource: "Catalog", withExtension: nil))
        try fileManager.copyItem(
            at: catalogDirectory,
            to: fixtureURL.appendingPathComponent("Catalog", isDirectory: true))
        let englishDirectory = try #require(CoreResources.bundle.url(forResource: "en", withExtension: "lproj"))
        try fileManager.copyItem(
            at: englishDirectory,
            to: fixtureURL.appendingPathComponent("en.lproj", isDirectory: true))
        let fixtureBundle = try #require(Bundle(url: fixtureURL))

        do {
            try Self.validateAllCatalogEntries(in: fixtureBundle)
            Issue.record("The resource verifier accepted a bundle missing de.lproj")
        } catch let error as ValidationError {
            #expect(error == .missingLocale("de"))
        }
    }
}
}
