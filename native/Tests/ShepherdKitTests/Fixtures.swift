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
