# lcwo-tools

A Chrome extension for one job: ticking LCWO's custom-character checkboxes
from a pasted list.

`lcwo.net/cwsettings` lays its ~150 character boxes out in **Koch order**, not
alphabetical, so setting a practice set by hand means hunting for each one.
This takes the list `make trouble LIST=1` prints and does it in a click.

## Install

Chrome doesn't allow installing an unpacked extension from a file, so:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this `lcwo-tools/` directory
   (the sources load as they are; `dist/` is only for sharing)

It shows up as a dit-dah icon; pin it if you want it on the toolbar.

## Use

```
$ make trouble PB=1        # ...and it is on your clipboard
L,F,U,D,H,Y,Z,B,G,P,Q
```

Click the extension, paste, **Apply**. What happens next depends on where you
are:

| You are on | Apply does |
|---|---|
| `lcwo.net/cwsettings` | ticks, saves, leaves you on the form |
| any other LCWO page | goes to the settings, ticks, saves, returns you to the page you were on |
| anywhere else | uses an LCWO tab already open in that window, or opens one, then ticks, saves and lands it on Code Groups |

Every route saves — you never have to click Submit yourself. The tab you were
on is only ever navigated if it was already an LCWO page; from anywhere else
the work happens in some other LCWO tab, so a page that merely *looks* like
LCWO (`evil-lcwo.net`) is never scripted at all. If you already have LCWO open
somewhere in that window it reuses that tab rather than stacking up another
copy, preferring one already sitting on the settings page.

So from **Code Groups**: paste, Apply, and you are back on Code Groups a second
later with the new character set live.

The popup closes as soon as the tab navigates — that is Chrome dismissing it,
not a bug — so the work runs in the service worker and the outcome lands on the
**toolbar badge**: `…` while it works, then a blue `✓` that blinks for a second
and goes. A red `!` means something went wrong and stays until you open the
popup, which shows the full message and clears it.

- **Untick everything else** (on by default) makes the page match your list
  exactly. Turn it off to add to what's already selected.
- **Read page** goes the other way: fills the box with what's currently ticked,
  so you can see or keep a set.
- Characters not on the page are reported rather than silently dropped.
- Every route **reads the saved page back** before going anywhere. If what came
  back is not what you asked for, it says so and leaves you on the settings
  page rather than claiming success.

## Permissions

`activeTab`, `scripting`, `storage`, and host access to `https://lcwo.net/*`
and `https://www.lcwo.net/*`.

The host permissions are what let the round trip keep working across the
navigations it makes (settings → save → back), and what let it find an LCWO tab
already open; `activeTab` alone is scoped to the page you clicked on. They are
limited to LCWO over HTTPS, and the URL check is anchored, so a lookalike like
`evil-lcwo.net` is refused rather than scripted.
`storage` is local only — it remembers your last list so the popup reopens
where you left it. Nothing leaves your machine.

## What this is becoming

Today this extension does one job. It is being grown into the whole tool -
recording runs straight off the LCWO page, keeping them in IndexedDB, and
building the report and the trouble lists in the popup - so that using it
needs nothing but a browser. The CLI stays as the reference implementation
the port is checked against, and as the way in and out of a plain file.

The port is in steps, each one usable on its own:

1. **the core and the store** - grading, rollups, practice generators, data
   layer. Done; no UI, but every check the CLI's selftest runs now runs here.
2. **import** - `lcwo.py export` into IndexedDB, so the rest is built against
   real practice data rather than fixtures.
3. **the report** - as an extension page reading IndexedDB, live instead of a
   generated file.
4. **trouble and practice** in the popup, wired straight into the applier
   below, so the list never has to be copied anywhere.
5. **capture** - buttons on `/groups` that record a run, and picking up LCWO's
   own grading when you submit.
6. **export**, and a note in the popup of how long since the last one.

## Layout

| | |
|---|---|
| `src/core/` | grading, rollups, practice, timestamps. Pure functions, no storage and no DOM |
| `src/data/` | `schema.js` the record shapes, `store.js` every query as logic over plain records, `idb.js` the IndexedDB plumbing |
| `src/ext/` | the extension itself: `page.js`, `background.js`, `popup.js`, `popup.html` |
| `test/` | the checks, and an in-memory backend to run them against |
| `build.js` | run the checks, then zip for sharing |

Two splits are load-bearing.

**The grading core touches nothing.** It takes arrays and returns numbers, so
the same functions run over a live database, an import or a test fixture.
Grading is also never stored - a run keeps only what you typed and the session
keeps the key - so fixing a grading bug re-grades your whole history instead
of leaving old sessions wrong for ever.

**The store does not know what IndexedDB is.** It talks to the five-method
backend described in `schema.js`, which means all of it runs under node
against an in-memory backend. `idb.js` is the only file that needs a browser,
and there is deliberately almost nothing in it.

Each module reads its dependencies through `require` under node and off
`self.LCWO` in a page, so the same files load both ways with no bundler.
`src/ns.js` creates that namespace and has to be the first script loaded.

## Files

| | |
|---|---|
| `src/ext/page.js` | the functions that run *inside* the LCWO page, plus the URL routing |
| `src/ext/background.js` | the service worker: navigate → tick → save → verify → return |
| `src/ext/popup.js` | the popup, kept thin because it gets dismissed mid-flight |
| `src/ext/popup.html` | markup and styles |

The split matters. `chrome.tabs.update` on the active tab dismisses the popup,
and a dismissed popup takes its JavaScript with it — driven from there, the
round trip died right after the first navigation and left you on the settings
page with nothing ticked. Anything that outlives a navigation belongs in the
worker.

## Tests and builds

```
node lcwo-tools/test/run.js          # everything
node lcwo-tools/test/run.js core     # just one file
make test                            # with the Python checks as well
make build                            # checks, then dist/lcwo-tools-<version>.zip
```

`make build` will not produce a zip if a check fails. A release that fails its
own grading checks would hand somebody wrong numbers about their own copy,
which is worse than no release. Development does not need a build at all -
load this directory unpacked and reload after an edit.

The page-side functions are plain, self-contained functions (`chrome.scripting`
serialises them into the page, so they cannot close over anything) and the test
runs them against a small DOM shim built from the real markup — including the
awkward bits: `charquot` for `"`, Cyrillic that must not collide with Latin,
the unrelated inputs sitting among the checkboxes, and the character boxes
sitting *outside* the `<form>`.

That last one is worth knowing about: LCWO closes `</form>` before the table
cell holding the character checkboxes, so by the DOM those boxes have no form
owner and a plain submit would leave them out of the POST. Before clicking
Submit the extension gives the form an id and sets `form="..."` on any box that
is not already owned. Boxes the form does own are untouched, so this quietly
becomes a no-op if LCWO ever fixes the markup.
