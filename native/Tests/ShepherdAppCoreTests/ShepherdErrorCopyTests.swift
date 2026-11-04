import Foundation
import Security
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
@MainActor
struct ShepherdErrorCopyTests {
    /// Every case ShepherdKit declares. This array does not itself catch a new
    /// case upstream — the exhaustive switches in ShepherdErrorCopy do that,
    /// failing to compile when a case is missing an arm. This array only
    /// exercises every case that already exists.
    private let all: [ShepherdError] = [
        .unauthenticated,
        .forbidden,
        .firstRunPending,
        .notFound,
        .badRequest("bad input"),
        .conflict(code: "name_taken", message: "name taken"),
        .unprocessable("no such ref"),
        .upstreamFailure("git exploded"),
        .upstreamFailure(code: "issue_unresolved", message: "could not re-resolve linked issue"),
        .serverFailure(status: 500, message: "EACCES: permission denied"),
        .serverFailure(status: 502, message: nil),
        .contractMismatch(route: "listSessions", underlying: "keyNotFound"),
        .insecureProfile(.insecureRemoteURL("box.example.com")),
        .transport("connection lost"),
        .cancelled,
    ]

    @Test func everyCaseHasNonEmptyCopy() {
        for error in all { #expect(!ShepherdErrorCopy.message(error).isEmpty) }
    }

    @Test func copyNeverLeaksACatalogKeyOrASwiftDump() {
        for error in all {
            let copy = ShepherdErrorCopy.message(error)
            #expect(!copy.hasPrefix("native_"), "\(error) leaked a catalog key")
            #expect(!copy.hasPrefix("login_"), "\(error) leaked a catalog key")
            #expect(!copy.contains("ShepherdError."), "\(error) leaked a Swift dump")
        }
    }

    @Test func missingTranscriptUsesLocalizedCopy() {
        #expect(ShepherdErrorCopy.message(
            ShepherdError.conflict(code: "transcript-missing", message: "transcript-missing"))
            == L.t("session_resume_transcript_missing"))
    }

    @Test func serverSuppliedMessagesAreShownVerbatim() {
        #expect(ShepherdErrorCopy.message(ShepherdError.badRequest("bad input")) == "bad input")
        #expect(ShepherdErrorCopy.message(
            ShepherdError.conflict(code: "name_taken", message: "name taken")) == "name taken")
        #expect(ShepherdErrorCopy.message(ShepherdError.unprocessable("no such ref")) == "no such ref")
        #expect(ShepherdErrorCopy.message(ShepherdError.upstreamFailure("git exploded")) == "git exploded")
        // A 502 that now carries a code still renders exactly its message here: the code is for
        // callers that branch (`ActionErrorCopy`), and this copy's behaviour is unchanged.
        #expect(
            ShepherdErrorCopy.message(
                ShepherdError.upstreamFailure(code: "issue_unresolved", message: "no issue"))
                == "no issue")
    }

    /// #2987: a server that failed is not a server on another API version —
    /// the copy names the failure and the server's own reason, never the
    /// "update one of them" line.
    @Test func aServerFailureSaysTheServerFailedNotThatTheVersionDiffers() {
        let withReason = ShepherdErrorCopy.message(
            ShepherdError.serverFailure(status: 500, message: "EACCES: permission denied"))
        #expect(withReason == L.t("native_error_server_failure", "500", "EACCES: permission denied"))
        #expect(withReason.contains("EACCES: permission denied"))
        let bare = ShepherdErrorCopy.message(ShepherdError.serverFailure(status: 502, message: nil))
        #expect(bare == L.t("native_error_server_failure_generic", "502"))
        for copy in [withReason, bare] { #expect(copy != L.t("native_error_mismatch")) }
        #expect(!ShepherdErrorCopy.isAuthFailure(ShepherdError.serverFailure(status: 500, message: nil)))
    }

    @Test func theUrlPolicyErrorReusesTheWelcomeCopy() {
        #expect(ShepherdErrorCopy.message(ShepherdError.insecureProfile(.insecureRemoteURL("box")))
            == L.t("native_url_error_insecure"))
    }

    /// The remote-server form throws the kit's ServerProfileError bare, not
    /// wrapped in ShepherdError.insecureProfile, so both spellings must land on
    /// the same copy.
    @Test func aBareProfileErrorGetsTheSameCopy() {
        #expect(ShepherdErrorCopy.message(ServerProfileError.insecureRemoteURL("box"))
            == L.t("native_url_error_insecure"))
        #expect(ShepherdErrorCopy.message(ServerProfileError.missingHost)
            == L.t("native_url_error_malformed"))
    }

    @Test func formFieldErrorsGetTheirOwnCopy() {
        #expect(ShepherdErrorCopy.message(RemoteServerForm.FieldError.empty)
            == L.t("native_url_error_empty"))
        #expect(ShepherdErrorCopy.message(RemoteServerForm.FieldError.malformed)
            == L.t("native_url_error_malformed"))
    }

    @Test func onlyAuthFailuresAskForANewSignIn() {
        #expect(ShepherdErrorCopy.isAuthFailure(ShepherdError.unauthenticated))
        #expect(ShepherdErrorCopy.isAuthFailure(ShepherdError.forbidden))
        #expect(!ShepherdErrorCopy.isAuthFailure(ShepherdError.notFound))
        #expect(!ShepherdErrorCopy.isAuthFailure(URLError(.timedOut)))
    }

    @Test func aNonKitErrorStillGetsCopy() {
        #expect(!ShepherdErrorCopy.message(URLError(.timedOut)).isEmpty)
    }

    /// A locked or otherwise refusing Keychain is not a network failure and
    /// must not fall through to the generic "cannot reach the server" copy.
    @Test func keychainFailuresGetTheirOwnCopyAndAreNotAuthFailures() {
        let unexpectedStatus = KeychainError.unexpectedStatus(errSecInteractionNotAllowed)
        let malformedItem = KeychainError.malformedItem

        #expect(ShepherdErrorCopy.message(unexpectedStatus) == L.t("native_error_keychain"))
        #expect(ShepherdErrorCopy.message(malformedItem) == L.t("native_error_keychain"))
        #expect(!ShepherdErrorCopy.isAuthFailure(unexpectedStatus))
        #expect(!ShepherdErrorCopy.isAuthFailure(malformedItem))
    }
}
}
