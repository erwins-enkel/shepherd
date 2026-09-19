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

@Suite("ShepherdClient detail reads")
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

  // `reviewers()` is not tested here — the method is not implemented yet. See the note on
  // `ShepherdClient+Detail.swift` and this task's report: `GET /git/reviewers` is missing its
  // reachable 502 in the contract, and Task 4 adds both together once that lands.
}
