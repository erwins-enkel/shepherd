import SwiftUI
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct SessionStatusStyleTests {
    private let all: [SessionStatus] = [
        SessionStatus(known: .running),
        SessionStatus(known: .idle),
        SessionStatus(known: .blocked),
        SessionStatus(known: .done),
        SessionStatus(known: .archived),
    ]

    @Test func everyStatusHasANonEmptyLabel() {
        for status in all { #expect(!SessionStatusStyle.label(status).isEmpty) }
    }

    @Test func labelsDoNotLeakRawKeys() {
        // A missing catalog entry makes String(localized:) echo the key back.
        for status in all { #expect(!SessionStatusStyle.label(status).hasPrefix("status_")) }
    }

    @Test func everyStatusHasADistinctLabel() {
        #expect(Set(all.map(SessionStatusStyle.label)).count == all.count)
    }

    @Test func blockedDoneRunningAndArchivedAreVisuallyDistinct() {
        #expect(SessionStatusStyle.tint(SessionStatus(known: .blocked))
            != SessionStatusStyle.tint(SessionStatus(known: .done)))
        #expect(SessionStatusStyle.tint(SessionStatus(known: .running))
            != SessionStatusStyle.tint(SessionStatus(known: .archived)))
    }

    @Test func aStatusThisBuildDoesNotKnowFallsBackToItsRawValue() {
        // The contract's read-side enums are open: a newer server may send a value
        // this app has never compiled against, and the badge must still render.
        let status = SessionStatus(unknown: "quiescing")
        #expect(SessionStatusStyle.label(status) == "QUIESCING")
        #expect(SessionStatusStyle.tint(status) == SessionStatusStyle.tint(SessionStatus(known: .idle)))
    }

    @Test func providerLabelIsNilWhenUnknown() {
        #expect(SessionStatusStyle.providerLabel(nil) == nil)
        #expect(SessionStatusStyle.providerLabel(.claude) != nil)
        #expect(SessionStatusStyle.providerLabel(.codex) != SessionStatusStyle.providerLabel(.claude))
    }

    @Test func previewSessionCarriesWhatItWasGiven() {
        let session = PreviewData.session(id: "abc", status: SessionStatus(known: .blocked))
        #expect(session.id == "abc")
        #expect(session.status.known == .blocked)
        #expect(session.agentProvider == .claude)
        #expect(PreviewData.session(agentProvider: nil).agentProvider == nil)
    }
}
}
