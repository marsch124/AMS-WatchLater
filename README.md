# AMS WatchLater

A read-later list for YouTube. Mac only, no account, no sync, nothing uploaded.

**Runs at** http://localhost:7821 · **Version** 1.1

---

## The pieces

| | What it does |
|---|---|
| **AMS WatchLater.app** | Opens the list. Starts the engine first if it is not running. |
| **Add to WatchLater.app** | Keep in the Dock. One click saves the page you are on. |
| **Add to WatchLater.shortcut** | Import once, then give it a key combination. Same thing, no mouse. |

## Four ways to get a video in

1. **Keyboard shortcut** — the fastest, and the one worth building a habit around.
2. **Dock button** — click *Add to WatchLater* while a video is open.
3. **Paste** — one link or fifty, one per line. This empties a window of tabs in one go.
4. **Drag and drop** a link onto the window.

All four start the engine themselves if it is not already running.

## First run asks two permission questions

The first click on *Add to WatchLater* shows two standard macOS dialogs:

- **"Add to WatchLater wants to control Safari"** → **OK**. This is how it reads the address of the page you are on, and the address is all it reads.
- **A Documents folder question** → **Allow**. The engine lives in Documents.

Both are one-time. Afterwards the button is silent and instant.

If you click Don't Allow by mistake: **System Settings → Privacy & Security → Automation**, and switch Safari back on under *Add to WatchLater*.

## The time buttons

The row across the top is the point of the app. Click **20 min** and you see only videos that fit in twenty minutes — the question you actually ask, rather than "what did I save on Tuesday". Lengths arrive by themselves: the engine reads them off the YouTube page.

## Nothing rots quietly

Anything untouched for three months turns amber and asks whether you still want it. **Keep** gives it another three months; the bin removes it.

---

## Where things live

```
server.js            the engine (plain Node, no dependencies)
index.html           the page
add.applescript      source for the Dock button
launcher.applescript source for the list app
shortcut-script.sh   the body of the keyboard shortcut
build-apps.sh        rebuilds both .app bundles from the above
icon-generator.py    regenerates both icons
watchlater.json      your list          (not in git)
thumbs/              one jpg per video  (not in git)
backups/             dated copies       (not in git)
```

Restore by putting a dated backup in place of `watchlater.json`.

## About the repository

**This repo is public, so your list is not in it.** `watchlater.json`, `thumbs/` and `backups/` are
gitignored and stay on this Mac only. Nothing committed contains a username or a personal path —
the apps work out their own location, and the shortcut uses `$HOME`.

The `.app` bundles are also excluded: they are signed binaries that git does not carry intact.
`./build-apps.sh` rebuilds both from the `.applescript` files and the icons.

---

## Notes for whoever works on this next

**Port 7821, and the port matters.** A stale **AMS Main Hub v1.15 service worker** was found registered at
`http://localhost:7796/` — it owned that whole origin and served the Main Hub's cached page instead of this
app, failing every API call. Any localhost port an AMS PWA has ever used can be squatted this way, and the
symptom looks exactly like a broken app. 7821 is used by nothing else, and `index.html` unregisters any stray
worker on sight and reloads once, so this app cannot be hijacked again.

**The apps need a bundle identifier.** `osacompile` produces an applet with an empty `CFBundleIdentifier`,
and TCC identifies apps by bundle id — so macOS could never grant stable permission and the app just hung in
`AESendMessage`. Both are ad-hoc signed with real ids, matching how *AMS Finance.app* is built. **Re-sign after
any change to a bundle** (`build-apps.sh` does it), or the permission grant breaks.

**The launcher must stay an AppleScript applet.** A bash-script `.app` gets silently TCC-denied for Documents
with no prompt, ever.

**There is no `runapplescript` Shortcuts action.** Only `is.workflow.actions.runshellscript` exists on this
macOS. A shortcut built around the former imports as an unknown action. Rebuild the shortcut from
`shortcut-script.sh` with `shortcuts sign --mode anyone`.

**Why there is a server at all.** The YouTube watch page carries the duration (`"lengthSeconds":"213"`) but
sends no CORS header, so a page script can never read it. Node has no such limit. That is the whole reason
this is not a plain PWA — and it means no API key and nothing secret in this repo.

**Thumbnails really can be stored.** Unlike Amazon's CDN in AMS PackTrack, `i.ytimg.com` sends
`access-control-allow-origin: *`, so every thumbnail is downloaded and kept locally. ~20 KB each.

**Dead links are refused, not saved.** An unavailable video id fails every lookup, and the engine says
"Could not read that link" rather than parking a blank card with no title, picture or length.

**Backups refuse to shrink.** Today's backup will not overwrite a fuller copy from the same day, so an empty
snapshot cannot replace a good list. The live store is still free to shrink, because deleting a video is a
legitimate shrink.

**The version badge reads the app, not the file.** `/api/list` overrides the version stamped in
`watchlater.json` with `APP_VERSION`, or a new release keeps displaying the old number.

---

## Version history

### v1.1 — 3 September 2026
- A keyboard shortcut that saves the current video from anywhere.
- Both apps work out their own location instead of carrying a fixed path.
- Fuller in-app *How this works* and a version history with benefits.
- Fixed: the version badge showed the data file's version, not the app's.

*Why it helps:* reaching for the Dock still breaks attention. A key combination does not, so saving costs
nothing and actually happens. Self-locating apps mean the folder can move, and no personal path sits in the repo.

### v1.0 — 3 September 2026
- One-click Dock capture, paste-many, drag-and-drop.
- Title, channel, thumbnail and real length fetched automatically, no account or key.
- The time-bucket row; three-month aging nudge with Keep; watched list.
- Thumbnails stored locally; dated self-checking backups.

*Why it helps:* videos were never lost for lack of storage — saving one cost more than it was worth in the
moment, so a tab stayed open and became noise. Capture costs one click here, and because every video arrives
with its real length the list can answer the only question ever asked of it: what fits in the time I have.
