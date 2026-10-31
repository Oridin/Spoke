#!/bin/sh
# Makes sure the watcher (watch.sh) is running, so that LG Home is replaced by the launcher.
# Safe to run again and again. Prints one word: applied, launcher-missing or files-missing.
# Run at boot by a link in /var/lib/webosbrew/init.d, and by the launcher whenever it opens.

APP_QML="${APP_QML:-/usr/palm/applications/com.webos.app.home/qml}"
HOOK="${HOOK:-/media/developer/launcher-homehook}"
LAUNCHER="${LAUNCHER:-/media/developer/apps/usr/palm/applications/com.oridin.spoke}"
PIDFILE="${PIDFILE:-/tmp/launcher-homehook-watch.pid}"
LOG="${LOG:-/tmp/launcher-homehook.log}"

log () { echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

# Earlier versions put a stand-in over LG Home's QML. Take it off if it is still there.
if [ -z "$DRY_RUN" ]; then
    while grep -q " $APP_QML " /proc/mounts; do
        umount "$APP_QML" || break
    done
fi

# The launcher must be installed (if it was uninstalled, LG Home is left alone).
if [ ! -f "$LAUNCHER/appinfo.json" ]; then
    log "launcher not installed: not starting the watcher"
    echo launcher-missing
    exit 2
fi

if [ ! -f "$HOOK/watch.sh" ]; then
    log "watch.sh missing: not starting the watcher"
    echo files-missing
    exit 4
fi

# Already running?
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "watcher already running (pid $(cat "$PIDFILE"))"
    echo applied
    exit 0
fi

if [ -z "$DRY_RUN" ]; then
    ( nohup sh "$HOOK/watch.sh" >/dev/null 2>&1 </dev/null & )
fi
log "watcher started"
echo applied
