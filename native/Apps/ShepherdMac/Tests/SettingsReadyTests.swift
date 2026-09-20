import Foundation
import Testing
import ShepherdKit
@testable import Shepherd
struct SettingsReadyTests {
    @Test func seedWarmupDwellRetryAndPrune() {
        var state = SettingsReadyState()
        #expect(state.candidates(enabled:true,ids:["old"],ready:["old"],now:0).isEmpty)
        #expect(state.candidates(enabled:true,ids:["old","new"],ready:["old","new"],now:1_000).isEmpty)
        #expect(state.candidates(enabled:true,ids:["old","new"],ready:["old","new"],now:15_999).isEmpty)
        #expect(state.candidates(enabled:true,ids:["old","new"],ready:["old","new"],now:16_000) == ["new"])
        // No sent() call: a focused/denied/cooldown delivery must retry.
        #expect(state.candidates(enabled:true,ids:["new"],ready:["new"],now:17_000) == ["new"])
        state.sent("new")
        #expect(state.candidates(enabled:true,ids:["new"],ready:["new"],now:18_000).isEmpty)
        #expect(state.seen["old"] == nil)
        #expect(state.candidates(enabled:false,ids:["new"],ready:["new"],now:19_000).isEmpty)
        #expect(!state.armed); #expect(state.seen.isEmpty)
        #expect(state.candidates(enabled:true,ids:["new"],ready:["new"],now:20_000).isEmpty)
    }
    @Test func leavingReadyRestartsDwell() {
        var state = SettingsReadyState()
        _ = state.candidates(enabled:true,ids:["a"],ready:[],now:0)
        _ = state.candidates(enabled:true,ids:["a"],ready:["a"],now:20_000)
        _ = state.candidates(enabled:true,ids:["a"],ready:[],now:24_999)
        #expect(state.candidates(enabled:true,ids:["a"],ready:["a"],now:25_000).isEmpty)
        #expect(state.candidates(enabled:true,ids:["a"],ready:["a"],now:30_000) == ["a"])
    }
    @Test func reducedPolicyFiltersRawReadyAndAllowsOnlyTheWebAllowlist() {
        for kind in ["done","blocked","merge_error","ready"] {
            #expect(!SettingsReadyRules.allows(kind:kind,reduced:true,evaluatedReady:false))
        }
        for kind in ["usage_limit","extra_credits","backup_stale","onboarding_stale"] {
            #expect(SettingsReadyRules.allows(kind:kind,reduced:true,evaluatedReady:false))
        }
        #expect(SettingsReadyRules.allows(kind:"ready",reduced:true,evaluatedReady:true))
        #expect(SettingsReadyRules.allows(kind:"done",reduced:false,evaluatedReady:false))
    }
    @Test(arguments: [
        (#"{"state":"merged","checks":"success","deployConfigured":false}"#, false),
        (#"{"state":"open","checks":"pending","deployConfigured":false}"#, false),
        (#"{"state":"open","checks":"failure","deployConfigured":false}"#, true),
        (#"{"state":"open","checks":"success","deployConfigured":false,"handoff":"reviewer"}"#, false),
        (#"{"state":"open","checks":"success","deployConfigured":false,"handoff":"merger"}"#, false),
        (#"{"state":"open","checks":"success","deployConfigured":false,"handoff":"reviewer","isDraft":true}"#, true),
        (#"{"state":"open","checks":"none","deployConfigured":false,"noCi":true,"handoff":"reviewer"}"#, false),
        (#"{"state":"open","checks":"none","deployConfigured":false,"noCi":false,"handoff":"reviewer"}"#, true),
    ] as [(String,Bool)])
    func gitReadyPrecedence(_ fixture: (String,Bool)) throws {
        let git = try JSONDecoder().decode(GitState.self,from:Data(fixture.0.utf8))
        let session = PreviewData.session(status:.init(known:.idle))
        #expect(SettingsReadyRules.ready(session,git:git,reviewing:false,working:false,now:0) == fixture.1)
    }
    @Test func readyFlagAndMergeBackstopPrecedence() {
        var session = PreviewData.session(status:.init(known:.idle))
        session.readyToMerge = true; session.mergingSince = 1
        #expect(!SettingsReadyRules.ready(session,git:nil,reviewing:false,working:false,now:10))
        #expect(SettingsReadyRules.ready(session,git:nil,reviewing:false,working:false,now:86_400_001))
    }
    @Test func readyPredicateExcludesRunningReviewAndWorkingBlocked() {
        var session = PreviewData.session(status:.init(known:.idle))
        #expect(SettingsReadyRules.ready(session,git:nil,reviewing:false,working:false,now:0))
        #expect(!SettingsReadyRules.ready(session,git:nil,reviewing:true,working:false,now:0))
        session.status = .init(known:.blocked)
        #expect(!SettingsReadyRules.ready(session,git:nil,reviewing:false,working:true,now:0))
        session.status = .init(known:.running)
        #expect(!SettingsReadyRules.ready(session,git:nil,reviewing:false,working:false,now:0))
    }
    @Test func appearanceAndPaletteCopyResolves() {
        let keys: [StaticString] = [
            "native_settings_colorblind",
            "native_settings_command_search",
            "native_settings_contrast",
            "native_settings_dark",
            "native_settings_full_motion",
            "native_settings_light",
            "native_settings_motion",
            "native_settings_no_commands",
            "native_settings_reduced_motion",
            "native_settings_system",
            "native_settings_theme",
        ]
        for key in keys { #expect(L.t(key) != String(describing: key)) }
    }
}
