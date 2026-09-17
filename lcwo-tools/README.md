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

It shows up as a dit-dah icon; pin it if you want it on the toolbar.

## Use

```
$ make trouble PB=1        # ...and it is on your clipboard
L,F,U,D,H,Y,Z,B,G,P,Q
```

Open `lcwo.net/cwsettings`, click the extension, paste, **Apply**. Then click
**Submit** on the LCWO page — the extension ticks the boxes, it does not save
for you.

- **Untick everything else** (on by default) makes the page match your list
  exactly. Turn it off to add to what's already selected.
- **Read page** goes the other way: fills the box with what's currently ticked,
  so you can see or keep a set.
- Characters not on the page are reported rather than silently dropped.

## Permissions

`activeTab`, `scripting`, `storage` — and no host permissions, so it can see
nothing at all until you click the icon, and then only the tab you clicked on.
`storage` is local only; it remembers your last list so the popup reopens where
you left it. Nothing leaves your machine.

## Tests

```
node lcwo-tools/test_popup.js     # or `make test` from the parent directory
```

The page-side functions are plain, self-contained functions (`chrome.scripting`
serialises them into the page, so they cannot close over anything) and the test
runs them against a small DOM shim built from the real markup — including the
awkward bits: `charquot` for `"`, Cyrillic that must not collide with Latin,
and the unrelated inputs sitting among the checkboxes.
