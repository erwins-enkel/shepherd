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

// Hand-written public types. These are declared in the files named below, not
// aliased here — a typealias of a type to itself does not compile — but they are
// listed so this file stays the single index of ShepherdKit's public surface:
//
//   Model/SessionStore.swift      SessionStore, ConnectionState
//   Model/ServerProfile.swift     ServerProfile, ServerProfile.Mode, ServerProfileError
//   Model/ShepherdError.swift     ShepherdError
//   Client/ShepherdClient.swift   ShepherdClient, CreateOutcome
//   Client/ProfileSetup.swift     ProfileSetup
//   Credentials/                  CredentialStore, StoredCredential,
//                                 KeychainCredentialStore, InMemoryCredentialStore,
//                                 KeychainError
//   Realtime/ServerEvent.swift    ServerEvent, PresenceFrame
//   Realtime/EventStream.swift    EventStream
//   Model/OpenEnum.swift          OpenEnum
//   Logging.swift                 ShepherdLog
