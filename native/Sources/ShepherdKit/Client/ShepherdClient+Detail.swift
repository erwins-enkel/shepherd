import Foundation

// The ten open-enum schemas the `# ── stream: detail ──` contract block flags with
// `x-shepherd-open-enum: true`. Each generates as an `anyOf: [{$ref: <Name>Known}, {type:
// string}]` wrapper struct — the same shape `Model/OpenEnum.swift` documents for the core
// schemas — so conforming them to `OpenEnum` here is what unlocks `.known` / `.rawValue`
// wherever this stream's views and tests read a detail route's status fields. `MergeMethod`
// (the one request-side enum in this block) stays closed and is not listed: it never appears in
// a server response, so a client never needs to tolerate a value it doesn't know.
//
// This file is this stream's kit route wrapper (native/README.md "Parallel streams: seams and
// rules" — "A kit route wrapper" — your own `ShepherdClient+<Stream>.swift`); it does not yet add
// any `ShepherdClient` methods because Task 2 only proves the generated shapes decode. A later
// detail-stream task adds the route calls here.
extension Components.Schemas.ActivityStatus: OpenEnum {}
extension Components.Schemas.DiffFileStatus: OpenEnum {}
extension Components.Schemas.DiffNoteKind: OpenEnum {}
extension Components.Schemas.DiffNoteSide: OpenEnum {}
extension Components.Schemas.BrowseEntryType: OpenEnum {}
extension Components.Schemas.ForgeKind: OpenEnum {}
extension Components.Schemas.PrState: OpenEnum {}
extension Components.Schemas.ChecksState: OpenEnum {}
extension Components.Schemas.MergeStateStatus: OpenEnum {}
extension Components.Schemas.PrReviewState: OpenEnum {}
