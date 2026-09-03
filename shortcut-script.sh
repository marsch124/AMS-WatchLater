# AMS WatchLater — the body of the "Add to WatchLater" shortcut.
# Kept here so the shortcut can be rebuilt from source if it is ever lost.
ENGINE="http://127.0.0.1:7821"
APPDIR="$HOME/Documents/01 Leisure/30 App Development/AMS WatchLater"
LOG="$HOME/Library/Logs/AMS-WatchLater.log"

URL=$(osascript <<'EOS' 2>/dev/null
set u to ""
try
	if application "Safari" is running then
		tell application "Safari"
			if (count of windows) > 0 then set u to (URL of current tab of front window) as text
		end tell
	end if
end try
if u is "" then
	try
		if application "Google Chrome" is running then
			tell application "Google Chrome"
				if (count of windows) > 0 then set u to (URL of active tab of front window) as text
			end tell
		end if
	end try
end if
return u
EOS
)

note () {
	# A video title can contain quotes, so escape before it goes into osascript.
	SAFE=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
	osascript -e "display notification \"$SAFE\" with title \"AMS WatchLater\"" >/dev/null 2>&1
}

if [ -z "$URL" ]; then
	note "No page open in Safari or Chrome."
	exit 0
fi

# Start the engine if it is not already up, then wait for it.
if ! curl -s --max-time 1 "$ENGINE/health" >/dev/null 2>&1; then
	/usr/local/bin/node "$APPDIR/server.js" >> "$LOG" 2>&1 &
	for i in $(seq 1 40); do
		curl -s --max-time 1 "$ENGINE/health" >/dev/null 2>&1 && break
		sleep 0.25
	done
fi

ANSWER=$(curl -s --max-time 30 -G --data-urlencode "url=$URL" --data-urlencode "fmt=text" "$ENGINE/api/add")
[ -z "$ANSWER" ] && ANSWER="Could not reach the engine"
note "$ANSWER"
echo "$ANSWER"
