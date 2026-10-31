#!/bin/sh
# Watches the system log for Home button presses and opens Spoke.
# Fallback for TVs where pressing Home doesn't launch com.webos.app.home.

LAUNCHER_ID="${LAUNCHER_ID:-com.oridin.spoke}"
LAUNCHER="${LAUNCHER:-/media/developer/apps/usr/palm/applications/$LAUNCHER_ID}"
LUNA="${LUNA_SEND:-luna-send}"
PIDFILE="${PIDFILE:-/tmp/launcher-homekey-watch.pid}"
LOG="${LOG:-/tmp/launcher-homehook.log}"
SYSLOG="${SYSLOG:-/var/log/messages}"

log () { echo "$(date '+%H:%M:%S') homekey: $*" >> "$LOG"; }

open_launcher () {
    "$LUNA" -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"$LAUNCHER_ID\"}" >/dev/null 2>&1
}

# Only one at a time.
if [ -f "$PIDFILE" ]; then
    other=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$other" ] && [ "$other" != "$$" ] && kill -0 "$other" 2>/dev/null; then
        exit 0
    fi
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"; exit 0' TERM INT

log "started (pid $$)"

last_home=""
while true; do
    line=$(tail -n 20 "$SYSLOG" 2>/dev/null | grep 'KEY_HOME' | tail -n 1)
    if [ -n "$line" ] && [ "$line" != "$last_home" ]; then
        last_home="$line"
        front=$("$LUNA" -n 1 luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>/dev/null)
        case "$front" in
            *"\"appId\":\"$LAUNCHER_ID\""*) ;;
            *)
                [ -f "$LAUNCHER/appinfo.json" ] || continue
                open_launcher
                log "Home pressed (app was: $(echo "$front" | grep -o '"appId":"[^"]*"')): opened Spoke"
                sleep 2
                ;;
        esac
    fi
    usleep 300000 2>/dev/null || sleep 1
done
