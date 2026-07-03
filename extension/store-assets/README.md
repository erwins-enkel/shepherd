# Chrome Web Store listing assets

Assets uploaded to the CWS **dashboard** at submission — distinct from the manifest
`icons` (which are the in-Chrome toolbar/management icons and stay full-bleed). See
[`../STORE_LISTING.md`](../STORE_LISTING.md) for the copy that accompanies these.

## `store-icon-128.png` — 128×128 store listing icon

The CWS listing icon wants a ~96×96 visual centered in a 128×128 frame with ~16px
transparent padding (unlike the manifest icons, which fill the frame). Regenerate from
the shared Shepherd sheep mark (`ui/static/favicon.svg`) with rsvg-convert + ImageMagick:

```bash
rsvg-convert -w 96 -h 96 ../../ui/static/favicon.svg -o /tmp/sheep96.png
magick /tmp/sheep96.png -background none -gravity center -extent 128x128 store-icon-128.png
```

## Still to produce (human/ops — not committable here)

- **≥1 screenshot** at 1280×800 (or 640×400) of the capture popup.
- **440×280** small promo tile.
