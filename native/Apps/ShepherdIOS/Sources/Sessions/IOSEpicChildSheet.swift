import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSEpicChildSheet: View {
    let control: IOSEpicControl
    let digest: EpicDigest
    let child: EpicChild
    let session: (() -> Void)?
    let created: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var composing = false
    var body: some View {
        NavigationStack {
            ScrollView {
                IOSEpicChildContent(digest: digest, child: child, writable: control.writable,
                    start: { composing = true }, session: session.map { open in { open(); dismiss() } })
            }.background(SessionListStyle.background)
                .navigationTitle(Text(verbatim: "#\(child.number)"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L.t("common_close")) { dismiss() } } }
        }.presentationDetents([.large]).preferredColorScheme(.dark).tint(SessionListStyle.amber)
            .sheet(isPresented: $composing) {
                IOSEpicChildComposer(control: control, child: child, close: { composing = false }, created: { id in
                    composing = false; created(id)
                })
            }
    }
}

struct IOSEpicChildContent: View {
    let digest: EpicDigest
    let child: EpicChild
    var writable = true
    var start: () -> Void = {}
    var session: (() -> Void)?
    @State private var description = false
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                Text(verbatim: L.t("native_ios_epic_step", String(child.order + 1), String(digest.total)))
                    .foregroundStyle(SessionListStyle.muted)
                Spacer(minLength: 0)
                IOSEpicRunChip(text: IOSEpicCopy.state(child))
            }.sessionFont(label: true)
            Text(verbatim: child.title).sessionFont(weight: .semibold).foregroundStyle(SessionListStyle.bright)
            if let chain = digest.chain(child.number) { IOSEpicChainStrip(chain: chain) }
            if let session {
                IOSEpicActionButton(title: L.t("native_ios_epic_open_session"), icon: "terminal", action: session)
            } else if child.sessionId != nil {
                Text(verbatim: L.t("native_ios_epic_session_unavailable")).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
            } else if writable, IOSEpicPolicy.canStart(child) {
                IOSEpicActionButton(title: L.t(child.isReady ? "native_ios_epic_start_child" : "native_ios_epic_start_anyway"), icon: "play", action: start)
            }
            if let url = IOSEpicPolicy.prURL(child), let number = child.prNumber {
                link(L.t("native_ios_epic_open_pr", String(number)), url: url)
            }
            if let url = URL(string: child.url), ["http", "https"].contains(url.scheme ?? "") {
                link(L.t("native_ios_epic_open_issue"), url: url)
            }
            DisclosureGroup(L.t("native_ios_epic_description"), isExpanded: $description) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(verbatim: expanded ? child.body : String(child.body.prefix(600)))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if child.body.count > 600 {
                        Button(L.t(expanded ? "native_ios_epic_less" : "native_ios_epic_more")) { expanded.toggle() }.frame(minHeight: 44)
                    }
                }.sessionFont(label: true).padding(.top, 10)
            }.sessionFont(label: true)
        }.padding(16).foregroundStyle(SessionListStyle.ink)
    }
    private func link(_ title: String, url: URL) -> some View {
        Link(destination: url) {
            Label(title, systemImage: "arrow.up.right.square").sessionFont(label: true)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }.foregroundStyle(SessionListStyle.blue)
    }
}

/// The existing composer handles issue attachment, branches, shaping and explicit submission.
private struct IOSEpicChildComposer: View {
    let control: IOSEpicControl
    let child: EpicChild
    let close: () -> Void
    let created: (String) -> Void
    @State private var model: ComposeModel?
    var body: some View {
        ZStack {
            ComposePalette.bg.ignoresSafeArea()
            if let store = control.owner.store, let model {
                IOSComposeContent(app: control.owner, store: store, activation: control.owner.activationGeneration,
                    model: model, fixtureCurrent: { control.current && control.writable }, close: close, onCreated: created)
                    .environment(control.owner)
            }
        }.task {
            guard model == nil, control.writable, let store = control.owner.store else { return }
            let value = ComposeModel(client: store.client, defaults: control.owner.composerDefaults,
                runDefaults: ComposeRunConfig.defaults(from: store.settings))
            value.repoPath = control.group.repoPath
            value.pickIssue(IOSEpicPolicy.issue(child))
            model = value
        }.presentationDetents([.large]).preferredColorScheme(.dark)
    }
}
