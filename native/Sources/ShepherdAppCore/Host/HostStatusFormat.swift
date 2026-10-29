import Foundation

enum HostStatusFormat {
    static func bytes(_ value: Int?) -> String {
        guard let value else { return "—" }
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .binary)
    }

    static func percent(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.formatted(.number.precision(.fractionLength(0...2))) + " %"
    }

    static func ramUsed(available: Int?, total: Int?) -> String {
        guard let available, let total, total > 0 else { return "—" }
        return percent((1 - Double(available) / Double(total)) * 100)
    }
}
