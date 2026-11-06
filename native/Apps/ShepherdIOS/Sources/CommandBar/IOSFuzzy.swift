import Foundation

/// Web fuzzy.ts, with positions measured in original Swift Characters (never lowercased indices).
enum IOSFuzzy {
    enum Kind: String { case empty, exact, prefix, substring, fuzzy }
    struct Result: Equatable {
        let score: Int
        let positions: [Int]
        let kind: Kind
        let span: Int
    }

    static func fuzzyScore(_ query: String, _ text: String) -> Result? {
        if query.isEmpty { return Result(score: 0, positions: [], kind: .empty, span: 0) }
        let q = Array(query.lowercased()), t = Array(text)
        var positions: [Int] = []
        var quality = 0, qi = 0, previous = -2
        for ti in t.indices {
            guard qi < q.count else { break }
            if String(t[ti]).lowercased() == String(q[qi]) {
                var bonus = 1
                if ti == 0 || isSeparator(t[ti - 1]) { bonus += 10 }
                if ti == previous + 1 { bonus += 5 }
                quality += bonus
                positions.append(ti); previous = ti; qi += 1
            }
        }
        guard qi == q.count, let first = positions.first, let last = positions.last else { return nil }
        let span = last - first + 1
        let kind: Kind = span != q.count ? .fuzzy : first != 0 ? .substring : span == t.count ? .exact : .prefix
        if kind == .fuzzy && span > max(q.count * 3, q.count + 2) { return nil }
        let base: Int
        switch kind {
        case .exact: base = 4000
        case .prefix: base = 3000
        case .substring: base = 2000
        case .fuzzy: base = 1000
        case .empty: base = 0
        }
        return Result(score: base + max(-250, min(250, quality - (span - q.count))),
            positions: positions, kind: kind, span: span)
    }

    private static func isSeparator(_ char: Character) -> Bool {
        if "-_/.".contains(char) { return true }
        // ECMAScript \s, including BOM and excluding NEL, as in fuzzy.ts's separator regex.
        return char.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 0x09...0x0d, 0x20, 0xa0, 0x1680, 0x2000...0x200a,
                 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff: true
            default: false
            }
        }
    }
}
