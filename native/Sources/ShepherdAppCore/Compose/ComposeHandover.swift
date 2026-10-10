import Foundation
import ShepherdKit

/// Ephemeral, server-scoped hand-over. Only the prompt crosses the connection boundary.
/// Repository, issue, branch, uploaded paths and run defaults belong to the new server.
struct ComposeHandover {
    let profileID: ServerProfile.ID
    let generation: Int
    let prompt: String
}

extension AppModel {
    public func activateForCompose(_ profile: ServerProfile, prompt: String) async {
        guard sheet == .newSession, profile.id != activeProfile?.id,
              profiles.contains(where: { $0.id == profile.id }) else { return }
        pendingComposeHandover = .init(profileID: profile.id, generation: activationGeneration &+ 1, prompt: prompt)
        await activate(profile)
    }

    /// Called on appearance, never in a SwiftUI View initializer (which may run repeatedly).
    public func consumeComposePrompt(activation: Int) -> String? {
        guard let pending = pendingComposeHandover, sheet == .newSession, store != nil,
              activation == activationGeneration, pending.generation == activation,
              pending.profileID == activeProfile?.id else { return nil }
        pendingComposeHandover = nil
        return pending.prompt
    }
}
