import Foundation
import Testing
@testable import ShepherdAppCore

extension CoreSeamTests {
struct PairingLinkTests {
    private let code = "shpp_" + String(repeating: "a", count: 43)
    private func link(_ server: String) -> String {
        var url = URLComponents(string: "shepherd://pair")!
        url.queryItems = [URLQueryItem(name: "server", value: server), URLQueryItem(name: "code", value: code)]
        return url.string!
    }
    @Test func validAddressUsesFormNormalization() throws {
        let parsed = try #require(PairingLink.parse(link(" HTTPS://Server.TS.NET:443/path?x=1#fragment ")))
        #expect(parsed.baseURL.absoluteString == "https://server.ts.net:443")
        #expect(parsed.code == code)
    }
    @Test func rejectsInsecureRemoteButAcceptsTailnet() {
        #expect(PairingLink.parse(link("http://example.com")) == nil)
        #expect(PairingLink.parse(link("http://server.tail.ts.net:7330")) != nil)
        #expect(PairingLink.parse(link("ftp://server.ts.net")) == nil)
    }
    @Test func missingOrMalformedCodeIsRejected() {
        #expect(PairingLink.parse("shepherd://pair?server=https%3A%2F%2Fserver.ts.net") == nil)
        #expect(PairingLink.parse(link("https://server.ts.net").replacingOccurrences(of: code, with: "shp_token")) == nil)
    }
    @Test func foreignAndAmbiguousLinksAreRejected() {
        #expect(PairingLink.parse("https://example.com/?code=\(code)") == nil)
        #expect(PairingLink.parse(link("https://server.ts.net") + "&code=\(code)") == nil)
        #expect(PairingLink.parse(link("https://server.ts.net").replacingOccurrences(of: "shepherd://pair", with: "shepherd://other")) == nil)
        #expect(PairingLink.parse(link("https://server.ts.net") + "#fragment") == nil)
    }
}
}
