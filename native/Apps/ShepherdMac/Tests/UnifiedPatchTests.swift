import ShepherdKit
import Testing

@testable import Shepherd

/// `GET /diff` sends `DiffFile.patch` — the raw patch block — and strips the server's parsed
/// hunks, so this parser is the only thing standing between that text and the diff tab. It is
/// pure and total: every case below is an answer, never a throw and never a crash.
struct UnifiedPatchTests {

    // MARK: - One hunk

    @Test func parsesHunkHeadersAndNumbersBothSides() {
        let parsed = UnifiedPatch.parse(
            """
            @@ -10,3 +10,4 @@ func thing()
             context
            -gone
            +new
            +extra
            """)
        #expect(parsed.hunks.count == 1)
        #expect(parsed.hunks[0].header == "@@ -10,3 +10,4 @@ func thing()")
        let lines = parsed.hunks[0].lines
        #expect(lines.map(\.kind) == [.context, .del, .add, .add])
        #expect(lines.map(\.text) == ["context", "gone", "new", "extra"])
        #expect(lines[0].oldNumber == 10 && lines[0].newNumber == 10)
        #expect(lines[1].oldNumber == 11 && lines[1].newNumber == nil)
        #expect(lines[2].oldNumber == nil && lines[2].newNumber == 11)
        #expect(lines[3].newNumber == 12)
    }

    @Test func keepsSeveralHunksApart() {
        let parsed = UnifiedPatch.parse("@@ -1 +1 @@\n-a\n+b\n@@ -20,2 +20,2 @@\n ctx\n-c")
        #expect(parsed.hunks.count == 2)
        #expect(parsed.hunks[1].lines.first?.oldNumber == 20)
    }

    @Test func aRangeWithNoCountIsOneLine() {
        let parsed = UnifiedPatch.parse("@@ -7 +9 @@\n-x\n+y")
        #expect(parsed.hunks[0].lines[0].oldNumber == 7)
        #expect(parsed.hunks[0].lines[1].newNumber == 9)
    }

    @Test func ignoresThePreambleBeforeTheFirstHunk() {
        let parsed = UnifiedPatch.parse(
            "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+y")
        #expect(parsed.hunks.count == 1)
        #expect(parsed.hunks[0].lines.map(\.text) == ["y"])
        #expect(parsed.files.count == 1)
        #expect(parsed.files[0].path == "x")
    }

    /// A bare empty line inside a hunk is git's way of writing a context line whose own content
    /// is empty — the trailing marker space is stripped — and it advances both sides.
    @Test func aBareEmptyLineInsideAHunkIsContext() {
        let parsed = UnifiedPatch.parse("@@ -1,2 +1,2 @@\n ctx\n\n+new")
        #expect(parsed.hunks[0].lines.map(\.kind) == [.context, .context, .add])
        #expect(parsed.hunks[0].lines[1].text.isEmpty)
        #expect(parsed.hunks[0].lines[1].oldNumber == 2 && parsed.hunks[0].lines[1].newNumber == 2)
    }

    /// The patch text carries no trailing newline, but a server that adds one must not turn it
    /// into a phantom context line at the end of the last hunk.
    @Test func aTrailingNewlineAddsNoPhantomLine() {
        #expect(UnifiedPatch.parse("@@ -1 +1 @@\n-a\n+b\n").hunks[0].lines.count == 2)
    }

    // MARK: - Several files in one block

    @Test func splitsAMultiFilePatchIntoItsFiles() {
        let parsed = UnifiedPatch.parse(
            """
            diff --git a/one.txt b/one.txt
            index 111..222 100644
            --- a/one.txt
            +++ b/one.txt
            @@ -1 +1 @@
            -first
            +First
            diff --git a/two.txt b/two.txt
            new file mode 100644
            --- /dev/null
            +++ b/two.txt
            @@ -0,0 +1,2 @@
            +second
            +lines
            """)
        #expect(parsed.files.map(\.path) == ["one.txt", "two.txt"])
        #expect(parsed.files[0].oldPath == "one.txt")
        // An added file has no old side at all: `--- /dev/null` resolves away.
        #expect(parsed.files[1].oldPath == nil)
        #expect(parsed.files.map { $0.hunks.count } == [1, 1])
        #expect(parsed.files[1].hunks[0].lines.map(\.newNumber) == [1, 2])
        // `hunks` is the flattened view the per-file diff tab reads.
        #expect(parsed.hunks.count == 2)
    }

