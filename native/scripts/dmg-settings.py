"""Headless Finder layout for dmgbuild 1.6.7; no Finder/AppleScript required."""
import os
import plistlib

application = defines["app"]
with open(os.path.join(application, "Contents", "Info.plist"), "rb") as source:
    info = plistlib.load(source)
icon_name = info["CFBundleIconFile"]
if not icon_name.endswith(".icns"):
    icon_name += ".icns"
icon = os.path.join(application, "Contents", "Resources", icon_name)
if not os.path.isfile(icon):
    raise ValueError("The app must contain its compiled .icns icon")

format = "UDZO"
filesystem = "HFS+"
files = [(application, "Shepherd.app")]
symlinks = {"Applications": "/Applications"}
# Do not hide the extension: dmgbuild adds com.apple.FinderInfo to the bundle,
# which codesign --verify --strict rejects as signing detritus.
background = defines["background"]
window_rect = ((200, 200), (660, 400))
# Save a compact installer window with all optional Finder chrome hidden.
# Finder may still override the path bar with the user's global preference.
show_pathbar = False
show_toolbar = False
show_sidebar = False
show_status_bar = False
show_tab_view = False
default_view = "icon-view"
include_icon_view_settings = True
show_icon_preview = False
arrange_by = None
grid_spacing = 80
scroll_position = (0, 0)
label_pos = "bottom"
text_size = 13
icon_size = 128
icon_locations = {"Shepherd.app": (170, 165), "Applications": (490, 165)}
