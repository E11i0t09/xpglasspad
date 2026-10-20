XPGlassPad – G1000 / GNS 430 / GNS 530 touch bezel for X-Plane 12
https://github.com/E11i0t09/xpglasspad

INSTALL
  Put this folder at  X-Plane 12/Resources/plugins/XPGlassPad/
  Start X-Plane. Allow the firewall prompt for private networks (Windows).
  Log.txt shows the address, e.g.  XPGlassPad: open on iPad:  http://192.168.1.20:8090/
  Open it in Safari on the tablet -> Share -> Add to Home Screen.

CONTROLS
  Key        tap = press, hold > 0.5 s = press and hold (e.g. CLR = default map)
  Dual knob  circle on outer ring = large knob, circle in centre = small knob, tap = push
  RANGE      circle = zoom, tap = push pan, hold + drag = pan (G1000)
  Menu       small bar at the top centre

SETTINGS      config.ini
DIAGNOSTICS   http://<PC-IP>:8090/api/status   and  "XPGlassPad:" lines in Log.txt

macOS: if Gatekeeper blocks the plugin:
  xattr -dr com.apple.quarantine "<X-Plane 12>/Resources/plugins/XPGlassPad"

License: CC BY 4.0 (c) E11i0t09 – third-party notices in THIRD_PARTY_NOTICES.md
Not affiliated with Garmin or Laminar Research.
