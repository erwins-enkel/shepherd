import Foundation
import Testing
import ShepherdKit

@testable import ShepherdAppCore

@MainActor
private func settle(until condition: () -> Bool, yields: Int? = nil) async -> Bool {
    if let yields {
        for _ in 0..<yields {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
    }
    let deadline = ContinuousClock.now + .seconds(10)
    while ContinuousClock.now < deadline {
        if condition() { return true }
        await Task.yield()
    }
    return condition()
}

@MainActor
private final class SeenIDs {
    var value: Set<String>?
}

extension CoreSeamTests {
/// Sessions mirrored from connected machines (#2768): the copy, the grouping and the terminal
/// rules both apps share. Each assertion mirrors `ui/src/lib/remote-sessions.ts` or
/// `RemoteTerminal.svelte`.
@MainActor
struct RemoteSessionsTests {
    private let now = 1_790_000_000_000

    private func mirrored(
        _ id: String, machine: String = "mac", name: String = "MacBook", desig: String = "TASK-07",
        connected: Bool = true, since: Int = 1_790_000_000_000
    ) -> Session {
        var session = PreviewData.session(id: id, desig: desig)
        session.host = SessionHost(
            instanceId: machine, name: name, platform: InstancePlatform(known: .macos))
        session.connection = SessionConnection(
            state: .init(known: connected ? .connected : .disconnected), since: since)
        return session
    }

    @Test func aMirroredSessionIsLabelledWithItsMachine() {
        let local = PreviewData.session(id: "l", desig: "TASK-01")
        let remote = mirrored("r")
        #expect(RemoteSessionCopy.qualifiedDesig(remote) == "MacBook · TASK-07")
        #expect(RemoteSessionCopy.qualifiedDesig(local) == "TASK-01")
        #expect(RemoteSessionCopy.isMirrored(remote))
        #expect(!RemoteSessionCopy.isMirrored(local))
        #expect(RemoteSessionCopy.platformName(InstancePlatform(known: .macos)) == "macOS")
        #expect(RemoteSessionCopy.platformName(InstancePlatform(known: .linux)) == "Linux")
        #expect(RemoteSessionCopy.platformName(InstancePlatform(unknown: "plan9")) == "plan9")
    }

    @Test func onlyADisconnectedMachineGetsTheLastKnownLine() throws {
        #expect(RemoteSessionCopy.disconnectedLine(mirrored("r"), now: now) == nil)
        #expect(RemoteSessionCopy.disconnectedLine(PreviewData.session(id: "l"), now: now) == nil)
        let line = try #require(RemoteSessionCopy.disconnectedLine(mirrored("r", connected: false), now: now))
        #expect(line.contains(RemoteSessionCopy.lastKnown(since: now, now: now)))
        #expect(!line.contains("%"))
    }

    @Test func lastKnownIsAClockTimeTodayAndADateBefore() {
        let today = Date(timeIntervalSince1970: Double(now) / 1_000)
        #expect(RemoteSessionCopy.lastKnown(since: now, now: now)
            == today.formatted(date: .omitted, time: .shortened))
        let earlier = now - 3 * 86_400_000
        #expect(RemoteSessionCopy.lastKnown(since: earlier, now: now)
            == Date(timeIntervalSince1970: Double(earlier) / 1_000).formatted(date: .numeric, time: .shortened))
    }

    @Test func theExplanationNamesTheMachineTheLinkAndTheActions() throws {
        let remote = mirrored("r", connected: false)
        let host = try #require(remote.host)
        let connection = try #require(remote.connection)
        let mac = RemoteSessionCopy.explanation(host: host, connection: connection, now: now)
        #expect(mac.title.contains("MacBook"))
        #expect(mac.summary.contains("macOS"))
        #expect(mac.sections.count == 2)
        #expect(mac.sections[0].text.contains("MacBook"))
        #expect(mac.sections[0].text.contains(RemoteSessionCopy.lastKnown(since: connection.since, now: now)))
        let ios = RemoteSessionCopy.explanation(
            host: host, connection: connection, now: now, terminalHere: false)
        #expect(ios.sections[1].text != mac.sections[1].text)
        #expect(ios.sections[1].text.contains("MacBook"))
        for text in [mac.title, mac.summary] + mac.sections.map(\.text) + ios.sections.map(\.text) {
            #expect(!text.contains("%"), "unformatted placeholder in \(text)")
        }
    }

    @Test func machineGroupsFollowFirstAppearanceAndSkipLocalSessions() {
        let groups = HerdMachineGroup.groups([
            mirrored("a1"), mirrored("b1", machine: "box", name: "Box"),
            PreviewData.session(id: "local"), mirrored("a2"),
        ])
        #expect(groups.map(\.id) == ["mac", "box"])
        #expect(groups[0].sessions.map(\.id) == ["a1", "a2"])
        #expect(groups[1].host.name == "Box")
    }

    @Test func theSidebarShowsMachineGroupsInTheAllLensOnly() {
        let model = SidebarModel(reads: .stub, now: { 1_800_000_000_000 })
        model.install(sessions: [PreviewData.session(id: "local")])
        model.install(remoteSessions: [mirrored("r")])
        #expect(model.machineGroups.map(\.id) == ["mac"])
        #expect(!model.sessions.contains { $0.id == "r" })
        // The repo filter names this server's checkouts and never hides another machine's work.
        model.selectedRepos = ["/somewhere/else"]
        #expect(model.machineGroups.map(\.id) == ["mac"])
        model.lens = .ready
        #expect(model.machineGroups.isEmpty)
    }

    @Test func aTerminalWhoseMachineWasUnreachableReattachesOnlyWhenItIsBack() async {
        let attachment = FakeAttachment()
        let model = TerminalSessionModel(sessionID: "r", reply: { _ in },
            makeAttachment: { _, _ in attachment })
        let up = SessionConnection(state: .init(known: .connected), since: 10)
        model.machineConnectionChanged(up)
        model.attach(cols: 80, rows: 24)
        attachment.emit(.attached)
        #expect(await settle(until: { model.phase == .live }))
        attachment.emit(.closed(.machineUnreachable))
        #expect(await settle(until: { model.phase == .ended(.machineUnreachable) }))

        // The same link it ended on, or the machine reported down, changes nothing.
        model.machineConnectionChanged(up)
        model.machineConnectionChanged(SessionConnection(state: .init(known: .disconnected), since: 20))
        #expect(attachment.takeOverCount == 0)
        #expect(model.phase == .ended(.machineUnreachable))

        // Back: a connected link that began after the end re-attaches once.
        model.machineConnectionChanged(SessionConnection(state: .init(known: .connected), since: 30))
        #expect(attachment.takeOverCount == 1)
        #expect(model.phase == .connecting)
        model.detach()
    }

    @Test func theTerminalControllerKeepsAMirroredSessionsModel() async throws {
        let profile = ServerProfile(
            name: "fake", baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local, credentialKey: "k")
        let store = SessionStore(client: try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore()))
        let payload = try JSONEncoder().encode(
            RemoteSessionsEvent(instanceId: "mac", sessions: [mirrored("r")]))
        store.apply(.unknown(name: "remote:sessions", payload: payload))
        #expect(store.remoteSessions.map(\.id) == ["r"])

        let seen = SeenIDs()
        let watcher = TerminalController.watchSessions(store) { seen.value = $0 }
        defer { watcher.cancel() }
        #expect(await settle(until: { seen.value == ["r"] }))
    }
}
}
