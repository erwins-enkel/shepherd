import Foundation
import Observation
import ShepherdKit

struct SettingsReadyState {
    private(set) var armed = false
    private(set) var seen: [String:Int] = [:]
    private var dwell: [String:(since:Int,notified:Bool)] = [:]
    mutating func candidates(enabled: Bool, ids: Set<String>, ready: Set<String>, now: Int) -> [String] {
        guard enabled else { self = .init(); return [] }
        seen = seen.filter { ids.contains($0.key) }; dwell = dwell.filter { ids.contains($0.key) }
        for id in ids where seen[id] == nil { seen[id] = now }
        if !armed {
            armed = true
            for id in ready.intersection(ids) { dwell[id] = (now,true) }
            return []
        }
        var result: [String] = []
        for id in ids.sorted() {
            guard ready.contains(id) else { dwell[id] = nil; continue }
            if dwell[id] == nil { dwell[id] = (now,false) }
            guard let entry = dwell[id], !entry.notified,
                  now - entry.since >= 5_000, now - (seen[id] ?? now) >= 15_000 else { continue }
            result.append(id)
        }
        return result
    }
    mutating func sent(_ id: String) { if dwell[id] != nil { dwell[id]?.notified = true } }
}
enum SettingsReadyRules {
    // Mirrors src/ready-stage.ts, whose merged exclusion intentionally differs from the UI lens.
    static func ready(_ session: Session, git: GitState?, reviewing: Bool, working: Bool, now: Int) -> Bool {
        if session.status.known == .running || (session.status.known == .blocked && working) || reviewing {return false}
        if git?.state.known == .merged {return false}
        if let since = session.mergingSince, now - since < 86_400_000 {return false}
        if session.readyToMerge {return true}
        if git?.state.known == .open && git?.checks.known == .pending {return false}
        if git?.state.known == .open && git?.checks.known == .failure {return true}
        if let git, git.state.known == .open,
            git.checks.known == .success || (git.checks.known == .some(.none) && git.noCi == true),
            session.status.known != .running, session.status.known != .blocked {
            if git.isDraft == true {return true}
            return git.handoff?.known != .reviewer && git.handoff?.known != .merger
        }
        return true
    }
    static func allows(kind: String, reduced: Bool, evaluatedReady: Bool) -> Bool {
        guard reduced else {return true}
        if kind == "ready" {return evaluatedReady}
        return ["usage_limit","extra_credits","backup_stale","onboarding_stale"].contains(kind)
    }
}
@MainActor enum SettingsNotificationBridge {
    static var git: (AppModel) -> [String:GitState] = {_ in [:]}
    static var reviewing: (AppModel,String) -> Bool = {_,_ in false}
    static var sendReady: (AppModel,Session) async -> Bool = {_,_ in false}
}
@MainActor final class SettingsReadyModel: AppExtension {
    private var timer: Task<Void,Never>?
    private var state = SettingsReadyState()
    init(store: SessionStore, app: AppModel) {
        let activation = app.activationGeneration
        timer = Task { [weak self,weak app,weak store] in
            while let self, let app, let store, !Task.isCancelled, app.activationGeneration == activation {
                let now = Int(Date().timeIntervalSince1970 * 1000)
                let sessions = store.sessions.filter { $0.status.known != .archived }
                let git = SettingsNotificationBridge.git(app)
                let working = SessionSignals.workingBlocked()
                let ready = Set(sessions.filter { SettingsReadyRules.ready($0,git:git[$0.id],
                    reviewing:SettingsNotificationBridge.reviewing(app,$0.id),working:working[$0.id] == true,now:now) }.map(\.id))
                let enabled = app.extension(SettingsModel.self)?.snapshot?.settings.reducedPushMode == true
                for id in self.state.candidates(enabled:enabled,ids:Set(sessions.map(\.id)),ready:ready,now:now) {
                    guard let session = sessions.first(where:{$0.id == id}) else {continue}
                    let sent = await SettingsNotificationBridge.sendReady(app,session)
                    guard !Task.isCancelled, app.activationGeneration == activation else {return}
                    if sent {self.state.sent(id)}
                }
                do {try await Task.sleep(for:.seconds(1))} catch {return}
            }
        }
    }
    func teardown() {timer?.cancel();timer = nil;state = .init()}
}
