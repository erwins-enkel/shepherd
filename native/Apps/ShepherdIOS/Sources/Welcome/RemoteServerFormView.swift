import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct RemoteServerFormView: View {
    let onConnect: (ServerProfile) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var pairing = false
    @State private var name: String
    @State private var address = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    /// `name` prefills the server's name, e.g. a mirrored machine's when it is added directly.
    init(name: String = "", onConnect: @escaping (ServerProfile) -> Void) {
        self.onConnect = onConnect
        _name = State(initialValue: name)
    }

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
                // Below the manual fields so large Dynamic Type keeps the address field on screen.
                Section {
                    Button { focused = false; pairing = true } label: {
                        Label(L.t("native_pairing_connect"), systemImage: "qrcode.viewfinder")
                    }.accessibilityIdentifier("scan-pairing-qr-row")
                }
            }
            .navigationTitle(L.t("native_welcome_remote_title"))
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button(L.t("common_cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { focused = false; pairing = true } label: {
                    Image(systemName: "qrcode.viewfinder")
                }.accessibilityLabel(L.t("native_pairing_scan"))
                    .accessibilityIdentifier("scan-pairing-qr")
            } }
            .onAppear { focused = true }
            .fullScreenCover(isPresented: $pairing) {
                PairingSheet(onConnected: { dismiss() }).environment(app)
            }
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
