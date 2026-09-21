import Foundation
import ShepherdKit
import SwiftUI

/// Groups shared directories in first-seen order, then flattens depth-first for SwiftUI.
/// This is view layout, not another server payload type.
public enum VisualFileTree {
    public struct Row {
        public let path: String
        public let name: String
        public let indent: CGFloat
        public var entry: FileTreeEntry?
    }

    public static func rows(_ entries: [FileTreeEntry]) -> [Row] {
        var nodes: [String: Row] = [:]
        var children: [String: [String]] = [:]
        for entry in entries {
            let segments = entry.path.split(separator: "/")
            var parent = ""
            for (depth, segment) in segments.enumerated() {
                let path = parent.isEmpty ? String(segment) : "\(parent)/\(segment)"
                if nodes[path] == nil {
                    nodes[path] = Row(path: path, name: String(segment), indent: CGFloat(depth * 12))
                    children[parent, default: []].append(path)
                }
                if depth == segments.count - 1 { nodes[path]?.entry = entry }
                parent = path
            }
        }
        // Iterative traversal also tolerates arbitrarily deep model-authored paths.
        var pending = Array((children[""] ?? []).reversed())
        var result: [Row] = []
        while let path = pending.popLast() {
            if let row = nodes[path] { result.append(row) }
            pending.append(contentsOf: (children[path] ?? []).reversed())
        }
        return result
    }
}
