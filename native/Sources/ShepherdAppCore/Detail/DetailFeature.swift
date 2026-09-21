import SwiftUI
import ShepherdKit

/// The identity a detail tab's `.task(id:)` keys on: the selected session **and** the model
/// showing it.
///
/// The session id alone is not enough. `AppModel` builds a fresh `DetailModel` per activation, so
/// a profile switch can leave the same session id selected in front of an empty cache — and a
/// task that did not re-run would sit on loading chrome nothing ever fills.
public struct DetailTaskKey: Hashable {
    let session: String
    let model: ObjectIdentifier

    public init(session: String, model: DetailModel) {
        self.session = session
        self.model = ObjectIdentifier(model)
    }
}

/// What a tab should render. A tab maps its own `Loaded` value onto this.
public enum DetailStatePhase: Equatable {
    case loading
    case empty(String)
    case failed(String)
    case content
}

extension CoreStreamInstallers {
    public static func installDetail(into app: AppModel) {
        app.register(DetailModel.self)
        StreamRegistrations.requiredHost.detailTabs(app)
    }
}
