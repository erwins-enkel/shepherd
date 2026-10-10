import SwiftUI

/// A Menu that only re-renders when `value` changes. SwiftUI rebuilds an open Menu on every
/// parent re-render, and a rebuild while the finger is down drops the tap; live store pushes
/// re-render the composer several times a second. `value` must cover everything the content
/// and label show; the actions may capture references, which stay current.
struct StableMenu<Value: Equatable, Content: View, Label: View>: View, Equatable {
    let value: Value
    @ViewBuilder let content: () -> Content
    @ViewBuilder let label: () -> Label
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.value == rhs.value }
    var body: some View { Menu(content: content, label: label) }
}
