import Foundation
import Testing
@testable import ShepherdKit

@Suite("ShepherdClient Chat", .timeLimit(.minutes(1)))
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

    @Test func remoteChatKeepsSessionRoutesAndScopesQuestionsToTheMachine() async throws {
        let fake = FakeShepherdServer()
        defer { fake.tearDown() }
        fake.stub("GET", "/api/sessions/remote-session/messages", status: 200,
            json: Data(#"{"messages":[],"awaitingInput":false,"pendingQuestion":null}"#.utf8))
        fake.stub("GET", "/api/blocks", status: 200, json: Data(#"{}"#.utf8))
        fake.stub("POST", "/api/uploads", status: 200, json: Data(#"{"path":"/remote/image.png"}"#.utf8))
        fake.stub("POST", "/api/sessions/remote-session/reply", status: 200, json: Data(#"{"ok":true}"#.utf8))
        fake.stub("POST", "/api/sessions/remote-session/answer-ask", status: 200, json: Data(#"{"result":"verified"}"#.utf8))
        let client = try detailClient(fake)
        _ = try await client.messages(sessionID: "remote-session")
        _ = try await client.blocks(host: "machine-id")
        let upload = try await client.uploadFile(data: Data([1, 2]), filename: "image.png", sessionID: "remote-session")
        try await client.replySession(id: "remote-session", text: upload.path)
        _ = try await client.answerAsk(sessionID: "remote-session", toolUseID: "remote-question", answers: [])
        let requests = fake.requests()
        #expect(requests.map(\.path) == ["/api/sessions/remote-session/messages", "/api/blocks", "/api/uploads",
            "/api/sessions/remote-session/reply", "/api/sessions/remote-session/answer-ask"])
        #expect(requests[1].query == "host=machine-id")
        #expect(requests[2].query == "session=remote-session")
        let reply = try JSONDecoder().decode([String: String].self, from: #require(requests[3].body))
        #expect(reply["text"] == "/remote/image.png")
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
