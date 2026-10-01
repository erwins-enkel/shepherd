import Foundation
import OpenAPIRuntime

public typealias VoiceStatus = Components.Schemas.VoiceStatus
public enum VoiceTranscriptionError: Error, Equatable, Sendable { case busy }

extension ShepherdClient {
    public func plugins() async throws -> [Components.Schemas.PluginSummary] {
        do {
            switch try await generated.listPlugins(.init()) {
            case .ok(let response): return try response.body.json.plugins
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let code, _): throw ShepherdError.fromUndocumented(statusCode: code, route: "listPlugins")
            }
        } catch { throw ShepherdError.from(error, route: "listPlugins") }
    }

    /// Discovery matches the web: servers without the plugin receive no status probe.
    public func getVoiceStatus() async throws -> VoiceStatus? {
        guard try await plugins().contains(where: { $0.id == "voice-whisper" }) else { return nil }
        do {
            switch try await generated.getVoiceStatus(.init()) {
            case .ok(let response): return try response.body.json
            case .notFound: return nil
            case .unauthorized: throw ShepherdError.unauthenticated
            case .undocumented(let code, _): throw ShepherdError.fromUndocumented(statusCode: code, route: "getVoiceStatus")
            }
        } catch { throw ShepherdError.from(error, route: "getVoiceStatus") }
    }

    /// PCM WAV, identical to web wav.ts. Final clips omit mode; partial clips are disposable.
    public func transcribeAudio(_ wav: Data, language: String? = nil, partial: Bool = false) async throws -> String {
        do {
            var parts: [Operations.TranscribeAudio.Input.Body.MultipartFormPayload] = [
                .file(.init(payload: .init(body: HTTPBody(wav)), filename: "clip.wav"))
            ]
            if let language { parts.append(.lang(.init(payload: .init(body: HTTPBody(language))))) }
            if partial { parts.append(.mode(.init(payload: .init(body: HTTPBody("partial"))))) }
            let body = MultipartBody<Operations.TranscribeAudio.Input.Body.MultipartFormPayload>(parts)
            switch try await generated.transcribeAudio(.init(body: .multipartForm(body))) {
            case .ok(let response): return try response.body.json.text
            case .unauthorized: throw ShepherdError.unauthenticated
            case .notFound: throw ShepherdError.notFound
            case .tooManyRequests: throw VoiceTranscriptionError.busy
            case .undocumented(let code, _): throw ShepherdError.fromUndocumented(statusCode: code, route: "transcribeAudio")
            }
        } catch let error as VoiceTranscriptionError { throw error }
        catch { throw ShepherdError.from(error, route: "transcribeAudio") }
    }
}
