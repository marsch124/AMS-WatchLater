-- AMS WatchLater Engine — starts the engine at login, quietly.
--
-- Same shape as AMS Finance Engine.app: an AppleScript applet, because a
-- bash-script .app gets silently TCC-denied for Documents and a plain
-- LaunchAgent has no bundle identity for macOS to hang a permission on.
-- Opens no window and no browser; it only makes sure the engine is up.

on run
	set appDir to (do shell script "dirname " & quoted form of (POSIX path of (path to me)))
	set logFile to (POSIX path of (path to home folder)) & "Library/Logs/AMS-WatchLater.log"
	try
		do shell script "/usr/bin/curl -s --max-time 1 http://127.0.0.1:7821/health >/dev/null && echo yes"
		return
	end try
	do shell script "/usr/local/bin/node " & quoted form of (appDir & "/server.js") & " >> " & quoted form of logFile & " 2>&1 &"
end run
