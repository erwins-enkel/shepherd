import ShepherdKit

/// Where the diff tab's annotations render, computed once per diff read rather than re-scanned
/// on every body pass: a 15 s poll tick that repaints unchanged content must not repeat an
/// O(files) reparse of every patch or an O(lines × notes) scan for each rendered line.
///
/// A `review` note is ALWAYS a file (or panel) banner, never anchored to one line —
/// `DiffFileStack.svelte`'s `reviewFindings` (the web reading of the same contract) is keyed by
/// path only, and a `lineNumber` a review note happens to carry is not a rendering instruction.
/// An `agent` note anchors to its line when the parsed patch actually renders that line;
/// otherwise it falls back to the file banner rather than vanishing — the file may be binary,
/// truncated, or the line may simply fall outside the (capped) patch this diff sent.
public struct DiffAnnotationLayout: Equatable, Sendable {
    public init() {}

    public struct LineKey: Hashable, Sendable {
        public init(path: String, side: Side, number: Int) { self.path = path; self.side = side; self.number = number }
        public enum Side: Hashable, Sendable { case old, new }
        let path: String
        let side: Side
        let number: Int
    }

    /// Panel-wide findings (an empty `path`), plus any note whose `path` names a file this diff
    /// no longer carries — grouped together rather than dropped, since neither belongs to one
    /// rendered file.
    public var panel: [DiffNote] = []
    /// Per-file banners: every `review` note for a file, plus any `agent` note that could not be
    /// anchored to a rendered line.
    public var fileLevel: [String: [DiffNote]] = [:]
    /// `agent` notes anchored to one rendered line.
    public var perLine: [LineKey: [DiffNote]] = [:]
    /// Each file's patch, parsed exactly once here — the diff tab's only source of hunks, so
    /// rendering never reparses text this already walked to build `perLine`.
    public var hunks: [String: UnifiedPatch] = [:]

    public static func partition(notes: [DiffNote], files: [DiffFile]) -> DiffAnnotationLayout {
        var layout = DiffAnnotationLayout()

        // One parse per file. Also the source of which old/new line numbers this diff actually
        // renders, so an out-of-range note (a stale annotation, a truncated file) falls back to
        // the file banner instead of being silently compared against nothing and dropped.
        var lineNumbers: [String: (old: Set<Int>, new: Set<Int>)] = [:]
        for file in files {
            let parsed = UnifiedPatch.parse(file.patch ?? "")
            layout.hunks[file.path] = parsed
            var old = Set<Int>()
            var new = Set<Int>()
            for hunk in parsed.hunks {
                for line in hunk.lines {
                    if let n = line.oldNumber { old.insert(n) }
                    if let n = line.newNumber { new.insert(n) }
                }
            }
            lineNumbers[file.path] = (old, new)
        }
        let filePaths = Set(files.map(\.path))

        for note in notes {
            if note.path.isEmpty {
                layout.panel.append(note)
                continue
            }
            guard filePaths.contains(note.path) else {
                layout.panel.append(note)
                continue
            }
            // Only an `agent` note with a line number is ever a per-line candidate; a `review`
            // note (or an unrecognised future kind) always renders as a file banner.
            guard note.kind.known == .agent, let number = note.lineNumber else {
                layout.fileLevel[note.path, default: []].append(note)
                continue
            }
            let side: LineKey.Side = note.side?.known == .deletions ? .old : .new
            let sets = lineNumbers[note.path]
            let isAnchored =
                side == .old ? sets?.old.contains(number) == true : sets?.new.contains(number) == true
            if isAnchored {
                layout.perLine[LineKey(path: note.path, side: side, number: number), default: []]
                    .append(note)
            } else {
                layout.fileLevel[note.path, default: []].append(note)
            }
        }
        return layout
    }
}
