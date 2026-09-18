import SwiftUI
import ShepherdKit

@main
struct ShepherdApp: App {
    init() {
        Log.app.info("Shepherd for Mac starting")
    }

    var body: some Scene {
        WindowGroup("Shepherd") {
            Text(verbatim: "Shepherd")
                .font(.largeTitle)
                .frame(minWidth: 900, minHeight: 600)
        }
        .defaultSize(width: 1100, height: 720)
        .windowResizability(.contentMinSize)
    }
}
