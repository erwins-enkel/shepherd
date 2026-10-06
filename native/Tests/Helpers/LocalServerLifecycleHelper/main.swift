import Foundation
import ShepherdKit

// A real separate parent, so Foundation in the test process cannot reap this
// server. Only the supplied temporary directory and /bin/sh fixture are used.
#if os(macOS)
let home = URL(fileURLWithPath: CommandLine.arguments[1])
let launch = LocalServerLaunch(executable: URL(fileURLWithPath: "/bin/sh"),
  arguments: [home.appendingPathComponent("fake.sh").path], workingDirectory: home,
  environment: ["PATH": "/usr/bin:/bin"])
let supervisor = LocalServerSupervisor(environment: LocalServerEnvironment(home: home),
  health: { true }, runDirectory: home.appendingPathComponent("run"), launch: { launch })
await supervisor.start()
guard await supervisor.state.isRunning else { exit(1) }
// Wait until the fake agent is stopped, exercising orphaned-group SIGHUP.
for _ in 0..<200 {
  if FileManager.default.fileExists(atPath: home.appendingPathComponent("agent.pid").path) { break }
  try await Task.sleep(for: .milliseconds(10))
}
supervisor.terminateForQuit()
exit(0)
#endif
