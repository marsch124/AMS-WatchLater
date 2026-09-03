-- AMS WatchLater — opens the list, starting the engine first if needed.

on run
	-- The applet sits inside the app folder, so it can work out where it lives.
	-- Nothing is hardcoded, which keeps a username out of the repository.
	set appDir to (do shell script "dirname " & quoted form of (POSIX path of (path to me)))
	set engine to "http://127.0.0.1:7821"
	set logFile to (POSIX path of (path to home folder)) & "Library/Logs/AMS-WatchLater.log"

	try
		do shell script "/bin/ls " & quoted form of appDir & " >/dev/null"
	end try

	set running to "no"
	try
		do shell script "/usr/bin/curl -s --max-time 1 " & engine & "/health >/dev/null && echo yes"
		set running to "yes"
	end try
	if running is not "yes" then
		do shell script "/usr/local/bin/node " & quoted form of (appDir & "/server.js") & " >> " & quoted form of logFile & " 2>&1 & for i in $(seq 1 40); do /usr/bin/curl -s --max-time 1 " & engine & "/health >/dev/null && exit 0; sleep 0.25; done; exit 0"
	end if

	do shell script "/usr/bin/open http://localhost:7821"
end run
