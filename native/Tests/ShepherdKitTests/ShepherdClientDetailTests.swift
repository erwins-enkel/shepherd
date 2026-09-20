import Foundation
import Testing

@testable import ShepherdKit

/// A client wired to an in-process fake, like ShepherdClientReadTests.
@MainActor
func detailClient(_ fake: FakeShepherdServer) throws -> ShepherdClient {
  let credentials = InMemoryCredentialStore()
  let profile = ServerProfile(name: "fake", baseURL: fake.baseURL, mode: .local)
  try credentials.save(StoredCredential(token: "shp_test", tokenId: "t1"), for: profile.credentialKey)
  return try ShepherdClient(profile: profile, credentials: credentials, urlSession: fake.urlSession())
}

@Suite("ShepherdClient detail reads", .timeLimit(.minutes(1)))
@MainActor
struct ShepherdClientDetailReadTests {
  @Test("activity comes back as generated entries; a 404 is notFound")
  func activity() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/activity", status: 200, json: DetailFixtures.activity)
    #expect(try await detailClient(fake).activity(sessionID: "s1").count == 1)

    let missing = FakeShepherdServer()
    defer { missing.tearDown() }
    missing.stub(
      "GET", "/api/sessions/s1/activity", status: 404, json: Data(#"{"error":"not found"}"#.utf8))
    await #expect(throws: ShepherdError.notFound) {
      _ = try await detailClient(missing).activity(sessionID: "s1")
    }
  }

  @Test("the diff comes back with its patch text; a 500 carries the server's sentence")
  func diff() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/diff", status: 200, json: DetailFixtures.diff)
    let diff = try await detailClient(fake).diff(sessionID: "s1")
    #expect(diff.baseRef == "origin/main")
    #expect(diff.files[0].patch?.contains("+extra") == true)

    let broken = FakeShepherdServer()
    defer { broken.tearDown() }
    broken.stub(
      "GET", "/api/sessions/s1/diff", status: 500,
      json: Data(#"{"error":"fatal: not a git repository"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("fatal: not a git repository")) {
      _ = try await detailClient(broken).diff(sessionID: "s1")
    }
  }

