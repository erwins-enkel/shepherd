import Foundation
import Testing
@testable import ShepherdKit

struct ShepherdClientVoiceTests {
    private func client(_ server: FakeShepherdServer) throws -> ShepherdClient {
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: "shp_test", tokenId: "voice"), for: "voice")
        return try ShepherdClient(profile: .init(name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "voice"), credentials: credentials, urlSession: server.urlSession())
    }
    @Test func absentPluginDoesNotProbeStatus() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.stub("GET", "/api/plugins", status: 200, json: Data(#"{"plugins":[]}"#.utf8))
        #expect(try await client(server).getVoiceStatus() == nil)
        #expect(server.requests().map(\.path) == ["/api/plugins"])
    }
    @Test func discoveryAndMultipartFinal() async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.stub("GET", "/api/plugins", status: 200, json: Data(#"{"plugins":[{"id":"voice-whisper","name":"Voice","future":true}]}"#.utf8))
        server.stub("GET", "/api/plugins/voice-whisper/status", status: 200, json: Data(#"{"available":true,"engine":"whisper.cpp","model":null,"ffmpeg":true,"language":"auto","preferLocal":true,"hint":""}"#.utf8))
        server.stub("POST", "/api/plugins/voice-whisper/transcribe", status: 200, json: Data(#"{"text":"Hallo Welt."}"#.utf8))
        let c = try client(server)
        #expect(try await c.getVoiceStatus()?.available == true)
        #expect(try await c.transcribeAudio(Data([82,73,70,70]), language: "de") == "Hallo Welt.")
        let request = try #require(server.requests().last)
        let body = String(decoding: try #require(request.body), as: UTF8.self)
        #expect(body.contains("clip.wav") && body.contains("name=\"lang\""))
        #expect(!body.contains("name=\"mode\""))
        #expect(request.headers["Authorization"] == "Bearer shp_test")
    }
    @Test(arguments: [401,404,429,503]) func errors(_ status: Int) async throws {
        let server = FakeShepherdServer(); defer { server.tearDown() }
        server.stub("POST", "/api/plugins/voice-whisper/transcribe", status: status, json: Data(#"{"error":"busy"}"#.utf8))
        let c = try client(server)
        if status == 429 { await #expect(throws: VoiceTranscriptionError.busy) { _ = try await c.transcribeAudio(Data([1])) } }
        else {
            let error: ShepherdError = status == 401 ? .unauthenticated : status == 404 ? .notFound : .contractMismatch(route: "transcribeAudio", underlying: "undocumented status 503")
            await #expect(throws: error) { _ = try await c.transcribeAudio(Data([1])) }
        }
    }
}
