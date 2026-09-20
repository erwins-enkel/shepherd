import Observation
import ShepherdKit
import SwiftUI

/// The `CreateSessionRequest` fields the contract already carries but the built-in sheet does not
/// show (inventory L2).
///
/// S0 owns the type because `CreateSessionRequest` is a core schema outside every stream block; a
/// stream owns the controls that write into it. `apply(to:)` is what the built-in sheet calls just
/// before it sends, so a stream's extras land without the stream touching `submit()`.
///
/// **Every field is optional and `apply` writes only what was set.** A blind assignment would undo
/// a value the sheet — or a replacement composer — had already decided, and "the operator did not
/// touch this control" must stay distinguishable from "the operator chose false".
@Observable
@MainActor
final class NewSessionExtras {
    /// nil = use the repo/global default. The server treats false as an explicit opt-out.
    var planGateEnabled: Bool?
    var autopilotEnabled: Bool?
    var sandboxProfile: Components.Schemas.SandboxProfile?
    /// nil = the server default. `plain` starts the agent without Shepherd's prompt scaffolding.
    var plain: Bool?
    /// nil = respect the usage-hold gate. true bypasses it and spawns immediately, which is why it
    /// is a deliberate opt-in rather than a default.
    var force: Bool?
    /// Staged attachment paths. Empty and absent mean the same thing to the server, so an empty
    /// list is not sent — see `apply(to:)`.
    var images: [String] = []

    init() {}

    /// Folds the operator's choices into the outgoing request. Called by the built-in sheet
    /// immediately before `store.create(_:)`.
    func apply(to request: inout CreateSessionRequest) {
        if let planGateEnabled { request.planGateEnabled = planGateEnabled }
        if let autopilotEnabled { request.autopilotEnabled = autopilotEnabled }
        if let sandboxProfile { request.sandboxProfile = sandboxProfile }
        if let plain { request.plain = plain }
        if let force { request.force = force }
        if !images.isEmpty { request.images = images }
    }
}

/// How a stream extends or replaces the New Task sheet without owning
/// `Sources/Main/NewSessionSheet.swift`.
///
/// Two hooks on purpose. `options` is additive — extra controls inside the built-in form, bound to
/// the `NewSessionExtras` the built-in submit path already folds in — and is what lands the six
/// contract-legal create fields with no contract work at all. `content` replaces the whole body and
/// is what a real composer takes. A stream that sets `content` owns everything and `options` is
/// ignored.
@MainActor
enum NewSessionSlot {
    /// What the sheet will render. Named rather than inferred at the call site, so the choice is
    /// assertable without hosting a view — same reason as `SidebarSlot.Resolution`.
    enum Resolution: Equatable {
        /// The built-in form ships, plus `options` if set.
        case fallback
        /// A stream has taken the whole sheet.
        case slot
    }

    static var content: (@MainActor (AppModel) -> AnyView)?

    /// Extra controls rendered inside the built-in form, below the effort picker and above the
    /// prompt editor. The closure is handed the sheet's own `NewSessionExtras` instance, which
    /// lives for as long as the sheet does.
    static var options: (@MainActor (NewSessionExtras) -> AnyView)?

    static var resolution: Resolution { content == nil ? .fallback : .slot }

    /// Tests and previews only.
    static func reset() {
        content = nil
        options = nil
    }
}
