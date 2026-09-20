import Foundation

/// A parsed unified git patch.
///
/// `GET /api/sessions/{id}/diff` strips the server's parsed hunks and sends `DiffFile.patch` —
/// the raw patch block — instead, which is what the web UI hands to its own diff renderer. This
/// models **no server payload**: the wire type is a `String` the contract already declares, so
/// the "no hand-written Codable" rule is intact.
///
/// One `DiffFile.patch` normally describes one file, but the parser is written against the
/// general shape (`diff --git` sections, or a plain `---`/`+++` stream) so a multi-file block
/// pasted or streamed through the same call site reads correctly instead of silently merging
/// two files' hunks into one list. The diff tab reads `hunks` — the flattened view.
///
/// Pure and total. Malformed input is never an error: whatever parses becomes `files`, and if
/// nothing does, the text survives in `raw` for the tab to show verbatim. A patch the operator
/// cannot read must not take the window with it.
struct UnifiedPatch: Equatable, Sendable {
    struct Line: Equatable, Sendable {
        enum Kind: Equatable, Sendable { case add, del, context }
        var kind: Kind
        /// The text WITHOUT its leading `+`, `-` or space marker.
        var text: String
        /// 1-based number on the old side; nil on an added line.
        var oldNumber: Int?
        /// 1-based number on the new side; nil on a deleted line.
        var newNumber: Int?
    }

    struct Hunk: Equatable, Sendable {
        /// The raw `@@ -a,b +c,d @@ …` line, shown as the hunk's header.
        var header: String
        var lines: [Line]
    }

    /// One file's section of the patch.
    struct File: Equatable, Sendable {
        /// The new path, with the `a/`/`b/` prefix removed. Falls back to the old path when the
        /// new side is `/dev/null` (a deletion), so a file always has a name to show. Nil only
        /// when the patch named neither side.
        var path: String?
        /// The old path, nil for an added file.
        var oldPath: String?
        /// `Binary files … differ` or a `GIT binary patch` payload: there is nothing to render
        /// line by line.
        var isBinary: Bool
        var hunks: [Hunk]

        var isRename: Bool {
            guard let oldPath, let path else { return false }
            return oldPath != path
        }
    }

    var files: [File]

    /// The patch text when nothing parsed out of it — a malformed block, or a shape this parser
    /// does not know. Empty whenever `files` is non-empty or the input was blank, so a tab can
    /// treat a non-empty `raw` as "show this verbatim" without a second check.
    var raw: String

    /// Every hunk in the patch, in order, regardless of which file it belongs to. What the diff
    /// tab renders, since it parses one `DiffFile.patch` at a time.
    var hunks: [Hunk] { files.flatMap(\.hunks) }

    static func parse(_ patch: String) -> UnifiedPatch {
        // Normalised up front. "\r\n" is a SINGLE Swift `Character`, so splitting a CRLF patch
        // on "\n" would not split it at all — the whole patch would come back as one line. The
        // trailing-empty drop is for the other end: a patch that does end in a newline must not
        // gain a phantom empty context line at the close of its last hunk.
        var lines = patch.replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.hasSuffix("\r") ? String($0.dropLast()) : String($0) }
        if lines.last?.isEmpty == true { lines.removeLast() }

        var files: [File] = []
        var hunks: [Hunk] = []
        var hunk: Hunk?
        var path: String?
        var oldPath: String?
        var isBinary = false
        /// Whether anything at all has been seen for the file being assembled. Without it a
        /// leading preamble would emit an empty `File` before the first real one.
        var started = false
        /// Set once `+++ ` has been read for the file being assembled; reset by `closeFile()`.
        /// Distinguishes the `--- `/`+++ ` pair that immediately follows a `diff --git` header
        /// (already `started`, must NOT close) from the next file's boundary in a plain `diff -u`
        /// stream (must close) — a distinction `!hunks.isEmpty` got wrong for a file with no
        /// hunks at all (binary, or a mode-only change): that file's own section was never
        /// closed, and the next file's `--- ` silently overwrote it instead of starting anew.
        var fileHeaderComplete = false
        var oldNo = 0
        var newNo = 0
        /// What the hunk header said is left to read on each side. Only ever consulted to tell a
        /// `---`/`+++` FILE header from a deletion/addition that happens to start that way: both
        /// readings are legal, and the counts are the only thing that distinguishes them. A count
        /// that runs out early never truncates a hunk — content markers keep being read.
        var remainingOld = 0
        var remainingNew = 0

