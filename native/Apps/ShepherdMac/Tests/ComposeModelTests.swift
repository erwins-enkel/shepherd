import AppKit
import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd
@testable import ShepherdAppCore

extension MacSeamTests {
@MainActor @Suite struct ComposeModelTests {
    @Test func chooserDropAndPasteInputsShareTheFileQueue() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("compose-\(UUID()).txt")
        try Data("file bytes".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        var received: [(String, Data)] = []
        let uploads = AttachmentModel(upload: { data, name in
            received.append((name, data))
            return "/staged/" + name
        })
        defer { uploads.teardown() }
        uploads.addFiles([url, URL(string: "https://example.test/ignored")!])
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(received.count == 1 && received[0].0 == url.lastPathComponent)
        #expect(received[0].1 == Data("file bytes".utf8))

        let provider = NSItemProvider()
        provider.suggestedName = "screenshot"
        provider.registerDataRepresentation(forTypeIdentifier: "public.png", visibility: .all) { completion in
            completion(Data([137, 80, 78, 71]), nil)
            return nil
        }
        uploads.paste([provider])
        #expect(uploads.hasOutstandingUploads && uploads.pendingImports == 1)
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(received.count == 2 && received[1].0 == "screenshot.png")
        #expect(received[1].1 == Data([137, 80, 78, 71]))

        let fileProvider = NSItemProvider()
        fileProvider.registerDataRepresentation(forTypeIdentifier: "public.file-url", visibility: .all) { completion in
            completion(url.dataRepresentation, nil)
            return nil
        }
        fileProvider.registerDataRepresentation(forTypeIdentifier: "public.png", visibility: .all) { completion in
            completion(Data([0]), nil)
            return nil
        }
        uploads.paste([fileProvider])
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(received.count == 3 && received[2].0 == url.lastPathComponent)
        #expect(received[2].1 == Data("file bytes".utf8))
    }

