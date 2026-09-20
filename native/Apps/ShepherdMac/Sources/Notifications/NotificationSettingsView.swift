import ShepherdKit
import SwiftUI

/// The per-profile notification switches.
///
/// The two pure helpers exist so the panel's three permission states are assertable without
/// hosting SwiftUI — the same reason `SidebarSlot.Resolution` and `DetailTabRegistry.Layout` are
/// named rather than decided inline.
struct NotificationSettingsView: View {
    let model: NotificationsModel
    let profileName: String

    /// `nil` unless macOS has actually refused; "not yet asked" is a button, not a warning.
    static func permissionNote(for authorization: NotificationAuthorization) -> String? {
        authorization == .denied ? L.t("native_notify_settings_permission_denied") : nil
    }

    static func showsAskButton(for authorization: NotificationAuthorization) -> Bool {
        authorization == .notDetermined
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: L.t("native_notify_settings_title")).font(.headline)
            Text(verbatim: L.t("native_notify_settings_scope", profileName))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let note = Self.permissionNote(for: model.authorization) {
                // Not `NoticeBar`: it always draws a close (×) button, and this notice has no
                // state for a dismiss to clear — it is derived from `model.authorization` and
                // reappears the moment macOS is asked again. A dead close button is worse than
                // none, so this renders the same warning without one.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                    Text(verbatim: note)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.12))
                .accessibilityIdentifier("notify-permission-denied")
            }
            if Self.showsAskButton(for: model.authorization) {
                Button(L.t("native_notify_settings_permission_ask")) {
                    Task { await model.requestAuthorization() }
                }
                .accessibilityIdentifier("notify-request-permission")
            }

            Toggle(
                L.t("native_notify_settings_enabled"),
                isOn: Binding(
                    get: { model.settings.enabled },
                    set: { model.save(model.settings.settingEnabled($0)) })
            )
            .accessibilityIdentifier("notify-enabled")

            ForEach(NotificationCategory.allCases, id: \.rawValue) { category in
                Toggle(
                    category.label,
                    isOn: Binding(
                        get: { model.settings.isOn(category) },
                        set: { model.save(model.settings.setting(category, to: $0)) })
                )
                .disabled(!model.settings.enabled)
                .padding(.leading, 18)
                .accessibilityIdentifier("notify-category-\(category.rawValue)")
            }

            Text(verbatim: L.t("native_notify_settings_quiet_hint"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(width: 420, alignment: .leading)
        .accessibilityIdentifier("notification-settings")
    }
}
