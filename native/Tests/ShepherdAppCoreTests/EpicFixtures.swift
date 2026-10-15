import Foundation
import ShepherdKit

/// Epics the way `GET /api/epic` answers them; children take `order` from their position.
enum EpicFixtures {
    struct Child {
        let number: Int
        var blockedBy: [Int] = []
        var state = "blocked"
        var sessionId: String? = nil
        var title: String? = nil
    }

    static func epic(_ children: [Child], parent: Int = 111, title: String = "Epic: Content-Plan-Kalender",
                     status: String = "running", extra: String = "") throws -> Epic {
        let rows = children.enumerated().map { index, child in
            let session = child.sessionId.map { "\"\($0)\"" } ?? "null"
            return """
                {"number":\(child.number),"title":"\(child.title ?? "Child \(child.number)")",\
                "url":"https://github.com/o/r/issues/\(child.number)","order":\(index),"body":"",\
                "blockedBy":\(child.blockedBy),"state":"\(child.state)","sessionId":\(session),\
                "prNumber":null,"issueClosed":false,"integrationMerged":false,"claimed":false}
                """
        }.joined(separator: ",")
        let json = """
            {"repoPath":"/repos/media","parentIssueNumber":\(parent),"parentTitle":"\(title)",\
            "source":"native","children":[\(rows)],"warnings":[],\
            "run":{"repoPath":"/repos/media","parentIssueNumber":\(parent),"mode":"auto","status":"\(status)"}\(extra)}
            """
        return try JSONDecoder().decode(Epic.self, from: Data(json.utf8))
    }

    /// Epic #111 of media-bib-and-rendering: #101 → #102, #103; #103 → #104–#106, #108–#110;
    /// #106 → #107. #101 runs, the rest are blocked unless `states` says otherwise.
    static func content111(_ states: [Int: String] = [:], sessions: [Int: String] = [:]) throws -> Epic {
        let edges: [Int: [Int]] = [102: [101], 103: [101], 104: [103], 105: [103], 106: [103],
                                   107: [106], 108: [103], 109: [103], 110: [103]]
        return try epic((101...110).map { number in
            Child(number: number, blockedBy: edges[number] ?? [],
                  state: states[number] ?? (number == 101 ? "running" : "blocked"), sessionId: sessions[number])
        })
    }

    static func allMerged() -> [Int: String] {
        Dictionary(uniqueKeysWithValues: (101...110).map { ($0, "merged") })
    }
}
