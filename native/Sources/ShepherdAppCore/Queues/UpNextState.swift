import Foundation
import Observation
import ShepherdKit
import SwiftUI

public enum UpNextSort: String, CaseIterable {
    case recommended, newest, oldest
    case titleAscending = "title-asc"
    case titleDescending = "title-desc"

    static let storageKey = "run.shepherd.mac.upnext.sort"

    public var label: String {
        switch self {
        case .recommended: L.t("upnext_sort_recommended")
        case .newest: L.t("upnext_sort_newest")
        case .oldest: L.t("upnext_sort_oldest")
        case .titleAscending: L.t("upnext_sort_title_asc")
        case .titleDescending: L.t("upnext_sort_title_desc")
        }
    }
}

public struct UpNextGroup: Identifiable {
    public let id: String
    public let title: String
    public let items: [UpNextItem]
    public let totalCount: Int
    public let cap: Int

    public func shown(expanded: Bool) -> [UpNextItem] {
        expanded ? items : Array(items.prefix(cap))
    }
}

public enum UpNextPresentation {
    public enum Phase { case computing, failed, empty, ready }

    public static func updated(_ milliseconds: Int, now: Date) -> String {
        let formatter = DateComponentsFormatter()
        formatter.unitsStyle = .abbreviated
        formatter.allowedUnits = [.hour, .minute, .second]
        formatter.maximumUnitCount = 1
        let age = max(0, now.timeIntervalSince1970 - Double(milliseconds) / 1_000)
        return L.t("upnext_updated_ago", formatter.string(from: age) ?? "—")
    }

    public static func key(_ item: UpNextItem) -> String { "\(item.repoPath)#\(item.number)" }

    public static func labels(_ item: UpNextItem) -> [String] {
        item.labels.filter { $0 != "shepherd:priority" && !(item.kind.rawValue == "epic" && $0 == "epic") }
    }

    public static func phase(_ snapshot: UpNextSnapshot?, failed: Bool, groups: [UpNextGroup]) -> Phase {
        if groups.contains(where: { !$0.items.isEmpty }) { return .ready }
        if failed || ((snapshot?.failedRepoCount ?? 0) > 0 && snapshot?.sections.isEmpty == true) {
            return .failed
        }
        return snapshot == nil ? .computing : .empty
    }

    public static func groups(_ snapshot: UpNextSnapshot?, sort: UpNextSort,
                       repos: Set<String> = []) -> [UpNextGroup] {
        let sections = (snapshot?.sections ?? []).compactMap { section -> UpNextSection? in
            guard !repos.isEmpty else { return section }
            if section.kind.rawValue == "repo" {
                return section.repoPath.map(repos.contains) == true ? section : nil
            }
            var filtered = section
            filtered.items = section.items.filter { repos.contains($0.repoPath) }
            filtered.totalCount = filtered.items.count
            return filtered.items.isEmpty ? nil : filtered
        }
        if sort == .recommended {
            return sections.enumerated().map { index, section in
                let priority = section.kind.rawValue == "priority"
                return UpNextGroup(id: "section:\(index):\(section.repoPath ?? "priority")",
                    title: priority ? L.t("upnext_priority_section")
                        : section.repoLabel ?? DonePresentation.repoBasename(section.repoPath ?? ""),
                    items: section.items, totalCount: section.totalCount, cap: priority ? 10 : 5)
            }
        }
        let all = sections.flatMap(\.items)
        return [true, false].compactMap { priority in
            let items = all.filter { $0.priority == priority }.sorted { less($0, $1, sort: sort) }
            guard !items.isEmpty else { return nil }
            return UpNextGroup(id: priority ? "priority" : "normal",
                title: priority ? L.t("upnext_priority_section") : L.t("upnext_normal_section"),
                items: items, totalCount: items.count, cap: priority ? 10 : 5)
        }
    }

