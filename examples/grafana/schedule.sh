#!/bin/sh
# The export of the measures on a schedule (macOS, launchd): once an hour and at the login.
#
#   examples/grafana/schedule.sh install   writes the job to ~/Library/LaunchAgents and starts it
#   examples/grafana/schedule.sh remove    stops the job and removes its file
#   examples/grafana/schedule.sh status    says whether launchd has the job
#
# The job runs `node examples/grafana/export.ts days=90`. When the store does not answer (Docker
# is off), the run ends with `store_unreachable` in the log and the next hour tries again.
set -eu

LABEL=com.reins.measures-export
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/reins-measures-export.log"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE=$(command -v node) || { echo "schedule: node is not on PATH" >&2; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$HERE/export.ts</string>
    <string>days=90</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "schedule: installed $PLIST; the log is $LOG"
    ;;
  remove)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "schedule: removed $PLIST"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|last exit code|run interval" || echo "schedule: launchd has no job $LABEL"
    ;;
  *)
    echo "usage: schedule.sh install|remove|status" >&2
    exit 2
    ;;
esac
