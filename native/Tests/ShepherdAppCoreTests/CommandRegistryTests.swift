import Foundation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct CommandRegistryTests {
    private func fresh() { CommandRegistry.reset() }

    @Test func anEmptyRegistryHasNoCommandsInAnyMenu() {
        fresh()
        for menu in MenuCommand.Menu.allCases {
            #expect(CommandRegistry.commands(in: menu).isEmpty)
        }
    }

    @Test func commandsSortByOrderThenID() {
        fresh()
        CommandRegistry.register(.init(id: "zed", menu: .view, order: 0, titleKey: "common_close") { _ in })
        CommandRegistry.register(.init(id: "abc", menu: .view, order: 0, titleKey: "common_close") { _ in })
        CommandRegistry.register(.init(id: "late", menu: .view, order: 5, titleKey: "common_close") { _ in })
        #expect(CommandRegistry.commands(in: .view).map(\.id) == ["abc", "zed", "late"])
    }

    @Test func registrationIsIdempotentPerID() {
        fresh()
        CommandRegistry.register(.init(id: "one", menu: .file, order: 0, titleKey: "common_close") { _ in })
        CommandRegistry.register(.init(id: "one", menu: .file, order: 9, titleKey: "common_cancel") { _ in })
        let all = CommandRegistry.commands(in: .file)
        #expect(all.count == 1)
        // Last registration wins, exactly as DetailTabRegistry does it, so the integration lane
        // can replace a command without a removal API.
        #expect(all[0].order == 9)
    }

    @Test func aCommandLandsOnlyInItsOwnMenu() {
        fresh()
        CommandRegistry.register(.init(id: "s", menu: .session, order: 0, titleKey: "common_close") { _ in })
        #expect(CommandRegistry.commands(in: .session).count == 1)
        #expect(CommandRegistry.commands(in: .view).isEmpty)
    }

    /// A bare `AppModel()` reaches the login Keychain. Always use throwaway defaults and
    /// an in-memory credential store in tests.
    private static func scratchModel() -> AppModel {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
    }

    @Test func enablementDefaultsToAlwaysOn() {
        fresh()
        let model = Self.scratchModel()
        CommandRegistry.register(.init(id: "s", menu: .session, order: 0, titleKey: "common_close") { _ in })
        #expect(CommandRegistry.commands(in: .session)[0].isEnabled(model))
    }
}
}
