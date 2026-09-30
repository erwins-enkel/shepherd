import ShepherdKit
import Testing
@testable import ShepherdAppCore

@Suite("Terminal owner copy")
struct TerminalOwnerCopyTests {
    @Test("a parked view reads each new owner snapshot and distinguishes unavailable from empty")
    func ownerTitles() {
        let mac: Components.Schemas.TerminalClientInfo = .init(
            kind: .init(unknown: "mac-app"), platform: .init(unknown: "macos"))
        let pwa: Components.Schemas.TerminalClientInfo = .init(
            kind: .init(unknown: "pwa"), platform: .init(unknown: "ios"))
        #expect(TerminalOwnerCopy.title(owners: ["a": mac], sessionID: "a") == L.t("terminal_owner_mac"))
        #expect(TerminalOwnerCopy.title(owners: ["a": pwa], sessionID: "a") == L.t("terminal_owner_pwa_platform", "iOS"))
        #expect(TerminalOwnerCopy.title(owners: [:], sessionID: "a") == L.t("terminal_owner_none"))
        #expect(TerminalOwnerCopy.title(owners: nil, sessionID: "a") == L.t("terminal_owner_unavailable"))
        let future: Components.Schemas.TerminalClientInfo = .init(
            kind: .init(unknown: "future"), platform: .init(unknown: "future"))
        #expect(TerminalOwnerCopy.title(owners: ["a": future], sessionID: "a") == L.t("native_terminal_superseded_title"))
    }
}
