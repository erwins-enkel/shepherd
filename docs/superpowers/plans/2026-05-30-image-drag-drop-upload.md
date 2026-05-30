# Image drag-drop + mobile upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Svelte note:** For every `.svelte` / `.svelte.ts` edit (Tasks 7–9), the implementing agent MUST use the `svelte-code-writer` skill / `svelte-core-bestpractices` skill (Svelte 5 runes only — `$state`/`$derived`/`$props`, no legacy syntax).

**Goal:** Let users attach screenshots to Claude via drag-drop (desktop) or a 📎 button (mobile), in both the New Task form and the live terminal.

**Architecture:** A single `POST /api/uploads` endpoint saves images to the server filesystem (validated MIME + size, traversal-safe UUID names). New Task uploads to a staging dir, tracks chips, and on submit the server moves files into the new worktree and appends their paths to the prompt. The live terminal uploads straight into the session's worktree and injects the path into the PTY. Claude's Read tool ingests the paths as vision.

**Tech Stack:** Bun + TypeScript server, `bun test`; SvelteKit static + Svelte 5 (runes) frontend; native drag/drop + `<input type=file>` (no new libs).

---

## File Structure

**Server (create):**
- `src/uploads.ts` — upload helpers + endpoint handler + staging sweep (one module, image-upload responsibility).
- `test/uploads.test.ts` — tests for the above.

**Server (modify):**
- `src/types.ts` — add `images?: string[]` to `CreateSessionInput`.
- `src/validate.ts` — validate optional `images` (staging-dir containment, ≤10, existing files).
- `src/service.ts` — move staged images into worktree + append paths to prompt argv (injectable `moveUploads`).
- `src/server.ts` — route `POST /api/uploads`.
- `src/index.ts` — call `sweepStaging` on startup.

**Frontend (modify):**
- `ui/src/lib/types.ts` — add `images?: string[]` to `CreateInput`.
- `ui/src/lib/api.ts` — `uploadImage()`; send `images` in `createSession`.
- `ui/src/lib/components/NewTask.svelte` — drop zone, 📎 button, chips, forward `images`.
- `ui/src/routes/+page.svelte` — forward `images` through `onsubmit`.
- `ui/src/lib/components/Viewport.svelte` — terminal drop zone + touch 📎 button → inject path.

---

## Task 1: Upload helpers module

**Files:**
- Create: `src/uploads.ts`
- Test: `test/uploads.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/uploads.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extForMime,
  MAX_UPLOAD_BYTES,
  stagingDir,
  worktreeUploadsDir,
  moveStagedIntoWorktree,
  sweepStaging,
} from "../src/uploads";

test("extForMime maps supported image types, rejects others", () => {
  expect(extForMime("image/png")).toBe("png");
  expect(extForMime("image/jpeg")).toBe("jpg");
  expect(extForMime("image/gif")).toBe("gif");
  expect(extForMime("image/webp")).toBe("webp");
  expect(extForMime("image/svg+xml")).toBeNull();
  expect(extForMime("application/pdf")).toBeNull();
  expect(extForMime("")).toBeNull();
});

test("MAX_UPLOAD_BYTES is 10 MB", () => {
  expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
});

test("stagingDir / worktreeUploadsDir build the expected paths", () => {
  expect(stagingDir("/repos")).toBe(join("/repos", ".shepherd-uploads-staging"));
  expect(worktreeUploadsDir("/wt/x")).toBe(join("/wt/x", ".shepherd-uploads"));
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-uploads-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("moveStagedIntoWorktree moves files in and returns new absolute paths", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const a = join(staging, "a.png");
  const b = join(staging, "b.jpg");
  writeFileSync(a, "AAA");
  writeFileSync(b, "BBB");
  const wt = join(root, "wt");
  mkdirSync(wt);

  const moved = moveStagedIntoWorktree([a, b], wt);

  expect(moved).toEqual([
    join(worktreeUploadsDir(wt), "a.png"),
    join(worktreeUploadsDir(wt), "b.jpg"),
  ]);
  expect(existsSync(a)).toBe(false); // moved, not copied
  expect(existsSync(b)).toBe(false);
  expect(readFileSync(moved[0]!, "utf8")).toBe("AAA");
  expect(readFileSync(moved[1]!, "utf8")).toBe("BBB");
});

test("sweepStaging deletes files older than maxAge, keeps fresh ones", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const old = join(staging, "old.png");
  const fresh = join(staging, "fresh.png");
  writeFileSync(old, "x");
  writeFileSync(fresh, "y");
  const now = Date.now();
  // backdate `old` by 48h via utimes
  const twoDaysAgoSec = (now - 48 * 3600_000) / 1000;
  require("node:fs").utimesSync(old, twoDaysAgoSec, twoDaysAgoSec);

  sweepStaging(root, 24 * 3600_000, now);

  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

test("sweepStaging is a no-op when staging dir is absent", () => {
  expect(() => sweepStaging(root, 1000, Date.now())).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/uploads.test.ts`
