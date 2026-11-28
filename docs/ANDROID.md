# Firefox for Android

This page covers the browser extension on Firefox for Android (phones and tablets).

## Status

- The Firefox manifest declares Firefox for Android (`gecko_android`, Firefox 142 or newer),
  so the extension is listed for Android on the Firefox add-ons store and copies there get
  updates from the store.
- Firefox for Android runs the same `firefox-mv3` build, and the dashboard and popup have had
  a pass for narrow screens. Release testing runs on desktop browsers only.
- Known gaps: **Search the web** is hidden (Firefox for Android has no search API), and
  site access may not grant cleanly on a fresh install, so update checks and detection can
  fail on sites other than the official sources.

## Stuck on an old version

Firefox holds back an update that asks for more (a new permission or data type) until you
approve it, on Android and on desktop. If you miss that prompt, the copy stays on the old
version. When a version has been out for a day and a half and your copy is still older, the
app shows **Finish update**: it opens StoryHoard's page on the Firefox add-ons store, and
Firefox asks you to approve the new version there. Without that banner, open
`addons.mozilla.org/android/addon/storyhoard/` in Firefox and tap **Add to Firefox**. Do not
remove the extension first: removing it deletes your library on that device.

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
