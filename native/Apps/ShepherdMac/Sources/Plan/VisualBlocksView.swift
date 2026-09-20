import Foundation
import ShepherdKit
import SwiftUI

/// Contract-backed blocks, in wire order. Plans use the default `inferred: false`;
/// a recap caller may opt in to the server's inferred badges.
struct VisualBlocksView: View {
    let blocks: [VisualBlock]
    var inferred = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // IDs are model-authored and can repeat. Position keeps every block visible.
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                content(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func content(_ block: VisualBlock) -> some View {
        if let value = block.value1 {
            identified("rich-text", value.id) { markdown(value.markdown) }
        } else if let value = block.value2 {
            identified("callout", value.id) { callout(value) }
        } else if let value = block.value10 {
            identified("checklist", value.id) { checklist(value) }
        } else if let value = block.value3 {
            identified("file-tree", value.id) { fileTree(value) }
        } else if let value = block.value9 {
            identified("table", value.id) { table(value) }
        } else if let value = block.value13 {
            // Task 7 replaces this read-only placeholder with QuestionFormView.
            identified("question-form", value.id) {
                omitted(value.questions.map(\.prompt))
            }
        } else if let value = block.value4 {
            identified("diff", value.id) { omitted([value.summary]) }
        } else if let value = block.value5 {
            identified("code", value.id) { omitted([value.filename]) }
        } else if let value = block.value6 {
            identified("annotated-code", value.id) { omitted([value.filename]) }
        } else if let value = block.value7 {
            identified("data-model", value.id) {
                omitted(value.entities.map(\.name), isInferred: value.inferred == true)
            }
        } else if let value = block.value8 {
            identified("api-endpoint", value.id) {
                omitted(["\(value.method) \(value.path)", value.summary].compactMap { $0 },
                        isInferred: value.inferred == true)
            }
        } else if let value = block.value11 {
            identified("mermaid", value.id) {
                omitted([value.caption].compactMap { $0 }, isInferred: value.inferred == true)
            }
        } else if let value = block.value12 {
            identified("wireframe", value.id) {
                // Never read html into a renderer, including a Markdown/HTML bridge.
                omitted([value.caption].compactMap { $0 }, wireframe: true)
            }
        }
        // Unknown open-union members intentionally produce no view, even with markdown.
    }

    private func identified<Content: View>(
        _ type: String, _ id: String, @ViewBuilder content: () -> Content
    ) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("visual-block-\(type)-\(id)")
    }

    private func markdown(_ source: String) -> some View {
        Text((try? AttributedString(markdown: source)) ?? AttributedString(source))
            .textSelection(.enabled)
    }

    private func callout(_ value: VisualBlockCallout) -> some View {
        let style = toneStyle(value.tone)
        return VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: style.label.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(style.color)
            markdown(value.markdown)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(style.color.opacity(0.06))
        .overlay(alignment: .leading) { Rectangle().fill(style.color).frame(width: 3) }
    }

    private func toneStyle(_ tone: CalloutTone) -> (label: String, color: Color) {
        switch tone.known {
        case .info: (L.t("vblock_callout_info"), .blue)
        case .decision: (L.t("vblock_callout_decision"), .orange)
        case .risk: (L.t("vblock_callout_risk"), .red)
        case .warning: (L.t("vblock_callout_warning"), .orange)
        case .success: (L.t("vblock_callout_success"), .green)
        case nil: (tone.rawValue, .secondary)
        }
    }

    private func checklist(_ value: VisualBlockChecklist) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(value.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: item.checked == true ? "☑" : "☐")
                        .foregroundStyle(item.checked == true ? Color.green : .secondary)
                    Text(verbatim: item.label)
                        .strikethrough(item.checked == true)
                        .opacity(item.checked == true ? 0.6 : 1)
                    if let note = item.note {
                        Text(verbatim: note).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func fileTree(_ value: VisualBlockFileTree) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let title = value.title { Text(verbatim: title).font(.headline) }
            ForEach(VisualFileTree.rows(value.entries), id: \.path) { row in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let change = row.entry?.change {
                        let badge = changeStyle(change)
                        Text(verbatim: badge.glyph)
                            .foregroundStyle(badge.color)
                            .help(badge.label)
                    } else {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                    Text(verbatim: row.name)
                    if let note = row.entry?.note {
                        Text(verbatim: note).foregroundStyle(.secondary)
                    }
                }
                .font(.caption.monospaced())
                .padding(.leading, row.indent)
            }
        }
    }

    private func changeStyle(_ change: FileTreeChange) -> (glyph: String, label: String, color: Color) {
        switch change.known {
        case .added: ("A", L.t("vblock_filetree_added"), .green)
        case .modified: ("M", L.t("vblock_filetree_modified"), .orange)
        case .removed: ("D", L.t("vblock_filetree_removed"), .red)
        case .renamed: ("R", L.t("vblock_filetree_renamed"), .orange)
        case nil: (String(change.rawValue.prefix(1)).uppercased(), change.rawValue, .secondary)
        }
    }

    private func table(_ value: VisualBlockTable) -> some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(value.columns.enumerated()), id: \.offset) { _, column in
                        Text(verbatim: column).fontWeight(.semibold)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
                ForEach(Array(value.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(verbatim: cell)
                        }
                    }
                }
            }
            .textSelection(.enabled)
        }
    }

    private func omitted(_ text: [String], isInferred: Bool = false, wireframe: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(text.enumerated()), id: \.offset) { _, line in
                Text(verbatim: line).textSelection(.enabled)
            }
            Text(wireframe ? L.t("vblock_native_wireframe_omitted") : L.t("vblock_native_not_rendered"))
                .font(.caption).foregroundStyle(.secondary)
            if inferred && isInferred {
                Text(L.t("vblock_inferred")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// Groups shared directories in first-seen order, then flattens depth-first for SwiftUI.
/// This is view layout, not another server payload type.
enum VisualFileTree {
    struct Row {
        let path: String
        let name: String
        let indent: CGFloat
        var entry: FileTreeEntry?
    }

    static func rows(_ entries: [FileTreeEntry]) -> [Row] {
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
