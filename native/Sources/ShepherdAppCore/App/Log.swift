import os

/// os.Logger instances for the app layer. Subsystem is fixed by the design spec.
public enum Log {
    static let subsystem = "run.shepherd.mac"
    public static let app = Logger(subsystem: subsystem, category: "app")
    public static let connect = Logger(subsystem: subsystem, category: "connect")
    public static let ui = Logger(subsystem: subsystem, category: "ui")
}
