import Foundation
import Observation
import ShepherdAppCore

/// One gesture identity; eligibility is checked again after the hold delay.
@MainActor
@Observable
final class IOSDictationHold {
    private(set) var holding = false
    var translation = CGSize.zero
    private var touchedLocked = false
    private var revision = 0
    private var task: Task<Void, Never>?
    private(set) var pendingStarts = 0

    func changed(voice: DictationController, translation: CGSize,
                 eligible: @escaping () -> Bool,
                 delay: @escaping () async throws -> Void = { try await Task.sleep(for: .milliseconds(250)) }) {
        guard eligible() else { cancel(); return }
        self.translation = translation
        if !holding {
            holding = true; touchedLocked = voice.state == .locked
            revision += 1; let mine = revision
            pendingStarts += 1
            task = Task {
                defer { pendingStarts -= 1 }
                do { try await delay() } catch { return }
                guard mine == revision, holding, !Task.isCancelled, eligible() else { return }
                await voice.begin()
                if mine == revision, holding, eligible() { voice.drag(x: self.translation.width, y: self.translation.height) }
            }
        }
        voice.drag(x: translation.width, y: translation.height)
    }

    func ended(voice: DictationController, eligible: Bool) {
        guard holding else { return }
        let locked = touchedLocked
        cancel()
        guard eligible else { return }
        if locked { voice.finalize() }
        else if !voice.active { voice.toggle() } else { voice.release() }
    }

    func cancel() { revision += 1; holding = false; task?.cancel(); task = nil; translation = .zero }
}

/// Terminal-only affordance. Scale changes drawing, never the gesture's layout identity.
enum IOSTerminalMicStyle {
    static let diameter: CGFloat = 44
    static func scale(held: Bool, reduceMotion: Bool) -> CGFloat { held && !reduceMotion ? 1.18 : 1 }
}
