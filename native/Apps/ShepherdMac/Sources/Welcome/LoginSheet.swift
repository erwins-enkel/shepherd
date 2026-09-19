import SwiftUI
import ShepherdKit

/// Password → token mint → Keychain, via ProfileSetup. The password is never
/// persisted. Also used as the re-login sheet when the store reports .needsLogin.
struct LoginSheet: View {
    let profile: ServerProfile
    let onDismiss: () -> Void

    @Environment(AppModel.self) private var model
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
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

            if let error {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
            }

            HStack {
                Button(L.t("common_cancel")) { onDismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button(busy ? L.t("login_busy") : L.t("login_submit")) { submit() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || password.isEmpty)
            }
        }
        .padding(24)
        .frame(width: 420)
        .onAppear { passwordFocused = true }
    }

    private func submit() {
        guard !busy, !password.isEmpty else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.signIn(profile: profile, password: password)
                password = ""
                onDismiss()
            } catch {
                // ShepherdErrorCopy is exhaustive over ShepherdError, so a wrong
                // password reads "wrong password" and every other failure reads as
                // itself instead of as a Swift dump.
                self.error = ShepherdErrorCopy.message(error)
            }
        }
    }
}
