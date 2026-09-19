import SwiftUI
import ShepherdKit

/// A pluggable tab in the session detail pane. Streams register one each instead
/// of editing `SessionDetailView`, which is how four branches add four tabs
/// without touching the same lines. `Sendable` is free — a conformer is a
/// stateless value naming a view builder; `makeView` is `@MainActor` because
/// `AppModel` and `SessionStore` are.
protocol DetailTab: Identifiable, Sendable where ID == String {
    /// Registry key: "terminal", "activity", "diff", "files", "git".
    var id: String { get }
    /// Read through `L.t(...)` at render time, never stored, so a language change
    /// needs no re-registration.
    var title: String { get }
    var systemImage: String { get }
    /// Ascending sort key; ties break on `id`. Terminal is 0, the built-in prompt
    /// tab 1_000, so a stream tab lands ahead of it by default.
    var order: Int { get }

    @MainActor func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView
}

/// The built-in tab. Always present unless a stream registers `promptTabID`.
struct PromptDetailTab: DetailTab {
    var id: String { DetailTabRegistry.promptTabID }
    var title: String { L.t("newtask_prompt_label") }
    let systemImage = "text.alignleft"
    let order = 1_000

    @MainActor
    func makeView(session: Session, store: SessionStore, app: AppModel) -> AnyView {
        AnyView(PromptTabView(session: session))
    }
}

/// Lifted out of `SessionDetailView` unchanged, so the copy — and therefore the
/// string catalog — stays exactly as Gate 2 left it.
struct PromptTabView: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            GroupBox(L.t("newtask_prompt_label")) {
                ScrollView {
                    Text(verbatim: session.prompt)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 220)
            }
            GroupBox(L.t("native_detail_placeholder_title")) {
                Text(verbatim: L.t("native_detail_placeholder_body"))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer()
        }
        .padding(16)
        .accessibilityIdentifier("detail-tab-prompt")
    }
}

/// Where streams hang their detail tabs. Per-process main-actor state:
/// registration happens once at launch, every read is a SwiftUI body evaluation.
@MainActor
enum DetailTabRegistry {
    /// `nonisolated` so the non-isolated `PromptDetailTab` can name it; a `let`
    /// of a `Sendable` type is safe to read anywhere.
    nonisolated static let promptTabID = "prompt"

    private static var registered: [String: any DetailTab] = [:]

    /// Idempotent per id — the last registration wins, so a stream can take the
    /// prompt slot by registering `promptTabID`.
    static func register(_ tab: any DetailTab) { registered[tab.id] = tab }

    /// Registered tabs plus the built-in one, ordered by `order` then `id` so the
    /// sequence never depends on dictionary iteration order.
    static var tabs: [any DetailTab] {
        var byID: [String: any DetailTab] = [promptTabID: PromptDetailTab()]
        for (id, tab) in registered { byID[id] = tab }
        return byID.values.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    /// Tests and previews only.
    static func reset() { registered.removeAll() }

    /// How the detail pane draws `tabs`. Named rather than decided inline at the
    /// call site, for the same reason `SidebarSlot.Resolution` is: the choice is
    /// then assertable without hosting a view.
    enum Layout: Equatable {
        /// Exactly one tab — its content renders on its own, with no tab bar.
        case single
        /// Two or more: a `TabView` with one item each.
        case tabbed
    }

    /// A tab bar with a single item is chrome with nothing to switch to, which
    /// is what the app shows until the first stream registers a tab. Pure, so a
    /// view can pass the count it already has and get the same answer as `layout`.
    static func layout(forTabCount count: Int) -> Layout { count == 1 ? .single : .tabbed }

    static var layout: Layout { layout(forTabCount: tabs.count) }
}
