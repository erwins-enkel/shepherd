import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { CodexAccountClient, parseCodexAccount } from "../src/codex-account";

const now = 1_800_000_000_000;
const payload = {
  accountId: "test-account",
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: now / 1000 + 600 },
  },
  rateLimitResetCredits: {
    availableCount: 3,
    credits: [
      {
        id: "credit-a",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: now / 1000 - 60,
        expiresAt: now / 1000 + 300,
      },
    ],
  },
};

test("Codex account: duration identifies a weekly primary and preserves partial credit details", () => {
  const result = parseCodexAccount(payload, now);
  expect(result.week).toEqual({ pct: 92, resetAt: now + 600_000 });
  expect(result.session5h).toBeNull();
  expect(result.resets).toEqual({
    availableCount: 3,
    credits: [{ id: "credit-a", expiresAt: now + 300_000 }],
  });
  expect(result.checkedAt).toBe(now);
});

test("Codex account: unknown counts differ from zero and count-only differs from empty details", () => {
  expect(parseCodexAccount({ ...payload, rateLimitResetCredits: null }, now).resets).toBeNull();
  expect(
    parseCodexAccount(
      { ...payload, rateLimitResetCredits: { availableCount: 0, credits: [] } },
      now,
    ).resets,
  ).toEqual({ availableCount: 0, credits: [] });
  expect(
    parseCodexAccount(
      { ...payload, rateLimitResetCredits: { availableCount: 3, credits: null } },
      now,
    ).resets,
  ).toEqual({ availableCount: 3, credits: null });
});

test("Codex account: foreign buckets and malformed percentages cannot authorize use", () => {
  expect(
    parseCodexAccount({ ...payload, rateLimits: { ...payload.rateLimits, limitId: "other" } }, now)
      .week,
  ).toBeNull();
  expect(() =>
    parseCodexAccount(
      {
        ...payload,
        rateLimits: {
          ...payload.rateLimits,
          primary: { ...payload.rateLimits.primary, usedPercent: "92" },
        },
      },
      now,
    ),
  ).toThrow();
  expect(() =>
    parseCodexAccount({ ...payload, rateLimitResetCredits: { availableCount: -1 } }, now),
  ).toThrow();
});

function client(script: string, timeoutMs = 1000) {
  return new CodexAccountClient({
    now: () => now,
    timeoutMs,
    spawn: () => spawn(process.execPath, ["-e", script], { stdio: "pipe" }),
  });
}
const responder = `let initialized = false; require('node:readline').createInterface({input:process.stdin}).on('line', l => {
 const r=JSON.parse(l); if(r.method==='initialized'){initialized=true;return;}
 if(r.method==='initialize'){console.log(JSON.stringify({id:r.id,result:{}}));return;}
 if(!initialized){console.log(JSON.stringify({id:r.id,error:{code:-1,message:'not initialized'}}));return;}
 console.log(JSON.stringify({method:'account/updated',params:{}}));
 const result=r.method==='account/rateLimits/read'?${JSON.stringify(payload)}:{outcome:'reset'};
 setTimeout(()=>console.log(JSON.stringify({id:r.id,result})),r.method==='account/rateLimits/read'?10:0);
});`;

test("Codex account: initializes once and correlates responses despite notifications and reordering", async () => {
  const c = client(responder);
  try {
    const [limits, result] = await Promise.all([
      c.readLimits(),
      c.consumeReset({ idempotencyKey: "request-a", creditId: "credit-a" }),
    ]);
    expect(limits.accountId).toBe("test-account");
    expect(result).toBe("reset");
  } finally {
    c.close();
  }
});

test("Codex account: timeout and process exit reject outstanding reads", async () => {
  for (const script of ["setInterval(()=>{},1000)", "process.exit(0)"]) {
    const c = client(script, 30);
    try {
      await expect(c.readLimits()).rejects.toThrow();
    } finally {
      c.close();
    }
  }
});