        func closeHunk() {
            if let hunk { hunks.append(hunk) }
            hunk = nil
        }

        func closeFile() {
            closeHunk()
            if started {
                files.append(File(path: path, oldPath: oldPath, isBinary: isBinary, hunks: hunks))
            }
            hunks = []
            path = nil
            oldPath = nil
            isBinary = false
            started = false
            fileHeaderComplete = false
        }

        for line in lines {
            // Inside a hunk the marker decides everything: `--- a/x` here is a deletion of
            // `-- a/x`, not a file header, which is exactly what git means by it.
            if hunk != nil {
                // A plain `diff -u` stream has no `diff --git` header, so the next file's
                // `--- a/…` is the only boundary there is — and inside an unfinished hunk that
                // same text is a deletion. The declared counts decide which it is.
                if remainingOld <= 0, remainingNew <= 0,
                    line.hasPrefix("--- ") || line.hasPrefix("+++ ")
                {
                    closeHunk()
                } else {
                    switch line.first {
                    case "+":
                        hunk?.lines.append(
                            Line(
                                kind: .add, text: String(line.dropFirst()), oldNumber: nil,
                                newNumber: newNo))
                        newNo += 1
                        remainingNew -= 1
                        continue
                    case "-":
                        hunk?.lines.append(
                            Line(
                                kind: .del, text: String(line.dropFirst()), oldNumber: oldNo,
                                newNumber: nil))
                        oldNo += 1
                        remainingOld -= 1
                        continue
                    case " ":
                        hunk?.lines.append(
                            Line(
                                kind: .context, text: String(line.dropFirst()), oldNumber: oldNo,
                                newNumber: newNo))
                        oldNo += 1
                        newNo += 1
                        remainingOld -= 1
                        remainingNew -= 1
                        continue
                    case nil:
                        // A bare empty line inside a hunk is an unmarked context line: git writes
                        // it that way when the file's own line is empty and the marker space was
                        // stripped in transit.
                        hunk?.lines.append(
                            Line(kind: .context, text: "", oldNumber: oldNo, newNumber: newNo))
                        oldNo += 1
                        newNo += 1
                        remainingOld -= 1
                        remainingNew -= 1
                        continue
                    case "\\":
                        // "\ No newline at end of file" annotates the line before it. Not
                        // content, and it advances neither side's numbering.
                        continue
                    default:
                        // Anything else ends the hunk and is re-read below as structure — the
                        // next file's `diff --git`, say.
                        closeHunk()
                    }
                }
            }

            if line.hasPrefix("@@") {
                guard let range = parseHeader(line) else { continue }
                oldNo = range.oldStart
                newNo = range.newStart
                remainingOld = range.oldCount
                remainingNew = range.newCount
                hunk = Hunk(header: line, lines: [])
                started = true
            } else if line.hasPrefix("diff --git ") {
                closeFile()
                let pair = gitHeaderPaths(String(line.dropFirst("diff --git ".count)))
                oldPath = pair.old
                path = pair.new
                started = true
            } else if line.hasPrefix("rename from ") {
                oldPath = String(line.dropFirst("rename from ".count))
                started = true
            } else if line.hasPrefix("rename to ") {
                path = String(line.dropFirst("rename to ".count))
                started = true
            } else if line.hasPrefix("--- ") {
                // A plain `diff -u` stream has no `diff --git` header, so this pair is the only
                // file boundary there is — but only once the PRIOR file's own `--- `/`+++ ` pair
                // has already been read in full, not merely once it has any hunks: a hunk-less
                // file (binary, or a mode-only change) still needs closing before the next one
                // starts.
                if fileHeaderComplete { closeFile() }
                oldPath = strippedPath(String(line.dropFirst(4)))
                started = true
            } else if line.hasPrefix("+++ ") {
                // `/dev/null` on the new side is a deletion: keep the old name so the file still
                // has something to be called, mirroring `DiffFile.path`.
                path = strippedPath(String(line.dropFirst(4))) ?? oldPath
                started = true
                fileHeaderComplete = true
            } else if line.hasPrefix("Binary files ") || line == "GIT binary patch" {
                isBinary = true
                started = true
            }
            // Everything else — `index`, `similarity index`, `new file mode`, prose — is
            // preamble this parser has no use for.
        }
        closeFile()

