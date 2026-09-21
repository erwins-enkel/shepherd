import SwiftUI
import Observation
import ShepherdKit

public struct SettingsField: Identifiable {
    public enum Kind { case toggle, text, number }
    public let id: String
    public let title: StaticString
    public let kind: Kind
    public let value: (Components.Schemas.Settings) -> String
    let patch: (String) -> SettingsPatch?
    public let cli: Bool

    public var choices: [String] {
        switch id {
        case "defaultAgentProvider": ["claude", "codex"]
        case "authMode": ["subscription", "api-key"]
        case "operatorLanguage": ["en", "de"]
        default: id.hasSuffix("Cli") ? ["", "claude", "codex"] : []
        }
    }
    public func choiceLabel(_ value: String) -> String {
        switch value {
        case "": L.t("newtask_model_default")
        case "claude": "Claude Code"
        case "codex": "Codex"
        case "en": "English"
        case "de": "Deutsch"
        case "subscription": L.t("settings_auth_mode_subscription")
        case "api-key": L.t("settings_auth_mode_apikey")
        default: value
        }
    }
}

@MainActor public enum SettingsFields {
    public static let all: [SettingsField] = [
        .init(id:"remoteControlAtStartup", title:"native_settings_field_remotecontrolatstartup", kind:.toggle, value:{ String($0.remoteControlAtStartup ?? false) }, patch:{ .init(remoteControlAtStartup: $0 == "true") }, cli:false),
        .init(id:"reducedPushMode", title:"native_settings_field_reducedpushmode", kind:.toggle, value:{ String($0.reducedPushMode ?? false) }, patch:{ .init(reducedPushMode: $0 == "true") }, cli:false),
        .init(id:"sessionHousekeepingEnabled", title:"native_settings_field_sessionhousekeepingenabled", kind:.toggle, value:{ String($0.sessionHousekeepingEnabled ?? false) }, patch:{ .init(sessionHousekeepingEnabled: $0 == "true") }, cli:false),
        .init(id:"autoReviveEnabled", title:"native_settings_field_autoreviveenabled", kind:.toggle, value:{ String($0.autoReviveEnabled ?? false) }, patch:{ .init(autoReviveEnabled: $0 == "true") }, cli:false),
        .init(id:"upnextSkipCliPicker", title:"native_settings_field_upnextskipclipicker", kind:.toggle, value:{ String($0.upnextSkipCliPicker ?? false) }, patch:{ .init(upnextSkipCliPicker: $0 == "true") }, cli:false),
        .init(id:"usageHoldEnabled", title:"native_settings_field_usageholdenabled", kind:.toggle, value:{ String($0.usageHoldEnabled ?? false) }, patch:{ .init(usageHoldEnabled: $0 == "true") }, cli:false),
        .init(id:"usageHoldAutoRelease", title:"native_settings_field_usageholdautorelease", kind:.toggle, value:{ String($0.usageHoldAutoRelease ?? false) }, patch:{ .init(usageHoldAutoRelease: $0 == "true") }, cli:false),
        .init(id:"usageDowngradeEnabled", title:"native_settings_field_usagedowngradeenabled", kind:.toggle, value:{ String($0.usageDowngradeEnabled ?? false) }, patch:{ .init(usageDowngradeEnabled: $0 == "true") }, cli:false),
        .init(id:"fableAvailable", title:"native_settings_field_fableavailable", kind:.toggle, value:{ String($0.fableAvailable ?? false) }, patch:{ .init(fableAvailable: $0 == "true") }, cli:false),
        .init(id:"judgeEnabled", title:"native_settings_field_judgeenabled", kind:.toggle, value:{ String($0.judgeEnabled ?? false) }, patch:{ .init(judgeEnabled: $0 == "true") }, cli:false),
        .init(id:"tuiFullscreen", title:"native_settings_field_tuifullscreen", kind:.toggle, value:{ String($0.tuiFullscreen ?? false) }, patch:{ .init(tuiFullscreen: $0 == "true") }, cli:false),
        .init(id:"tuiDisableMouse", title:"native_settings_field_tuidisablemouse", kind:.toggle, value:{ String($0.tuiDisableMouse ?? false) }, patch:{ .init(tuiDisableMouse: $0 == "true") }, cli:false),
        .init(id:"prReviewCyclesCap", title:"native_settings_field_prreviewcyclescap", kind:.number, value:{ String($0.prReviewCyclesCap ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(prReviewCyclesCap: n) }, cli:false),
        .init(id:"planReviewCyclesCap", title:"native_settings_field_planreviewcyclescap", kind:.number, value:{ String($0.planReviewCyclesCap ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(planReviewCyclesCap: n) }, cli:false),
        .init(id:"distillerIntervalDays", title:"native_settings_field_distillerintervaldays", kind:.number, value:{ String($0.distillerIntervalDays ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(distillerIntervalDays: n) }, cli:true),
        .init(id:"extraCreditsDrainCeiling", title:"native_settings_field_extracreditsdrainceiling", kind:.number, value:{ String($0.extraCreditsDrainCeiling ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(extraCreditsDrainCeiling: n) }, cli:false),
        .init(id:"usageHoldPct", title:"native_settings_field_usageholdpct", kind:.number, value:{ String($0.usageHoldPct ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(usageHoldPct: n) }, cli:false),
        .init(id:"usageDowngradePct", title:"native_settings_field_usagedowngradepct", kind:.number, value:{ String($0.usageDowngradePct ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(usageDowngradePct: n) }, cli:false),
        .init(id:"judgeDailyUsd", title:"native_settings_field_judgedailyusd", kind:.number, value:{ String($0.judgeDailyUsd ?? 0) }, patch:{ value in guard let n = Double(value), n.isFinite else { return nil }; return .init(judgeDailyUsd: n) }, cli:false),
        .init(id:"defaultModel", title:"native_settings_field_defaultmodel", kind:.text, value:{ $0.defaultModel }, patch:{ .init(defaultModel: $0) }, cli:true),
        .init(id:"defaultCodexModel", title:"native_settings_field_defaultcodexmodel", kind:.text, value:{ $0.defaultCodexModel ?? "" }, patch:{ .init(defaultCodexModel: $0) }, cli:true),
        .init(id:"defaultEffort", title:"native_settings_field_defaulteffort", kind:.text, value:{ $0.defaultEffort }, patch:{ .init(defaultEffort: $0) }, cli:true),
        .init(id:"defaultAgentProvider", title:"native_settings_field_defaultagentprovider", kind:.text, value:{ $0.defaultAgentProvider.rawValue }, patch:{ .init(defaultAgentProvider: $0) }, cli:true),
        .init(id:"authMode", title:"native_settings_field_authmode", kind:.text, value:{ $0.authMode.rawValue }, patch:{ .init(authMode: $0) }, cli:true),
        .init(id:"operatorLanguage", title:"native_settings_field_operatorlanguage", kind:.text, value:{ $0.operatorLanguage.rawValue }, patch:{ .init(operatorLanguage: $0) }, cli:false),
        .init(id:"usageDowngradeModel", title:"native_settings_field_usagedowngrademodel", kind:.text, value:{ $0.usageDowngradeModel ?? "" }, patch:{ .init(usageDowngradeModel: $0) }, cli:true),
        .init(id:"blockJudgeMode", title:"native_settings_field_blockjudgemode", kind:.text, value:{ $0.blockJudgeMode ?? "" }, patch:{ .init(blockJudgeMode: $0) }, cli:false),
        .init(id:"houseRuleRelevance", title:"native_settings_field_houserulerelevance", kind:.text, value:{ $0.houseRuleRelevance ?? "" }, patch:{ .init(houseRuleRelevance: $0) }, cli:false),
        .init(id:"telemetryConsent", title:"native_settings_field_telemetryconsent", kind:.text, value:{ $0.telemetryConsent ?? "" }, patch:{ .init(telemetryConsent: $0) }, cli:false),
        .init(id:"criticCli", title:"native_settings_field_criticcli", kind:.text, value:{ $0.criticCli ?? "" }, patch:{ .init(criticCli: $0) }, cli:true),
        .init(id:"criticModel", title:"native_settings_field_criticmodel", kind:.text, value:{ $0.criticModel ?? "" }, patch:{ .init(criticModel: $0) }, cli:true),
        .init(id:"criticEffort", title:"native_settings_field_criticeffort", kind:.text, value:{ $0.criticEffort ?? "" }, patch:{ .init(criticEffort: $0) }, cli:true),
        .init(id:"plannerCli", title:"native_settings_field_plannercli", kind:.text, value:{ $0.plannerCli ?? "" }, patch:{ .init(plannerCli: $0) }, cli:true),
        .init(id:"plannerModel", title:"native_settings_field_plannermodel", kind:.text, value:{ $0.plannerModel ?? "" }, patch:{ .init(plannerModel: $0) }, cli:true),
        .init(id:"plannerEffort", title:"native_settings_field_plannereffort", kind:.text, value:{ $0.plannerEffort ?? "" }, patch:{ .init(plannerEffort: $0) }, cli:true),
        .init(id:"recapCli", title:"native_settings_field_recapcli", kind:.text, value:{ $0.recapCli ?? "" }, patch:{ .init(recapCli: $0) }, cli:true),
        .init(id:"recapModel", title:"native_settings_field_recapmodel", kind:.text, value:{ $0.recapModel ?? "" }, patch:{ .init(recapModel: $0) }, cli:true),
        .init(id:"recapEffort", title:"native_settings_field_recapeffort", kind:.text, value:{ $0.recapEffort ?? "" }, patch:{ .init(recapEffort: $0) }, cli:true),
        .init(id:"docAgentCli", title:"native_settings_field_docagentcli", kind:.text, value:{ $0.docAgentCli ?? "" }, patch:{ .init(docAgentCli: $0) }, cli:true),
        .init(id:"docAgentModel", title:"native_settings_field_docagentmodel", kind:.text, value:{ $0.docAgentModel ?? "" }, patch:{ .init(docAgentModel: $0) }, cli:true),
        .init(id:"docAgentEffort", title:"native_settings_field_docagenteffort", kind:.text, value:{ $0.docAgentEffort ?? "" }, patch:{ .init(docAgentEffort: $0) }, cli:true),
        .init(id:"distillerCli", title:"native_settings_field_distillercli", kind:.text, value:{ $0.distillerCli ?? "" }, patch:{ .init(distillerCli: $0) }, cli:true),
        .init(id:"distillerModel", title:"native_settings_field_distillermodel", kind:.text, value:{ $0.distillerModel ?? "" }, patch:{ .init(distillerModel: $0) }, cli:true),
        .init(id:"distillerEffort", title:"native_settings_field_distillereffort", kind:.text, value:{ $0.distillerEffort ?? "" }, patch:{ .init(distillerEffort: $0) }, cli:true),
        .init(id:"optimizerCli", title:"native_settings_field_optimizercli", kind:.text, value:{ $0.optimizerCli ?? "" }, patch:{ .init(optimizerCli: $0) }, cli:true),
        .init(id:"optimizerModel", title:"native_settings_field_optimizermodel", kind:.text, value:{ $0.optimizerModel ?? "" }, patch:{ .init(optimizerModel: $0) }, cli:true),
        .init(id:"optimizerEffort", title:"native_settings_field_optimizereffort", kind:.text, value:{ $0.optimizerEffort ?? "" }, patch:{ .init(optimizerEffort: $0) }, cli:true),
        .init(id:"mergeSuggestCli", title:"native_settings_field_mergesuggestcli", kind:.text, value:{ $0.mergeSuggestCli ?? "" }, patch:{ .init(mergeSuggestCli: $0) }, cli:true),
        .init(id:"mergeSuggestModel", title:"native_settings_field_mergesuggestmodel", kind:.text, value:{ $0.mergeSuggestModel ?? "" }, patch:{ .init(mergeSuggestModel: $0) }, cli:true),
        .init(id:"mergeSuggestEffort", title:"native_settings_field_mergesuggesteffort", kind:.text, value:{ $0.mergeSuggestEffort ?? "" }, patch:{ .init(mergeSuggestEffort: $0) }, cli:true),
        .init(id:"namerCli", title:"native_settings_field_namercli", kind:.text, value:{ $0.namerCli ?? "" }, patch:{ .init(namerCli: $0) }, cli:true),
        .init(id:"namerModel", title:"native_settings_field_namermodel", kind:.text, value:{ $0.namerModel ?? "" }, patch:{ .init(namerModel: $0) }, cli:true),
        .init(id:"namerEffort", title:"native_settings_field_namereffort", kind:.text, value:{ $0.namerEffort ?? "" }, patch:{ .init(namerEffort: $0) }, cli:true),
        .init(id:"autopilotCli", title:"native_settings_field_autopilotcli", kind:.text, value:{ $0.autopilotCli ?? "" }, patch:{ .init(autopilotCli: $0) }, cli:true),
        .init(id:"autopilotModel", title:"native_settings_field_autopilotmodel", kind:.text, value:{ $0.autopilotModel ?? "" }, patch:{ .init(autopilotModel: $0) }, cli:true),
        .init(id:"autopilotEffort", title:"native_settings_field_autopiloteffort", kind:.text, value:{ $0.autopilotEffort ?? "" }, patch:{ .init(autopilotEffort: $0) }, cli:true),
    ]
}

@Observable @MainActor public final class SettingsFieldDraft {
    public init() {}

    public var text = ""

    public func canSave(field: SettingsField, payload: Components.Schemas.Settings) -> Bool {
        text != field.value(payload) && field.patch(text) != nil
    }

    public func submit(field: SettingsField, model: SettingsModel,
                save: @escaping @Sendable (SettingsPatch) async throws -> Components.Schemas.Settings) {
        guard let patch = field.patch(text) else { return }
        model.run({ try await save(patch) }, commit: { [weak self] settings in
            // A successful normalization can leave the server value unchanged.
            // Commit only after the write, authoritative GET and store reconciliation succeed.
            self?.text = field.value(settings)
        })
    }
}
