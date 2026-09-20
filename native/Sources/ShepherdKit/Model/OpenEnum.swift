import Foundation

/// A generated open enum: `anyOf: [{$ref: <Name>Known}, {type: string}]` for a
/// named schema (such as `SessionStatus`), or the inline
/// `anyOf: [{type: string, enum: […]}, {type: string}]` for properties
/// such as `Session.planPhase` and `ClaudeUsageProviderSnapshot.provider`.
///
/// swift-openapi-generator's enums are closed, so a server that learns a new
/// `SessionStatus` would break decoding on an older client. The derived
/// contract sidesteps that with an `anyOf` whose second branch is a bare
/// string; this protocol hides the resulting two-optional wrapper behind
/// `known` (the case we understand) and `rawValue` (what actually came over
/// the wire), whether `Known` is the named `<Name>Known` enum or the
/// generator's nested `Value1Payload`.
public protocol OpenEnum: Sendable, Hashable {
  associatedtype Known: RawRepresentable & Hashable & Sendable where Known.RawValue == String

  var value1: Known? { get }
  var value2: String? { get }
  init(value1: Known?, value2: String?)
}

extension OpenEnum {
  /// The case this client understands, or `nil` when the server sent
  /// something newer. Switch on this and handle `nil` as "unrecognised".
  public var known: Known? { value1 }

  /// The wire value, known or not. Safe to log and to show in a diagnostic.
  ///
  /// Falls back to `""` only when BOTH `value1` and `value2` are `nil` — a
  /// state the generated `Decodable` initialiser never produces (decoding
  /// always sets one of the two branches, or throws) and the wire never
  /// sends. The only way to reach it is `Self(value1: nil, value2: nil)`,
  /// a memberwise construction this module does not use; `init(unknown:)`
  /// always sets `value2`, and `init(known:)` always sets both. Treat a `""`
  /// you see here as a bug in whoever built the value that way, not a real
  /// wire value — the server can send `""` as a string, but that still
  /// round-trips through `value2`, not this fallback.
  public var rawValue: String { value1?.rawValue ?? value2 ?? "" }

  /// Build a value the client understands.
  public init(known: Known) { self.init(value1: known, value2: known.rawValue) }

  /// Build a value the client does not understand — used by tests to prove
  /// an unknown value survives a round trip.
  public init(unknown raw: String) { self.init(value1: nil, value2: raw) }
}

// Core schemas the derivation flags with `x-shepherd-open-enum`.
// Named components use the top-level `<Name>Known` enum for `value1`;
// inline properties use the generator's nested `Value1Payload` enum.
// The generated code lives in this same module, so these are not retroactive
// conformances across a module boundary.
extension Components.Schemas.SessionStatus: OpenEnum {}
extension Components.Schemas.HerdrState: OpenEnum {}
extension Components.Schemas.SessionArchiveReason: OpenEnum {}
extension Components.Schemas.ExperimentRole: OpenEnum {}
extension Components.Schemas.EventName: OpenEnum {}
extension Components.Schemas.BlockReason.ShapePayload: OpenEnum {}
extension Components.Schemas.BlockReason.QuotaKindPayload: OpenEnum {}
extension Components.Schemas.Session.PlanPhasePayload: OpenEnum {}
extension Components.Schemas.Session.HaltReasonPayload: OpenEnum {}
extension Components.Schemas.ClaudeUsageProviderSnapshot.ProviderPayload: OpenEnum {}
extension Components.Schemas.ClaudeUsageProviderSnapshot.KindPayload: OpenEnum {}
extension Components.Schemas.CodexUsageProviderSnapshot.ProviderPayload: OpenEnum {}
extension Components.Schemas.CodexUsageProviderSnapshot.KindPayload: OpenEnum {}
extension Components.Schemas.CodexUsageProviderSnapshot.RateLimitSourcePayload: OpenEnum {}
