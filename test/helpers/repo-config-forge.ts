import type { GitForge, OpenPrInput, PrStatus } from "../../src/forge/types";

/** Stateful forge paired with the real bare-origin config fixture. */
export function configForge(headExists?: () => boolean) {
  let state: PrStatus["state"] = "none";
  const opened: OpenPrInput[] = [];
  const edited: { title?: string; body?: string }[] = [];
  const status = () => {
    if (state === "open" && headExists && !headExists()) state = "closed";
    return {
      state,
      number: state === "none" ? undefined : 41,
      url: "https://host/pr/41",
    } as PrStatus;
  };
  const forge = {
    kind: "github",
    slug: "acme/project",
    isFork: false,
    prStatus: async () => status(),
    openPr: async (input: OpenPrInput) => {
      opened.push(input);
      state = "open";
      return status();
    },
    editPr: async (_number: number, input: { title?: string; body?: string }) => {
      edited.push(input);
    },
    closePr: async () => {
      state = "closed";
    },
  } as unknown as GitForge;
  return {
    forge,
    opened,
    edited,
    setState: (value: PrStatus["state"]) => {
      state = value;
    },
  };
}
