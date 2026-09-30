import ShepherdKit

/// The map itself is nil until a current snapshot arrives; a missing id means no owner.
public enum TerminalOwnerCopy {
    public static func title(
        owners: [String: Components.Schemas.TerminalClientInfo]?, sessionID: String
    ) -> String {
        guard let owners else { return L.t("terminal_owner_unavailable") }
        guard let owner = owners[sessionID] else { return L.t("terminal_owner_none") }
        if owner.kind.rawValue == "mac-app" { return L.t("terminal_owner_mac") }
        let platforms = [
            "macos": "macOS", "ios": "iOS", "ipados": "iPadOS", "android": "Android",
            "windows": "Windows", "linux": "Linux", "chromeos": "ChromeOS",
        ]
        let platform = platforms[owner.platform.rawValue]
        switch owner.kind.rawValue {
        case "pwa":
            if let platform { return L.t("terminal_owner_pwa_platform", platform) }
            return L.t("terminal_owner_pwa")
        case "browser":
            if let platform { return L.t("terminal_owner_browser_platform", platform) }
            return L.t("terminal_owner_browser")
        default: return L.t("native_terminal_superseded_title")
        }
    }
}
