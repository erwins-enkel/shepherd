import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

@MainActor
struct ShepherdErrorCopyTests {
    /// Every case ShepherdKit declares, so a new case upstream shows up here as a
    /// compile error in the array literal rather than as a silent Swift dump on screen.
    private let all: [ShepherdError] = [
        .unauthenticated,
        .forbidden,
        .firstRunPending,
        .notFound,
        .badRequest("bad input"),
        .conflict(code: "name_taken", message: "name taken"),
        .unprocessable("no such ref"),
        .upstreamFailure("git exploded"),
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

    @Test func serverSuppliedMessagesAreShownVerbatim() {
        #expect(ShepherdErrorCopy.message(ShepherdError.badRequest("bad input")) == "bad input")
        #expect(ShepherdErrorCopy.message(
            ShepherdError.conflict(code: "name_taken", message: "name taken")) == "name taken")
        #expect(ShepherdErrorCopy.message(ShepherdError.unprocessable("no such ref")) == "no such ref")
        #expect(ShepherdErrorCopy.message(ShepherdError.upstreamFailure("git exploded")) == "git exploded")
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
}