    private static func less(_ a: UpNextItem, _ b: UpNextItem, sort: UpNextSort) -> Bool {
        switch sort {
        case .newest where a.createdAt != b.createdAt: return a.createdAt > b.createdAt
        case .oldest where a.createdAt != b.createdAt: return a.createdAt < b.createdAt
        case .titleAscending, .titleDescending:
            let comparison = a.title.localizedCompare(b.title)
            if comparison != .orderedSame {
                return comparison == (sort == .titleAscending ? .orderedAscending : .orderedDescending)
            }
        default: break
        }
        for (left, right) in [(a.repoLabel, b.repoLabel), (a.repoPath, b.repoPath)] {
            let comparison = left.localizedCompare(right)
            if comparison != .orderedSame { return comparison == .orderedAscending }
        }
        return a.number < b.number
    }
}

public struct UpNextNotice: Identifiable {
    public enum Kind { case created, held, errors }
    public let kind: Kind
    let count: Int
    public var id: Kind { kind }
    public var message: String {
        switch kind {
        case .created: L.t("upnext_started", String(count))
        case .held: L.t("upnext_held", String(count))
        case .errors: L.t("upnext_start_failed", String(count))
        }
    }
}

@MainActor
public struct UpNextCommands {
    var start: ([UpNextStartItem], UpNextStartChoice?) async throws -> UpNextStartResult

    public static func live(_ client: ShepherdClient) -> Self {
        Self(start: { try await client.startUpNext(items: $0, choice: $1) })
    }
}

/// Selection and presentation only; SessionCommandState owns the shared busy/error gate.
@Observable
@MainActor
public final class UpNextPanelState {
    public private(set) var sort: UpNextSort
    public private(set) var selected: Set<String> = []
    public var expanded: Set<String> = []
    public private(set) var confirmation: [UpNextStartItem]?
    public var notices: [UpNextNotice] = []
    @ObservationIgnored private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        sort = defaults.string(forKey: UpNextSort.storageKey).flatMap(UpNextSort.init(rawValue:)) ?? .newest
    }

    public func setSort(_ mode: UpNextSort) {
        sort = mode
        defaults.set(mode.rawValue, forKey: UpNextSort.storageKey)
        confirmation = nil
    }

    public func toggle(_ item: UpNextItem) {
        let key = UpNextPresentation.key(item)
        if !selected.insert(key).inserted { selected.remove(key) }
        confirmation = nil
    }

    public func selectedItems(in items: [UpNextItem]) -> [UpNextItem] {
        var seen: Set<String> = []
        return items.filter { selected.contains(UpNextPresentation.key($0))
            && seen.insert(UpNextPresentation.key($0)).inserted }
    }

    public func reconcile(_ items: [UpNextItem]) {
        selected.formIntersection(items.map(UpNextPresentation.key))
        confirmation = nil
    }

    public func cancelConfirmation() { confirmation = nil }
    public func clearSelection() { selected.removeAll(); confirmation = nil }

    public func reset() {
        clearSelection()
        expanded.removeAll()
        notices.removeAll()
    }

    @discardableResult
    public func requestStart(_ items: [UpNextItem], choice: UpNextStartChoice? = nil,
                      commands: UpNextCommands, gate: SessionCommandState,
                      isCurrent: () -> Bool) async -> Bool {
        guard !items.isEmpty, !gate.busy, isCurrent(), !Task.isCancelled else { return false }
        let requests = items.map { UpNextStartItem(repoPath: $0.repoPath, issueRef: $0.issueRef) }
        if items.count > 3, confirmation != requests {
            confirmation = requests
            return false
        }
        confirmation = nil
        notices.removeAll()
        return await gate.run({
            let result = try await commands.start(requests, choice)
            guard isCurrent(), !Task.isCancelled else { return }
            // The HTTP outcome does not select an array. Mixed results matter for every status.
            if !result.created.isEmpty { notices.append(.init(kind: .created, count: result.created.count)) }
            if !result.held.isEmpty { notices.append(.init(kind: .held, count: result.held.count)) }
            if !result.errors.isEmpty { notices.append(.init(kind: .errors, count: result.errors.count)) }
            if notices.isEmpty { notices.append(.init(kind: .errors, count: items.count)) }
            selected.subtract(items.map(UpNextPresentation.key))
        }, failureCopy: { L.t("upnext_start_failed", String(items.count)) + "\n" + $0 },
           isCurrent: { isCurrent() && !Task.isCancelled })
    }
}
