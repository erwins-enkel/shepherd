import SwiftUI
import ShepherdKit

/// The sheet's busy/dismiss gate, pulled out of the view so it is unit-testable
/// without hosting SwiftUI (see LoginSheetStateTests).
struct LoginSheetState: Equatable {
    var busy = false
    var error: String?
    /// While a sign-in request is in flight, Cancel and the sheet's own
    /// interactive dismissal must both be blocked: dismissing does not cancel
    /// the untracked `Task` in `submit()`, so a stale success would later
    /// activate the wrong profile and fire a dismissal closure that now
    /// belongs to a different sheet.
    var canDismiss: Bool { !busy }
}

/// Password → token mint → Keychain, via ProfileSetup. The password is never
/// persisted. Also used as the re-login sheet when the store reports .needsLogin.
struct LoginSheet: View {
    let profile: ServerProfile
    let onDismiss: () -> Void

    @Environment(AppModel.self) private var model
    @State private var password = ""
    @State private var state = LoginSheetState()
    @FocusState private var passwordFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: L.t("native_login_sheet_title", profile.name))
                .font(.title2.weight(.semibold))
            Text(verbatim: L.t("login_subtitle"))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            SecureField(
                L.t("login_password_label"),
                text: $password,
                prompt: Text(verbatim: L.t("login_password_placeholder"))
            )
            .textFieldStyle(.roundedBorder)
            .focused($passwordFocused)
            .onSubmit { submit() }
            .accessibilityIdentifier("login-password")

            if let error = state.error {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
            }

            HStack {
                Button(L.t("common_cancel")) { onDismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(state.busy)
                Spacer()
                Button(state.busy ? L.t("login_busy") : L.t("login_submit")) { submit() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(state.busy || password.isEmpty)
            }
        }
        .padding(24)
        .frame(width: 420)
        .onAppear { passwordFocused = true }
        // Mirrors the Cancel button's .disabled(state.busy): the sheet's own
        // close affordance (Esc, click-outside) must not out-run the in-flight
        // request either. See LoginSheetState.canDismiss.
        .interactiveDismissDisabled(!state.canDismiss)
    }

    private func submit() {
        guard !state.busy, !password.isEmpty else { return }
        state.busy = true
        state.error = nil
        Task {
            defer { state.busy = false }
            do {
                try await model.signIn(profile: profile, password: password)
                password = ""
                onDismiss()
            } catch {
                // ShepherdErrorCopy is exhaustive over ShepherdError, so a wrong
                // password reads "wrong password" and every other failure reads as
                // itself instead of as a Swift dump.
                state.error = ShepherdErrorCopy.message(error)
            }
        }
    }
}
