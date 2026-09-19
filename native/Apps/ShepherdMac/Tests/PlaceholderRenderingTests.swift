import Foundation
import Testing

/// Deferred from Gate 1 (sub-project 4a, Task 11): after formatting every
/// catalog string with dummy arguments, no literal `%1$@`/`%@`/`%%` placeholder
/// artefact should survive in the rendered EN or DE copy. A survivor there
/// means either an argument-count mismatch (`L.t` called with too few args for
/// the placeholders `gen-strings.ts` emitted) or a `%` that should have been
/// escaped to `%%` before going through `String(format:)`.
///
/// This reads the committed catalog directly (like StringCatalogTests) rather
/// than going through `L.t`, so the test needs no bundle/locale plumbing and
/// exercises exactly the same `String(format:locale:arguments:)` call `L.t`
/// makes.
struct PlaceholderRenderingTests {
    private static let catalogURL: URL = {
        // …/native/Apps/ShepherdMac/Tests/PlaceholderRenderingTests.swift
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // Tests
            .deletingLastPathComponent()      // ShepherdMac
            .appendingPathComponent("Resources/Localizable.xcstrings")
    }()

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

    private static func load() throws -> Catalog {
        let data = try Data(contentsOf: catalogURL)
        return try JSONDecoder().decode(Catalog.self, from: data)
    }

    /// The highest positional index used by a `%N$@` placeholder, 0 when the
    /// string carries none.
    private static func placeholderCount(_ value: String) -> Int {
        var maxIndex = 0
        let pattern = try! NSRegularExpression(pattern: "%(\\d+)\\$@")
        let range = NSRange(value.startIndex..., in: value)
        for match in pattern.matches(in: value, range: range) {
            if let r = Range(match.range(at: 1), in: value), let n = Int(value[r]) {
                maxIndex = max(maxIndex, n)
            }
        }
        return maxIndex
    }

    /// The first `%%`, `%@` or `%N$@` sequence still present, or `nil` when
    /// none remains. `%%` is only a survivor here because this function is run
    /// on *rendered* output, where a correctly-consumed escape has already
    /// collapsed to a single `%`.
    private static func leftoverPlaceholder(_ value: String) -> String? {
        let pattern = try! NSRegularExpression(pattern: "%%|%\\d*\\$?@")
        let range = NSRange(value.startIndex..., in: value)
        guard let match = pattern.firstMatch(in: value, range: range),
            let r = Range(match.range, in: value)
        else { return nil }
        return String(value[r])
    }

    @Test func renderedCopyHasNoLeftoverPlaceholderArtefacts() throws {
        let catalog = try Self.load()
        #expect(!catalog.strings.isEmpty)

        for (key, entry) in catalog.strings {
            for locale in ["en", "de"] {
                guard let value = entry.localizations[locale]?.stringUnit.value else {
                    Issue.record("\(key) is missing a \(locale) value")
                    continue
                }

                let count = Self.placeholderCount(value)
                let rendered: String
                if count == 0 {
                    // No placeholders: L.t(key) returns String(localized:)
                    // verbatim with no format pass, so this is the render path.
                    rendered = value
                } else {
                    let args = (1...count).map { "dummy\($0)" }
                    rendered = String(format: value, locale: Locale(identifier: locale), arguments: args)
                }

                let message =
                    "\(key) (\(locale)) still shows a placeholder artefact after formatting: \"\(rendered)\""
                #expect(Self.leftoverPlaceholder(rendered) == nil, Comment(rawValue: message))
            }
        }
    }
}
