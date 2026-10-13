import Foundation

/// What registering a native iOS device for push came to.
public enum ApnsRegistrationOutcome: Equatable, Sendable {
    /// The device is stored; `endpoint` keys its categories and unsubscribe.
    case registered(endpoint: String)
    /// The server has no APNs key, so this device cannot be reached from it.
    case unavailable
}

/// What a device tells a relaying server (#3058): the servers it is registered with itself, and
/// whether it wants notifications for sessions mirrored through this one.
public struct ApnsRelay: Equatable, Sendable {
    public var coveredInstances: [String]
    public var relayRemote: Bool
    public init(coveredInstances: [String], relayRemote: Bool) {
        self.coveredInstances = coveredInstances
        self.relayRemote = relayRemote
    }
}

extension ShepherdClient {
    /// `POST /api/push/apns` — register this device's APNs token (interim direct transport, #2665).
    /// `relay` goes only to servers that report `pushRelay`; without it the body is unchanged.
    public func registerApnsDevice(token: String, sandbox: Bool, locale: String,
                                   relay: ApnsRelay? = nil) async throws -> ApnsRegistrationOutcome {
        let body = Components.Schemas.ApnsRegistration(token: token,
            environment: sandbox ? .sandbox : .production, locale: locale,
            coveredInstances: relay?.coveredInstances, relayRemote: relay?.relayRemote)
        do {
            switch try await generated.registerApnsDevice(.init(body: .json(body))) {
            case .ok(let value): return .registered(endpoint: try value.body.json.endpoint)
            case .badRequest(let value): throw ShepherdError.badRequest(try value.body.json.error)
            case .unauthorized: throw ShepherdError.unauthenticated
            case .serviceUnavailable: return .unavailable
            case .undocumented(let status, _):
                throw ShepherdError.fromUndocumented(statusCode: status, route: "registerApnsDevice")
            }
        } catch { throw ShepherdError.from(error, route: "registerApnsDevice") }
    }
}
