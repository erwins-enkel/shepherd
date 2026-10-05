import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor @Suite struct ComposeAutoStartTests {
    @Test func armedStartFiresOnceWithItsForceFlagAfterUploadsSettle() async throws {
        var pending: CheckedContinuation<String, any Error>?
        let attachments = AttachmentModel(upload: { _, _ in try await withCheckedThrowingContinuation { pending = $0 } })
        defer { attachments.teardown() }
        let begun = Box(0), released = Box(0), fired = Box<[Bool]>([])
        let auto = ComposeAutoStart(keepAlive: { begun.value += 1; return { released.value += 1 } })
        attachments.addFiles([.init(name: "a", data: Data([1]))])
        auto.arm(force: true, attachments: attachments) { fired.value.append($0) }
        auto.arm(force: false, attachments: attachments) { fired.value.append($0) }
        #expect(auto.armed && begun.value == 1)
        try await eventually { pending != nil }
        #expect(fired.value.isEmpty)
        pending?.resume(returning: "/a")
        try await eventually { !fired.value.isEmpty }
        #expect(fired.value == [true] && !auto.armed && !auto.aborted)
        try await eventually { released.value == 1 }
    }

    @Test func disarmBeforeSettleNeverFiresAndReleasesAtOnce() async throws {
        var pending: CheckedContinuation<String, any Error>?
        let attachments = AttachmentModel(upload: { _, _ in try await withCheckedThrowingContinuation { pending = $0 } })
        defer { attachments.teardown() }
        let released = Box(0), fired = Box(0)
        let auto = ComposeAutoStart(keepAlive: { { released.value += 1 } })
        attachments.addFiles([.init(name: "a", data: Data([1]))])
        auto.arm(force: false, attachments: attachments) { _ in fired.value += 1 }
        auto.disarm()
        #expect(!auto.armed && released.value == 1)
        try await eventually { pending != nil }
        pending?.resume(returning: "/a")
        try await eventually { !attachments.inFlight }
        for _ in 0..<20 { await Task.yield() }
        #expect(fired.value == 0 && released.value == 1)
    }

    @Test func failedUploadAbortsWithoutFiringUntilNewWorkClearsTheNotice() async throws {
        let attachments = AttachmentModel(upload: { _, _ in throw ShepherdError.badRequest("nope") })
        defer { attachments.teardown() }
        let fired = Box(0)
        let auto = ComposeAutoStart()
        attachments.addFiles([.init(name: "a", data: Data([1]))])
        auto.arm(force: false, attachments: attachments) { _ in fired.value += 1 }
        try await eventually { auto.aborted }
        #expect(fired.value == 0 && !auto.armed && attachments.hasFailedUploads)
        auto.clearAborted()
        #expect(!auto.aborted)
    }

    @Test func teardownCancelsAPendingStart() async throws {
        var pending: CheckedContinuation<String, any Error>?
        let attachments = AttachmentModel(upload: { _, _ in try await withCheckedThrowingContinuation { pending = $0 } })
        let fired = Box(0)
        let auto = ComposeAutoStart()
        attachments.addFiles([.init(name: "a", data: Data([1]))])
        auto.arm(force: false, attachments: attachments) { _ in fired.value += 1 }
        try await eventually { pending != nil }
        auto.teardown()
        attachments.teardown()
        pending?.resume(returning: "/late")
        for _ in 0..<20 { await Task.yield() }
        #expect(fired.value == 0 && !auto.armed)
    }

    @Test func armingWithNothingInFlightFiresAtOnce() async throws {
        let attachments = AttachmentModel(upload: { _, _ in "/unused" })
        let fired = Box(0)
        let auto = ComposeAutoStart()
        auto.arm(force: false, attachments: attachments) { _ in fired.value += 1 }
        try await eventually { fired.value == 1 }
        #expect(!auto.armed)
    }

    private func eventually(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        #expect(predicate())
    }
}
}
