-- Add to WatchLater — saves the page you are on to your list.
--
-- Lives in ~/Applications so Raycast, Alfred and Spotlight rank it as an app.
-- Needs nothing from Documents: if the engine is not running it asks macOS to
-- launch the Engine app by its bundle id, wherever that app happens to live.
-- The only permission it ever needs is reading the address of the Safari tab.

on run
	set engine to "http://127.0.0.1:7821"

	set theURL to ""
	try
		if application "Safari" is running then
			tell application "Safari"
				if (count of windows) > 0 then set theURL to (URL of current tab of front window) as text
			end tell
		end if
	end try
	if theURL is "" then
		try
			if application "Google Chrome" is running then
				tell application "Google Chrome"
					if (count of windows) > 0 then set theURL to (URL of active tab of front window) as text
				end tell
			end if
		end try
	end if
	if theURL is "" then
		display notification "No page open in Safari or Chrome." with title "AMS WatchLater"
		return
	end if

	set engineUp to "no"
	try
		do shell script "/usr/bin/curl -s --max-time 1 " & engine & "/health >/dev/null && echo yes"
		set engineUp to "yes"
	end try
	if engineUp is not "yes" then
		try
			do shell script "/usr/bin/open -g -b com.ams.watchlater.engine; for i in $(seq 1 40); do /usr/bin/curl -s --max-time 1 " & engine & "/health >/dev/null && exit 0; sleep 0.25; done; exit 0"
		end try
	end if

	set answer to "Could not reach the engine"
	try
		set answer to do shell script "/usr/bin/curl -s --max-time 30 -G --data-urlencode " & quoted form of ("url=" & theURL) & " --data-urlencode " & quoted form of "fmt=text" & " " & engine & "/api/add"
	end try
	display notification answer with title "AMS WatchLater"
end run
