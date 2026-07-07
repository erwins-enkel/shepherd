import { buildPreviewUrl } from "./previewUrl";

export function openPreviewInNewTab(
  previewHost: string | null,
  loc: Location,
  port: number,
): string {
  const url = buildPreviewUrl(previewHost, loc, port);
  window.open(url, "_blank", "noopener,noreferrer");
  return url;
}
