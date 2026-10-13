import { expect, test } from "bun:test";
import { recordXcode } from "../scripts/record-xcode-fixtures";
import { CapabilityService, probeCapabilities } from "../src/remote-instances/capability-probe";
import { expectedView, macosView, recordingDeps } from "./helpers/xcode-fixture";

// The macOS probe (#2771) on a real Mac with Xcode. The suite self-gates on darwin, so it no-ops on
// the Linux `verify` lane and runs on the macos-latest job (.github/workflows/macos.yml). It records
// this Mac the way a fixture is recorded, then checks that the parsers read the recording — and the
// live probe reads the Mac itself — exactly as the Mac's other sources describe it.
const onDarwin = process.platform === "darwin" ? test : test.skip;

onDarwin(
  "reads this Mac's Xcode, SDKs and simulators as its other sources describe them",
  async () => {
    // Recording first also starts CoreSimulatorService, so the probe's 5 s simctl timeout holds.
    const recording = recordXcode("live");
    expect(recording.expected.xcode).toBeDefined();
    expect(recording.expected["sdk:macos"]).toBeDefined();

    const replayed = await probeCapabilities(recordingDeps(recording));
    expect(macosView(replayed.checks)).toEqual(expectedView(recording.expected));

    const live = await new CapabilityService().refresh();
    expect(macosView(live?.checks ?? [])).toEqual(expectedView(recording.expected));
  },
  120_000,
);