Expected: FAIL — `Cannot find module "../src/uploads"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/uploads.ts`:

```typescript
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  copyFileSync,
  rmSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Extension for a supported image MIME, or null if unsupported. */
export function extForMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null;
}

/** Pre-session staging dir for New Task uploads (worktree doesn't exist yet). */
export function stagingDir(repoRoot: string): string {
  return join(repoRoot, ".shepherd-uploads-staging");
}

/** Per-session uploads dir inside a worktree (removed with the worktree). */
export function worktreeUploadsDir(worktreePath: string): string {
  return join(worktreePath, ".shepherd-uploads");
}

/** Generate a fresh, traversal-safe filename for a validated image. */
export function uploadFilename(ext: string): string {
  return `${randomUUID()}.${ext}`;
}

/**
 * Move each staged file into the worktree's uploads dir; return new absolute
 * paths (basename preserved). Falls back to copy+unlink across devices.
 */
export function moveStagedIntoWorktree(images: string[], worktreePath: string): string[] {
  const dir = worktreeUploadsDir(worktreePath);
  mkdirSync(dir, { recursive: true });
  return images.map((src) => {
    const dest = join(dir, src.split("/").pop()!);
    try {
      renameSync(src, dest);
    } catch {
      copyFileSync(src, dest);
      rmSync(src, { force: true });
    }
    return dest;
  });
}

/** Best-effort: delete staged files older than maxAgeMs. No-op if dir absent. */
export function sweepStaging(repoRoot: string, maxAgeMs: number, now: number): void {
  const dir = stagingDir(repoRoot);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/uploads.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/uploads.ts test/uploads.test.ts
git commit -m "feat(uploads): image upload helpers (mime/ext, staging, move, sweep)"
```

---

## Task 2: Upload endpoint handler

**Files:**
- Modify: `src/uploads.ts`
- Test: `test/uploads.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/uploads.test.ts`:

```typescript
import { handleUpload } from "../src/uploads";
import { SessionStore } from "../src/store";

function uploadReq(file: File | null, query = ""): Request {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new Request(`http://x/api/uploads${query}`, { method: "POST", body: fd });
}

test("handleUpload saves to staging dir when no session given", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
  const res = await handleUpload(uploadReq(file), { store, repoRoot: root });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.startsWith(stagingDir(root) + "/")).toBe(true);
  expect(body.path.endsWith(".png")).toBe(true);
  expect(existsSync(body.path)).toBe(true);
  // generated name, not the client filename
  expect(body.path.includes("shot.png")).toBe(false);
});

test("handleUpload saves into the session worktree when ?session= is valid", async () => {
  const store = new SessionStore(":memory:");
  const wt = join(root, "wt-sess");
  mkdirSync(wt);
  const s = store.create({
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/n",
    worktreePath: wt,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
    claudeSessionId: "00000000-0000-0000-0000-000000000000",
    model: null,
  });
  const file = new File([new Uint8Array([9])], "x.webp", { type: "image/webp" });
  const res = await handleUpload(uploadReq(file, `?session=${s.id}`), { store, repoRoot: root });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.startsWith(worktreeUploadsDir(wt) + "/")).toBe(true);
  expect(existsSync(body.path)).toBe(true);
});

test("handleUpload 404s for an unknown session", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
  const res = await handleUpload(uploadReq(file, "?session=nope"), { store, repoRoot: root });
  expect(res.status).toBe(404);
});

