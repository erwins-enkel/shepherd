import SwiftUI

@MainActor
enum ComposeStream {
    static func install(_ app: AppModel) {
        // Integration owns the caller. The existing NewSessionSheet remains the empty-slot fallback.
        NewSessionSlot.content = { app in AnyView(ComposeSheet().environment(app)) }
    }
}