    /// A plain `diff -u` stream has no `diff --git` headers — the `---`/`+++` pair is the only
    /// file boundary there is.
    @Test func splitsAPlainUnifiedStreamOnItsFileHeaders() {
        let parsed = UnifiedPatch.parse(
            "--- a/one\n+++ b/one\n@@ -1 +1 @@\n-a\n+A\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-b\n+B")
        #expect(parsed.files.map(\.path) == ["one", "two"])
        #expect(parsed.files.allSatisfy { $0.hunks.count == 1 })
    }

    /// A hunk-less section (a binary file, or a mode-only change with no textual hunks) in a
    /// plain `diff -u` stream must still close before the next file's `--- ` starts a new one.
    /// `!hunks.isEmpty` got this wrong — it only closed a file that happened to have a hunk —
    /// and silently merged the first file's headers into the second's.
    @Test func aHunklessFileBoundaryInAPlainStreamStillStartsANewFile() {
        let parsed = UnifiedPatch.parse(
            "--- a/one\n+++ b/one\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-b\n+B")
        #expect(parsed.files.map(\.path) == ["one", "two"])
        #expect(parsed.files[0].hunks.isEmpty)
        #expect(parsed.files[1].hunks.count == 1)
    }

    // MARK: - Renames

    @Test func readsARenameFromItsHeaders() {
        let parsed = UnifiedPatch.parse(
            """
            diff --git a/old/name.swift b/new/name.swift
            similarity index 94%
            rename from old/name.swift
            rename to new/name.swift
            --- a/old/name.swift
            +++ b/new/name.swift
            @@ -1 +1 @@
            -a
            +b
            """)
        #expect(parsed.files.count == 1)
        #expect(parsed.files[0].oldPath == "old/name.swift")
        #expect(parsed.files[0].path == "new/name.swift")
        #expect(parsed.files[0].isRename)
        #expect(parsed.hunks.count == 1)
    }

    @Test func aPureRenameWithNoHunksIsStillAFile() {
        let parsed = UnifiedPatch.parse(
            "diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt")
        #expect(parsed.files.count == 1)
        #expect(parsed.files[0].isRename)
        #expect(parsed.hunks.isEmpty)
    }

    // MARK: - Binary

    @Test func marksABinaryFileAndParsesNoHunksForIt() {
        let parsed = UnifiedPatch.parse(
            "diff --git a/logo.png b/logo.png\nindex 1..2 100644\n"
                + "Binary files a/logo.png and b/logo.png differ")
        #expect(parsed.files.count == 1)
        #expect(parsed.files[0].isBinary)
        #expect(parsed.files[0].path == "logo.png")
        #expect(parsed.hunks.isEmpty)
    }

    @Test func marksAGitBinaryPatchPayload() {
        let parsed = UnifiedPatch.parse(
            "diff --git a/x.bin b/x.bin\nGIT binary patch\ndelta 42\nzcmZ")
        #expect(parsed.files[0].isBinary)
        #expect(parsed.hunks.isEmpty)
    }

    // MARK: - The no-newline marker

    @Test func aNoNewlineMarkerIsNotAContextLine() {
        let parsed = UnifiedPatch.parse("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file")
        #expect(parsed.hunks[0].lines.count == 2)
        #expect(parsed.hunks[0].lines.map(\.kind) == [.del, .add])
    }

