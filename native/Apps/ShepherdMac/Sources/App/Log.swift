import os

/// os.Logger instances for the app layer. Subsystem is fixed by the design spec.
enum Log {
    static let subsystem = "run.shepherd.mac"
    static let app = Logger(subsystem: subsystem, category: "app")
    static let connect = Logger(subsystem: subsystem, category: "connect")
    static let ui = Logger(subsystem: subsystem, category: "ui")
}
