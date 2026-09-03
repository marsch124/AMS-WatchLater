#!/bin/bash
# Rebuilds both app bundles from source.
#
# The .app bundles are not kept in git — they are signed binaries and git
# does not carry them intact. Everything needed to recreate them is: this
# script, the two .applescript files, and the two .icns icons.
#
# A bundle MUST carry a real CFBundleIdentifier and be signed, or macOS
# cannot remember its permissions and the app hangs forever on first launch.
set -e
cd "$(dirname "$0")"

build () {
  local app="$1" src="$2" bid="$3" name="$4" icns="$5"
  rm -rf "$app"
  /usr/bin/osacompile -o "$app" "$src"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $bid" "$app/Contents/Info.plist" >/dev/null 2>&1 || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bid" "$app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleName string $name" "$app/Contents/Info.plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Set :NSAppleEventsUsageDescription AMS WatchLater reads the address of the page you are on, so it can save the video to your list." "$app/Contents/Info.plist"
  cp "$icns" "$app/Contents/Resources/applet.icns"
  # codesign occasionally refuses a freshly written bundle with "resource fork,
  # Finder information, or similar detritus not allowed". Clean and retry rather
  # than abort, or set -e kills the run and the second app never gets built.
  xattr -cr "$app"
  if ! codesign --force --deep --sign - "$app" 2>/dev/null; then
    sleep 1
    xattr -cr "$app"
    codesign --force --deep --sign - "$app"
  fi
  codesign --verify --deep "$app"
  echo "built $app"
}

build "Add to WatchLater.app" add.applescript      com.ams.watchlater.add "Add to WatchLater" watchlater-add.icns
build "AMS WatchLater.app"    launcher.applescript com.ams.watchlater.hub "AMS WatchLater"    watchlater.icns
build "AMS WatchLater Engine.app" engine.applescript com.ams.watchlater.engine "AMS WatchLater Engine" watchlater.icns
echo "Done. Both apps will ask for permission once on first launch."