    /// The marker sits between two lines when only the old side lacked the newline; it must not
    /// shift the numbering of everything after it either.
    @Test func aNoNewlineMarkerInTheMiddleShiftsNoNumbers() {
        let parsed = UnifiedPatch.parse(
            "@@ -1,2 +1,2 @@\n-a\n\\ No newline at end of file\n+a\n ctx")
        let lines = parsed.hunks[0].lines
        #expect(lines.map(\.kind) == [.del, .add, .context])
        #expect(lines[2].oldNumber == 2 && lines[2].newNumber == 2)
    }

    // MARK: - CRLF

    @Test func stripsCarriageReturnsFromCrlfPatches() {
        let parsed = UnifiedPatch.parse(
            "diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n")
        #expect(parsed.files.count == 1)
        #expect(parsed.files[0].path == "x")
        #expect(parsed.hunks.count == 1)
        #expect(parsed.hunks[0].header == "@@ -1 +1 @@")
        #expect(parsed.hunks[0].lines.map(\.text) == ["a", "b"])
    }

    // MARK: - Malformed input degrades, never throws

    @Test func emptyOrGarbageInputIsAnEmptyPatch() {
        #expect(UnifiedPatch.parse("").hunks.isEmpty)
        #expect(UnifiedPatch.parse("").files.isEmpty)
        #expect(UnifiedPatch.parse("not a patch at all").hunks.isEmpty)
    }

    /// Nothing parsed, but there was text: the tab shows it verbatim rather than claiming there
    /// are no changes.
    @Test func textThatParsesToNothingIsKeptAsARawBlock() {
        #expect(UnifiedPatch.parse("not a patch at all").raw == "not a patch at all")
        #expect(UnifiedPatch.parse("").raw.isEmpty)
        #expect(UnifiedPatch.parse("   \n\n").raw.isEmpty)
        // A patch that did parse never carries a raw fallback.
        #expect(UnifiedPatch.parse("@@ -1 +1 @@\n+a").raw.isEmpty)
    }

    @Test func anUnparseableHunkHeaderDropsItsHunkAndKeepsGoing() {
        let parsed = UnifiedPatch.parse("@@ garbage @@\n+dropped\n@@ -5 +5 @@\n+kept")
        #expect(parsed.hunks.count == 1)
        #expect(parsed.hunks[0].lines.map(\.text) == ["kept"])
        #expect(parsed.hunks[0].lines[0].newNumber == 5)
    }

    @Test func aLineWithNoMarkerEndsTheHunkInsteadOfBecomingContent() {
        let parsed = UnifiedPatch.parse("@@ -1 +1 @@\n+a\nsuddenly prose\n+b")
        #expect(parsed.hunks.count == 1)
        #expect(parsed.hunks[0].lines.map(\.text) == ["a"])
    }

    @Test func aHugePatchIsStillLinearToParse() {
        let body = (0..<5_000).map { "+line \($0)" }.joined(separator: "\n")
        let parsed = UnifiedPatch.parse("@@ -1 +1,5000 @@\n" + body)
        #expect(parsed.hunks[0].lines.count == 5_000)
        #expect(parsed.hunks[0].lines.last?.newNumber == 5_000)
    }
}

/// `DiffAnnotationLayout.partition` is what the diff tab reads instead of scanning `[DiffNote]`
/// itself — see its own doc comment for why. Never discards a note: the three previously-silent
/// drops (an anchored-looking `review` note, an unanchorable `agent` note, an orphaned `path`)
/// each land somewhere real here.
struct DiffAnnotationLayoutTests {
    private func file(_ path: String, patch: String = "", binary: Bool = false) -> DiffFile {
        DiffFile(
            path: path, status: .init(known: .modified), additions: 1, deletions: 0,
            binary: binary, patch: patch)
    }

    private let onePatch = "@@ -1 +1 @@\n-old\n+new"

