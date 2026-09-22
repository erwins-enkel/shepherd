import Foundation

/// Localised copy lookup. Every key comes from Resources/Localizable.xcstrings,
/// which native/scripts/gen-strings.sh mirrors from ui/messages/{en,de}.json.
/// Never pass a runtime-built key: the catalog is a fixed manifest.
public enum L {
    public static func t(_ key: StaticString) -> String {
        String(localized: String.LocalizationValue(stringLiteral: "\(key)"), bundle: .module)
    }

    public static func t(_ key: StaticString, _ args: any CVarArg...) -> String {
        String(format: t(key), locale: .current, arguments: args)
    }
}

enum CoreResources { static var bundle: Bundle { .module } }
