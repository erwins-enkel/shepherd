import os

/// `os.Logger` instances for this package. The subsystem is fixed by the
/// design spec: ShepherdKit logs under `run.shepherd.kit` and nothing else.
///
/// Never interpolate a token, a password or a prompt body into these.
public enum ShepherdLog {
  public static let subsystem = "run.shepherd.kit"

  public static let client = Logger(subsystem: subsystem, category: "client")
  public static let realtime = Logger(subsystem: subsystem, category: "realtime")
  public static let store = Logger(subsystem: subsystem, category: "store")
  public static let credentials = Logger(subsystem: subsystem, category: "credentials")
}
