import ShepherdKit
import SwiftUI

/// Task-context table from ui/src/lib/model-guidance.ts, including non-picker sentinels.
struct ModelGuidance {
    enum CostTier: String {
        case low, standard, high, premium
        var label: String {
            switch self {
            case .low: L.t("model_cost_low")
            case .standard: L.t("model_cost_standard")
            case .high: L.t("model_cost_high")
            case .premium: L.t("model_cost_premium")
            }
        }
        var mark: String {
            switch self {
            case .low: "$"
            case .standard: "$$"
            case .high: "$$$"
            case .premium: "$$$$"
            }
        }
    }
    enum Tag: String {
        case budget, balanced, strong, max, longContext, providerDefault
        var label: String {
            switch self {
            case .budget: L.t("model_tag_budget")
            case .balanced: L.t("model_tag_balanced")
            case .strong: L.t("model_tag_strong")
            case .max: L.t("model_tag_max")
            case .longContext: L.t("model_tag_long_context")
            case .providerDefault: L.t("model_tag_provider_default")
            }
        }
    }

    let costTier: CostTier
    let tag: Tag
    let detailKey: StaticString
    var costMark: String { costTier.mark }
    var costBadge: String { costTier.label.uppercased() }
    var tagBadge: String { tag.label.uppercased() }
    var detail: String { L.t(detailKey) }

    static func value(provider: AgentProvider, model: String) -> Self {
        switch model {
        case "auto": return .init(costTier: .standard, tag: .providerDefault, detailKey: "model_guidance_auto")
        case "default": return .init(costTier: .standard, tag: .providerDefault, detailKey: "model_guidance_default")
        case "inherit": return .init(costTier: .standard, tag: .providerDefault, detailKey: "model_guidance_inherit")
        default: break
        }
        if provider == .claude {
            switch model {
            case "fable": return .init(costTier: .premium, tag: .max, detailKey: "model_guidance_claude_fable")
            case "claude-fable-5-1": return .init(costTier: .premium, tag: .max, detailKey: "model_guidance_claude_fable_5_1")
            case "opus": return .init(costTier: .high, tag: .strong, detailKey: "model_guidance_claude_opus")
            case "opus[1m]": return .init(costTier: .premium, tag: .longContext, detailKey: "model_guidance_claude_opus_1m")
            case "claude-opus-5": return .init(costTier: .high, tag: .strong, detailKey: "model_guidance_claude_opus_5")
            case "claude-opus-5[1m]": return .init(costTier: .premium, tag: .longContext, detailKey: "model_guidance_claude_opus_5_1m")
            case "sonnet": return .init(costTier: .standard, tag: .balanced, detailKey: "model_guidance_claude_sonnet")
            case "sonnet[1m]": return .init(costTier: .high, tag: .longContext, detailKey: "model_guidance_claude_sonnet_1m")
            case "haiku": return .init(costTier: .low, tag: .budget, detailKey: "model_guidance_claude_haiku")
            default: break
            }
        } else {
            switch model {
            case "gpt-6-astra": return .init(costTier: .premium, tag: .max, detailKey: "model_guidance_codex_6_astra")
            case "gpt-5.5": return .init(costTier: .premium, tag: .max, detailKey: "model_guidance_codex_55")
            case "gpt-5.6-sol": return .init(costTier: .premium, tag: .max, detailKey: "model_guidance_codex_56_sol")
            case "gpt-5.6-terra": return .init(costTier: .high, tag: .balanced, detailKey: "model_guidance_codex_56_terra")
            case "gpt-5.6-luna": return .init(costTier: .low, tag: .budget, detailKey: "model_guidance_codex_56_luna")
            case "gpt-5.4": return .init(costTier: .high, tag: .strong, detailKey: "model_guidance_codex_54")
            case "gpt-5.3-codex": return .init(costTier: .standard, tag: .balanced, detailKey: "model_guidance_codex_53")
            case "gpt-5.1-codex": return .init(costTier: .standard, tag: .balanced, detailKey: "model_guidance_codex_51_codex")
            case "gpt-5-codex": return .init(costTier: .low, tag: .budget, detailKey: "model_guidance_codex_5_codex")
            case "gpt-5.1": return .init(costTier: .standard, tag: .balanced, detailKey: "model_guidance_codex_51")
            case "gpt-5": return .init(costTier: .low, tag: .budget, detailKey: "model_guidance_codex_5")
            case "o3": return .init(costTier: .high, tag: .strong, detailKey: "model_guidance_codex_o3")
            default: break
            }
        }
        return .init(costTier: .standard, tag: .balanced, detailKey: "model_guidance_unknown")
    }

    static func configuredModelLabel(_ model: String) -> String {
        switch model {
        case "default": L.t("newtask_model_default")
        case "fable": L.t("model_configured_fable_latest")
        case "opus": L.t("model_configured_opus_latest")
        case "opus[1m]": L.t("model_configured_opus_1m_latest")
        case "claude-fable-5-1": L.t("model_label_fable_5_1")
        case "claude-opus-5": L.t("model_label_opus_5")
        case "claude-opus-5[1m]": L.t("model_label_opus_5_1m")
        case "sonnet[1m]": L.t("model_label_sonnet_1m")
        default: model
        }
    }

    static func optionLabel(provider: AgentProvider, model: String) -> String {
        let guidance = value(provider: provider, model: model)
        return "\(configuredModelLabel(model)) · \(guidance.tag.label) · \(guidance.costMark)"
    }
}

struct ModelGuidanceView: View {
    let guidance: ModelGuidance

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                badge(guidance.costBadge).accessibilityIdentifier("compose.model.cost")
                badge(guidance.tagBadge).accessibilityIdentifier("compose.model.tag")
            }
            Text(verbatim: guidance.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("compose.model.guidance")
        }
    }

    private func badge(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(.quaternary, in: Capsule())
    }
}