test("Codex account: unsupported method and unknown redemption outcome are failures", async () => {
  const c = client(responder.replace("{outcome:'reset'}", "{outcome:'surprise'}"));
  try {
    await expect(c.consumeReset({ idempotencyKey: "x" })).rejects.toThrow();
  } finally {
    c.close();
  }
  const d = client(
    responder.replace(
      "console.log(JSON.stringify({method:'account/updated',params:{}}));",
      "console.log(JSON.stringify({id:r.id,error:{code:-32601,message:'unknown method'}}));return;",
    ),
  );
  try {
    await expect(d.readLimits()).rejects.toThrow();
  } finally {
    d.close();
  }
});

test("Codex account: provider displays authoritative account data without a local thread database", async () => {
  const { CodexUsageProvider } = await import("../src/codex-usage");
  const provider = new CodexUsageProvider(
    "/nonexistent/codex-state",
    "/nonexistent/codex-home",
    () => ({
      measurement: parseCodexAccount(payload, now),
      resetStatus: {
        autoEnabled: false,
        state: "ready",
        checkedAt: now,
        availableCount: 3,
        nextExpiryAt: now + 300_000,
        reason: null,
        lastOutcome: null,
        waitingCount: 0,
      },
    }),
  );
  const snapshot = provider.snapshot(now);
  expect(snapshot).toMatchObject({
    provider: "codex",
    week: { pct: 92 },
    tokenDataAvailable: false,
    rateLimitSource: "app-server",
    resetStatus: { availableCount: 3 },
  });
});

test("Codex speed: queries the retained provider and restored model across catalog pages", async () => {
  const c =
    client(`require('node:readline').createInterface({input:process.stdin}).on('line', l => {
    const {id, method, params} = JSON.parse(l);
    if (!id) return;
    let result = {};
    if (method === "account/read") result = {account:{type:"chatgpt"}};
    if (method === "config/read") result = {config:{model:"other", model_provider:"openai"}};
    if (method === "model/list") {
      if (params.modelProvider !== "retained") return console.log(JSON.stringify({id,error:{code:-1}}));
      result = params.cursor
        ? {data:[{model:"restored",serviceTiers:[{id:"priority",name:"Fast"}]}],nextCursor:null}
        : {data:[],nextCursor:"next"};
    }
    console.log(JSON.stringify({id,result}));
  });`);
  try {
    expect(await c.readFastTier({ cwd: "/task", provider: "retained", model: "restored" })).toEqual(
      {
        tier: "priority",
      },
    );
  } finally {
    c.close();
  }
});

test.each([
  [{ account: null }, { config: {} }, {}, { data: [] }, "login"],
  [{ account: {} }, { config: { features: { fast_mode: false } } }, {}, { data: [] }, "disabled"],
  [
    { account: {} },
    { config: {} },
    { requirements: { featureRequirements: { fast_mode: false } } },
    { data: [] },
    "disabled",
  ],
  [{ account: {} }, { config: {} }, {}, { data: [{ isDefault: true }] }, "version"],
  [
    { account: {} },
    { config: { model: "selected" } },
    {},
    {
      data: [
        { isDefault: true, model: "default", serviceTiers: [{ id: "priority", name: "Fast" }] },
        { model: "selected", serviceTiers: [{ id: "ultrafast", name: "Ultrafast" }] },
      ],
    },
    "model",
  ],
  [{ account: {} }, {}, {}, { data: [] }, "unknown"],
] as const)(
  "Codex speed withholds Fast without matching account/config/catalog evidence (%#)",
  async (account, config, policy, models, reason) => {
    const responses = {
      "account/read": account,
      "config/read": config,
      "configRequirements/read": policy,
      "model/list": models,
    };
    const c =
      client(`require('node:readline').createInterface({input:process.stdin}).on('line', l => {
    const {id, method} = JSON.parse(l);
    if (id) console.log(JSON.stringify({id,result:${JSON.stringify(responses)}[method] ?? {}}));
  });`);
    try {
      expect(await c.readFastTier({ cwd: "/task" })).toEqual({ reason });
    } finally {
      c.close();
    }
  },
);
