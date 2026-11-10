#!/bin/bash
# Start the CLO Atelier bridge on macOS without pasting anything by hand.
#
# It launches CLO if needed, opens Edit > Python Script, pastes the one-line
# loader into the editor and presses Run, by sending clicks and keystrokes
# through System Events. macOS will ask you to allow your terminal under
# System Settings > Privacy & Security > Accessibility the first time.
#
# It replaces whatever text is in CLO's Python editor, and it uses the
# clipboard for a moment (your clipboard is put back afterwards).
set -u

DIR="$HOME/.clo-mcp"
STATE="$DIR/bridge.json"
BRIDGE="$DIR/clo_mcp_bridge.py"
LOADER='import os; exec(open(os.path.expanduser("~/.clo-mcp/clo_mcp_bridge.py")).read())'

if [ ! -f "$BRIDGE" ]; then
  echo "Bridge script not found at $BRIDGE. Start your MCP client once so the server can install it." >&2
  exit 1
fi

clo_pid() { pgrep -f '/CLO[^/]*\.app/Contents/MacOS/' | head -1; }

PID="$(clo_pid)"
if [ -f "$STATE" ]; then
  if [ -n "$PID" ] && grep -q "\"pid\": $PID[,}]" "$STATE"; then
    echo "The bridge is already running in CLO (pid $PID)."
    exit 0
  fi
  rm -f "$STATE"   # left over from a CLO session that has ended
fi

if [ -z "$PID" ]; then
  APP="$(ls -d /Applications/CLO*.app 2>/dev/null | sort | tail -1)"
  if [ -z "$APP" ]; then
    echo "CLO is not running and no CLO application was found in /Applications." >&2
    exit 1
  fi
  echo "Starting $(basename "$APP")..."
  open -a "$APP"
fi

# Wait until CLO's main menu is there (it appears after login and loading).
for _ in $(seq 1 90); do
  PID="$(clo_pid)"
  if [ -n "$PID" ] && osascript -e "tell application \"System Events\" to tell (first process whose unix id is $PID) to return name of every menu bar item of menu bar 1" 2>/dev/null | grep -q "Edit"; then
    break
  fi
  sleep 2
done
if [ -z "$PID" ]; then
  echo "CLO did not start." >&2
  exit 1
fi
sleep 4   # the menu bar appears a little before CLO accepts input

OLD_CLIPBOARD="$(pbpaste 2>/dev/null)"
printf '%s' "$LOADER" | pbcopy

RESULT="$(osascript <<APPLESCRIPT 2>&1
tell application "System Events" to tell (first process whose unix id is $PID)
  set frontmost to true
  delay 0.5
  -- Opening the editor from the menu is harmless when it is already open. Its
  -- untitled window exists even while hidden, so its presence proves nothing.
  click menu item "Python Script" of menu 1 of menu bar item "Edit" of menu bar 1
  delay 2
  set editor to first window whose name is ""
  set {x, y} to position of editor
  click at {x + 300, y + 250}
  delay 0.4
  keystroke "a" using command down
  keystroke "v" using command down
  delay 0.8
  click at {x + 91, y + 52}
end tell
return "ok"
APPLESCRIPT
)"
printf '%s' "$OLD_CLIPBOARD" | pbcopy

if [ "$RESULT" != "ok" ]; then
  echo "Could not drive CLO's Python editor: $RESULT" >&2
  echo "Allow your terminal under System Settings > Privacy & Security > Accessibility, or paste this into Edit > Python Script and press Run:" >&2
  echo "  $LOADER" >&2
  exit 1
fi

for _ in $(seq 1 20); do
  if [ -f "$STATE" ]; then
    echo "The bridge is running in CLO."
    exit 0
  fi
  sleep 1
done
echo "CLO did not report the bridge as started. Check the Python editor's output, or paste this there and press Run:" >&2
echo "  $LOADER" >&2
exit 1
