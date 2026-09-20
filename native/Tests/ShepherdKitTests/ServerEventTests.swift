import Foundation
import Testing

@testable import ShepherdKit

@Suite("ServerEvent", .timeLimit(.minutes(1)))
struct ServerEventTests {
  private func decode(_ json: String) throws -> ServerEvent {
    try JSONDecoder().decode(ServerEvent.self, from: Data(json.utf8))
  }

  @Test("session:new carries the whole generated Session")
  func sessionNew() throws {
    let payload = String(decoding: try Fixtures.sessionJSON(id: "a", name: "alpha"), as: UTF8.self)
    let event = try decode(#"{"event":"session:new","data":\#(payload)}"#)
    guard case .sessionNew(let session) = event else {
      Issue.record("expected sessionNew, got \(event)")
      return
    }
    #expect(session.id == "a")
    #expect(session.name == "alpha")
  }

  @Test("session:status decodes into the generated SessionStatusEvent")
  func sessionStatus() throws {
    let event = try decode(#"{"event":"session:status","data":{"id":"a","status":"blocked"}}"#)
    guard case .sessionStatus(let payload) = event else {
      Issue.record("expected sessionStatus, got \(event)")
      return
    }
    #expect(payload.id == "a")
    #expect(payload.status.known == .blocked)
    #expect(payload.hasScratchpadFiles == nil)
  }

  @Test("a status value this client does not know still decodes")
  func sessionStatusUnknownValue() throws {
    let event = try decode(#"{"event":"session:status","data":{"id":"a","status":"quiescing"}}"#)
    guard case .sessionStatus(let payload) = event else {
      Issue.record("expected sessionStatus, got \(event)")
      return
    }
    #expect(payload.status.known == nil)
    #expect(payload.status.rawValue == "quiescing")
  }

  @Test("session:status carries the turn-end scratchpad flag when present")
  func sessionStatusScratchpad() throws {
    let event = try decode(
      #"{"event":"session:status","data":{"id":"a","status":"idle","hasScratchpadFiles":true}}"#)
    guard case .sessionStatus(let payload) = event else {
      Issue.record("expected sessionStatus, got \(event)")
      return
    }
    #expect(payload.hasScratchpadFiles == true)
  }

  @Test("session:renamed keeps a null branch as nil")
  func sessionRenamed() throws {
    let event = try decode(
      #"{"event":"session:renamed","data":{"id":"a","name":"new","branch":null}}"#)
    guard case .sessionRenamed(let payload) = event else {
      Issue.record("expected sessionRenamed, got \(event)")
      return
    }
    #expect(payload.id == "a")
    #expect(payload.name == "new")
    #expect(payload.branch == nil)
  }

  @Test("session:archived decodes")
  func sessionArchived() throws {
    let event = try decode(#"{"event":"session:archived","data":{"id":"a"}}"#)
    guard case .sessionArchived(let payload) = event else {
      Issue.record("expected sessionArchived, got \(event)")
      return
    }
    #expect(payload.id == "a")
  }

  @Test("session:ready decodes")
  func sessionReady() throws {
    let event = try decode(#"{"event":"session:ready","data":{"id":"a","ready":true}}"#)
    guard case .sessionReady(let payload) = event else {
      Issue.record("expected sessionReady, got \(event)")
      return
    }
    #expect(payload.ready == true)
  }

  @Test("session:block carries a BlockReason, and null clears it")
  func sessionBlock() throws {
    let set = try decode(
      #"""
      {"event":"session:block","data":{"id":"a","block":{"shape":"yes-no",
      "options":[{"label":"Yes","send":"y"}],"tail":["continue?"]}}}
      """#)
    guard case .sessionBlock(let payload) = set else {
      Issue.record("expected sessionBlock, got \(set)")
      return
    }
    #expect(payload.block?.shape.rawValue == "yes-no")
    #expect(payload.block?.options.first?.send == "y")

    let cleared = try decode(#"{"event":"session:block","data":{"id":"a","block":null}}"#)
    guard case .sessionBlock(let clearedPayload) = cleared else {
      Issue.record("expected sessionBlock, got \(cleared)")
      return
    }
    #expect(clearedPayload.block == nil)
  }

  @Test("automerge:status decodes")
  func automerge() throws {
    let event = try decode(
      #"""
      {"event":"automerge:status","data":{"repoPath":"/repos/demo","enabled":true,
      "state":"waiting","detail":null,"sessionId":"a"}}
      """#)
    guard case .automergeStatus(let status) = event else {
      Issue.record("expected automergeStatus, got \(event)")
      return
    }
    #expect(status.repoPath == "/repos/demo")
    #expect(status.enabled == true)
  }

  @Test("usage:limits decodes")
  func usageLimits() throws {
    let event = try decode(
      #"""
      {"event":"usage:limits","data":{"session5h":null,"week":null,"perModelWeek":[],
      "credits":null,"stale":false,"calibratedAt":null,"subscriptionOnly":true}}
      """#)
    guard case .usageLimits(let limits) = event else {
      Issue.record("expected usageLimits, got \(event)")
      return
    }
    #expect(limits.subscriptionOnly == true)
  }

  @Test("an event the contract does not list becomes .unknown, not an error")
  func unknownEvent() throws {
    let event = try decode(#"{"event":"epic:progress","data":{"anything":1}}"#)
    guard case .unknown(let name, _) = event else {
      Issue.record("expected an .unknown event")
      return
    }
    #expect(name == "epic:progress")
  }

  @Test("a known event name with an undecodable payload becomes .unknown, not a throw")
  func knownNameBadPayload() throws {
    // A frame the client cannot make sense of must not kill the stream.
    let event = try decode(#"{"event":"session:ready","data":{"id":"a"}}"#)
    guard case .unknown(let name, _) = event else {
      Issue.record("expected an .unknown event")
      return
    }
    #expect(name == "session:ready")
  }

  @Test("a frame with no event key fails to decode")
  func malformedFrame() {
    #expect(throws: (any Error).self) { try decode(#"{"data":{}}"#) }
  }

  @Test("the presence frame encodes the shape the server expects")
  func presenceFrame() throws {
    let data = try JSONEncoder().encode(PresenceFrame(active: true))
    let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    #expect(decoded?["type"] as? String == "presence")
    #expect(decoded?["active"] as? Bool == true)
  }
}
