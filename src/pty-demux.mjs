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
  return {
    feed(chunk) {
      buf += chunk;
      let progressed = true;
      while (progressed) {
        progressed = false;
        // consume any complete resize frames at the head of the buffer
        let nl;
        while (buf.startsWith("\x00resize:") && (nl = buf.indexOf("\n")) !== -1) {
          const [, c, r] = buf.slice(0, nl).split(":");
          buf = buf.slice(nl + 1);
          onResize(Number(c) || 100, Number(r) || 30);
          progressed = true;
        }
        // forward the leading run of input, stopping at the next NUL (which
        // begins a control frame). A bare leading NUL with no frame yet is held
        // until more bytes arrive.
        if (buf && !buf.startsWith("\x00")) {
          const nul = buf.indexOf("\x00");
          onInput(nul === -1 ? buf : buf.slice(0, nul));
          buf = nul === -1 ? "" : buf.slice(nul);
          progressed = true;
        }
      }
    },
  };
}
