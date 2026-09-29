// Starlight route middleware (registered via `routeMiddleware` in astro.config.mjs):
// adds the per-page social card from src/pages/og/[...slug].ts to every page's head.
// Starlight already emits og:title/description + twitter:card summary_large_image,
// but no image — link previews showed a blank placeholder without this.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

export const onRequest = defineRouteMiddleware((context) => {
  const { id, entry, head } = context.locals.starlightRoute;
  // Homepage route id is "" (its collection id is "index"); the synthetic 404 page
  // has no card of its own, so it reuses the homepage's; api/** shares one card.
  const key = id === "" || id === "404" ? "index" : id.startsWith("api/") ? "api" : id;
  const image = new URL(`/og/${key}.png`, context.site).href;
  head.push(
    { tag: "meta", attrs: { property: "og:image", content: image } },
    { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
    { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
    { tag: "meta", attrs: { property: "og:image:alt", content: entry.data.title } },
    { tag: "meta", attrs: { name: "twitter:image", content: image } },
  );
});
