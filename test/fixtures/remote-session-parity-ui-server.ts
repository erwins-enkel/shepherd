// Two disposable Shepherds: real auth, routing and mirror; no real agent processes.
// UI tests sign in through Welcome, so production live-smoke write protection is unchanged.
import { writeFileSync } from "node:fs";
import { AccessTokenService } from "../../src/access-tokens";
import { config } from "../../src/config";
import { PtyBridge, type PtySocket } from "../../src/pty-bridge";
import { RemoteInstanceService } from "../../src/remote-instances/service";
import { RemoteSessionMirror, type OpenSocket } from "../../src/remote-instances/sessions";
import { startContractServer, withAuth, restoreAuth } from "../contract/harness";

await withAuth();
config.herdrSocketTerminal = false;
const audit: { machine: string; action: string; id: string; text?: string }[] = [];
PtyBridge.prototype.open = function () {
  const bridge = this as unknown as { terminalId: string; ws: PtySocket };
  audit.push({ machine: bridge.terminalId, action: "attach", id: bridge.terminalId });
  bridge.ws.send("\r\nIsolated fixture terminal\r\n");
};
PtyBridge.prototype.write = function () {};
PtyBridge.prototype.close = function () {};

function node(machine: string) {
  const server = startContractServer();
  const { deps, validRepo } = server;
  deps.store.setSetting("firstRunResolved", "1");
  deps.store.setSetting("steersIssueActionsMigrated", "1");
  deps.store.setSetting(
    "steers",
    JSON.stringify([
      {
        id: `${machine}-steer`,
        label: `${machine} template`,
        text: `${machine} instruction`,
        inSteerBar: true,
        onIssues: false,
      },
    ]),
  );
  const session = deps.store.create({
    name: `${machine}-task`,
    prompt: "Check remote session parity",
    repoPath: validRepo,
    worktreePath: validRepo,
    branch: "main",
    baseBranch: "main",
    isolated: false,
    herdrSession: "default",
    herdrAgentId: `term_${machine}`,
    claudeSessionId: `claude-${machine}`,
  });
  const pane = {
    terminalId: `term_${machine}`,
    cwd: validRepo,
    agent: "claude",
    agentStatus: "working",
    paneId: `p-${machine}`,
    tabId: `t-${machine}`,
    workspaceId: "w",
    name: machine,
  };
  deps.herdr = { list: () => [pane], listAsync: async () => [pane] } as never;
  deps.service.operatorReply = async (id, text) => {
    audit.push({ machine, action: "reply", id, text });
    return true;
  };
  deps.service.leftovers = () => [];
  deps.service.leftoverProbesUnavailable = () => false;
  deps.service.archive = async (id) => {
    audit.push({ machine, action: "archive", id });
    deps.store.archive(id);
    deps.events.emit("session:archived", { id });
    return 0;
  };
  const rename = deps.service.rename.bind(deps.service);
  deps.service.rename = (id, name, options) => {
    audit.push({ machine, action: "rename", id, text: name });
    return rename(id, name, options);
  };
  const accessTokens = new AccessTokenService(deps.store);
  deps.accessTokens = accessTokens;
  return {
    ...server,
    session,
    token: accessTokens.mint("fixture-machine", null, "full", null).token,
  };
}
const mo = node("mo"),
  mac = node("mac");
const instances = new RemoteInstanceService({ store: mo.deps.store });
let machineSocket: WebSocket | undefined;
const openSocket: OpenSocket = (url, headers, on) => {
  const socket = new WebSocket(url, { headers } as never);
  machineSocket = socket;
  socket.onopen = () => on.open();
  socket.onmessage = (message) => on.message(message.data);
  socket.onclose = () => on.close();
  socket.onerror = () => on.close();
  return { close: () => socket.close() };
};
const mirror = new RemoteSessionMirror({
  store: mo.deps.store,
  instances,
  openSocket,
  recheckDelaysMs: [600_000],
});
mo.deps.remoteInstances = instances;
mo.deps.remoteSessions = mirror;
instances.onChange((id) => mirror.sync(id));
const connected = await instances.connect({
  url: mac.baseUrl,
  token: mac.token,
  label: "MacBook fixture",
});
if (!connected.ok) throw new Error(connected.error);
for (let n = 0; n < 300 && !mirror.list().some((s) => s.id === mac.session.id); n++)
  await Bun.sleep(10);
const instanceId = mirror.machines()[0]?.host.instanceId;
if (!instanceId) throw new Error("fixture mirror missing");
const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/state" && req.method === "GET")
      return Response.json({
        audit,
        localId: mo.session.id,
        remoteId: mac.session.id,
        steers: {
          mo: JSON.parse(mo.deps.store.getSetting("steers")!),
          mac: JSON.parse(mac.deps.store.getSetting("steers")!),
        },
      });
    if (path === "/disconnect" && req.method === "POST") {
      machineSocket?.close();
      return Response.json({ ok: true });
    }
    if (path === "/reconnect" && req.method === "POST") {
      await instances.check(instanceId);
      mirror.sync(instanceId);
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  },
});
if (process.env.SHEPHERD_REMOTE_FIXTURE_FILE)
  writeFileSync(
    process.env.SHEPHERD_REMOTE_FIXTURE_FILE,
    JSON.stringify({
      baseURL: mo.baseUrl,
      controlURL: `http://127.0.0.1:${control.port}`,
      localId: mo.session.id,
      remoteId: mac.session.id,
    }),
  );
console.log(`Remote parity fixture ready: ${mo.baseUrl}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    mirror.stop();
    control.stop(true);
    mac.stop();
    mo.stop();
    restoreAuth();
    process.exit(0);
  });
