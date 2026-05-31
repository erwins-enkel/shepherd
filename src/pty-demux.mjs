// Demultiplexes the single stdin byte-stream that carries BOTH terminal input
// and `\x00resize:<cols>:<rows>\n` control frames (see ui/src/lib/pty.ts).
//
// Forwards real input via onInput and resize frames via onResize. Stateful:
// feed() buffers partial frames across chunks. Critically, it never forwards
// control bytes as input — earlier inline logic wrote a whole chunk verbatim
// when input preceded a resize frame in the same chunk (common on mobile, where
// resize events storm on keyboard show/hide), leaking `\x00resize:…` into the
// terminal. This splits the buffer at NUL boundaries so that can't happen.
export function createDemux({ onInput, onResize }) {
  let buf = "";
  // last forwarded size; mobile storms identical resize frames on keyboard /
  // URL-bar toggles — forwarding each one repaints the TUI (and can poke a
  // transiently-dead pty), so only forward genuine size changes.
  let lastC = -1;
  let lastR = -1;

  // Consume any complete resize frames at the head of the buffer. Returns true
  // if at least one frame was consumed (buffer advanced).
  function consumeResizes() {
    let any = false;
    let nl;
    while (buf.startsWith("\x00resize:") && (nl = buf.indexOf("\n")) !== -1) {
      const [, c, r] = buf.slice(0, nl).split(":");
      buf = buf.slice(nl + 1);
      const cols = Number(c) || 100;
      const rows = Number(r) || 30;
      if (cols !== lastC || rows !== lastR) {
        lastC = cols;
        lastR = rows;
        onResize(cols, rows);
      }
      any = true;
    }
    return any;
  }

  // Forward the leading run of input, stopping at the next NUL (which begins a
  // control frame). A bare leading NUL with no frame yet is held until more
  // bytes arrive. Returns true if input was forwarded (buffer advanced).
  function forwardInput() {
    if (!buf || buf.startsWith("\x00")) return false;
    const nul = buf.indexOf("\x00");
    onInput(nul === -1 ? buf : buf.slice(0, nul));
    buf = nul === -1 ? "" : buf.slice(nul);
    return true;
  }

  return {
    feed(chunk) {
      buf += chunk;
      let progressed = true;
      while (progressed) {
        const resized = consumeResizes();
        const forwarded = forwardInput();
        progressed = resized || forwarded;
      }
    },
  };
}