test("handleUpload 415s an unsupported type", async () => {
  const store = new SessionStore(":memory:");
  const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
  const res = await handleUpload(uploadReq(file), { store, repoRoot: root });
  expect(res.status).toBe(415);
});

test("handleUpload 413s a file over the size cap", async () => {
  const store = new SessionStore(":memory:");
  const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "x.png", { type: "image/png" });
  const res = await handleUpload(uploadReq(big), { store, repoRoot: root });
  expect(res.status).toBe(413);
});

test("handleUpload 400s when the file field is missing", async () => {
  const store = new SessionStore(":memory:");
  const res = await handleUpload(uploadReq(null), { store, repoRoot: root });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/uploads.test.ts`
Expected: FAIL — `handleUpload` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/uploads.ts` (top: extend `node:fs` import already present; add the imports/types/function below):

```typescript
import type { SessionStore } from "./store";

const j = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface UploadDeps {
  store: Pick<SessionStore, "get">;
  repoRoot: string;
}

/** POST /api/uploads — multipart `file`; optional `?session=<id>`. Returns { path }. */
export async function handleUpload(req: Request, deps: UploadDeps): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return j({ error: "missing file field" }, 400);

  const ext = extForMime(file.type);
  if (!ext) return j({ error: "unsupported image type" }, 415);
  if (file.size > MAX_UPLOAD_BYTES) return j({ error: "file too large" }, 413);

  const sessionId = new URL(req.url).searchParams.get("session");
  let destDir: string;
  if (sessionId) {
    const s = deps.store.get(sessionId);
    if (!s) return j({ error: "unknown session" }, 404);
    destDir = worktreeUploadsDir(s.worktreePath);
  } else {
    destDir = stagingDir(deps.repoRoot);
  }

  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, uploadFilename(ext));
  await Bun.write(path, file);
  return j({ path });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/uploads.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/uploads.ts test/uploads.test.ts
git commit -m "feat(uploads): POST /api/uploads handler (worktree/staging dest)"
```

---

## Task 3: Route the endpoint in the server

**Files:**
- Modify: `src/server.ts` (imports near line 1-13; route block near line 117)
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/server.test.ts`:

```typescript
import { existsSync as fsExists } from "node:fs";
import { stagingDir } from "../src/uploads";

test("POST /api/uploads saves a staged image and returns its path", async () => {
  const app = harness();
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }));
  const res = await app.fetch(
    new Request("http://x/api/uploads", { method: "POST", body: fd }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.startsWith(stagingDir(config.repoRoot) + "/")).toBe(true);
  expect(fsExists(body.path)).toBe(true);
  rmSync(body.path, { force: true });
});

test("POST /api/uploads rejects a non-image", async () => {
  const app = harness();
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1])], "s.pdf", { type: "application/pdf" }));
  const res = await app.fetch(
    new Request("http://x/api/uploads", { method: "POST", body: fd }),
  );
  expect(res.status).toBe(415);
});
```

Note: `rmSync` is already imported in `test/server.test.ts` line 2.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/server.test.ts`
Expected: FAIL — upload route returns 404 (not found), so `res.status` is 404 not 200.

- [ ] **Step 3: Write minimal implementation**

In `src/server.ts`, add the import after line 10 (`import { sessionTokens, jsonlPathFor } from "./usage";`):

```typescript
import { handleUpload } from "./uploads";
```

Then add this route block immediately before the `if (parts[0] === "api" && parts[1] === "repos" ...)` block (currently near line 117):

```typescript
      if (parts[0] === "api" && parts[1] === "uploads" && !parts[2]) {
        if (req.method === "POST") {
          return handleUpload(req, { store: deps.store, repoRoot: config.repoRoot });
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): route POST /api/uploads"
```

---

## Task 4: Validate `images` on session create

**Files:**
- Modify: `src/types.ts` (line 26-31), `src/validate.ts` (imports line 1-5; `ALLOWED_KEYS` line 21; validator body)
- Test: `test/validate.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/validate.test.ts` (note `writeFileSync` + `stagingDir` must be imported — add `writeFileSync` to the `node:fs` import on line 2 and `import { stagingDir } from "../src/uploads";`):