    @Test(arguments: [false, true])
    func sheetOpenedBeforeBootstrapReconcilesPickerSelections(explicit: Bool) async throws {
        let suite = "ComposeBootstrapTests.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let credentials = InMemoryCredentialStore()
        let app = AppModel(defaults: defaults, credentials: credentials, notifications: MacTestSupport.environment(defaults: defaults))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ComposeBootstrapProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = try ShepherdClient(profile: .init(name: "fixture", baseURL: URL(string: "https://compose.invalid")!,
            mode: .remote), credentials: credentials, urlSession: session)
        let store = SessionStore(client: client)
        let model = Self.composer()
        let host = NSHostingView(rootView: ComposeSheetContent(app: app, store: store, activation: 0, model: model))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 740, height: 780),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        defer {
            window.orderOut(nil); window.contentView = nil
            model.teardown(); store.stop(); app.teardown(); session.invalidateAndCancel()
            defaults.removePersistentDomain(forName: suite)
        }
        #expect(store.settings == nil)
        if explicit {
            model.selectProviderManually(.claude); model.model = "sonnet"; model.effort = "high"
        }
        try await store.bootstrap()
        try await eventually { model.runDefaults.provider == .codex }
        #expect(EnginePicker(model: model).selection.wrappedValue == (explicit ? .claude : .codex))
        #expect(model.model == (explicit ? "sonnet" : "gpt-6-astra"))
        #expect(model.effort == (explicit ? "high" : "ultra"))
        #expect(ModelPicker(model: model).options.contains(model.model))
        #expect(EffortPicker(model: model).options.contains(model.effort))
        // Opt-in screenshot handoff: the regular unit suite never waits or exposes a window.
        if !explicit, let marker = ProcessInfo.processInfo.environment["SHEPHERD_COMPOSE_CAPTURE"] {
            let webURL = URL(fileURLWithPath: marker).deletingLastPathComponent().appendingPathComponent("web-composer.png")
            let webImage = try #require(NSImage(contentsOf: webURL))
            let screenshotModel = ComposeModel(defaults: defaults,
                repoBranches: RepoBranchModel(loadBranches: { _ in .init(branches: ["main"]) },
                    loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: true, localExists: true) },
                    repair: { _, branch in .init(branch: branch) }),
                loadIssues: { _ in .init(slug: "example/storefront", issues: [
                    .init(number: 121, title: "Wishlist button on product cards", body: "Add a wishlist button.",
                          url: "https://example.com/issues/121", labels: [], createdAt: 0, assignees: []),
                    .init(number: 122, title: "Empty-cart illustration", body: "Illustrate the empty cart.",
                          url: "https://example.com/issues/122", labels: [], createdAt: 0, assignees: [])
                ]) }, loadCommands: { _, _ in .init(commands: []) },
                loadEpics: { _ in .init(epics: [], subIssues: []) })
            screenshotModel.repoPath = "/repo"
            await screenshotModel.loadSources()
            defer { screenshotModel.teardown() }
            let comparison = NSHostingView(rootView: HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Web · local demo").font(.title2.bold())
                    ZStack(alignment: .topLeading) {
                        Color.clear
                        Image(nsImage: webImage).resizable()
                            .frame(width: 897 * 1.4, height: 769 * 1.4)
                            .offset(x: -261 * 1.4, y: -239 * 1.4)
                    }.frame(width: 482 * 1.4, height: 336 * 1.4, alignment: .topLeading).clipped()
                }
                VStack(alignment: .leading, spacing: 16) {
                    Text("macOS · local fixture").font(.title2.bold())
                    ComposeSheetContent(app: app, store: store, activation: 0, model: screenshotModel)
                }
            }.padding(24).background(Color(nsColor: .windowBackgroundColor)))
            window.styleMask = [.titled, .closable]
            window.contentView = comparison
            window.setContentSize(NSSize(width: 1490, height: 860))
            window.title = "S11 composer fixture"
            window.center()
            window.makeKeyAndOrderFront(nil)
            print("compose fixture capture ready")
            let deadline = ContinuousClock.now + .seconds(120)
            while !FileManager.default.fileExists(atPath: marker), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(250))
            }
        }

    }

    static func composer(attachments: AttachmentModel? = nil, shaping: ShapeRoundModel? = nil) -> ComposeModel {
        ComposeModel(defaults: UserDefaults(suiteName: "ComposeModeTests.\(UUID())")!,
                     repoBranches: RepoBranchModel(
                        loadBranches: { _ in .init(branches: []) },
                        loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false) },
                        repair: { _, branch in .init(branch: branch) }),
                     loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
                     loadEpics: { _ in .init(epics: [], subIssues: []) }, attachments: attachments, shaping: shaping)
    }

    private func model(
        branches: @escaping (String) async throws -> BranchListing = { _ in .init(branches: []) },
        status: @escaping (String, String) async throws -> BranchStatus = { _, _ in
            .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false)
        },
        repair: @escaping (String, String) async throws -> InitEmptyCommitResponse = { _, branch in .init(branch: branch) },
        sleep: @escaping (Duration) async throws -> Void = { _ in }
    ) -> RepoBranchModel {
        RepoBranchModel(loadBranches: branches, loadStatus: status, repair: repair, debounce: sleep)
    }

    private func eventually(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        #expect(predicate())
    }

}
}

extension MacSeamTests {
@MainActor @Suite struct ComposeCapacityTests {
    private func limits(_ fields: String = "") throws -> UsageLimits {
        try JSONDecoder().decode(UsageLimits.self, from: Data("""
        {"perModelWeek":[],"stale":false,"calibratedAt":null,"subscriptionOnly":false\(fields)}
        """.utf8))
    }

    @Test func staleClaudeObservationsStillDimTheLine() throws {
        let usage = try limits(#", "observed":{"week":{"pct":7,"resetAt":2000,"scrapedAt":1}}"#)
        var stale = usage
        stale.stale = true
        for (value, opacity) in [(usage, 1.0), (stale, 0.55)] {
            let line = CapacityLine(provider: .claude, usageLimits: { value })
            #expect(capacityElements(_OpacityEffect.self, in: line.body).map(\.opacity) == [opacity])
            #expect(capacityElements(_OpacityEffect.self, in: line.allWindows).map(\.opacity) == [opacity, 1],
                    "The popover must dim Claude independently of Codex, including unavailable rows")
        }
    }

