/**
 * Unit tests for the egress real-machinery suite's skip gate
 * (test/egress-runner-gate.ts). Pure helpers, no filesystem — `isSocket` is
 * stubbed throughout.
 */

import { test, expect } from "bun:test";
import {
  egressRunnerShouldSkip,
  rootlessDockerSocketPresent,
  type GateProbes,
} from "./egress-runner-gate";

const never = (): boolean => false;
const onlyRootlessSock = (p: string) => p === "/run/user/1000/docker.sock";

const cases: { name: string; probes: GateProbes; expected: boolean }[] = [
  {
    name: "not capable ⇒ skip",
    probes: { capable: false, env: {}, uid: 1000, isSocket: never },
    expected: true,
  },
  {
    name: "capable + CI:'true' (no socket) ⇒ skip",
    probes: { capable: true, env: { CI: "true" }, uid: 1000, isSocket: never },
    expected: true,
  },
  {
    name: "capable + CI:'' (empty) + no socket ⇒ run",
    probes: { capable: true, env: { CI: "" }, uid: 1000, isSocket: never },
    expected: false,
  },
  {
    name: "capable + no CI + no socket ⇒ run",
    probes: { capable: true, env: {}, uid: 1000, isSocket: never },
    expected: false,
  },
  {
    name: "capable + no CI + rootless docker.sock present ⇒ skip",
    probes: { capable: true, env: {}, uid: 1000, isSocket: onlyRootlessSock },
    expected: true,
  },
  {
    name: "capable + no CI + DOCKER_HOST unix socket present ⇒ skip",
    probes: {
      capable: true,
      env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
      uid: 1000,
      isSocket: onlyRootlessSock,
    },
    expected: true,
  },
  {
    name: "capable + no CI + DOCKER_HOST tcp (non-unix) + no unix socket ⇒ run",
    probes: {
      capable: true,
      env: { DOCKER_HOST: "tcp://1.2.3.4:2375" },
      uid: 1000,
      isSocket: never,
    },
    expected: false,
  },
  {
    name: "capable + no CI + DOCKER_HOST unix candidate probed but isSocket false ⇒ run",
    probes: {
      capable: true,
      env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
      uid: 1000,
      isSocket: never,
    },
    expected: false,
  },
  {
    name: "capable + no CI + uid undefined + no DOCKER_HOST ⇒ run (no candidates)",
    probes: { capable: true, env: {}, uid: undefined, isSocket: never },
    expected: false,
  },
];

for (const { name, probes, expected } of cases) {
  test(`egressRunnerShouldSkip: ${name}`, () => {
    expect(egressRunnerShouldSkip(probes)).toBe(expected);
  });
}

test("rootlessDockerSocketPresent: uid undefined + no DOCKER_HOST ⇒ false", () => {
  expect(rootlessDockerSocketPresent({}, undefined, () => true)).toBe(false);
});
