import AVFoundation
import SwiftUI
import UIKit
import VisionKit
import ShepherdAppCore
import ShepherdKit

/// Both the in-app scanner and the system Camera URL enter the same pairing path.
struct PairingSheet: View {
    var initialLink: String?
    var onConnected: () -> Void = {}
    @Environment(AppModel.self) private var app
    @Environment(IOSServerHub.self) private var hub: IOSServerHub?
    @Environment(\.dismiss) private var dismiss
    @State private var scanning = true
    @State private var busy = false
    @State private var error: String?
    @State private var operation: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if busy {
                    ProgressView(L.t("native_ios_connecting"))
                } else if scanning {
                    PairingCamera(onCode: connect)
                } else {
                    if let error { Text(verbatim: error).foregroundStyle(.red).accessibilityIdentifier("pairing-error") }
                    Button { error = nil; scanning = true } label: {
                        Label(L.t("native_pairing_retry"), systemImage: "qrcode.viewfinder")
                    }.buttonStyle(.borderedProminent)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(L.t("native_pairing_scan"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L.t("common_cancel")) { dismiss() }.disabled(busy)
                }
            }
        }
        .interactiveDismissDisabled(busy)
        .onAppear { if let initialLink { connect(initialLink) } }
        .onDisappear { operation?.cancel() }
    }

    private func connect(_ raw: String) {
        guard !busy else { return }
        scanning = false
        guard let link = PairingLink.parse(raw) else { error = L.t("native_pairing_invalid"); return }
        busy = true
        operation = Task { @MainActor in
            defer { busy = false }
            do {
                if let hub { try await hub.pair(link: link, deviceName: UIDevice.current.name) }
                else { try await app.pair(link: link, deviceName: UIDevice.current.name) }
                try Task.checkCancellation()
                onConnected()
                dismiss()
            } catch ProfileSetup.PairingError.invalidCode { error = L.t("native_pairing_expired") }
              catch ProfileSetup.PairingError.rateLimited { error = L.t("native_pairing_rate_limited") }
              catch is CancellationError { }
              catch { self.error = ShepherdErrorCopy.message(error) }
        }
    }
}

private struct PairingCamera: View {
    @Environment(\.scenePhase) private var scenePhase
    let onCode: (String) -> Void
    private enum Availability { case checking, ready, denied, unavailable }
    @State private var availability = Availability.checking
    var body: some View {
        VStack(spacing: 16) {
            switch availability {
            case .checking: ProgressView()
            case .ready:
                QRScanner(onCode: onCode, onUnavailable: { availability = .unavailable })
                    .accessibilityLabel(L.t("native_pairing_scan"))
                Text(verbatim: L.t("native_pairing_scan_hint")).foregroundStyle(.secondary).padding()
            case .denied:
                Text(verbatim: L.t("native_pairing_camera_denied")).padding()
                Button(L.t("native_pairing_open_settings")) {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            case .unavailable: Text(verbatim: L.t("native_pairing_unavailable")).padding()
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            guard DataScannerViewController.isSupported else { availability = .unavailable; return }
            let permission = AVCaptureDevice.authorizationStatus(for: .video)
            let allowed: Bool
            if permission == .notDetermined { allowed = await AVCaptureDevice.requestAccess(for: .video) }
            else { allowed = permission == .authorized }
            guard !Task.isCancelled else { return }
            guard allowed else { availability = .denied; return }
            availability = DataScannerViewController.isAvailable ? .ready : .unavailable
        }
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onUnavailable: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode, onUnavailable: onUnavailable) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
            recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }
    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        guard !scanner.isScanning else { return }
        do { try scanner.startScanning() }
        catch { Task { @MainActor in onUnavailable() } }
    }
    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) { scanner.stopScanning() }
    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        let onUnavailable: () -> Void
        private var handled = false
        init(onCode: @escaping (String) -> Void, onUnavailable: @escaping () -> Void) {
            self.onCode = onCode; self.onUnavailable = onUnavailable
        }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !handled else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let code = barcode.payloadStringValue {
                    handled = true; dataScanner.stopScanning(); onCode(code); return
                }
            }
        }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            onUnavailable()
        }
    }
}
