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

    func continueComposeHandover(for profile: ServerProfile) {
        guard let pending = pendingComposeHandover, pending.profileID == profile.id else { return }
        pendingComposeHandover = .init(profileID: profile.id, generation: activationGeneration &+ 1,
                                      prompt: pending.prompt)
    }

    /// Keep edits made while the target server is still authenticating.
    public func updateComposeHandoverPrompt(_ prompt: String, activation: Int) {
        guard let pending = pendingComposeHandover, pending.generation == activation,
              activationGeneration == activation, pending.profileID == activeProfile?.id else { return }
        pendingComposeHandover = .init(profileID: pending.profileID, generation: activation, prompt: prompt)
    }

    /// Called on appearance, never in a SwiftUI View initializer (which may run repeatedly).
    public func consumeComposePrompt(activation: Int) -> String? {
        guard let pending = pendingComposeHandover, sheet == .newSession, store != nil,
              activation == activationGeneration, pending.generation == activation,
              pending.profileID == activeProfile?.id,
              composeHandoverConsumedGeneration != activation else { return nil }
        composeHandoverConsumedGeneration = activation
        // A remote store can exist before it reports needsLogin. Keep the prompt until
        // authentication is confirmed, but deliver it only once per composer.
        if store?.connection == .live { pendingComposeHandover = nil }
        return pending.prompt
    }
}