```typescript
test("validateCreate accepts images inside the staging dir", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const img = join(staging, "a.png");
  writeFileSync(img, "x");
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [img] },
    root,
  );
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.images).toEqual([img]);
});

test("validateCreate defaults images to [] when omitted", () => {
  const r = validateCreate({ repoPath: validRepo, baseBranch: "main", prompt: "go" }, root);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.images).toEqual([]);
});

test("validateCreate rejects an image outside the staging dir", () => {
  const outside = join(root, "evil.png");
  writeFileSync(outside, "x");
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [outside] },
    root,
  );
  expect(r.ok).toBe(false);
});

test("validateCreate rejects a non-existent image", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: [join(stagingDir(root), "nope.png")] },
    root,
  );
  expect(r.ok).toBe(false);
});

test("validateCreate rejects more than 10 images", () => {
  const staging = stagingDir(root);
  mkdirSync(staging, { recursive: true });
  const imgs: string[] = [];
  for (let i = 0; i < 11; i++) {
    const p = join(staging, `i${i}.png`);
    writeFileSync(p, "x");
    imgs.push(p);
  }
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: imgs },
    root,
  );
  expect(r.ok).toBe(false);
});

test("validateCreate rejects a non-array images value", () => {
  const r = validateCreate(
    { repoPath: validRepo, baseBranch: "main", prompt: "go", images: "x" },
    root,
  );
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/validate.test.ts`
Expected: FAIL — `r.value.images` is undefined / `images` treated as unknown key.

- [ ] **Step 3: Write minimal implementation**

In `src/types.ts`, update `CreateSessionInput` (lines 26-31):

```typescript
export interface CreateSessionInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null; // null = claude default (no --model flag)
  images: string[]; // absolute paths to staged uploads (may be empty)
}
```

In `src/validate.ts`:

1. Extend the `node:fs` import (line 1) to include `realpathSync` (already there) — confirm it imports `statSync, realpathSync`. It does.
2. Add after line 5 (`import { MODELS, type CreateSessionInput } from "./types";`):

```typescript
import { stagingDir } from "./uploads";
```

3. Add `"images"` to `ALLOWED_KEYS` (line 21):

```typescript
const ALLOWED_KEYS = new Set(["repoPath", "baseBranch", "prompt", "model", "images"]);
```

4. Add image validation just before the final `return { ok: true, ... }` (currently line 68). Place it after the repoPath block:

```typescript
  // images — optional array of staged upload paths, confined to the staging dir
  const images: string[] = [];
  if (obj.images != null) {
    if (!Array.isArray(obj.images)) return err("images must be an array");
    if (obj.images.length > 10) return err("images must be ≤ 10 entries");
    let stagingReal: string;
    try {
      stagingReal = realpathSync(stagingDir(root));
    } catch {
      return err("no staged uploads exist");
    }
    for (const it of obj.images) {
      if (typeof it !== "string") return err("each image must be a string path");
      let real: string;
      try {
        real = realpathSync(resolve(expandHome(it)));
      } catch {
        return err("image does not exist");
      }
      const inside = real === stagingReal || real.startsWith(stagingReal + sep);
      if (!inside) return err("image must be inside the staging dir");
      try {
        if (!statSync(real).isFile()) return err("image must be a file");
      } catch {
        return err("image does not exist");
      }
      images.push(real);
    }
  }
```

5. Update the success return (line 68-71) to include `images`:

```typescript
  return {
    ok: true,
    value: { repoPath: resolved, baseBranch: obj.baseBranch, prompt, model, images },
  };
```

Note: `root` is already defined in `validateCreate` (line 57: `const root = resolve(expandHome(repoRoot));`). The image block must appear **after** line 57 so `root` is in scope — place it directly before the success return.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/validate.test.ts`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/validate.ts test/validate.test.ts
git commit -m "feat(validate): validate optional images[] (staging containment, ≤10)"
```

---

## Task 5: Move images into worktree + append to prompt

**Files:**
- Modify: `src/service.ts` (imports line 1-6; `ServiceDeps` line 8-13; `create` line 18-39)
- Test: `test/service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/service.test.ts`:

```typescript
test("createSession: moves images into worktree and appends paths to the prompt", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    worktree: {
      create: () => ({ worktreePath: "/wt/repo-x", branch: "shepherd/repo-x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: (name: string, cwd: string, argv: string[]) => {
        calls.argv = argv;
        return { terminalId: "term_y", cwd, agent: "claude", agentStatus: "working", paneId: "p", tabId: "t", workspaceId: "w" };
      },
      list: () => [],
    } as any,
    moveUploads: (images: string[], worktreePath: string) =>
      images.map((i) => `${worktreePath}/.shepherd-uploads/${i.split("/").pop()}`),
  });

  const s = await service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "look at this",
    model: null,
    images: ["/stage/a.png", "/stage/b.png"],
  });

  // prompt argv (last element) carries the user text + the moved image paths
  expect(calls.argv[calls.argv.length - 1]).toBe(
    "look at this\n\nAttached images:\n/wt/repo-x/.shepherd-uploads/a.png\n/wt/repo-x/.shepherd-uploads/b.png",
  );
  // stored prompt stays the clean user text
  expect(store.get(s.id)?.prompt).toBe("look at this");
});

test("createSession: no images leaves the prompt argv unchanged", async () => {
  const store = new SessionStore(":memory:");
  const calls: any = {};
  const service = new SessionService({
    store,
    namer: async () => "repo-x",
    worktree: { create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }), remove: () => {} } as any,
    herdr: {
      start: (_n: string, _c: string, argv: string[]) => {
        calls.argv = argv;
        return { terminalId: "t", cwd: "/wt/x", agent: "claude", agentStatus: "working", paneId: "p", tabId: "t", workspaceId: "w" };
      },
      list: () => [],
    } as any,
  });
  await service.create({ repoPath: "/repo", baseBranch: "main", prompt: "go", model: null, images: [] });
  expect(calls.argv[calls.argv.length - 1]).toBe("go");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/service.test.ts`
Expected: FAIL — `moveUploads` not used; prompt argv lacks the appended paths.

- [ ] **Step 3: Write minimal implementation**

In `src/service.ts`:

1. Add after line 6 (`import type { CreateSessionInput, Session } from "./types";`):

```typescript
import { moveStagedIntoWorktree } from "./uploads";
```

2. Add an optional `moveUploads` to `ServiceDeps` (after line 12, before the closing brace):

```typescript
  /** Inject point for tests; defaults to the real fs move. */
  moveUploads?: (images: string[], worktreePath: string) => string[];
```

3. Rewrite `create` (lines 18-39) so the prompt argv is augmented while the stored prompt stays clean:

```typescript
  async create(input: CreateSessionInput): Promise<Session> {
    const name = await this.deps.namer(input.prompt);
    const wt = this.deps.worktree.create(input.repoPath, input.baseBranch, name);
    const claudeSessionId = randomUUID();

    let promptArg = input.prompt;
    if (input.images.length > 0) {
      const move = this.deps.moveUploads ?? moveStagedIntoWorktree;
      const moved = move(input.images, wt.worktreePath);
      promptArg = `${input.prompt}\n\nAttached images:\n${moved.join("\n")}`;
    }

    const argv = ["claude", "--dangerously-skip-permissions", "--session-id", claudeSessionId];
    if (input.model) argv.push("--model", input.model);
    argv.push(promptArg);
    const agent = this.deps.herdr.start(name, wt.worktreePath, argv);
    return this.deps.store.create({
      name,
      prompt: input.prompt,
      repoPath: input.repoPath,
      baseBranch: input.baseBranch,
      branch: wt.branch,
      worktreePath: wt.worktreePath,
      isolated: wt.isolated,
      herdrSession: config.herdrSession,
      herdrAgentId: agent.terminalId,
      claudeSessionId,
      model: input.model,
    });
  }
```

