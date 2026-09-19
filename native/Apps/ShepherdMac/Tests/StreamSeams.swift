import Testing
@testable import Shepherd

/// Clears every seam a stream can fill: the detail-tab registry and all three
/// slots.
///
/// All of it is per-process state, so a suite that registers a stub leaks it
/// into whatever runs next — and the suites that assert the *fallback* would
/// then fail for a reason that has nothing to do with them. Every seam suite
/// calls this from its `init`, which Swift Testing runs before each test, so
/// each one starts from the shipped state no matter what ran before it. A
/// stream adding its own suite does the same, rather than resetting the two
/// seams it happens to remember.
///
/// Callers stay `@Suite(.serialized)`: this makes the state predictable, not
/// concurrent.
@MainActor
func resetStreamSeams() {
    DetailTabRegistry.reset()
    SidebarSlot.reset()
    WelcomeSlots.reset()
    ActionBarSlot.reset()
}
