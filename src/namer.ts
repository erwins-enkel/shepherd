import { config } from "./config";

export function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
}

const PROMPT = (p: string) =>
  `Reply with ONLY a 2-4 word kebab-case task name, no punctuation, for this request:\n${p}`;

export async function generateName(
  prompt: string,
  opts?: { model?: string; endpoint?: string; fetchImpl?: typeof fetch },
): Promise<string> {
  const f = opts?.fetchImpl ?? fetch;
  try {
    const res = await f(opts?.endpoint ?? config.ollamaEndpoint, {
      method: "POST",
      body: JSON.stringify({
        model: opts?.model ?? config.ollamaModel,
        prompt: PROMPT(prompt),
        stream: false,
      }),
    });
    const data = (await res.json()) as { response?: string };
    return normalize(data.response ?? "") || normalize(prompt) || "task";
  } catch {
    return normalize(prompt) || "task";
  }
}
