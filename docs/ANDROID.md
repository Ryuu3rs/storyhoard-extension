# Firefox for Android

The StoryHoard mobile app is the supported phone client. This page covers the browser
extension on Firefox for Android, which is **not an official target**.

## Status

- The extension is built and tested for desktop Firefox and Chromium. Its Firefox manifest
  does not declare Firefox for Android (no `gecko_android`).
- It may still install and partly work there: Firefox for Android runs the same
  `firefox-mv3` build, and the dashboard and popup have had a pass for narrow screens.
  Nothing on Android is tested before a release.
- Known gaps: **Search the web** is hidden (Firefox for Android has no search API), and
  site access may not grant cleanly on a fresh install, so update checks and detection can
  fail on sites other than the official sources.

## Testing a local build

Enable **USB debugging** in Android developer options, connect the phone to a desktop,
then on the desktop open `about:debugging` → **This Firefox** (select the connected
device) → **Load Temporary Add-on** and pick a file from
`apps/extension/.output/firefox-mv3/`. Temporary add-ons are removed when Firefox
restarts, so re-load after each restart.

## Testing checklist

- [ ] Dashboard library renders and the poster grid reflows to the narrow layout.
- [ ] Search finds a title and its page shows where to read it.
- [ ] Opening a chapter opens it on the source's own page in a new tab.
- [ ] GitHub Gist sync (push/pull) completes.
- [ ] The popup appears and detects an official source page.
