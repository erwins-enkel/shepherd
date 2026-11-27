import SwiftUI
import UIKit
import ShepherdAppCore
import ShepherdKit

/// The artifact card above the steer capsule (#3878), iOS's `viewport/ArtifactRow.svelte`: the
/// newest artifact the agent published on claude.ai. It takes the merge card's place while the
/// session has no PR and shares its shape.
struct IOSArtifactCard: View {
    let artifact: SessionArtifact
    var rendersStaticFixture = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.openURL) private var openURL

    var body: some View {
        if let url = ArtifactRowRules.url(artifact) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    // Large text: everything stacks, nothing truncates.
                    VStack(alignment: .leading, spacing: 8) {
                        summary
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 8) { moreMenu(url); open(url) }
                            VStack(alignment: .leading, spacing: 8) { moreMenu(url); open(url) }
                        }
                    }
                } else {
                    HStack(spacing: 8) {
                        summary
                        Spacer(minLength: 0)
                        moreMenu(url)
                        open(url)
                    }
                }
            }
            .foregroundStyle(SessionListStyle.ink)
            .padding(.leading, 14).padding(.trailing, 8).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { cardBackground }
            .padding(.horizontal, 10).padding(.top, 6)
            .tint(SessionListStyle.blue)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(L.t("artifactrow_aria"))
            .accessibilityIdentifier("artifact-card")
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label {
                Text(verbatim: L.t("artifactrow_label").uppercased())
            } icon: { Image(systemName: "diamond.fill").accessibilityHidden(true) }
                .sessionFont(label: true, weight: .semibold).foregroundStyle(SessionListStyle.blue)
                .fixedSize(horizontal: false, vertical: true)
            // Agent data: text only.
            Text(verbatim: artifact.title)
                .sessionFont().foregroundStyle(SessionListStyle.bright)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                .fixedSize(horizontal: false, vertical: dynamicTypeSize.isAccessibilitySize)
                .accessibilityIdentifier("artifact-card-title")
            TimelineView(.everyMinute) { context in
                Text(verbatim: ArtifactRowRules.facts(artifact, now: context.date))
                    .sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("artifact-card-facts")
            }
        }
    }

    private func open(_ url: URL) -> some View {
        Button { openURL(url) } label: {
            Label(L.t("native_ios_artifact_open"), systemImage: "arrow.up.right")
                .fixedSize(horizontal: false, vertical: true)
        }
        .buttonStyle(IOSActionButtonStyle(tint: SessionListStyle.blue, minHeight: 48))
        .accessibilityLabel(ArtifactRowRules.accessibilityLabel(artifact))
        .accessibilityHint(L.t("native_ios_artifact_open_hint"))
        .accessibilityIdentifier("artifact-card-open")
    }

    @ViewBuilder private func moreMenu(_ url: URL) -> some View {
        if rendersStaticFixture { moreLabel }
        else {
            Menu {
                Button(L.t("artifactrow_copy"), systemImage: "doc.on.doc") { UIPasteboard.general.string = artifact.url }
                    .accessibilityIdentifier("artifact-card-copy")
                ShareLink(item: url) { Label(L.t("native_ios_artifact_share"), systemImage: "square.and.arrow.up") }
                    .accessibilityIdentifier("artifact-card-share")
            } label: { moreLabel }
                .accessibilityLabel(L.t("artifactrow_more_aria"))
                .accessibilityIdentifier("artifact-card-menu")
        }
    }

    private var moreLabel: some View {
        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
            .foregroundStyle(SessionListStyle.ink)
    }

    /// The merge card's shape: panel, 1 pt line, shadow, glass on iOS 26.
    @ViewBuilder private var cardBackground: some View {
        let shape = RoundedRectangle(cornerRadius: 22)
        if #available(iOS 26.0, *), !rendersStaticFixture {
            shape.fill(SessionListStyle.panel.opacity(0.7)).glassEffect(.regular, in: shape)
        } else { shape.fill(SessionListStyle.panel) }
        shape.stroke(SessionListStyle.line)
            .shadow(color: SessionListStyle.background.opacity(0.45), radius: 8, y: 4)
    }
}
