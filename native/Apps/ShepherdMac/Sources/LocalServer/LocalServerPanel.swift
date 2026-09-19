import SwiftUI

/// Placeholder for the Welcome card body. Task 6 needs a `LocalServerPanel` to
/// exist so `LocalServerFeature.install()` compiles; Task 7 replaces this whole
/// file with the real panel (status line, Install/Start/Stop/Restart, the log
/// disclosure and Connect).
struct LocalServerPanel: View {
    let model: LocalServerModel
    let app: AppModel

    var body: some View {
        Text(LocalServerCopy.label(for: model.state))
            .font(.callout)
            .foregroundStyle(.secondary)
            .task { await model.refresh() }
    }
}