    @Test func severityBoundariesUseUsedCapacity() throws {
        for (used, expected) in [(0.0, Color.secondary), (50, .secondary), (50.01, .orange),
                                 (90, .orange), (90.01, .red), (100, .red)] {
            let usage = try limits(", \"week\":{\"pct\":\(used),\"resetAt\":0}")
            let line = CapacityLine(provider: .claude, usageLimits: { usage })
            try expectCapacityTint(expected, in: line.body)
            try expectCapacityTint(expected, in: line.allWindows)
        }
    }

    @Test func reconnectRereadRendersFivePercentFreeAfterAnOlderSevenPercentPush() async throws {
        let suite = "ComposeCapacityTests.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: MacTestSupport.environment(defaults: defaults))
        let store = try SessionStore(
            profile: .init(name: "capacity", baseURL: URL(string: "https://capacity.invalid")!, mode: .remote),
            credentials: InMemoryCredentialStore())
        let sidebar = SidebarModel(store: store, app: app)
        let old = try limits(#", "week":{"pct":7,"resetAt":0}"#)
        let fresh = try limits(#", "week":{"pct":95,"resetAt":0}"#)
        // Replace reads before yielding to bootstrap; the store is never started.
        sidebar.reads = SidebarReads(workingBlocked: { [:] }, holds: { [:] }, blocks: { [:] },
                                     usage: { .init(limits: old, projections: []) })
        defer { sidebar.teardown(); app.teardown() }
        func settle(_ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(3)
            while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
            try #require(predicate())
        }
        try await settle { sidebar.usage != nil }
        let connection = ConnectionBox()
        var observed: ConnectionState?
        sidebar.watchConnection { observed = connection.state; return connection.state }
        try await settle { observed == .idle }
        connection.state = .live
        try await settle { observed == .live }
        store.apply(.usageLimits(old))

        // Exercise the default cross-stream reader without keeping process-wide test state
        // installed across an await (other seam suites can run while this test suspends).
        func throughSeam<T>(_ read: () throws -> T) rethrows -> T {
            let previous = SessionSignals.usageLimits
            SessionSignals.usageLimits = { sidebar.limits }
            defer { SessionSignals.usageLimits = previous }
            return try read()
        }
        let line = throughSeam { CapacityLine(provider: .claude) }
        let initial = try throughSeam { try #require(line.state.selected) }
        #expect(initial.window.remainingPct == 93)
        connection.state = .offline(message: "disconnected")
        try await settle { observed == connection.state }
        sidebar.reads.usage = { .init(limits: fresh, projections: []) }
        connection.state = .live
        try await settle { sidebar.usage?.limits.week?.pct == 95 }

        let reconciled = try throughSeam { try #require(line.state.selected) }
        #expect(reconciled.code == "CC·WK")
        #expect(reconciled.window.remainingPct == 5)
        #expect(reconciled.window.freeCopy == L.t("newtask_provider_capacity_free", "5"))
        #expect(reconciled.window.tint == .red)
        store.apply(.usageLimits(old))
        #expect(try throughSeam { try #require(line.state.selected) }.window.remainingPct == 93)
    }

    @Test func engineBindingHonorsCommandConstraintAndUnlocksWhenRemoved() {
        let model = ComposeModelTests.composer()
        defer { model.teardown() }
        let picker = EnginePicker(model: model)
        model.selectProviderManually(.claude)
        #expect(picker.selection.wrappedValue == .claude)
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .codex)
        #expect(picker.selection.wrappedValue == .codex)
        picker.selection.wrappedValue = .claude
        #expect(model.provider == .claude)
        model.pickCommand(.init(name: "ship", description: "Ship", scope: .init(known: .project), providers: [.claude]))
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .claude)
        model.prompt = "new task"
        #expect(model.allowsProvider(.codex))
        model.selectProviderManually(.claude)
        #expect(model.provider == .claude)
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .codex)
    }
}
}

/// Walk the actual SwiftUI value tree, expanding ForEach's rendered content instead
/// of inspecting its input models. Keep SDK reflection confined to this test helper.
@MainActor private protocol CapacityForEachContent {
    var capacityChildren: [Any] { get }
}

extension ForEach: CapacityForEachContent where Content: View {
    fileprivate var capacityChildren: [Any] { data.map { content($0) } }
}

@MainActor private func capacityElements<Element>(
    _ type: Element.Type, in value: Any, depth: Int = 0
) -> [Element] {
    if let element = value as? Element { return [element] }
    guard depth < 40 else { return [] }
    if let repeated = value as? any CapacityForEachContent {
        return repeated.capacityChildren.flatMap { capacityElements(type, in: $0, depth: depth + 1) }
    }
    let mirror = Mirror(reflecting: value)
    // Do not enter reference graphs (state, environment storage, color providers).
    guard mirror.displayStyle != .class else { return [] }
    return mirror.children.flatMap { capacityElements(type, in: $0.value, depth: depth + 1) }
}

@MainActor private func expectCapacityTint(_ expected: Color, in view: some View) throws {
    // Derive the tint environment key from SwiftUI itself, not a private key name.
    let reference = capacityElements(_EnvironmentKeyWritingModifier<AnyShapeStyle?>.self,
                                     in: EmptyView().tint(Color.red))
    let key = try #require(reference.first?.keyPath)
    let modifiers = capacityElements(_EnvironmentKeyWritingModifier<AnyShapeStyle?>.self, in: view)
        .filter { $0.keyPath == key }
    #expect(modifiers.count == 1, "The rendered meter must apply exactly one tint")
    let style = try #require(modifiers.first?.value)
    // AnyShapeStyle type-erases Color, but its storage retains SwiftUI's equality.
    // Require that representation explicitly so SDK changes fail visibly.
    let actual = try #require(Mirror(reflecting: style).descendant("storage") as? any Equatable)
    let wanted = try #require(Mirror(reflecting: AnyShapeStyle(expected)).descendant("storage"))
    func equals<T: Equatable>(_ value: T, _ other: Any) -> Bool { value == other as? T }
    let matches = equals(actual, wanted)
    #expect(matches, "The rendered tint must match the severity color")
}

/// Uploads reject a credential; every secondary exchange fails offline.
final class ComposeUploadProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.path == "/api/uploads" else {
            Issue.record("Upload attempted a secondary request")
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer rejected-token")
        let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"error":"unauthorized"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// In-memory HTTP fixture: opening before bootstrap must exercise the sheet's actual onChange.
private final class ComposeBootstrapProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let body: String
        switch request.url?.path {
        case "/api/settings":
            body = #"{"repoRoot":"/repo","repoRootDisplay":"repo","firstRunPending":false,"defaultModel":"opus","defaultCodexModel":"gpt-6-astra","defaultEffort":"ultra","defaultAgentProvider":"codex","authMode":"subscription","operatorLanguage":"en"}"#
        case "/api/repos":
            body = #"{"recentWindowDays":7,"repos":[{"name":"shepherd","path":"/repo","display":"shepherd","realPath":"/repo","isFork":false,"hidden":false}]}"#
        case "/api/sessions": body = "[]"
        default: body = "{}"
        }
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Fixture responses for the production replacement -> store refresh path; no shared state.
private final class ComposeReplacementProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let encoded = request.value(forHTTPHeaderField: "X-Compose-Fixture"),
              let session = Data(base64Encoded: encoded), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let body: Data
        switch url.path {
        case "/api/sessions/replace-existing/replace":
            body = Data("{\"session\":".utf8) + session + Data("}".utf8)
        case "/api/sessions": body = Data("[".utf8) + session + Data("]".utf8)
        case "/api/settings":
            body = Data(#"{"repoRoot":"/repo","repoRootDisplay":"repo","firstRunPending":false,"defaultModel":"auto","defaultEffort":"default","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"en"}"#.utf8)
        case "/api/repos": body = Data(#"{"recentWindowDays":7,"repos":[]}"#.utf8)
        default:
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
