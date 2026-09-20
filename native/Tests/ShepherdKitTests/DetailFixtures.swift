import Foundation
import Testing

@testable import ShepherdKit

/// Raw JSON for the detail routes, kept as text so the tests prove the generated models decode
/// what the server actually sends rather than what a Swift initialiser can build.
enum DetailFixtures {
  static let activity = Data(
    #"[{"ts":1800000000000,"tool":"Edit","summary":"edited server.ts","status":"ok"}]"#.utf8)
  static let diff = Data(
    """
    {"base":"main","baseRef":"origin/main","head":"shepherd/x","fetchFailed":false,
     "truncated":false,"files":[{"path":"src/a.ts","status":"modified","additions":2,
     "deletions":1,"binary":false,"patch":"@@ -1,2 +1,3 @@\\n ctx\\n-old\\n+new\\n+extra\\n"}]}
    """.utf8)
  static let annotations = Data(
    """
    {"notes":[{"path":"src/a.ts","kind":"agent","text":"renamed","side":"additions",
     "lineNumber":3,"tool":"Edit"},{"path":"","kind":"review","text":"boundary moved"}]}
    """.utf8)
  static let listing = Data(
    """
    {"path":"","parent":null,"entries":[
     {"name":"docs","type":"dir","path":"docs","createdMs":1800000000000},
     {"name":"README.md","type":"file","path":"README.md"}]}
    """.utf8)
  static let gitState = Data(
    """
    {"kind":"github","state":"open","number":12,"url":"https://example.invalid/pull/12",
     "title":"add the thing","createdAt":1800000000000,"mergeable":true,"checks":"success",
     "mergeStateStatus":"clean","isDraft":false,"deployConfigured":false,
     "requestedReviewers":["octocat"],"authorLogin":"shepherd-bot",
     "latestReview":{"state":"approved","author":"octocat","submittedAt":1800000100000}}
    """.utf8)
  static let reviewers = Data(
    """
    {"logins":["octocat","hubot"],"unavailable":false,"prNumber":12,"repoSlug":"acme/demo",
     "isFork":false,"requestedReviewers":[],"authorLogin":"shepherd-bot",
     "defaultReviewer":"octocat","isDraft":false}
    """.utf8)
}

@Suite("Generated detail contract types", .timeLimit(.minutes(1)))
struct GeneratedDetailContractTests {
  @Test("open enums decode both a known and an unknown member")
  func openEnums() throws {
    let list = try JSONDecoder().decode(
      [Components.Schemas.ActivityEntry].self, from: DetailFixtures.activity)
    #expect(list[0].status.known == .ok)
    let odd = try JSONDecoder().decode(
      [Components.Schemas.ActivityEntry].self,
      from: Data(#"[{"ts":1,"tool":"X","summary":"s","status":"quarantined"}]"#.utf8))
    #expect(odd[0].status.known == nil)
    #expect(odd[0].status.rawValue == "quarantined")
  }

  @Test("merge responsibility decodes independently of herd handoff, including future roles")
  func mergeResponsibility() throws {
    for role in ["reviewer", "merger", "future-role"] {
      let payload = Data(
        """
        {"id":"s1","git":{"state":"open","checks":"pending","deployConfigured":false,
        "headSha":"head-a","baseRefName":"release","handoff":"reviewer","handoffWho":"other",
        "mergeGate":{"handoff":"\(role)","handoffWho":"owner","reviewBlockBy":"reviewer"}}}
        """.utf8)
      let event = try JSONDecoder().decode(SessionGitEvent.self, from: payload)
      #expect(event.git.baseRefName == "release")
      #expect(event.git.headSha == "head-a")
      #expect(event.git.handoffWho == "other")
      let gate = try #require(event.git.mergeGate)
      #expect(gate.handoff?.rawValue == role)
      #expect((gate.handoff?.known == nil) == (role == "future-role"))
      #expect(gate.handoffWho == "owner")
      #expect(gate.reviewBlockBy == "reviewer")
      let roundTrip = try JSONDecoder().decode(
        SessionGitEvent.self, from: JSONEncoder().encode(event))
      #expect(roundTrip.git.mergeGate == gate)
    }
    let old = try JSONDecoder().decode(GitState.self, from: DetailFixtures.gitState)
    #expect(old.mergeGate == nil)
    #expect(old.baseRefName == nil)
    let blockOnly = try JSONDecoder().decode(
      Components.Schemas.MergeResponsibility.self,
      from: Data(#"{"reviewBlockBy":"reviewer"}"#.utf8))
    #expect(blockOnly.handoff == nil)
    #expect(blockOnly.reviewBlockBy == "reviewer")
    let nulls = try JSONDecoder().decode(
      Components.Schemas.MergeConfirmation.self,
      from: Data(
        #"{"headSha":null,"baseRefName":null,"handoff":null,"handoffWho":null,"reviewBlockBy":null}"#
          .utf8))
    #expect(nulls == .init())
  }

  @Test("the session diff carries patch text, and annotations keep both kinds")
  func diffAndNotes() throws {
    let diff = try JSONDecoder().decode(
      Components.Schemas.DiffResult.self, from: DetailFixtures.diff)
    #expect(diff.files[0].status.known == .modified)
    #expect(diff.files[0].patch?.hasPrefix("@@ -1,2 +1,3 @@") == true)
    let notes = try JSONDecoder().decode(
      Components.Schemas.DiffAnnotations.self, from: DetailFixtures.annotations
    ).notes
    #expect(notes[0].side?.known == .additions)
    #expect(notes[1].kind.known == .review)
    #expect(notes[1].path.isEmpty)
  }

  @Test("a listing keeps a null parent and an absent createdMs")
  func listing() throws {
    let listing = try JSONDecoder().decode(
      Components.Schemas.BrowseListing.self, from: DetailFixtures.listing)
    #expect(listing.parent == nil)
    #expect(listing.entries[0]._type.known == .dir)
    #expect(listing.entries[1].createdMs == nil)
  }

  @Test("git state keeps its optional kind and nullable mergeable, and decodes the bare form")
  func gitState() throws {
    let git = try JSONDecoder().decode(
      Components.Schemas.GitState.self, from: DetailFixtures.gitState)
    #expect(git.kind?.known == .github)
    #expect(git.mergeable == true)
    #expect(git.latestReview?.state.known == .approved)
    // The PR-action responses answer the same schema WITHOUT `kind`.
    let bare = try JSONDecoder().decode(
      Components.Schemas.GitState.self,
      from: Data(#"{"state":"merged","checks":"none","deployConfigured":false}"#.utf8))
    #expect(bare.kind == nil)
    #expect(bare.state.known == .merged)
  }

  @Test("reviewer options keep their nullable fields")
  func reviewers() throws {
    let options = try JSONDecoder().decode(
      Components.Schemas.PrReviewerOptions.self, from: DetailFixtures.reviewers)
    #expect(options.logins == ["octocat", "hubot"])
    #expect(options.defaultReviewer == "octocat")
  }
}
