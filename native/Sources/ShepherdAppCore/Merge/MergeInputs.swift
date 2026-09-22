import SwiftUI
import ShepherdKit

@MainActor public enum MergeInputs {
    public static var git: (AppModel) -> [String: GitState] = { _ in [:] }
    public static var reviewing: (AppModel, String) -> Bool = { _, _ in false }
    public static var planReviewBlocked: (AppModel, String) -> Bool = { _, _ in true }
    public static var terminalEnded: (AppModel, String) -> Bool = { _, _ in true }
}
