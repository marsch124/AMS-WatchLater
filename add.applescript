-- Add to WatchLater — the one-click capture.
--
-- Sits in the Dock. Click it while a video is open and the link is sent
-- straight to the engine; nothing opens, nothing steals the screen, the
-- page you were on stays exactly where it was. The engine is started if it
-- is not already running, so this works from cold.

on run
	-- The applet sits inside the app folder, so it can work out where it lives.
	-- Nothing is hardcoded, which keeps a username out of the repository.
	set appDir to (do shell script "dirname " & quoted form of (POSIX path of (path to me)))
	set engine to "http://127.0.0.1:7821"
	set logFile to (POSIX path of (path to home folder)) & "Library/Logs/AMS-WatchLater.log"

	-- Touch the folder first so the Documents permission question, if it is
	-- ever going to be asked, is asked on the very first click.
	try
		do shell script "/bin/ls " & quoted form of appDir & " >/dev/null"
	end try

	-- Safari first: that is the everyday browser here. Chrome is the fallback.
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

	-- Start the engine if it is not up yet, then wait for it.
	set engineUp to "no"
	try
		do shell script "/usr/bin/curl -s --max-time 1 " & engine & "/health >/dev/null && echo yes"
		set engineUp to "yes"
	end try
	if engineUp is not "yes" then
		try
			do shell script "/usr/local/bin/node " & quoted form of (appDir & "/server.js") & " >> " & quoted form of logFile & " 2>&1 & for i in $(seq 1 40); do /usr/bin/curl -s --max-time 1 " & engine & "/health >/dev/null && exit 0; sleep 0.25; done; exit 0"
		end try
	end if

	-- --data-urlencode does the escaping, so a link with & or ? in it is safe.
	set answer to "Could not reach the engine"
	try
		set answer to do shell script "/usr/bin/curl -s --max-time 30 -G " & ¬
			"--data-urlencode " & quoted form of ("url=" & theURL) & " " & ¬
			"--data-urlencode " & quoted form of "fmt=text" & " " & ¬
			engine & "/api/add"
	end try

	display notification answer with title "AMS WatchLater"
end run
