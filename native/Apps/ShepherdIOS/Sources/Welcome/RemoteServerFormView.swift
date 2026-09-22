import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct RemoteServerFormView: View {
    let onConnect: (ServerProfile) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var address = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L.t("native_welcome_remote_name_label"), text: $name)
                        .accessibilityIdentifier("server-name")
                    TextField(L.t("native_welcome_remote_url_label"), text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focused).accessibilityIdentifier("server-address")
                        .onSubmit(submit)
                } footer: { Text(verbatim: L.t("native_welcome_remote_body")) }
                if let error { Text(verbatim: error).foregroundStyle(.red) }
                Button(L.t("native_welcome_connect"), action: submit)
                    .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("connect-server")
                    .keyboardShortcut(.defaultAction)
            }
            .navigationTitle(L.t("native_welcome_remote_title"))
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(L.t("common_cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
            } }
            .onAppear { focused = true }
        }
    }
    private func submit() {
        do {
            let profile = try app.addRemoteProfile(name: name, address: address)
            onConnect(profile)
            dismiss()
        } catch { self.error = ShepherdErrorCopy.message(error) }
    }
}