Note: existing service tests call `create({...})` without `images`. They must be updated to pass `images: []` OR `input.images.length` will throw on undefined. **Update existing `create(...)` calls in `test/service.test.ts` to include `images: []`** (there are two earlier tests — add `images: []` to each input object).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/service.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/service.ts test/service.test.ts
git commit -m "feat(service): move staged images into worktree, append paths to prompt"
```

---

## Task 6: Frontend API client + types

**Files:**
- Modify: `ui/src/lib/types.ts` (lines 72-77), `ui/src/lib/api.ts` (lines 1-19)

No unit tests (no API test harness in `ui/`); verified by `bun run check` and downstream UI tasks.

- [ ] **Step 1: Update the `CreateInput` type**

In `ui/src/lib/types.ts`, update `CreateInput`:

```typescript
export interface CreateInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null;
  images?: string[]; // absolute staging paths from /api/uploads
}
```

- [ ] **Step 2: Add `uploadImage` and send `images` in `createSession`**

In `ui/src/lib/api.ts`, replace `createSession` (lines 11-19) and add `uploadImage`:

```typescript
export async function createSession(input: CreateInput): Promise<Session> {
  const r = await fetch("/api/sessions", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`create failed: ${r.status}`);
  return r.json();
}

/** Upload one image; returns its absolute server path. Pass sessionId to store it
 *  inside that session's worktree (live terminal); omit for New Task staging. */
export async function uploadImage(file: File, sessionId?: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  // no content-type header: the browser sets the multipart boundary
  const r = await fetch(`/api/uploads${q}`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`upload failed: ${r.status}`);
  return (await r.json()).path as string;
}
```

(`createSession` already serializes the whole `input`, so `images` flows through once the type allows it — the body is unchanged but kept here for clarity.)

- [ ] **Step 3: Verify types compile**

Run: `cd ui && bun run check`
Expected: no new errors referencing `api.ts` / `types.ts`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts
git commit -m "feat(ui/api): uploadImage() + images in CreateInput"
```

---

## Task 7: New Task form — drop zone, button, chips

**Files:**
- Modify: `ui/src/lib/components/NewTask.svelte`

**Use the `svelte-code-writer` / `svelte-core-bestpractices` skill for this edit.** No unit test; verify via `bun run check` + manual.

- [ ] **Step 1: Add upload state, handlers, and the `images` payload**

In the `<script>` block of `ui/src/lib/components/NewTask.svelte`:

1. Add to the imports (line 3): `uploadImage` —

```typescript
import { listRepos, listBranches, uploadImage } from "$lib/api";
```

2. Add state after `let branches` (line 34):

```typescript
  let images = $state<{ path: string; name: string }[]>([]);
  let dragging = $state(false);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement>();
```

3. Add upload helpers (after the `$effect` for branches, before `submit`):

```typescript
  async function addFiles(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    uploading = true;
    error = null;
    try {
      for (const f of imgs) {
        const path = await uploadImage(f);
        images.push({ path, name: f.name });
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "upload failed";
    } finally {
      uploading = false;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }

  function removeImage(path: string) {
    images = images.filter((i) => i.path !== path);
  }
```

4. In `submit`, include `images` in the `onsubmit` payload (the call near line 80):

```typescript
      await onsubmit({
        repoPath: repoPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        prompt: prompt.trim(),
        model: model === "default" ? null : model,
        images: images.map((i) => i.path),
      });
```

5. Update the `onsubmit` prop type (lines 14-19) to include `images`:

```typescript
    onsubmit: (input: {
      repoPath: string;
      baseBranch: string;
      prompt: string;
      model: string | null;
      images: string[];
    }) => Promise<void> | void;
```

- [ ] **Step 2: Add the drop zone, attach button, and chips to the markup**

On the `<form>` element (line 100), add drag handlers and a dragging class:

```svelte
  <form
    class="card bracket"
    class:dragging
    onsubmit={submit}
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={(e) => {
      if (e.target === e.currentTarget) dragging = false;
    }}
    ondrop={onDrop}
  >
```

Immediately after the `<textarea>` (line 108), add the attach control + chips:

```svelte
    <div class="attach-row">
      <button type="button" class="attach" onclick={() => fileInput?.click()} disabled={uploading}>
        {uploading ? "Uploading…" : "📎 Attach image"}
      </button>
      <span class="hint">or drop screenshots here</span>
    </div>
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*"
      multiple
      hidden
      onchange={(e) => {
        const t = e.currentTarget;
        if (t.files) addFiles(t.files);
        t.value = "";
      }}
    />
    {#if images.length > 0}
      <div class="chips">
        {#each images as img (img.path)}
          <span class="chip">
            <span class="chip-name">{img.name}</span>
            <button type="button" class="chip-x" onclick={() => removeImage(img.path)} aria-label="remove">✕</button>
          </span>
        {/each}
      </div>
    {/if}
```

