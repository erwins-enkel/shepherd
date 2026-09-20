import Foundation
import OpenAPIRuntime

public typealias AutomationOverride = Components.Schemas.AutomationOverride
public typealias MergeStep = Components.Schemas.MergeStep
public typealias PostMergeSteps = Components.Schemas.PostMergeSteps
public typealias ManualStepToggle = Components.Schemas.ManualStepToggle
public typealias BuildStepStatus = Components.Schemas.BuildStepStatus
public typealias BuildStep = Components.Schemas.BuildStep
public typealias BuildStepInput = Components.Schemas.BuildStepInput
public typealias BuildQueue = Components.Schemas.BuildQueue
public typealias BuildQueueMap = Components.Schemas.BuildQueueMap
public typealias BuildQueueWrite = Components.Schemas.BuildQueueWrite
public typealias DrainStatus = Components.Schemas.DrainStatus
public typealias DrainQueuedItem = Components.Schemas.DrainQueuedItem
public typealias ClearMergedPreview = Components.Schemas.ClearMergedPreview
public typealias ClearMergedRequest = Components.Schemas.ClearMergedRequest
public typealias ClearMergedResult = Components.Schemas.ClearMergedResult
public typealias SessionAutomergeEvent = Components.Schemas.SessionAutomergeEvent
public typealias SessionAutopilotEvent = Components.Schemas.SessionAutopilotEvent
public typealias SessionMergingEvent = Components.Schemas.SessionMergingEvent
public typealias MergeTrainLandedEvent = Components.Schemas.MergeTrainLandedEvent
public typealias PostMergeStepsChangedEvent = Components.Schemas.PostMergeStepsChangedEvent
public typealias MergeManualStep = Components.Schemas.MergeManualStep
public typealias SessionManualStepsEvent = Components.Schemas.SessionManualStepsEvent
extension Components.Schemas.BuildStepStatus: OpenEnum {}
extension Components.Schemas.AutomationOverride {
    public static func value(_ enabled: Bool?) throws -> Self {
        .init(enabled: try OpenAPIValueContainer(unvalidatedValue: enabled))
    }
}

extension ShepherdClient {
    public func listAutomerge() async throws -> [Components.Schemas.AutoMergeStatus] {
        do {
            switch try await generated.listAutomerge(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listAutomerge")
            }
        } catch { throw ShepherdError.from(error, route: "listAutomerge") }
    }
    public func setSessionAutopilot(id: String, body: AutomationOverride) async throws -> Components.Schemas.Session {
        do {
            switch try await generated.setSessionAutopilot(.init(path: .init(id: id), body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "setSessionAutopilot")
            }
        } catch { throw ShepherdError.from(error, route: "setSessionAutopilot") }
    }
    public func setSessionAutomerge(id: String, body: AutomationOverride) async throws -> Components.Schemas.Session {
        do {
            switch try await generated.setSessionAutomerge(.init(path: .init(id: id), body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "setSessionAutomerge")
            }
        } catch { throw ShepherdError.from(error, route: "setSessionAutomerge") }
    }
    public func redeploySession(id: String) async throws -> Components.Schemas.Ok {
        do {
            switch try await generated.redeploySession(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .badGateway(let bad): throw ShepherdError.fromUpstream(try bad.body.json)
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "redeploySession")
            }
        } catch { throw ShepherdError.from(error, route: "redeploySession") }
    }
    public func previewClearMerged() async throws -> Components.Schemas.ClearMergedPreview {
        do {
            switch try await generated.previewClearMerged(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "previewClearMerged")
            }
        } catch { throw ShepherdError.from(error, route: "previewClearMerged") }
    }
    public func clearMergedSessions(body: ClearMergedRequest) async throws -> Components.Schemas.ClearMergedResult {
        do {
            switch try await generated.clearMergedSessions(.init(body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "clearMergedSessions")
            }
        } catch { throw ShepherdError.from(error, route: "clearMergedSessions") }
    }
    public func listOutstandingManualSteps() async throws -> [Components.Schemas.PostMergeSteps] {
        do {
            switch try await generated.listOutstandingManualSteps(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listOutstandingManualSteps")
            }
        } catch { throw ShepherdError.from(error, route: "listOutstandingManualSteps") }
    }
    public func setManualStepDone(id: String, stepId: String, body: ManualStepToggle) async throws -> Components.Schemas.PostMergeSteps {
        do {
            switch try await generated.setManualStepDone(.init(path: .init(id: id, stepId: stepId), body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "setManualStepDone")
            }
        } catch { throw ShepherdError.from(error, route: "setManualStepDone") }
    }
    public func dismissManualSteps(id: String) async throws -> Components.Schemas.PostMergeSteps {
        do {
            switch try await generated.dismissManualSteps(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "dismissManualSteps")
            }
        } catch { throw ShepherdError.from(error, route: "dismissManualSteps") }
    }
    public func ackManualSteps(id: String) async throws -> Components.Schemas.Ok {
        do {
            switch try await generated.ackManualSteps(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "ackManualSteps")
            }
        } catch { throw ShepherdError.from(error, route: "ackManualSteps") }
    }
    public func listDrain() async throws -> [Components.Schemas.DrainStatus] {
        do {
            switch try await generated.listDrain(.init()) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listDrain")
            }
        } catch { throw ShepherdError.from(error, route: "listDrain") }
    }
    public func listDrainQueue(repo: String) async throws -> [Components.Schemas.DrainQueuedItem] {
        do {
            switch try await generated.listDrainQueue(.init(query: .init(repo: repo))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listDrainQueue")
            }
        } catch { throw ShepherdError.from(error, route: "listDrainQueue") }
    }
    public func listBuildQueues() async throws -> [String: BuildQueue] {
        do {
            switch try await generated.listBuildQueues(.init()) {
            case .ok(let ok): return try ok.body.json.additionalProperties
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "listBuildQueues")
            }
        } catch { throw ShepherdError.from(error, route: "listBuildQueues") }
    }
    public func getBuildQueue(id: String) async throws -> Components.Schemas.BuildQueue {
        do {
            switch try await generated.getBuildQueue(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "getBuildQueue")
            }
        } catch { throw ShepherdError.from(error, route: "getBuildQueue") }
    }
    public func putBuildQueue(id: String, body: BuildQueueWrite) async throws -> Components.Schemas.BuildQueue {
        do {
            switch try await generated.putBuildQueue(.init(path: .init(id: id), body: .json(body))) {
            case .ok(let ok): return try ok.body.json
            case .badRequest(let bad): throw ShepherdError.badRequest(try bad.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "putBuildQueue")
            }
        } catch { throw ShepherdError.from(error, route: "putBuildQueue") }
    }
    public func approveBuildQueue(id: String) async throws -> Components.Schemas.BuildQueue {
        do {
            switch try await generated.approveBuildQueue(.init(path: .init(id: id))) {
            case .ok(let ok): return try ok.body.json
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "approveBuildQueue")
            }
        } catch { throw ShepherdError.from(error, route: "approveBuildQueue") }
    }
}
