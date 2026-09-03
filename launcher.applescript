-- AMS WatchLater — opens your list.
-- Lives in ~/Applications. Needs no permissions at all: it only checks the
-- engine, launches the Engine app by bundle id if needed, and opens Safari.

on run
	set engine to "http://127.0.0.1:7821"
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
	do shell script "/usr/bin/open http://localhost:7821"
end run
