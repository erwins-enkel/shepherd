import { HerdrSocketClient } from "./herdr-socket-client";
import {
  CLEAN_TERMINAL_PREFIX,
  parseCleanTerminalRequest,
  type CleanTerminalRequest,
  type CleanTerminalReply,
  type TerminalScroll,
} from "../shared/clean-terminal";

/** Shell-pane history lives in herdr, not in the ANSI screen-diff client. */
export class CleanTerminalControl {
  private enabled = false;
  private busy = false;
  private closed = false;

  constructor(
    private readonly paneId: string,
    private readonly client: Pick<HerdrSocketClient, "request">,
    private readonly authorized: () => boolean,
    private readonly send: (frame: string) => void,
  ) {}

  close(): void {
    this.closed = true;
  }

  handle(frame: string): boolean {
    if (!frame.startsWith(CLEAN_TERMINAL_PREFIX)) return false;
    const request = parseCleanTerminalRequest(frame);
    if (!request || !this.active() || (request.op !== "init" && !this.enabled)) return true;
    // A compliant client coalesces gestures while waiting. Bound work from other clients too.
    if (this.busy) {
      this.reply({ id: request.id, error: "unavailable" });
      return true;
    }
    this.busy = true;
    void this.run(request)
      .then(
        (result) => this.reply({ id: request.id, ...result }),
        (error: unknown) => {
          const code =
            error && typeof error === "object" && "code" in error ? String(error.code) : "";
          this.reply({
            id: request.id,
            error:
              code === "stale_content"
                ? "stale"
                : /method|unsupported/.test(code)
                  ? "unsupported"
                  : "unavailable",
          });
        },
      )
      .finally(() => {
        this.busy = false;
      });
    return true;
  }

  private active(): boolean {
    return !this.closed && this.authorized();
  }

  private reply(reply: CleanTerminalReply): void {
    if (this.active()) this.send(CLEAN_TERMINAL_PREFIX + JSON.stringify(reply));
  }

  private async getScroll(): Promise<TerminalScroll> {
    if (!this.active()) throw new Error("detached");
    const result = await this.client.request("pane.get", { pane_id: this.paneId });
    if (result.type !== "pane_info") throw new Error("invalid pane reply");
    const { pane } = result;
    if (!pane.scroll) throw Object.assign(new Error("scroll unavailable"), { code: "unsupported" });
    return pane.scroll;
  }

  private async revision(): Promise<number> {
    if (!this.active()) throw new Error("detached");
    // pane.read.revision is hardcoded to 0 in herdr 0.9.5. This read-only motion returns
    // the actual content_seq, which pane.selection.read checks against content_revision.
    const result = await this.client.request("pane.copy_motion", {
      pane_id: this.paneId,
      cursor: { row: 0, col: 0 },
      motion: "line_end",
    });
    if (result.type !== "pane_copy_motion") throw new Error("invalid revision reply");
    return result.content_revision;
  }

  private async run(r: CleanTerminalRequest): Promise<Omit<CleanTerminalReply, "id">> {
    if (r.op === "init") {
      const scroll = await this.getScroll();
      const revision = await this.revision();
      if (!this.active()) throw new Error("detached");
      await this.client.request("pane.selection.read", {
        pane_id: this.paneId,
        anchor: { row: 0, col: 0 },
        cursor: { row: 0, col: 0 },
        content_revision: revision,
      });
      this.enabled = true;
      return { scroll };
    }
    if (r.op === "selection") {
      const result = await this.client.request("pane.selection.read", {
        pane_id: this.paneId,
        content_revision: r.revision,
        anchor: r.anchor,
        cursor: r.cursor,
      });
      if (result.type !== "pane_selection") throw new Error("invalid selection reply");
      return { text: result.text };
    }
    if (r.op === "scroll") {
      const scroll = await this.getScroll();
      if (!this.active()) throw new Error("detached");
      await this.client.request("pane.scroll", {
        pane_id: this.paneId,
        offset_from_bottom: Math.min(r.offset, scroll.max_offset_from_bottom),
      });
    }
    const revision = await this.revision();
    const scroll = await this.getScroll();
    if (!this.active()) throw new Error("detached");
    const result = await this.client.request("pane.read", {
      pane_id: this.paneId,
      source: "visible",
      format: "ansi",
      strip_ansi: false,
    });
    if (result.type !== "pane_read") throw new Error("invalid read reply");
    const { read } = result;
    const after = await this.revision();
    const latest = await this.getScroll();
    if (after !== revision || JSON.stringify(latest) !== JSON.stringify(scroll)) {
      return { error: "stale" };
    }
    return { scroll, revision, text: read.text };
  }
}
