import Foundation

@testable import ShepherdKit

/// Builders and raw JSON shared by every suite. One place knows the generated
/// memberwise initialisers, so a contract change breaks exactly one file.
enum Fixtures {
  /// A minimal valid `Session`. Every argument here is a *required* property
  /// of `#/components/schemas/Session`; optionals are left to their defaults.
  static func session(
    id: String,
    name: String = "session",
    desig: String = "TASK-01",
    status: SessionStatus = SessionStatus(known: .running),
    readyToMerge: Bool = false,
    branch: String? = nil
  ) -> Session {
    Session(
      id: id,
      desig: desig,
      name: name,
      prompt: "do the thing",
      repoPath: "/repos/demo",
      baseBranch: "main",
      branch: branch,
      worktreePath: "/repos/demo-\(id)",
      isolated: false,
      herdrSession: "herdr-\(id)",
      herdrAgentId: "agent-\(id)",
      claudeSessionId: "claude-\(id)",
      model: nil,
      effort: nil,
      readyToMerge: readyToMerge,
      mergingSince: nil,
      autopilotEnabled: nil,
      autopilotPaused: false,
      autopilotComplete: false,
      planGateEnabled: nil,
      planPhase: nil,
      autoMergeEnabled: nil,
      auto: false,
      issueNumber: nil,
      sandboxApplied: nil,
      status: status,
      lastState: Components.Schemas.HerdrState(known: .working),
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_001,
      archivedAt: nil,
      archiveReason: nil,
      haltReason: nil,
      haltedAt: nil,
      manualSteps: []
    )
  }

  /// `Session` as the server would send it. Encoded from the builder so the
  /// JSON can never disagree with the generated type.
  static func sessionJSON(id: String, name: String = "session") throws -> Data {
    try JSONEncoder().encode(session(id: id, name: name))
  }

  /// A raw JSON `Session` object, built directly from a dictionary rather
  /// than by encoding `session(...)` above — used where the point of the
  /// test is *decoding* (e.g. proving `Session` really is the generated
  /// type, or that a nullable ref round-trips both its `null` and non-null
  /// forms), so the fixture must not go through the same Swift model it is
  /// checking. Every key in the base dictionary is either a *required*
  /// property of `#/components/schemas/Session`, or one of the three
  /// optional-ref properties (`sandboxApplied`, `archiveReason`,
  /// `experimentRole`) the nullable-ref regression test exercises — those
  /// three default to JSON `null`. `overrides` replaces entries by key with
  /// raw JSON-serializable values (not Swift models).
  static func minimalSessionJSON(overrides: [String: Any] = [:]) throws -> Data {
    var dict: [String: Any] = [
      "id": "s1",
      "desig": "TASK-01",
      "name": "session",
      "prompt": "do the thing",
      "repoPath": "/repos/demo",
      "baseBranch": "main",
      "branch": NSNull(),
      "worktreePath": "/repos/demo-s1",
      "isolated": false,
      "herdrSession": "herdr-s1",
      "herdrAgentId": "agent-s1",
      "claudeSessionId": "claude-s1",
      "model": NSNull(),
      "effort": NSNull(),
      "readyToMerge": false,
      "mergingSince": NSNull(),
      "autopilotEnabled": NSNull(),
      "autopilotPaused": false,
      "autopilotComplete": false,
      "planGateEnabled": NSNull(),
      "autoMergeEnabled": NSNull(),
      "auto": false,
      "issueNumber": NSNull(),
      "sandboxApplied": NSNull(),
      "status": "running",
      "lastState": "working",
      "createdAt": 1_700_000_000,
      "updatedAt": 1_700_000_001,
      "archivedAt": NSNull(),
      "archiveReason": NSNull(),
      "haltedAt": NSNull(),
      "manualSteps": [],
      "experimentRole": NSNull(),
    ]
    for (key, value) in overrides { dict[key] = value }
    return try JSONSerialization.data(withJSONObject: dict)
  }

  static func settings(firstRunPending: Bool = false, repoRoot: String = "/repos") -> Settings {
    Settings(
      repoRoot: repoRoot,
      repoRootDisplay: repoRoot,
      firstRunPending: firstRunPending,
      defaultModel: "sonnet",
      defaultCodexModel: nil,
      defaultEffort: "medium",
      defaultAgentProvider: .claude,
      authMode: .subscription,
      operatorLanguage: .en
    )
  }

  static func repoList() -> RepoList {
    RepoList(
      repos: [
        Repo(
          name: "demo",
          path: "/repos/demo",
          display: "demo",
          realPath: "/repos/demo",
          isFork: false,
          hidden: false
        )
      ],
      recentWindowDays: 14
    )
  }

  static func health(version: String = "1.47.0", minClient: String? = nil) -> Health {
    Health(ok: true, version: version, minClient: minClient)
  }

  static func json(_ value: some Encodable) throws -> Data { try JSONEncoder().encode(value) }

  static func errorJSON(_ message: String, code: String? = nil) throws -> Data {
    try JSONEncoder().encode(Components.Schemas._Error(error: message, code: code))
  }
}
