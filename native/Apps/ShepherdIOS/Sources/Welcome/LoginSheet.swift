import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct LoginSheet: View {
    let profile: ServerProfile
    @Environment(AppModel.self) private var app
    @State private var password = ""
    @State private var state = LoginSheetState()
    @FocusState private var focused: Bool
    var body: some View {
        NavigationStack {
            Form {
                Text(verbatim: L.t("login_subtitle"))
                SecureField(L.t("login_password_label"), text: $password)
                    .textContentType(.password).focused($focused)
                    .accessibilityIdentifier("login-password").onSubmit(submit)
                if let error = state.error { Text(verbatim: error).foregroundStyle(.red) }
                Button(state.busy ? L.t("login_busy") : L.t("login_submit"), action: submit)
                    .disabled(state.busy || password.isEmpty)
                    .accessibilityIdentifier("login-submit")
            }
            .navigationTitle(L.t("native_login_sheet_title", profile.name))
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(L.t("common_cancel")) { dismissIfMatching() }.disabled(state.busy)
            } }
            .onAppear { focused = true }
        }
        .interactiveDismissDisabled(!state.canDismiss)
    }
    private func dismissIfMatching() {
        if app.sheet == .login(profile) { app.sheet = nil }
    }
    private func submit() {
        guard !state.busy, !password.isEmpty else { return }
        state.busy = true
        state.error = nil
        Task {
            defer { password = ""; state.busy = false }
            do {
                try await app.signIn(profile: profile, password: password)
                dismissIfMatching()
            } catch { state.error = ShepherdErrorCopy.message(error) }
        }
    }
}