  @Test("annotations are unwrapped to the note list")
  func annotations() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "GET", "/api/sessions/s1/diff/annotations", status: 200, json: DetailFixtures.annotations)
    #expect(try await detailClient(fake).diffAnnotations(sessionID: "s1").count == 2)
  }

  @Test("a listing sends its path as a query item, and nil sends none")
  func listings() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/worktree", status: 200, json: DetailFixtures.listing)
    _ = try await detailClient(fake).worktreeFiles(sessionID: "s1", path: "docs/api")
    let query = try #require(fake.requests().last?.query)
    #expect(query.contains("path=docs/api") || query.contains("path=docs%2Fapi"))

    let root = FakeShepherdServer()
    defer { root.tearDown() }
    root.stub("GET", "/api/sessions/s1/scratchpad", status: 200, json: DetailFixtures.listing)
    #expect(try await detailClient(root).scratchpad(sessionID: "s1", path: nil).parent == nil)
    #expect(root.requests().last?.query?.contains("path=") != true)
  }

  @Test("git state comes back whole; a 404 is nil and a 502 is an upstream failure")
  func git() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/git", status: 200, json: DetailFixtures.gitState)
    let git = try #require(try await detailClient(fake).git(sessionID: "s1"))
    #expect(git.number == 12)
    #expect(git.checks.known == .success)

    let absent = FakeShepherdServer()
    defer { absent.tearDown() }
    absent.stub(
      "GET", "/api/sessions/s1/git", status: 404,
      json: Data(#"{"error":"no forge for this repo"}"#.utf8))
    #expect(try await detailClient(absent).git(sessionID: "s1") == nil)

    let angry = FakeShepherdServer()
    defer { angry.tearDown() }
    angry.stub(
      "GET", "/api/sessions/s1/git", status: 502, json: Data(#"{"error":"forge error"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("forge error")) {
      _ = try await detailClient(angry).git(sessionID: "s1")
    }
  }

  @Test("reviewers come back whole; an unsupported forge is a bad request with its code")
  func reviewers() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("GET", "/api/sessions/s1/git/reviewers", status: 200, json: DetailFixtures.reviewers)
    #expect(try await detailClient(fake).reviewers(sessionID: "s1").logins.count == 2)

    let unsupported = FakeShepherdServer()
    defer { unsupported.tearDown() }
    unsupported.stub(
      "GET", "/api/sessions/s1/git/reviewers", status: 400,
      json: Data(#"{"code":"review_request_unsupported"}"#.utf8))
    await #expect(throws: ShepherdError.badRequest("review_request_unsupported")) {
      _ = try await detailClient(unsupported).reviewers(sessionID: "s1")
    }

    let angry = FakeShepherdServer()
    defer { angry.tearDown() }
    angry.stub(
      "GET", "/api/sessions/s1/git/reviewers", status: 502,
      json: Data(#"{"code":"review_request_failed","error":"forge unreachable"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("forge unreachable")) {
      _ = try await detailClient(angry).reviewers(sessionID: "s1")
    }

    let missing = FakeShepherdServer()
    defer { missing.tearDown() }
    missing.stub(
      "GET", "/api/sessions/s1/git/reviewers", status: 404,
      json: Data(#"{"error":"no forge for this repo"}"#.utf8))
    await #expect(throws: ShepherdError.notFound) {
      _ = try await detailClient(missing).reviewers(sessionID: "s1")
    }
  }
}

@Suite("ShepherdClient detail writes", .timeLimit(.minutes(1)))
@MainActor
struct ShepherdClientDetailWriteTests {
  private func sentJSON(_ fake: FakeShepherdServer) throws -> [String: Any] {
    let body = try #require(fake.requests().last?.body)
    return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
  }

  @Test("opening a PR sends the title and body it was given")
  func openPR() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("POST", "/api/sessions/s1/git/pr", status: 200, json: DetailFixtures.gitState)
    #expect(try await detailClient(fake).openPR(sessionID: "s1", title: "T", body: "B").number == 12)
    let json = try sentJSON(fake)
    #expect(json["title"] as? String == "T")
    #expect(json["body"] as? String == "B")
  }

  @Test("an empty diff is a conflict carrying the server's sentence")
  func openPRConflict() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/pr", status: 409,
      json: Data(#"{"error":"no commits to merge"}"#.utf8))
    await #expect(throws: ShepherdError.conflict(code: nil, message: "no commits to merge")) {
      _ = try await detailClient(fake).openPR(sessionID: "s1", title: nil, body: nil)
    }
  }

  @Test("opening a PR for an unknown session is notFound; a forge failure is an upstream failure")
  func openPRNotFoundAndUpstreamFailure() async throws {
    let missing = FakeShepherdServer()
    defer { missing.tearDown() }
    missing.stub(
      "POST", "/api/sessions/s1/git/pr", status: 404,
      json: Data(#"{"error":"no forge for this repo"}"#.utf8))
    await #expect(throws: ShepherdError.notFound) {
      _ = try await detailClient(missing).openPR(sessionID: "s1", title: nil, body: nil)
    }

    let angry = FakeShepherdServer()
    defer { angry.tearDown() }
    angry.stub(
      "POST", "/api/sessions/s1/git/pr", status: 502,
      json: Data(#"{"error":"forge error"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("forge error")) {
      _ = try await detailClient(angry).openPR(sessionID: "s1", title: nil, body: nil)
    }
  }

  @Test("merging sends the method and the delete-branch choice; an enqueued merge is a failure")
  func mergePR() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("POST", "/api/sessions/s1/git/merge", status: 200, json: DetailFixtures.gitState)
    _ = try await detailClient(fake).mergePR(sessionID: "s1", method: .squash, deleteBranch: false)
    let json = try sentJSON(fake)
    #expect(json["method"] as? String == "squash")
    #expect(json["deleteBranch"] as? Bool == false)
    #expect(json["confirm"] == nil)

    let enqueued = FakeShepherdServer()
    defer { enqueued.tearDown() }
    enqueued.stub(
      "POST", "/api/sessions/s1/git/merge", status: 502,
      json: Data(#"{"error":"merge enqueued","code":"merge_enqueued"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("merge enqueued")) {
      _ = try await detailClient(enqueued).mergePR(
        sessionID: "s1", method: nil, deleteBranch: nil)
    }
  }

  @Test("merging sends takeover confirmation and preserves refusal codes")
  func mergePRConfirmation() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub("POST", "/api/sessions/s1/git/merge", status: 200, json: DetailFixtures.gitState)
    _ = try await detailClient(fake).mergePR(
      sessionID: "s1", method: .rebase, deleteBranch: false,
      confirm: .init(
        headSha: "head-a", baseRefName: "release", handoff: .reviewer,
        handoffWho: "reviewer", reviewBlockBy: "reviewer"))
    let body = try sentJSON(fake)
    let confirm = try #require(body["confirm"] as? [String: String])
    #expect(
      confirm == [
        "headSha": "head-a", "baseRefName": "release", "handoff": "reviewer",
        "handoffWho": "reviewer", "reviewBlockBy": "reviewer",
      ])
    #expect(body["method"] as? String == "rebase")
    #expect(body["deleteBranch"] as? Bool == false)

    for code in ["merge_confirm_required", "merge_confirm_stale"] {
      fake.stub(
        "POST", "/api/sessions/s1/git/merge", status: 409,
        json: Data("{\"error\":\"confirm again\",\"code\":\"\(code)\"}".utf8))
      await #expect(throws: ShepherdError.conflict(code: code, message: "confirm again")) {
        _ = try await detailClient(fake).mergePR(
          sessionID: "s1", method: nil, deleteBranch: nil, confirm: .init())
      }
    }
    let emptyBody = try sentJSON(fake)
    #expect((emptyBody["confirm"] as? [String: String])?.isEmpty == true)
  }

  @Test("merging an unknown session is notFound; a merge conflict carries the server's sentence")
  func mergePRNotFoundAndConflict() async throws {
    let missing = FakeShepherdServer()
    defer { missing.tearDown() }
    missing.stub(
      "POST", "/api/sessions/s1/git/merge", status: 404,
      json: Data(#"{"error":"no forge for this repo"}"#.utf8))
    await #expect(throws: ShepherdError.notFound) {
      _ = try await detailClient(missing).mergePR(sessionID: "s1", method: nil, deleteBranch: nil)
    }

    let conflicted = FakeShepherdServer()
    defer { conflicted.tearDown() }
    conflicted.stub(
      "POST", "/api/sessions/s1/git/merge", status: 409,
      json: Data(#"{"error":"merge conflict"}"#.utf8))
    await #expect(throws: ShepherdError.conflict(code: nil, message: "merge conflict")) {
      _ = try await detailClient(conflicted).mergePR(
        sessionID: "s1", method: nil, deleteBranch: nil)
    }
  }

  @Test("ready, draft and close all answer the full git state")
  func draftStateAndClose() async throws {
    for route in ["ready", "draft", "close"] {
      let fake = FakeShepherdServer()
      defer { fake.tearDown() }
      fake.stub("POST", "/api/sessions/s1/git/\(route)", status: 200, json: DetailFixtures.gitState)
      let client = try detailClient(fake)
      let state =
        switch route {
        case "ready": try await client.markPRReady(sessionID: "s1")
        case "draft": try await client.markPRDraft(sessionID: "s1")
        default: try await client.closePR(sessionID: "s1")
        }
      #expect(state.kind?.known == .github)
    }
  }

  @Test("a draft still awaiting sign-off is a conflict with its code")
  func readyBlocked() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/ready", status: 409,
      json: Data(#"{"code":"draft_awaiting_signoff","error":"Draft mode."}"#.utf8))
    await #expect(
      throws: ShepherdError.conflict(code: "draft_awaiting_signoff", message: "Draft mode.")
    ) { _ = try await detailClient(fake).markPRReady(sessionID: "s1") }
  }

  @Test("a forge missing a PR-mutation capability is a bad request with the server's sentence")
  func missingCapability() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/close", status: 400,
      json: Data(#"{"error":"this host does not support closing a pull request"}"#.utf8))
    await #expect(
      throws: ShepherdError.badRequest("this host does not support closing a pull request")
    ) { _ = try await detailClient(fake).closePR(sessionID: "s1") }
  }

  @Test("closing an unknown session is notFound; no open PR is a conflict; a forge failure is upstream")
  func closePRNotFoundConflictAndUpstreamFailure() async throws {
    let missing = FakeShepherdServer()
    defer { missing.tearDown() }
    missing.stub(
      "POST", "/api/sessions/s1/git/close", status: 404,
      json: Data(#"{"error":"no forge for this repo"}"#.utf8))
    await #expect(throws: ShepherdError.notFound) {
      _ = try await detailClient(missing).closePR(sessionID: "s1")
    }

    let conflicted = FakeShepherdServer()
    defer { conflicted.tearDown() }
    conflicted.stub(
      "POST", "/api/sessions/s1/git/close", status: 409,
      json: Data(#"{"error":"no open pull request"}"#.utf8))
    await #expect(throws: ShepherdError.conflict(code: nil, message: "no open pull request")) {
      _ = try await detailClient(conflicted).closePR(sessionID: "s1")
    }

    let angry = FakeShepherdServer()
    defer { angry.tearDown() }
    angry.stub(
      "POST", "/api/sessions/s1/git/close", status: 502,
      json: Data(#"{"error":"forge error"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("forge error")) {
      _ = try await detailClient(angry).closePR(sessionID: "s1")
    }
  }

  @Test("marking a PR back to draft covers every declared error status")
  func markPRDraftErrors() async throws {
    let unsupported = FakeShepherdServer()
    defer { unsupported.tearDown() }
    unsupported.stub(
      "POST", "/api/sessions/s1/git/draft", status: 400,
      json: Data(#"{"error":"this host does not support draft state"}"#.utf8))
    await #expect(throws: ShepherdError.badRequest("this host does not support draft state")) {
      _ = try await detailClient(unsupported).markPRDraft(sessionID: "s1")
    }

    let missing = FakeShepherdServer()
    defer { missing.tearDown() }
    missing.stub(
      "POST", "/api/sessions/s1/git/draft", status: 404,
      json: Data(#"{"error":"no forge for this repo"}"#.utf8))
    await #expect(throws: ShepherdError.notFound) {
      _ = try await detailClient(missing).markPRDraft(sessionID: "s1")
    }

    let conflicted = FakeShepherdServer()
    defer { conflicted.tearDown() }
    conflicted.stub(
      "POST", "/api/sessions/s1/git/draft", status: 409,
      json: Data(#"{"error":"no open pull request"}"#.utf8))
    await #expect(throws: ShepherdError.conflict(code: nil, message: "no open pull request")) {
      _ = try await detailClient(conflicted).markPRDraft(sessionID: "s1")
    }

    let angry = FakeShepherdServer()
    defer { angry.tearDown() }
    angry.stub(
      "POST", "/api/sessions/s1/git/draft", status: 502,
      json: Data(#"{"error":"forge error"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("forge error")) {
      _ = try await detailClient(angry).markPRDraft(sessionID: "s1")
    }
  }

  @Test("a 401 from any pull-request action is unauthenticated")
  func pullRequestActions401() async throws {
    let cases: [(method: String, path: String, call: @Sendable (ShepherdClient) async throws -> Void)] = [
      ("POST", "/api/sessions/s1/git/pr", { _ = try await $0.openPR(sessionID: "s1", title: nil, body: nil) }),
      (
        "POST", "/api/sessions/s1/git/merge",
        { _ = try await $0.mergePR(sessionID: "s1", method: nil, deleteBranch: nil) }
      ),
      ("POST", "/api/sessions/s1/git/draft", { _ = try await $0.markPRDraft(sessionID: "s1") }),
      ("POST", "/api/sessions/s1/git/close", { _ = try await $0.closePR(sessionID: "s1") }),
      ("GET", "/api/sessions/s1/git/reviewers", { _ = try await $0.reviewers(sessionID: "s1") }),
      (
        "POST", "/api/sessions/s1/git/request-review",
        { _ = try await $0.requestPRReview(sessionID: "s1", prNumber: 12, reviewer: "octocat") }
      ),
    ]
    for testCase in cases {
      let fake = FakeShepherdServer()
      defer { fake.tearDown() }
      fake.stub(testCase.method, testCase.path, status: 401, json: Data(#"{"error":"unauthorized"}"#.utf8))
      let client = try detailClient(fake)
      await #expect(throws: ShepherdError.unauthenticated) { try await testCase.call(client) }
    }
  }

  @Test("requesting a review reports refreshPending and sends both fields")
  func requestReview() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 200,
      json: Data(#"{"ok":true,"refreshPending":true}"#.utf8))
    #expect(
      try await detailClient(fake).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat") == true)
    let json = try sentJSON(fake)
    #expect(json["prNumber"] as? Int == 12)
    #expect(json["reviewer"] as? String == "octocat")
  }

  @Test("a draft PR is a conflict carrying the machine code")
  func requestReviewDraft() async throws {
    let fake = FakeShepherdServer()
    defer { fake.tearDown() }
    fake.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 409,
      json: Data(#"{"code":"review_request_draft"}"#.utf8))
    await #expect(
      throws: ShepherdError.conflict(
        code: "review_request_draft", message: "review_request_draft")
    ) {
      _ = try await detailClient(fake).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat")
    }
  }

  @Test("the host forbids the request, or rejects the reviewer login")
  func requestReviewForbiddenOrInvalid() async throws {
    let forbidden = FakeShepherdServer()
    defer { forbidden.tearDown() }
    forbidden.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 403,
      json: Data(#"{"code":"review_request_forbidden"}"#.utf8))
    await #expect(throws: ShepherdError.forbidden) {
      _ = try await detailClient(forbidden).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat")
    }

    let invalid = FakeShepherdServer()
    defer { invalid.tearDown() }
    invalid.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 422,
      json: Data(#"{"code":"review_request_invalid_reviewer"}"#.utf8))
    await #expect(throws: ShepherdError.unprocessable("review_request_invalid_reviewer")) {
      _ = try await detailClient(invalid).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "not-a-user")
    }
  }

  /// `reviewRequestError()` answers 502 `review_request_failed` for anything the forge threw
  /// that is not a refusal or a bad login — a plain GitHub outage. The route used not to declare
  /// it, so it fell through to `.undocumented` and reached the operator as contract-mismatch
  /// copy: both wrong and alarming for a transient upstream failure.
  @Test("a forge outage on a review request is an upstream failure, not a contract mismatch")
  func requestReviewUpstreamFailure() async throws {
    let angry = FakeShepherdServer()
    defer { angry.tearDown() }
    angry.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 502,
      json: Data(#"{"code":"review_request_failed","error":"forge unreachable"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("forge unreachable")) {
      _ = try await detailClient(angry).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat")
    }

    // The body often carries the machine code and no prose; the code stands in for both.
    let terse = FakeShepherdServer()
    defer { terse.tearDown() }
    terse.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 502,
      json: Data(#"{"code":"review_request_failed"}"#.utf8))
    await #expect(throws: ShepherdError.upstreamFailure("review_request_failed")) {
      _ = try await detailClient(terse).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat")
    }
  }

  @Test("an unsupported forge is a bad request; an unknown session is notFound")
  func requestReviewUnsupportedOrNotFound() async throws {
    let unsupported = FakeShepherdServer()
    defer { unsupported.tearDown() }
    unsupported.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 400,
      json: Data(#"{"code":"review_request_unsupported"}"#.utf8))
    await #expect(throws: ShepherdError.badRequest("review_request_unsupported")) {
      _ = try await detailClient(unsupported).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat")
    }

    let missing = FakeShepherdServer()
    defer { missing.tearDown() }
    missing.stub(
      "POST", "/api/sessions/s1/git/request-review", status: 404,
      json: Data(#"{"error":"no forge for this repo"}"#.utf8))
    await #expect(throws: ShepherdError.notFound) {
      _ = try await detailClient(missing).requestPRReview(
        sessionID: "s1", prNumber: 12, reviewer: "octocat")
    }
  }
}
