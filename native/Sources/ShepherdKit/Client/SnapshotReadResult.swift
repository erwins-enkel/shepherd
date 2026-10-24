/// A conditional read never treats a bodyless 304 as an empty snapshot.
public enum SnapshotReadResult<Value: Sendable>: Sendable {
  case modified(value: Value, etag: String?)
  case notModified
}
