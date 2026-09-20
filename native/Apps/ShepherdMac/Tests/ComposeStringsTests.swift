import ShepherdKit
import Testing
@testable import Shepherd

@MainActor @Suite struct ComposeStringsTests {
    @Test func glossaryMarkupKeepsLabelsAndSurroundingText() {
        #expect(GuardToggles.label("[[plan-gate|Plan-Gate]]") == "Plan-Gate")
        #expect(GuardToggles.label("[[autopilot|Autopilot bis zum PR]]") == "Autopilot bis zum PR")
        #expect(GuardToggles.label("Use [[plan-gate|Plan gate]] + [[autopilot|Autopilot]]") == "Use Plan gate + Autopilot")
        #expect(GuardToggles.label("Already plain") == "Already plain")
        #expect(GuardToggles.label("[[unfinished") == "[[unfinished")
    }

    @Test func codexDetailsIncludeTheHoldAdviceOnlyWhileLive() {
        for hold in [false, true] {
            #expect(CodexAlphaWarning(provider: .claude, holdLikely: hold).paragraphs.isEmpty)
        }
        let ordinary = CodexAlphaWarning(provider: .codex, holdLikely: false).paragraphs
        #expect(ordinary == [L.t("newtask_agent_provider_codex_alpha_note"), L.t("newtask_agent_provider_codex_note")])
        let hold = CodexAlphaWarning(provider: .codex, holdLikely: true).paragraphs
        #expect(hold == [L.t("newtask_agent_provider_codex_alpha_note"),
                         L.t("newtask_agent_provider_codex_suggested_for_hold"), L.t("newtask_agent_provider_codex_note")])
    }
}
