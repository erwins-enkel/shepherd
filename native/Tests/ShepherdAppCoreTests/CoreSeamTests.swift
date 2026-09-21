import Testing

/// A single serialization boundary also covers suspended registry-mutating tests.
@Suite(.serialized)
struct CoreSeamTests {}
