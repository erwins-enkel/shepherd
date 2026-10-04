#!/usr/bin/env bash
# Rebuild the Icon Composer foreground from the shared brand SVG. Xcode renders
# platform masks, Liquid Glass renditions and the macOS 15 fallback at build time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
python3 - "$ROOT" <<'PYTHON'
import json, pathlib, sys, xml.etree.ElementTree as ET

root = pathlib.Path(sys.argv[1])
svg = ET.parse(root / "ui/static/icons/v2/icon-maskable.svg")
ns = "{http://www.w3.org/2000/svg}"
background = svg.getroot().find(ns + "rect")
assert background is not None, "Brand SVG must have a background rectangle"
color = background.attrib["fill"].removeprefix("#")
assert len(color) == 6, "Brand background must be an RGB hex color"
svg.getroot().remove(background)
svg.getroot().set("width", "1024")
svg.getroot().set("height", "1024")
ET.register_namespace("", "http://www.w3.org/2000/svg")
assets = root / "native/Apps/ShepherdMac/Sources/AppIcon.icon/Assets"
assets.mkdir(parents=True, exist_ok=True)
svg.write(assets / "Sheep.svg", encoding="unicode", xml_declaration=False)
with (assets / "Sheep.svg").open("a") as output:
    output.write("\n")
manifest = assets.parent / "icon.json"
icon = json.loads(manifest.read_text())
rgb = [int(color[index:index + 2], 16) / 255 for index in (0, 2, 4)]
icon["fill"] = {"solid": "extended-srgb:" + ",".join(f"{component:.5f}" for component in [*rgb, 1])}
manifest.write_text(json.dumps(icon, indent=2) + "\n")
PYTHON
