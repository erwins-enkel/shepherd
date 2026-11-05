import Foundation
import Testing
@testable import ShepherdKit

@Suite("ShepherdClient Chat")
@MainActor
struct ShepherdClientChatTests {
    @Test func messagesRequestIncludesTheMobileWindowAndTools() async throws {
        let fake = FakeShepherdServer()
        defer { fake.tearDown() }
        fake.stub("GET", "/api/sessions/s1/messages", status: 200,
            json: Data(#"{"messages":[{"role":"user","text":"hello","ts":1}],"awaitingInput":true,"pendingQuestion":"Go?","tools":[{"tool":"Read","summary":"README.md","ts":2,"status":"ok"}]}"#.utf8))
        let result = try await detailClient(fake).messages(sessionID: "s1")
        #expect(result.messages.first?.text == "hello")
        #expect(result.tools?.first?.tool == "Read")
        #expect(result.awaitingInput)
        #expect(result.pendingQuestion == "Go?")
        let query = try #require(fake.requests().last?.query)
        let items = URLComponents(string: "http://fixture/?\(query)")?.queryItems ?? []
        #expect(items.contains(URLQueryItem(name: "limit", value: "50")))
        #expect(items.contains(URLQueryItem(name: "includeUser", value: "true")))
        #expect(items.contains(URLQueryItem(name: "includeTools", value: "true")))
    }

    @Test func unavailableMessagesAndMissingSessions() async throws {
        let fake = FakeShepherdServer()
        defer { fake.tearDown() }
        fake.stub("GET", "/api/sessions/s1/messages", status: 200,
            json: Data(#"{"messages":[],"awaitingInput":false,"pendingQuestion":null,"unavailable":"no-transcript"}"#.utf8))
        #expect(try await detailClient(fake).messages(sessionID: "s1").unavailable?.value1 == .noTranscript)
        let missing = FakeShepherdServer()
        defer { missing.tearDown() }
        missing.stub("GET", "/api/sessions/s1/messages", status: 404, json: Data(#"{"error":"not found"}"#.utf8))
        await #expect(throws: ShepherdError.notFound) { _ = try await detailClient(missing).messages(sessionID: "s1") }
    }
}