    @Test func aPanelNoteWithNoPathIsAlwaysPanelLevel() {
        let note = DiffNote(path: "", kind: .init(known: .review), text: "verdict")
        let layout = DiffAnnotationLayout.partition(notes: [note], files: [])
        #expect(layout.panel == [note])
        #expect(layout.fileLevel.isEmpty)
        #expect(layout.perLine.isEmpty)
    }

    /// The web's own reading of this contract (`DiffFileStack.svelte`'s `reviewFindings`) keys a
    /// review finding by path only — a `lineNumber` it happens to carry is never a per-line
    /// anchor. The previous file-level filter (`lineNumber == nil`) silently dropped exactly this
    /// note when nothing anchored it, since it also failed the per-line scan.
    @Test func aReviewNoteWithALineNumberIsStillAFileBanner() {
        let files = [file("a.swift", patch: onePatch)]
        let note = DiffNote(
            path: "a.swift", kind: .init(known: .review), text: "looks risky",
            side: .init(known: .additions), lineNumber: 1)
        let layout = DiffAnnotationLayout.partition(notes: [note], files: files)
        #expect(layout.fileLevel["a.swift"] == [note])
        #expect(layout.perLine.isEmpty)
    }

    @Test func anAgentNoteAnchorsToTheLineItNames() {
        let files = [file("a.swift", patch: onePatch)]
        let note = DiffNote(
            path: "a.swift", kind: .init(known: .agent), text: "flipped the guard",
            side: .init(known: .additions), lineNumber: 1, tool: "Edit")
        let layout = DiffAnnotationLayout.partition(notes: [note], files: files)
        #expect(layout.perLine[.init(path: "a.swift", side: .new, number: 1)] == [note])
        #expect(layout.fileLevel["a.swift"] == nil)
    }

    /// A line the parsed patch never rendered — a stale annotation, or a file too large to send
    /// its patch — must still surface the note, just not anchored to a specific line.
    @Test func anAgentNoteOnAnUnrenderedLineFallsBackToTheFileBanner() {
        let files = [file("a.swift", patch: onePatch)]
        let note = DiffNote(
            path: "a.swift", kind: .init(known: .agent), text: "orphaned",
            side: .init(known: .additions), lineNumber: 999, tool: "Edit")
        let layout = DiffAnnotationLayout.partition(notes: [note], files: files)
        #expect(layout.fileLevel["a.swift"] == [note])
        #expect(layout.perLine.isEmpty)
    }

    /// A binary or truncated file renders no hunks at all, so every one of its notes — even a
    /// well-formed `agent` note with a real line number — falls back to the file banner.
    @Test func anAgentNoteOnABinaryFileFallsBackToTheFileBanner() {
        let files = [file("logo.png", binary: true)]
        let note = DiffNote(
            path: "logo.png", kind: .init(known: .agent), text: "check the palette",
            side: .init(known: .additions), lineNumber: 1, tool: "Edit")
        let layout = DiffAnnotationLayout.partition(notes: [note], files: files)
        #expect(layout.fileLevel["logo.png"] == [note])
    }

    /// A note whose `path` names a file this diff no longer carries (renamed away, or a stale
    /// read) used to vanish outright — neither the panel filter nor the file filter matched it.
    @Test func aNoteForAPathNotInTheDiffLandsInPanel() {
        let note = DiffNote(path: "gone.swift", kind: .init(known: .agent), text: "orphaned")
        let layout = DiffAnnotationLayout.partition(notes: [note], files: [file("a.swift")])
        #expect(layout.panel == [note])
    }

    /// The parsed hunks `partition` builds are the diff tab's only source — never reparsed for
    /// rendering — so the layout has to carry them even for a file with no notes at all.
    @Test func everyFilesPatchIsParsedIntoTheLayoutRegardlessOfNotes() {
        let files = [file("a.swift", patch: onePatch), file("logo.png", binary: true)]
        let layout = DiffAnnotationLayout.partition(notes: [], files: files)
        #expect(layout.hunks["a.swift"]?.hunks.count == 1)
        #expect(layout.hunks["logo.png"]?.hunks.isEmpty == true)
    }
}
