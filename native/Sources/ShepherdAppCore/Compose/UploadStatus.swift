import Foundation

/// One live line for pending composer attachments, shared by the iOS footer and the Mac row.
public struct UploadStatus: Equatable, Sendable {
    public enum Phase: Equatable, Sendable { case preparing, transferring, finishing, failed }
    public let phase: Phase
    public var current = 0
    public var total = 0
    public var percent = 0
    /// Nil until a transfer rate is measurable, mirroring the web footer's estimate.
    public var remainingSeconds: Int?

    public var line: String {
        switch phase {
        case .preparing: L.t("native_compose_upload_preparing")
        case .failed: L.t("newtask_readiness_upload_failed")
        case .finishing: "\(fileCount) · \(L.t("newtask_upload_finishing"))"
        case .transferring: "\(fileCount) · \(L.t("newtask_upload_percent", String(percent))) · \(eta)"
        }
    }

    private var fileCount: String { L.t("newtask_upload_file_count", String(current), String(total)) }
    private var eta: String {
        guard let remainingSeconds else { return L.t("newtask_upload_eta_calculating") }
        return L.t("newtask_upload_eta", Self.clock(remainingSeconds))
    }

    /// The web's `elapsed()` reading: `MM:SS` under an hour, then `{h}h {MM}m`, then `{d}d {HH}h`.
    static func clock(_ seconds: Int) -> String {
        let minutes = max(0, seconds) / 60
        if minutes < 60 { return String(format: "%02d:%02d", minutes, max(0, seconds) % 60) }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h " + String(format: "%02dm", minutes % 60) }
        return "\(hours / 24)d " + String(format: "%02dh", hours % 24)
    }
}
