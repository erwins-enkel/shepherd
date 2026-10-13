import SwiftUI
import ShepherdAppCore

/// One switch per connected server that relays its mirrored machines (#3059): "Mirrored
/// machines via <server>". Servers without the capability show nothing here.
struct IOSPushRelaySection: View {
    let hub: IOSServerHub
    var body: some View {
        let push = IOSPushRegistration.shared
        let relaying = hub.connectedIDs.compactMap { id -> (UUID, String)? in
            guard push.isEnabled, hub.models[id]?.extension(IOSInstanceIdentity.self)?.pushRelay == true,
                  let profile = hub.profiles.first(where: { $0.id == id }) else { return nil }
            return (id, profile.name)
        }
        if !relaying.isEmpty {
            Section {
                ForEach(relaying, id: \.0) { id, name in
                    Toggle(L.t("native_ios_push_relay_toggle", name), isOn: Binding(
                        get: { push.relaysMirrored(id) },
                        set: { push.setRelaysMirrored($0, for: id) }))
                        .accessibilityIdentifier("push-relay-\(id)")
                }
            } header: {
                Text(verbatim: L.t("native_ios_push_title"))
            } footer: {
                Text(verbatim: L.t("native_ios_push_relay_hint"))
            }
        }
    }
}
