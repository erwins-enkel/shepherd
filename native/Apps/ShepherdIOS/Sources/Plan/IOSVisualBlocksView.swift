import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// Render contract members in wire order. Unknown members and untrusted HTML stay inert.
struct IOSVisualBlocksView: View {
    let blocks: [VisualBlock]
    let presentation: IOSPlanPresentation
    var fixture = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                content(block, index: index)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("plan-visual-block-\(index)")
            }
        }
    }

    @ViewBuilder private func content(_ block: VisualBlock, index: Int) -> some View {
        if let value = block.value1 { markdown(value.markdown) }
        else if let value = block.value2 {
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: toneLabel(value.tone)).sessionFont(label: true, weight: .semibold)
                markdown(value.markdown)
            }
            .padding(12).background(SessionListStyle.panel)
            .overlay(alignment: .leading) { Rectangle().fill(SessionListStyle.amber).frame(width: 2) }
        } else if let value = block.value3 {
            VStack(alignment: .leading, spacing: 6) {
                if let title = value.title { heading(title) }
                ForEach(VisualFileTree.rows(value.entries), id: \.path) { row in
                    HStack(alignment: .top, spacing: 6) {
                        Text(verbatim: row.entry.map { changeLabel($0.change) } ?? "▸").foregroundStyle(SessionListStyle.muted)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: row.name)
                            if let note = row.entry?.note { Text(verbatim: note).foregroundStyle(SessionListStyle.muted) }
                        }
                    }.padding(.leading, min(row.indent, 60))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(verbatim: [row.path, row.entry.map { changeLabel($0.change) }, row.entry?.note].compactMap { $0 }.joined(separator: ", ")))
                }
            }
        } else if let value = block.value4 {
            heading(value.path)
            markdown(value.summary)
            annotations(value.annotations)
            omission()
        } else if let value = block.value5 {
            code(filename: value.filename, source: value.code)
        } else if let value = block.value6 {
            code(filename: value.filename, source: value.code)
            annotations(value.annotations)
        } else if let value = block.value7 {
            ForEach(Array(value.entities.enumerated()), id: \.offset) { _, entity in
                heading(entity.name)
                ForEach(Array(entity.fields.enumerated()), id: \.offset) { _, field in
                    Text(verbatim: "\(field.name): \(field._type)")
                }
            }
        } else if let value = block.value8 {
            heading("\(value.method) \(value.path)")
            if let summary = value.summary { markdown(summary) }
            ForEach(Array((value.params ?? []).enumerated()), id: \.offset) { _, param in
                Text(verbatim: "\(param.name): \(param._type)")
                if let note = param.note { markdown(note) }
            }
            ForEach(Array((value.responses ?? []).enumerated()), id: \.offset) { _, response in
                Text(verbatim: [String(response.status), response.description].compactMap { $0 }.joined(separator: " · "))
            }
        } else if let value = block.value9 {
            // Key/value rows avoid a wide desktop grid and retain column context for VoiceOver.
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(value.rows.enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                            VStack(alignment: .leading, spacing: 2) {
                                if value.columns.indices.contains(index) {
                                    Text(verbatim: value.columns[index]).sessionFont(label: true)
                                        .foregroundStyle(SessionListStyle.muted)
                                }
                                Text(verbatim: cell)
                            }.accessibilityElement(children: .combine)
                        }
                    }.padding(10).background(SessionListStyle.panel)
                }
            }
        } else if let value = block.value10 {
            ForEach(Array(value.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: item.checked == true ? "checkmark.square" : "square")
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: item.label)
                        if let note = item.note { Text(verbatim: note).foregroundStyle(SessionListStyle.muted) }
                    }
                }.accessibilityElement(children: .combine)
            }
        } else if let value = block.value11 {
            if let caption = value.caption { heading(caption) }
            Text(verbatim: value.source).sessionFont(label: true)
            omission()
        } else if let value = block.value12 {
            if let caption = value.caption { heading(caption) }
            Text(verbatim: L.t("vblock_native_wireframe_omitted")).foregroundStyle(SessionListStyle.muted)
        } else if let value = block.value13 {
            IOSQuestionFormView(model: presentation.form(at: index, block: value),
                answered: presentation.answered(value), fixture: fixture)
        }
    }

    private func markdown(_ source: String) -> some View { IOSPlanMarkdownView(source: source, fixture: fixture) }
    private func heading(_ text: String) -> some View {
        Text(verbatim: text).sessionFont(weight: .semibold).accessibilityAddTraits(.isHeader)
    }
    private func omission() -> some View {
        Text(verbatim: L.t("vblock_native_not_rendered")).sessionFont(label: true).foregroundStyle(SessionListStyle.muted)
    }
    private func toneLabel(_ tone: CalloutTone) -> String {
        switch tone.known {
        case .info: L.t("vblock_callout_info")
        case .decision: L.t("vblock_callout_decision")
        case .risk: L.t("vblock_callout_risk")
        case .warning: L.t("vblock_callout_warning")
        case .success: L.t("vblock_callout_success")
        case nil: tone.rawValue
        }
    }
    private func changeLabel(_ change: FileTreeChange) -> String {
        switch change.known {
        case .added: L.t("vblock_filetree_added")
        case .modified: L.t("vblock_filetree_modified")
        case .removed: L.t("vblock_filetree_removed")
        case .renamed: L.t("vblock_filetree_renamed")
        case nil: change.rawValue
        }
    }
    @ViewBuilder private func annotations(_ values: [DiffAnnotation]?) -> some View {
        ForEach(Array((values ?? []).enumerated()), id: \.offset) { _, value in
            Text(verbatim: [value.label, value.note].compactMap { $0 }.joined(separator: ": "))
        }
    }
    @ViewBuilder private func code(filename: String, source: String?) -> some View {
        heading(filename)
        if let source { Text(verbatim: source).sessionFont(label: true).padding(10).background(SessionListStyle.panel) }
        else { omission() }
    }
}

/// Mirrors the Mac paragraph/list parsing without importing any Mac view or HTML renderer.
struct IOSPlanMarkdownView: View {
    let source: String
    var fixture = false
    var body: some View {
        if fixture { paragraphs }
        else { paragraphs.textSelection(.enabled) }
    }
    private var paragraphs: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.blocks(source).enumerated()), id: \.offset) { _, block in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let marker = block.marker { Text(verbatim: marker).accessibilityHidden(true) }
                    Text(block.text).sessionFont(weight: block.heading ? .semibold : .regular)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(block.heading ? .isHeader : [])
                }.padding(.leading, CGFloat(min(block.depth, 5) * 12))
            }
        }
    }
    struct Block {
        let text: AttributedString
        var heading = false
        var marker: String?
        var depth = 0
    }
    static func blocks(_ source: String) -> [Block] {
        guard let parsed = try? AttributedString(markdown: source) else { return [Block(text: AttributedString(source))] }
        return parsed.runs[\.presentationIntent].map { intent, range in
            var block = Block(text: AttributedString(parsed[range]))
            let components = intent?.components ?? []
            let ordered = components.first { $0.kind == .orderedList || $0.kind == .unorderedList }?.kind == .orderedList
            for component in components {
                switch component.kind {
                case .header: block.heading = true
                case .listItem(let ordinal): if block.marker == nil { block.marker = ordered ? "\(ordinal)." : "•" }
                default: break
                }
            }
            block.depth = max(0, components.filter {
                $0.kind == .orderedList || $0.kind == .unorderedList || $0.kind == .blockQuote
            }.count - 1)
            return block
        }
    }
}
