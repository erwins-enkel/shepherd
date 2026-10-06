import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
@testable import ShepherdAppCore

@Suite @MainActor struct LocalConnectionBannerTests {
    private let endpoint = URL(string: "http://127.0.0.1:7330")!
    private var local: ServerProfile { ServerProfile(name: "Local", baseURL: endpoint, mode: .local) }

    @Test func offlineLocalStatesChooseCopyAndAction() {
        let cases: [(LocalServerState, String, LocalConnectionBannerPolicy.Action?)] = [
            (.stopped, L.t("native_local_banner_stopped"), .start),
            (.notInstalled, L.t("native_local_banner_not_installed"), .settings),
            (.starting, L.t("native_local_banner_starting"), nil),
            (.installing, LocalServerCopy.label(for: .installing), nil),
            (.upgradingBun, LocalServerCopy.label(for: .upgradingBun), nil),
            (.failed(.healthTimeout), LocalServerCopy.message(for: .healthTimeout), .start),
            (.failed(.exited(code: 1)), LocalServerCopy.message(for: .exited(code: 1)), .start),
        ]
        for (state, message, action) in cases {
            let result = LocalConnectionBannerPolicy.resolve(kind: .offline(server: "Local"),
                profile: local, endpoint: endpoint, state: state)
            #expect(result?.message == message)
            #expect(result?.action == action)
        }
        #expect(LocalConnectionBannerPolicy.Action.start.title == L.t("native_local_start"))
        #expect(LocalConnectionBannerPolicy.Action.settings.title == L.t("native_local_banner_settings"))
    }

    @Test func unmanagedOrRunningServersKeepGenericBanner() {
        var remote = local
        remote.mode = .remote
        var otherEndpoint = local
        otherEndpoint.baseURL = URL(string: "http://127.0.0.1:7331")!
        for profile in [remote, otherEndpoint, nil] {
            for state: LocalServerState in [.stopped, .notInstalled, .starting, .failed(.healthTimeout)] {
                #expect(LocalConnectionBannerPolicy.resolve(kind: .offline(server: "Local"),
                    profile: profile, endpoint: endpoint, state: state) == nil)
            }
        }
        for state: LocalServerState in [.externallyManaged, .running(pid: 123)] {
            #expect(LocalConnectionBannerPolicy.resolve(kind: .offline(server: "Local"),
                profile: local, endpoint: endpoint, state: state) == nil)
        }
    }

    @Test func otherConnectionBannersKeepTheirPriority() {
        for kind: BannerKind in [.needsLogin, .unhealthy(server: "Local"),
            .contractMismatch(server: "1", app: "2"), .clientTooOld(minimum: "2", app: "1")] {
            #expect(LocalConnectionBannerPolicy.resolve(kind: kind, profile: local,
                endpoint: endpoint, state: .stopped) == nil)
        }
    }
}
