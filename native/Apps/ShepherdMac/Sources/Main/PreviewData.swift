#if DEBUG
import Foundation
import ShepherdKit

/// Sample values for SwiftUI previews and for the view unit tests.
///
/// The session is built by DECODING contract-shaped JSON rather than by calling the
/// generated memberwise initialiser: swift-openapi-generator orders that initialiser's
/// parameters by schema order, which is not something this plan can pin, and decoding
/// tolerates the contract gaining a new optional property without a source change.
///
/// DEBUG only — none of this ships in a Release build.
enum PreviewData {
    static func session(
        id: String = "s1",
        desig: String = "TASK-01",
        name: String = "wire up the toolbar",
        prompt: String = "Wire the toolbar buttons to the session store.",
        status: SessionStatus = SessionStatus(known: .running),
        agentProvider: AgentProvider? = .claude,
        branch: String? = "feat/toolbar"
    ) -> Session {
        var payload: [String: Any] = [
            "id": id,
            "desig": desig,
            "name": name,
            "prompt": prompt,
            "repoPath": "/repos/demo",
            "baseBranch": "main",
            "worktreePath": "/repos/demo-\(id)",
            "isolated": false,
            "herdrSession": "herdr-\(id)",
            "herdrAgentId": "agent-\(id)",
            "claudeSessionId": "claude-\(id)",
            "readyToMerge": false,
            "autopilotPaused": false,
            "autopilotComplete": false,
            "auto": false,
            "status": status.rawValue,
            "lastState": "working",
            "createdAt": 1_700_000_000,
            "updatedAt": 1_700_000_001,
            "manualSteps": [String](),
        ]
        // An absent optional is an absent KEY, not a null: never put a Swift
        // optional into a [String: Any] bound for JSONSerialization.
        if let branch { payload["branch"] = branch }
        if let agentProvider { payload["agentProvider"] = agentProvider.rawValue }

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let decoded = try? JSONDecoder().decode(Session.self, from: data)
        else {
            fatalError("PreviewData.session no longer matches the contract's Session schema")
        }
        return decoded
    }
}
#endif