        let parsed = UnifiedPatch(files: files, raw: "")
        guard parsed.files.isEmpty else { return parsed }
        let trimmed = patch.trimmingCharacters(in: .whitespacesAndNewlines)
        return UnifiedPatch(files: [], raw: trimmed.isEmpty ? "" : patch)
    }

    /// The largest line number or count a hunk header may name.
    ///
    /// `Int(_:)` happily parses `9223372036854775807`, and the walk below then does `newNo += 1`
    /// on it — which **traps**, taking the window down with a patch the type promises is only
    /// ever "unreadable", never fatal. Any header naming a number outside this range is treated
    /// as unparsable, exactly like `@@ garbage @@`: its hunk is dropped and the parse keeps
    /// going. The ceiling is far above any file a forge will ever send (a billion lines) and far
    /// below where the arithmetic can overflow, so no real patch is refused by it. A negative
    /// number is refused for the same reason — a hunk cannot start before line zero, and only a
    /// malformed header says it does.
    private static let lineNumberLimit = 1_000_000_000

    /// `@@ -oldStart[,count] +newStart[,count] @@ …` → both sides' start and length. A range
    /// with no count is one line. Nil for a header this parser will not walk, including one
    /// whose numbers are out of range — see `lineNumberLimit`.
    private static func parseHeader(
        _ header: String
    ) -> (oldStart: Int, oldCount: Int, newStart: Int, newCount: Int)? {
        let fields = header.split(separator: " ")
        guard fields.count >= 3 else { return nil }
        func sane(_ value: Int) -> Bool { value >= 0 && value <= lineNumberLimit }
        func range(_ field: Substring, _ marker: Character) -> (Int, Int)? {
            guard field.first == marker else { return nil }
            let parts = field.dropFirst().split(separator: ",")
            guard let start = parts.first.flatMap({ Int($0) }), sane(start) else { return nil }
            guard parts.count > 1 else { return (start, 1) }
            guard let count = Int(parts[1]), sane(count) else { return nil }
            return (start, count)
        }
        guard let old = range(fields[1], "-"), let new = range(fields[2], "+") else { return nil }
        return (oldStart: old.0, oldCount: old.1, newStart: new.0, newCount: new.1)
    }

    /// The two paths of a `diff --git a/<old> b/<new>` header. Genuinely ambiguous when a path
    /// contains a space, so the split takes the LAST " b/" — the common case where only the new
    /// side's prefix can be confused with content. The `---`/`+++` pair that follows overwrites
    /// whatever this guessed, and is the authority for `/dev/null` sides.
    private static func gitHeaderPaths(_ rest: String) -> (old: String?, new: String?) {
        if let separator = rest.range(of: " b/", options: .backwards) {
            return (
                strippedPath(String(rest[rest.startIndex..<separator.lowerBound])),
                strippedPath(String(rest[separator.lowerBound...].dropFirst()))
            )
        }
        let fields = rest.split(separator: " ")
        guard fields.count == 2 else { return (nil, nil) }
        return (strippedPath(String(fields[0])), strippedPath(String(fields[1])))
    }

    /// One side of a `---`/`+++`/`diff --git` header as a path: the `a/`/`b/` prefix removed, a
    /// plain-diff timestamp after a tab dropped, and `/dev/null` resolved to nil.
    private static func strippedPath(_ field: String) -> String? {
        var value = field
        if let tab = value.firstIndex(of: "\t") { value = String(value[value.startIndex..<tab]) }
        value = value.trimmingCharacters(in: .whitespaces)
        guard value != "/dev/null", !value.isEmpty else { return nil }
        if value.hasPrefix("a/") || value.hasPrefix("b/") { value = String(value.dropFirst(2)) }
        return value.isEmpty ? nil : value
    }
}
