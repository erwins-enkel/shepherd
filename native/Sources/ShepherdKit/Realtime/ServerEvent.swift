import Foundation
import OpenAPIRuntime

/// One decoded `/events` frame.
///
/// The contract describes every frame as an `EventEnvelope` — `{event, data}`
/// — and names a component schema for each `data` shape, so this file holds no
/// payload models of its own: it reads the envelope's `event`, then decodes
/// `data` into the generated type that `x-shepherd-events` names for it.
///
/// `EventName` is an open enum, so a name this client has never heard of
/// arrives as a plain string rather than failing to decode.
public enum ServerEvent: Decodable, Equatable, Sendable {
  case sessionNew(Session)
  case sessionStatus(Components.Schemas.SessionStatusEvent)
  case sessionRenamed(Components.Schemas.SessionRenamedEvent)
  case sessionArchived(Components.Schemas.SessionArchivedEvent)
  case sessionBlock(Components.Schemas.SessionBlockEvent)
  case sessionReady(Components.Schemas.SessionReadyEvent)
  case automergeStatus(Components.Schemas.AutoMergeStatus)
  case usageLimits(Components.Schemas.UsageLimits)
  /// An event this client does not handle — either a name the contract does
  /// not list, or a listed name whose payload would not decode. Ignored by
  /// the store, never an error: the server emits many events the native
  /// client does not use yet, and one bad frame must not kill the stream.
  ///
  /// `payload` is the frame's `data` re-encoded as JSON, or `nil` when the
  /// frame carried none. It is how a parallel stream reads an event its own
  /// contract block declares — match the raw `name`, then decode `payload`
  /// into the generated schema — without adding a case to `EventName` and the
  /// exhaustive switch below, which every stream would then have to edit.
  case unknown(name: String, payload: Data?)

  private enum CodingKeys: String, CodingKey {
    case event, data
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    // Decoding the name is the only hard requirement: a frame without one is
    // not an EventEnvelope at all.
    let name = try container.decode(Components.Schemas.EventName.self, forKey: .event)

    func payload<T: Decodable>(_ type: T.Type) -> T? {
      try? container.decode(type, forKey: .data)
    }

    /// The `data` member as JSON bytes. Decoded through
    /// `OpenAPIValueContainer` — the runtime's any-JSON box — because a keyed
    /// container hands out decoded values, never the original bytes.
    func rawPayload() -> Data? {
      guard let value = try? container.decode(OpenAPIValueContainer.self, forKey: .data)
      else { return nil }
      return try? JSONEncoder().encode(value)
    }

    switch name.known {
    case .session_colon_new:
      self =
        payload(Session.self).map(ServerEvent.sessionNew)
        ?? .unknown(name: name.rawValue, payload: rawPayload())
    case .session_colon_status:
      self = payload(Components.Schemas.SessionStatusEvent.self).map(ServerEvent.sessionStatus)
        ?? .unknown(name: name.rawValue, payload: rawPayload())
    case .session_colon_renamed:
      self = payload(Components.Schemas.SessionRenamedEvent.self).map(ServerEvent.sessionRenamed)
        ?? .unknown(name: name.rawValue, payload: rawPayload())
    case .session_colon_archived:
      self = payload(Components.Schemas.SessionArchivedEvent.self).map(ServerEvent.sessionArchived)
        ?? .unknown(name: name.rawValue, payload: rawPayload())
    case .session_colon_block:
      self = payload(Components.Schemas.SessionBlockEvent.self).map(ServerEvent.sessionBlock)
        ?? .unknown(name: name.rawValue, payload: rawPayload())
    case .session_colon_ready:
      self = payload(Components.Schemas.SessionReadyEvent.self).map(ServerEvent.sessionReady)
        ?? .unknown(name: name.rawValue, payload: rawPayload())
    case .automerge_colon_status:
      self = payload(Components.Schemas.AutoMergeStatus.self).map(ServerEvent.automergeStatus)
        ?? .unknown(name: name.rawValue, payload: rawPayload())
    case .usage_colon_limits:
      self = payload(Components.Schemas.UsageLimits.self).map(ServerEvent.usageLimits)
        ?? .unknown(name: name.rawValue, payload: rawPayload())
    case nil:
      self = .unknown(name: name.rawValue, payload: rawPayload())
    }
  }
}

/// The one frame the client sends. The contract documents it in prose under
/// `x-shepherd-events` rather than as a schema, so it is written out here.
/// The server never replies to it; it uses it to suppress push notifications
/// while the app is focused.
public struct PresenceFrame: Encodable, Sendable {
  public let type: String = "presence"
  public let active: Bool

  public init(active: Bool) { self.active = active }
}
