# vaft

Continuation of the `vaft` ad-blocking userscript from
[pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions)
(archived 2026-03-05). History has been filtered to only the commits that
touched the `vaft/` folder in the original repo.

`vaft` intercepts Twitch's player worker and GQL requests at page-load time,
tries to fetch a clean (ad-free) stream, and falls back to stripping ad
segments from the HLS manifest when it can't.

## Files

- `vaft.user.js` — userscript for Tampermonkey / Violentmonkey.
- `vaft-ublock-origin.js` — same logic packaged as a uBlock Origin resource.

## Applying (userscript)

Open `vaft.user.js` in a browser with a userscript manager installed and
confirm the install prompt.

## Applying (uBlock Origin)

- uBlock Origin dashboard → `My filters` → add `twitch.tv##+js(twitch-videoad)`
- `Settings` → enable `I am an advanced user` → set `userResourcesLocation`
  to the local/raw URL of `vaft-ublock-origin.js`
- Restart the browser / toggle the extension so uBlock reloads resources

## Known issues (inherited from upstream)

- Freezing / buffering / repeating segments around ad transitions — see the
  `PlayerBuffering*` options in `vaft.user.js`.
- Streams can appear "offline" during ad breaks.
- No mobile (`m.twitch.tv`) support.

## Status

Twitch changes its player/GQL internals periodically, which breaks scripts
like this one — expect ongoing maintenance rather than a one-time fix.