- [ ] **Step 3: Add styles**

Add to the `<style>` block:

```css
  .card.dragging {
    border-color: var(--color-amber);
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .attach-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .attach {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.06em;
    padding: 6px 10px;
    border-radius: 2px;
    cursor: pointer;
  }
  .attach:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .hint {
    font-size: 10.5px;
    color: var(--color-muted);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 3px 7px;
    font-size: 11px;
    color: var(--color-ink);
  }
  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
  }
  .chip-x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  @media (max-width: 768px) {
    .attach {
      min-height: 44px;
    }
  }
```

- [ ] **Step 4: Verify**

Run: `cd ui && bun run check`
Expected: no new errors in `NewTask.svelte`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/NewTask.svelte
git commit -m "feat(ui): New Task image drop zone, attach button, chips"
```

---

## Task 8: Forward `images` through the page submit handler

**Files:**
- Modify: `ui/src/routes/+page.svelte` (`onsubmit`, lines 57-68)

- [ ] **Step 1: Widen the `onsubmit` signature**

In `ui/src/routes/+page.svelte`, update `onsubmit` to accept and forward `images`:

```typescript
  async function onsubmit(input: {
    repoPath: string;
    baseBranch: string;
    prompt: string;
    model: string | null;
    images: string[];
  }) {
    const s = await createSession(input);
    selectedId = s.id;
    showNew = false;
    composeRepoPath = null;
    composePrompt = "";
  }
```

(`createSession(input)` already forwards the whole object, including `images`.)

- [ ] **Step 2: Verify**

Run: `cd ui && bun run check`
Expected: no new errors; `NewTask`'s `onsubmit` prop type now matches.

- [ ] **Step 3: Commit**

```bash
git add ui/src/routes/+page.svelte
git commit -m "feat(ui): forward images through new-task submit"
```

---

## Task 9: Live terminal — drop zone + touch attach button

**Files:**
- Modify: `ui/src/lib/components/Viewport.svelte`

**Use the `svelte-code-writer` / `svelte-core-bestpractices` skill for this edit.**

- [ ] **Step 1: Add upload state + handlers in `<script>`**

1. Add to the `api` import (line 8):

```typescript
import { getSessionUsage, uploadImage } from "$lib/api";
```

2. Add state near `let conn` (line 33):

```typescript
  let dragging = $state(false);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement>();
```

3. Add handlers (after the `decommission` function, before the terminal `$effect`):

```typescript
  // upload image(s) into this session's worktree, then inject their paths into
  // the PTY as if typed — the user adds wording and presses Enter themselves.
  async function attachImages(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0 || !conn) return;
    uploading = true;
    try {
      for (const f of imgs) {
        const path = await uploadImage(f, session.id);
        conn.send(` ${path} `);
      }
    } catch {
      /* swallow: a failed upload must never wedge the terminal */
    } finally {
      uploading = false;
    }
  }

  function onTermDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files?.length) attachImages(e.dataTransfer.files);
  }
```

- [ ] **Step 2: Add drop handlers to the terminal mount**

Update the `term-mount` div (lines 232-236):

```svelte
    <div
      class="term-mount"
      class:dragging
      bind:this={el}
      style:display={tab === "term" ? undefined : "none"}
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={(e) => {
        if (e.target === e.currentTarget) dragging = false;
      }}
      ondrop={onTermDrop}
    ></div>
