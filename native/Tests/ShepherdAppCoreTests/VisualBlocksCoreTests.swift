import ShepherdKit
import SwiftUI
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
@Suite(.serialized)
@MainActor
struct VisualBlocksTests {
    @Test func treeGroupsInterleavedPathsAndIndentsTwelvePoints() {
        let rows = VisualFileTree.rows([
            .init(path: "src/a.swift", change: .init(known: .added)),
            .init(path: "README.md", change: .init(known: .modified)),
            .init(path: "/src/nested/b.swift", change: .init(known: .removed)),
            .init(path: "src/c.swift", change: .init(known: .renamed)),
            .init(path: "///", change: .init(known: .added)),
        ])
        #expect(rows.map(\.name) == ["src", "a.swift", "nested", "b.swift", "c.swift", "README.md"])
        #expect(rows.map(\.indent) == [0, 12, 12, 24, 12, 0])
    }

}
}
