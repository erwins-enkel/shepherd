import type { PageMetadata } from "./types";

/** In-page signals gathered by the injected function (see background.ts). */
export interface PageInfo {
  viewportW: number;
  viewportH: number;
  devicePixelRatio: number;
  userAgent: string;
  locale: string;
}

/** Decode a `data:` URL (e.g. captureVisibleTab PNG) into a Blob. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(",");
  const mime = header.match(/data:([^;]+)/)?.[1] ?? "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Merge tab-level fields with injected page info into PageMetadata. */
export function buildMetadata(
  tab: { url?: string; title?: string },
  info: PageInfo,
  timestamp: string,
): PageMetadata {
  return {
    url: tab.url ?? "",
    title: tab.title ?? "",
    viewportW: info.viewportW,
    viewportH: info.viewportH,
    devicePixelRatio: info.devicePixelRatio,
    userAgent: info.userAgent,
    locale: info.locale,
    timestamp,
  };
}
