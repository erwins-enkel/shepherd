import Foundation

// Short names for the "Epics to land" schemas (the herd block). Typealiases, not wrappers.
public typealias CompletedEpic = Components.Schemas.CompletedEpic
public typealias CompletedEpicChild = Components.Schemas.CompletedEpicChild
public typealias CompletedEpicClearedEvent = Components.Schemas.CompletedEpicClearedEvent
public typealias EpicLandingState = Components.Schemas.EpicLandingState
public typealias EpicLandingStateKnown = Components.Schemas.EpicLandingStateKnown
public typealias LandingStageStatus = Components.Schemas.LandingStageStatus
public typealias LandingStageStatusKnown = Components.Schemas.LandingStageStatusKnown
public typealias LandingCiAutomation = Components.Schemas.LandingCiAutomation
public typealias LandingCiChecks = Components.Schemas.LandingCiChecks

extension Components.Schemas.EpicLandingState: OpenEnum {}
extension Components.Schemas.LandingStageStatus: OpenEnum {}
extension Components.Schemas.CompletedEpic.LandingRebasePauseReasonPayload: OpenEnum {}
extension Components.Schemas.LandingCiRerunStage.SkipReasonPayload: OpenEnum {}
extension Components.Schemas.LandingCiRepairStage.SkipReasonPayload: OpenEnum {}

/// The band of completed epics waiting to land, and the five actions a row offers.
///
/// Only the GET carries a row's live landing signals; the `epic:completed` frame never does.
extension ShepherdClient {
  /// `GET /api/epics/completed`. Every row nobody removed, newest first.
  public func completedEpics(repo: String? = nil) async throws -> [CompletedEpic] {
    do {
      switch try await generated.listCompletedEpics(.init(query: .init(repo: repo))) {
      case .ok(let ok): return try ok.body.json
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "listCompletedEpics")
      }
    } catch { throw ShepherdError.from(error, route: "listCompletedEpics") }
  }

  /// `POST /api/epics/completed/land`. Merges the landing PR; answers once the merge is done.
  public func landCompletedEpic(repo: String, parent: Int) async throws {
    do {
      switch try await generated.landCompletedEpic(.init(body: .json(.init(repo: repo, parent: parent)))) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "landCompletedEpic")
      }
    } catch { throw ShepherdError.from(error, route: "landCompletedEpic") }
  }

  /// `POST /api/epics/completed/dismiss`. Hides the row; PR, branch and issue stay.
  public func dismissCompletedEpic(repo: String, parent: Int) async throws {
    do {
      switch try await generated.dismissCompletedEpic(.init(body: .json(.init(repo: repo, parent: parent)))) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "dismissCompletedEpic")
      }
    } catch { throw ShepherdError.from(error, route: "dismissCompletedEpic") }
  }

  /// `POST /api/epics/completed/ack-migrations`. Acknowledges the migrations and hides the row.
  public func ackCompletedEpicMigrations(repo: String, parent: Int) async throws {
    do {
      switch try await generated.ackCompletedEpicMigrations(
        .init(body: .json(.init(repo: repo, parent: parent)))) {
      case .ok: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "ackCompletedEpicMigrations")
      }
    } catch { throw ShepherdError.from(error, route: "ackCompletedEpicMigrations") }
  }

  /// `POST /api/epics/completed/resolve-conflicts`. Starts the conflict-rework agent.
  public func resolveCompletedEpicConflicts(repo: String, parent: Int) async throws {
    do {
      switch try await generated.resolveCompletedEpicConflicts(
        .init(body: .json(.init(repo: repo, parent: parent)))) {
      case .accepted: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .serviceUnavailable(let unavailable): throw ShepherdError.fromUpstream(try unavailable.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "resolveCompletedEpicConflicts")
      }
    } catch { throw ShepherdError.from(error, route: "resolveCompletedEpicConflicts") }
  }

  /// `POST /api/epics/completed/repair-ci`. Starts the agent that fixes a red landing PR.
  public func repairCompletedEpicCi(repo: String, parent: Int) async throws {
    do {
      switch try await generated.repairCompletedEpicCi(.init(body: .json(.init(repo: repo, parent: parent)))) {
      case .accepted: return
      case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
      case .unauthorized: throw ShepherdError.unauthenticated
      case .notFound: throw ShepherdError.notFound
      case .conflict(let conflict): throw ShepherdError.fromConflict(try conflict.body.json)
      case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
      case .serviceUnavailable(let unavailable): throw ShepherdError.fromUpstream(try unavailable.body.json)
      case .undocumented(let status, _):
        throw ShepherdError.fromUndocumented(statusCode: status, route: "repairCompletedEpicCi")
      }
    } catch { throw ShepherdError.from(error, route: "repairCompletedEpicCi") }
  }
}
