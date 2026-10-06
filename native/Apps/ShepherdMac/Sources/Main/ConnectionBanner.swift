import ShepherdAppCore
import SwiftUI
import ShepherdKit

struct ConnectionBanner: View {
    let kind: BannerKind
    /// Disables Retry while one is already in flight, so a second click cannot
    /// start a second round trip.
    var isRetrying: Bool = false
    var localPresentation: LocalConnectionBannerPolicy? = nil
    var localBusy = false
    var onLocalAction: (LocalConnectionBannerPolicy.Action) -> Void = { _ in }
    let onRetry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: kind.systemImage)
                .accessibilityHidden(true)
            Text(verbatim: localPresentation?.message ?? kind.message)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let localPresentation {
                if let action = localPresentation.action {
                    Button(action.title) { onLocalAction(action) }
                        .buttonStyle(.link)
                        .disabled(localBusy)
                }
            } else {
                Button(L.t("common_retry"), action: onRetry)
                    .buttonStyle(.link)
                    .disabled(isRetrying)
            }
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.yellow.opacity(0.18))
        .overlay(alignment: .bottom) { Divider() }
        .accessibilityIdentifier("connection-banner")
    }
}

#if DEBUG
#Preview("Banners") {
    VStack(spacing: 0) {
        ConnectionBanner(kind: .offline(server: "Studio")) {}
        ConnectionBanner(kind: .contractMismatch(server: "1.47.0", app: "0.1.0")) {}
        ConnectionBanner(kind: .clientTooOld(minimum: "3.42.0", app: "3.41.0")) {}
        ConnectionBanner(kind: .unhealthy(server: "Studio")) {}
        ConnectionBanner(kind: .needsLogin, isRetrying: true) {}
    }
    .frame(width: 640)
}
#endif
