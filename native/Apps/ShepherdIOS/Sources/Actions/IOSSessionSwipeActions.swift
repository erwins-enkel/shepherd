import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// List-only commands reuse the detail's activation-scoped command state. The
/// system exposes the swipe buttons through VoiceOver's Actions rotor as well.
struct IOSSessionSwipeActions: ViewModifier {
    let session: Session
    @Environment(AppModel.self) private var app
    func body(content: Content) -> some View {
        if let controller = app.extension(IOSSessionActions.self) {
            let state = controller.state(for: session)
            VStack(alignment: .leading, spacing: 4) {
                content
                if state.error != nil || state.outcome.note != nil || state.busy {
                    IOSActionFeedback(error: state.error, note: state.outcome.note, busy: state.busy)
                        .padding(.horizontal, 10)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if state.allowsWrites {
                    ForEach(state.swipeActions) { action in
                        Button { Task { await state.execute(action) } } label: {
                            Label(IOSSessionActionState.label(action, session: session), systemImage: action.systemImage)
                        }
                        .tint(action == .toggleReady ? SessionListStyle.slate : SessionListStyle.amber)
                        .disabled(state.busy).accessibilityIdentifier("swipe-\(action.id)-\(session.id)")
                    }
                }
            }
            .contextMenu {
                if state.allowsWrites {
                    ForEach(state.swipeActions) { action in
                        Button { Task { await state.execute(action) } } label: {
                            Label(IOSSessionActionState.label(action, session: session), systemImage: action.systemImage)
                        }.disabled(state.busy)
                    }
                }
            }
        } else { content }
    }
}
