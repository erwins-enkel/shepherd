import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// iOS-only feed and draft. The visible view owns the polling task; cancellation
/// and selection checks fence every response, including noncooperative loaders.
@MainActor
@Observable
final class IOSChatModel {
    var data: SessionMessages?
    var loadFailed = false
    var draft = ""
    private(set) var sending = false
    private(set) var sendFailed = false
    private(set) var pending: [ChatTimeline.Pending] = []
    private var pollGeneration = 0
    var dictation: IOSDictationSession?
    var attachments: AttachmentModel?
    var ask: PendingAsk?
    let askFlow = AskAnswerFlow()

    var entries: [ChatTimeline.Entry] { ChatTimeline.entries(data?.messages ?? []) }
    var rows: [ChatTimeline.Row] { ChatTimeline.rows(entries, tools: data?.tools ?? []) }
    var waiting: [ChatTimeline.Pending] { pending.filter { $0.echoTS == nil } }
    var canSend: Bool {
        !sending && dictation?.voice.active != true && attachments?.hasOutstandingUploads != true
            && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachments?.rows.isEmpty == false)
    }

    static func pollSeconds(running: Bool) -> Int { running ? 2 : 8 }

    func poll(fetch: () async throws -> SessionMessages, running: () -> Bool,
              isCurrent: () -> Bool, fetchAsk: (() async throws -> PendingAsk?)? = nil,
              wait: (Int) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) async {
        pollGeneration += 1
        let generation = pollGeneration
        defer { if generation == pollGeneration { pollGeneration += 1 } }
        while !Task.isCancelled && isCurrent() && generation == pollGeneration {
            do {
                let result = try await fetch()
                guard !Task.isCancelled, isCurrent(), generation == pollGeneration else { return }
                if let fetchAsk {
                    let question = try await fetchAsk()
                    guard !Task.isCancelled, isCurrent(), generation == pollGeneration else { return }
                    ask = question
                }
                data = result
                pending = ChatTimeline.settle(pending, entries: entries)
                loadFailed = false
            } catch {
                guard !Task.isCancelled, isCurrent(), generation == pollGeneration else { return }
                loadFailed = true
            }
            do { try await wait(Self.pollSeconds(running: running())) }
            catch { return }
        }
    }

    func send(isCurrent: () -> Bool, reply: (String) async throws -> Void,
              now: () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) async {
        guard isCurrent(), canSend else { return }
        let text = IOSAttachmentPaste.reply(paths: attachments?.rows.compactMap(\.path) ?? [], draft: draft)
        let at = now()
        sending = true; sendFailed = false
        defer { sending = false }
        do {
            try await reply(text)
            guard !Task.isCancelled, isCurrent() else { return }
            pending.append(.init(text: text, at: at))
            pending = ChatTimeline.settle(pending, entries: entries)
            draft = ""
            for row in attachments?.rows ?? [] { attachments?.remove(row.id) }
        } catch {
            guard !Task.isCancelled, isCurrent() else { return }
            sendFailed = true
        }
    }

    func stopDictation() {
        dictation?.engine.stopWhisperProbe()
        dictation?.voice.teardown()
        dictation = nil
    }
}
