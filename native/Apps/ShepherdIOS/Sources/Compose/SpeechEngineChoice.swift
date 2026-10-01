/// Capability projection kept separate from permission dialogs and Apple API availability.
enum SpeechEngineChoice: Equatable {
    case analyzer, onDevice, appleServer, needsConsent, whisperOnly, denied, unsupported
    static func choose(analyzer: Bool, recognizer: Bool, onDevice: Bool,
                       speechGranted: Bool, appleServerConsent: Bool, whisper: Bool) -> Self {
        if speechGranted {
            if analyzer { return .analyzer }
            if recognizer && onDevice { return .onDevice }
            if recognizer { return appleServerConsent ? .appleServer : .needsConsent }
        }
        if whisper { return .whisperOnly }
        return !analyzer && !recognizer || speechGranted ? .unsupported : .denied
    }
}