```

- [ ] **Step 3: Add the touch attach button next to ControlBar**

Replace the ControlBar block (lines 253-256) with a wrapper that adds the 📎 button + hidden input:

```svelte
  {#if (mobile || touch) && tab === "term"}
    <div class="ctrl-row">
      <button
        type="button"
        class="attach"
        onpointerdown={(e) => {
          e.preventDefault();
          fileInput?.click();
        }}
        aria-label="Attach image"
      >
        {uploading ? "⏳" : "📎"}
      </button>
      <ControlBar onkey={(seq) => conn?.send(seq)} />
    </div>
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*"
      multiple
      hidden
      onchange={(e) => {
        const t = e.currentTarget;
        if (t.files) attachImages(t.files);
        t.value = "";
      }}
    />
  {/if}
```

- [ ] **Step 4: Add styles**

Add to the `<style>` block:

```css
  .term-mount.dragging {
    outline: 2px dashed var(--color-amber);
    outline-offset: -4px;
  }
  .ctrl-row {
    display: flex;
    align-items: stretch;
    gap: 4px;
  }
  .ctrl-row .attach {
    flex: 0 0 auto;
    min-width: 44px;
    height: 36px;
    margin: 6px 0 6px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font-size: 16px;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }
```

- [ ] **Step 5: Verify**

Run: `cd ui && bun run check`
Expected: no new errors in `Viewport.svelte`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/Viewport.svelte
git commit -m "feat(ui): terminal image drop + touch attach button → inject path"
```

---

## Task 10: Sweep staging dir on startup

**Files:**
- Modify: `src/index.ts` (imports line 1-14; startup body)

- [ ] **Step 1: Add the sweep call**

In `src/index.ts`:

1. Add after line 14 (`import { HerdrUsageProbe } from "./usage-probe";`):

```typescript
import { sweepStaging } from "./uploads";
```

2. Add after `mkdirSync(dirname(config.dbPath), { recursive: true });` (line 16):

```typescript
// drop abandoned New-Task uploads (attached but never submitted) older than 24h
sweepStaging(config.repoRoot, 24 * 60 * 60 * 1000, Date.now());
```

- [ ] **Step 2: Verify it starts cleanly**

Run: `bun run src/index.ts` (Ctrl-C after the `shepherd core on …` line appears).
Expected: server boots, no error from the sweep. (Requires herdr available; if not installed locally, instead run `bun -e 'import("./src/uploads").then(m => m.sweepStaging(process.env.HOME+"/Work", 1000, Date.now()))'` and confirm no throw.)

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: sweep abandoned staging uploads on startup"
```

---

## Task 11: Full validation pass

**Files:** none (verification only)

- [ ] **Step 1: Run the whole server test suite**

Run: `bun test`
Expected: all tests pass (existing + new uploads/validate/service/server tests).

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 3: Format**

Run: `bun run format`
Expected: files formatted; commit if anything changed.

- [ ] **Step 4: UI type-check + build**

Run: `cd ui && bun run check && bun run build`
Expected: no errors; build succeeds.

- [ ] **Step 5: Manual smoke test (real app)**

Start the app (`bun run start` or the user's deploy), then:
- New Task: drag a PNG onto the form → chip appears; submit → session prompt argv contains `Attached images:` + a `<worktree>/.shepherd-uploads/<uuid>.png` path; Claude reads the image.
- New Task on mobile/touch: tap 📎 → pick from gallery → chip appears.
- Live terminal: drag a PNG onto the terminal → its worktree path is typed into the prompt; add wording + Enter → Claude reads it.
- Touch terminal: tap 📎 in the control row → pick image → path injected.
- Decommission the session → `<worktree>/.shepherd-uploads/` is gone with the worktree.

- [ ] **Step 6: Commit any formatting changes**

```bash
git add -A
git commit -m "chore: formatting" || echo "nothing to format"
```

---

## Self-review notes

- **Spec coverage:** upload endpoint (T1-3), MIME/size/traversal (T1-2), worktree-vs-staging dest (T2), New Task chips + move-on-create (T4-8), terminal drop + inject (T9), mobile button both surfaces (T7, T9), worktree cleanup (existing) + 24h staging sweep (T10), tests (T1-5, T11). All spec sections map to tasks.
- **Type consistency:** `CreateSessionInput.images` (server, required `string[]`), `CreateInput.images?` (ui, optional), `validateCreate` always returns `images: []` default, `service.create` reads `input.images.length`, `moveUploads`/`moveStagedIntoWorktree` share signature `(string[], string) => string[]`, `uploadImage(file, sessionId?)` matches both call sites. Prompt-append format string is identical in T5 impl and its test.
- **Out of scope:** clipboard paste, non-image files, thumbnails, progress bars — not implemented.
