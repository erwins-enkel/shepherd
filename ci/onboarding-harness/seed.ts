import type { IncusDriver } from "./incus";
import type { Scenario } from "./types";

const SHEPHERD_DIR = "/opt/shepherd";

/** Commands that turn a fresh instance into a bootable-Shepherd baseline: bun
 *  runtime + the pushed working-tree build + deps + the claude CLI (agent path).
 *  Defects are layered AFTER this so degraded Shepherd can still boot. */
function baselineCommands(): string[] {
  return [
    "command -v curl >/dev/null 2>&1 || (apt-get update && apt-get install -y curl) || (apk add --no-cache curl) || (dnf install -y curl) || (pacman -Sy --noconfirm curl)",
    "curl -fsSL https://bun.sh/install | bash",
    `mkdir -p ${SHEPHERD_DIR} && tar -xf /root/shepherd.tar -C ${SHEPHERD_DIR}`,
    `cd ${SHEPHERD_DIR} && ~/.bun/bin/bun install`,
    // claude CLI for the agent apply path; harmless if a scenario removes it later.
    "curl -fsSL https://claude.ai/install.sh | bash || true",
  ];
}

/** Launch a fresh instance for `scenario`, install the bootable baseline, push
 *  the Shepherd build, then run the scenario's messy-state seed commands. */
export async function seedInstance(
  driver: IncusDriver,
  scenario: Scenario,
  tarballPath: string,
): Promise<void> {
  await driver.launch(scenario.image, scenario.id, {
    vm: scenario.vm,
    profile: "shep-onb",
  });
  // Wait for the instance's network/init to settle before exec.
  await driver.exec(scenario.id, [
    "sh",
    "-c",
    "for i in $(seq 1 30); do test -e /bin/sh && break; sleep 1; done",
  ]);
  await driver.push(scenario.id, tarballPath, "/root/shepherd.tar");
  for (const cmd of baselineCommands()) {
    await driver.exec(scenario.id, ["sh", "-c", cmd]);
  }
  for (const cmd of scenario.seed) {
    await driver.exec(scenario.id, ["sh", "-c", cmd]);
  }
}
