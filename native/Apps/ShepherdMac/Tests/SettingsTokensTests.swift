import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
@MainActor struct SettingsTokensTests {
    @Test func closeClearsAllObservableAccessState() {
        let tokens = SettingsTokensModel()
        tokens.close(); tokens.close()
        #expect(tokens.revealed == nil); #expect(tokens.entries.isEmpty)
        #expect(!tokens.authenticated); #expect(!tokens.busy); #expect(tokens.error == nil)
    }
    @Test func lateFailedAuthenticationAfterCloseIsDiscarded() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 0.01
        let transport = URLSession(configuration:config)
        let tokens = SettingsTokensModel()
        tokens.authenticate(profile:.init(name:"offline",baseURL:URL(string:"http://127.0.0.1:1")!,mode:.local),
            password:"fixture",session:transport)
        tokens.close()
        for _ in 0..<10 {await Task.yield()}
        #expect(!tokens.authenticated); #expect(tokens.revealed == nil); #expect(tokens.error == nil)
    }
    @Test func accessLabelsResolve() {
        #expect(L.t("native_settings_token_login") != "native_settings_token_login")
        #expect(L.t("native_settings_token_once") != "native_settings_token_once")
        #expect(L.t("native_settings_revoke_confirm") != "native_settings_revoke_confirm")
        #expect(L.t("native_settings_days", "30").contains("30"))
    }
}
