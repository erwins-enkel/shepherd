import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct SettingsRepoTests {
    @Test func roleClearingSendsNullAndConfigCarriesConfirmation() throws {
        let clear = try RepoRolesPatch.values(reviewer:nil,merger:nil)
        let roles = try #require(JSONSerialization.jsonObject(with:JSONEncoder().encode(clear)) as? [String:Any])
        #expect(roles["reviewer"] is NSNull); #expect(roles["merger"] is NSNull)
        let config = RepoConfigPatch(autoDrainEnabled:true,automationConfirmed:true)
        let body = try #require(JSONSerialization.jsonObject(with:JSONEncoder().encode(config)) as? [String:Any])
        #expect(body["autoDrainEnabled"] as? Bool == true)
        #expect(body["automationConfirmed"] as? Bool == true)
        #expect(body.count == 2)
    }
    @Test func workspaceLabelsResolve() {
        #expect(L.t("native_settings_repo_confirm") != "native_settings_repo_confirm")
        #expect(L.t("native_settings_roles_push_notice") != "native_settings_roles_push_notice")
        #expect(L.t("native_settings_repo_egressextrahosts") != "native_settings_repo_egressextrahosts")
    }
}
