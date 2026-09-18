import Foundation

// Short names for the generated schemas the app uses constantly. These are
// typealiases, not wrappers: there is still exactly one definition of each
// type, and it still comes from the contract.

public typealias Session = Components.Schemas.Session
public typealias Settings = Components.Schemas.Settings
public typealias Repo = Components.Schemas.Repo
public typealias RepoList = Components.Schemas.RepoList
public typealias HeldTask = Components.Schemas.HeldTask
public typealias SessionStatus = Components.Schemas.SessionStatus
public typealias CreateSessionRequest = Components.Schemas.CreateSessionRequest
public typealias AgentProvider = Components.Schemas.AgentProvider
public typealias Effort = Components.Schemas.Effort
public typealias Health = Components.Schemas.Health

// The closed enum each named open enum splits off (see OpenEnum.swift).
// Switch on `<wrapper>.known` and get one of these back.
public typealias SessionStatusKnown = Components.Schemas.SessionStatusKnown
public typealias HerdrStateKnown = Components.Schemas.HerdrStateKnown
public typealias SessionArchiveReasonKnown = Components.Schemas.SessionArchiveReasonKnown
public typealias ExperimentRoleKnown = Components.Schemas.ExperimentRoleKnown
public typealias EventNameKnown = Components.Schemas.EventNameKnown
