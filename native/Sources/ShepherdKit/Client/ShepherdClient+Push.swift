import Foundation

/// What registering a native iOS device for push came to.
public enum ApnsRegistrationOutcome: Equatable, Sendable {
    /// The device is stored; `endpoint` keys its categories and unsubscribe.
    case registered(endpoint: String)
    /// The server has no APNs key, so this device cannot be reached from it.
    case unavailable
}

extension ShepherdClient {
    /// `POST /api/push/apns` — register this device's APNs token (interim direct transport, #2665).
    public func registerApnsDevice(token: String, sandbox: Bool, locale: String) async throws -> ApnsRegistrationOutcome {
        let body = Components.Schemas.ApnsRegistration(token: token,
            environment: sandbox ? .sandbox : .production, locale: locale)
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
