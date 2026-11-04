// Short-lived Darwin-only process. Never import this FFI module into the server.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { execFile } from "node:child_process";
import { collectDarwinMarkers } from "./proc-markers-darwin-core";

async function main() {
  if (process.platform !== "darwin") throw new Error("Darwin only");
  const ids: unknown = JSON.parse(await Bun.stdin.text());
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
    throw new Error("invalid ids");
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  try {
    const size = new BigUint64Array(1);
    const argmax = new Int32Array(1);
    size[0] = 4n;
    // CTL_KERN=1, KERN_ARGMAX=8, KERN_PROCARGS2=49; size_t is 64-bit on Darwin.
    const maxMib = new Int32Array([1, 8]);
    if (
      lib.symbols.sysctl(ptr(maxMib), 2, ptr(argmax), ptr(size), null, 0) !== 0 ||
      size[0] !== 4n ||
      argmax[0]! <= 0 ||
      argmax[0]! > 16 * 1024 * 1024
    )
      throw new Error("argmax unavailable");
    const data = Buffer.alloc(argmax[0]!);
    const mib = new Int32Array([1, 49, 0]);
    const ps = await new Promise<string>((resolve, reject) => {
      execFile(
        "/bin/ps",
        ["-axo", "pid=,uid=,rss=,stat="],
        {
          timeout: 2000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          env: { ...process.env, LC_ALL: "C" },
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    // A process that vanished or whose arguments macOS won't show is skipped either way.
    const result = collectDarwinMarkers(ps, process.geteuid!(), new Set(ids), (pid) => {
      mib[2] = pid;
      size[0] = BigInt(data.length);
      if (lib.symbols.sysctl(ptr(mib), 3, ptr(data), ptr(size), null, 0) !== 0) return null;
      const length = Number(size[0]);
      return length <= data.length ? data.subarray(0, length) : null;
    });
    process.stdout.write(JSON.stringify(result && [...result]));
  } finally {
    lib.close();
  }
}

await main().catch(() => {
  process.exitCode = 1;
});
