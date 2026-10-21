import { describe, expect, it } from "vitest";
import { desigIndex } from "./desigLinks";
import { linkifySessionDesignations } from "./markdownSessionLinks";

const live = desigIndex([{ id: "s31", desig: "TASK-31" }]);

describe("linkifySessionDesignations", () => {
  it("links paragraphs, strong, tables and lists without changing the text", () => {
    const body = document.createElement("div");
    body.innerHTML =
      "<p>TASK-31 and task-31</p><strong>TASK-31</strong><table><tbody><tr><td>TASK-31</td></tr></tbody></table><ul><li>TASK-31</li></ul>";
    const text = body.textContent;
    linkifySessionDesignations(body, live);
    expect(body.querySelectorAll('a[data-session-id="s31"]')).toHaveLength(5);
    expect(body.textContent).toBe(text);
    expect(body.querySelector("strong > a")?.getAttribute("href")).toBe("#session-s31");
  });

  it("leaves code, existing links, unknown tokens and token boundaries alone", () => {
    const body = document.createElement("div");
    body.innerHTML =
      '<code>TASK-31</code><pre>TASK-31</pre><a href="https://example.com">TASK-31</a><p>TASK-99 XTASK-31 TASK-311 repo/TASK-31</p>';
    const html = body.innerHTML;
    linkifySessionDesignations(body, live);
    expect(body.innerHTML).toBe(html);
  });

  it("creates attributes safely even for unusual session ids", () => {
    const body = document.createElement("div");
    body.textContent = "TASK-31";
    const id = '"><img src=x onerror=alert(1)>';
    linkifySessionDesignations(body, desigIndex([{ id, desig: "TASK-31" }]));
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("a")?.dataset.sessionId).toBe(id);
  });
});
