import Foundation
import Observation
import ShepherdKit

/// Pre-session shaping. A sequence fences both requests, including callbacks after cancellation.
@Observable @MainActor
final class ShapeRoundModel {
    private(set) var round: ShapeRound?
    private(set) var running = false
    private(set) var composing = false
    private(set) var errorKey: String?
    var single: [String: Int] = [:]
    var multi: [String: Set<Int>] = [:]
    var freeform: [String: String] = [:]
    @ObservationIgnored private let shape: (ShapeRequest) async throws -> ShapeRound
    @ObservationIgnored private let brief: (ShapeBriefRequest) async throws -> String
    private var sequence: UInt64 = 0
    private var stopped = false

    init(shape: @escaping (ShapeRequest) async throws -> ShapeRound,
         brief: @escaping (ShapeBriefRequest) async throws -> String) {
        self.shape = shape
        self.brief = brief
    }

    convenience init(client: ShepherdClient) {
        self.init(shape: { try await client.shapeTask($0) }, brief: { try await client.shapeBrief($0) })
    }

    static func blocker(running: Bool, mode: ComposeMode, repoPath: String, prompt: String) -> String? {
        if running { return "running" }
        if mode != .code { return "wrong_mode" }
        if repoPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "no_repo" }
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "empty_prompt" }
        return nil
    }

    var errorMessage: String? {
        switch errorKey {
        case "shape_err_empty_prompt": L.t("shape_err_empty_prompt")
        case "shape_err_spawn_failed": L.t("shape_err_spawn_failed")
        case "shape_err_unavailable": L.t("shape_err_unavailable")
        case "shape_err_compose": L.t("shape_err_compose")
        case "shape_err_timeout": L.t("shape_err_timeout")
        default: nil
        }
    }

    var visible: Bool { running || round != nil || errorKey != nil }
    var canUseBrief: Bool {
        guard let round, !running, !composing, !stopped else { return false }
        return round.block.questions.allSatisfy { question in
            switch question.kind.known {
            case .single:
                guard let selected = single[question.id] else { return false }
                return (question.options ?? []).indices.contains(selected)
            case .multi:
                return multi[question.id, default: []].allSatisfy { (question.options ?? []).indices.contains($0) }
            case .freeform:
                return !freeform[question.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case nil: return false
            }
        }
    }

    var answers: [RawAnswer] {
        guard let round else { return [] }
        return round.block.questions.compactMap { question in
            switch question.kind.known {
            case .single:
                return .init(blockId: round.block.id, questionId: question.id,
                             optionIndices: single[question.id].map { [$0] } ?? [])
            case .multi:
                return .init(blockId: round.block.id, questionId: question.id,
                             optionIndices: multi[question.id, default: []].sorted())
            case .freeform:
                return .init(blockId: round.block.id, questionId: question.id, text: freeform[question.id, default: ""])
            case nil: return nil
            }
        }
    }

    func start(_ request: ShapeRequest) async {
        guard !stopped, !running, !composing else { return }
        discard()
        let mine = sequence
        running = true
        defer { if mine == sequence { running = false } }
        do {
            let result = try await shape(request)
            guard mine == sequence, !stopped, !Task.isCancelled else { return }
            round = result
        } catch {
            guard mine == sequence, !stopped, !Task.isCancelled else { return }
            if case ShepherdError.cancelled = error { return }
            let slug: String
            if case ComposeShapeError.failed(let value) = error { slug = value } else { slug = "timeout" }
            switch slug {
            case "empty-prompt": errorKey = "shape_err_empty_prompt"
            case "spawn-failed": errorKey = "shape_err_spawn_failed"
            case "unavailable": errorKey = "shape_err_unavailable"
            default: errorKey = "shape_err_timeout"
            }
        }
    }

    func useBrief(_ answers: [RawAnswer]) async -> String? {
        guard let round, !running, !composing, !stopped else { return nil }
        let mine = sequence
        composing = true
        errorKey = nil
        defer { if mine == sequence { composing = false } }
        do {
            let result = try await brief(.init(draft: round.draft, block: round.block, answers: answers))
            guard mine == sequence, !stopped, !Task.isCancelled else { return nil }
            discard()
            return result
        } catch {
            guard mine == sequence, !stopped, !Task.isCancelled else { return nil }
            if case ShepherdError.cancelled = error { return nil }
            errorKey = "shape_err_compose"
            return nil
        }
    }

    func discard() {
        sequence += 1
        running = false
        composing = false
        round = nil
        errorKey = nil
        single = [:]; multi = [:]; freeform = [:]
    }

    func teardown() {
        stopped = true
        discard()
    }
}
