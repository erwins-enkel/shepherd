#if os(iOS)
import ShepherdKit

extension QuestionAnswerContext {
    public func lockedForIOS(_ locked: Bool) -> Self {
        Self(sessionID: sessionID, locked: self.locked || locked)
    }
}

extension QuestionFormWriter {
    /// The phone's mounted/foreground lease supplements the shared selection guard.
    /// Keep this adapter iOS-scoped so Mac request and confirmation behaviour is unchanged.
    @MainActor
    public func guardedForIOS(
        isCurrent: @escaping @MainActor @Sendable () -> Bool,
        submissionChanged: @escaping @MainActor @Sendable (Bool) -> Void
    ) -> Self {
        let original = self
        return Self(send: { id, answers in
            guard original.isCurrent(), isCurrent() else { throw ShepherdError.notFound }
            submissionChanged(true)
            defer { submissionChanged(false) }
            return try await original.send(id, answers)
        }, isCurrent: { original.isCurrent() && isCurrent() })
    }
}
#endif
