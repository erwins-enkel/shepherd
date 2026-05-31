import { test, expect } from "bun:test";
import { createDemux } from "../src/pty-demux.mjs";

/** Drive a demux with a list of chunks; return forwarded input + resize calls. */
function run(chunks: string[]) {
  let input = "";
  const resizes: Array<[number, number]> = [];
  const demux = createDemux({
    onInput: (d: string) => (input += d),
    onResize: (c: number, r: number) => resizes.push([c, r]),
  });
  for (const c of chunks) demux.feed(c);
  return { input, resizes };
}

test("forwards plain keystrokes untouched", () => {
  const { input, resizes } = run(["hello world"]);
  expect(input).toBe("hello world");
  expect(resizes).toEqual([]);
});

test("parses a leading resize frame and forwards trailing input", () => {
  const { input, resizes } = run(["\x00resize:120:40\nls\n"]);
  expect(resizes).toEqual([[120, 40]]);
  expect(input).toBe("ls\n");
});

test("LEAK BUG: text before a resize frame must NOT leak control bytes", () => {
  // path injected, then a resize storms in within the same stdin chunk
  const { input, resizes } = run(["echo hi\x00resize:90:28\n"]);
  expect(input).toBe("echo hi"); // only the real input
  expect(input.includes("\x00")).toBe(false); // no NUL leaked
  expect(input.includes("resize:")).toBe(false); // no control text leaked
  expect(resizes).toEqual([[90, 28]]);
});

test("suppresses identical consecutive resizes, forwards real changes", () => {
  // mobile storms the same size on keyboard/URL-bar toggles; only real changes
  // should reach the pty (each forwarded resize repaints the TUI)
  const { resizes } = run([
    "\x00resize:90:28\n",
    "\x00resize:90:28\n",
    "\x00resize:100:30\n",
    "\x00resize:100:30\n",
    "\x00resize:90:28\n",
  ]);
  expect(resizes).toEqual([
    [90, 28],
    [100, 30],
    [90, 28],
  ]);
});

test("dedup holds across a chunk split mid-frame", () => {
  const { resizes } = run(["\x00resize:90:28\n\x00resize:90:", "28\n"]);
  expect(resizes).toEqual([[90, 28]]); // second (identical) frame suppressed
});

test("buffers a resize frame split across chunks", () => {
  const { input, resizes } = run(["\x00resize:90:", "28\nX"]);
  expect(resizes).toEqual([[90, 28]]);
  expect(input).toBe("X");
});

test("injected path survives at EVERY chunk-split point, no leak", () => {
  const PATH = " /home/p/.shepherd-uploads/fc2248c8-62c7-44b7-a4f7-034607bf1b76.png ";
  // path injected, immediately followed by a resize frame (mobile resize storm)
  const stream = PATH + "\x00resize:90:28\n";
  for (let i = 1; i < stream.length; i++) {
    const { input } = run([stream.slice(0, i), stream.slice(i)]);
    expect(input).toBe(PATH); // exact path, nothing dropped, nothing leaked
  }
});
