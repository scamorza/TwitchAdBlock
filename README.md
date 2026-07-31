# vaft — Twitch ad blocking userscript

A maintained fork of the `vaft` script from
[pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions),
kept in userscript form only. It tries to get you a clean stream as fast as it
can, and strips ad segments from the playlist when it can't.

## Install

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/)
   or [Violentmonkey](https://violentmonkey.github.io/).
2. Open
   [`vaft.user.js`](https://github.com/scamorza/TwitchAdBlock/raw/master/vaft.user.js).
   The manager will prompt you to install it.

Updates are automatic: the script declares `@updateURL`, so the manager pulls
new versions on its own update schedule.

**If you already have another script from the TwitchAdSolutions family,
remove it first.** This fork resets its own version counter, so an older
script can take priority and silently disable this one. You will see it in the
console as `[VAFT] skipping vaft as there's another script active`.

## How it works

Twitch stitches ads into the same HLS playlist as the stream, so there is no
request to block. `vaft` hooks `window.Worker` and `window.fetch`, then works
on the playlist itself:

- It requests playback access tokens under a different player type
  (`ForceAccessTokenPlayerType`, `BackupPlayerTypes`), because those streams
  frequently come back without ads.
- If every fallback still contains ads, `IsAdStrippingEnabled` removes the ad
  segments (`AdSignifier`) from the M3U8 and serves the stream without them.
- Around the transition it can pause/play or reload the player
  (`ReloadPlayerAfterAd`, `AlwaysReloadPlayerOnAd`) and mitigate a player that
  gets stuck buffering (`PlayerBufferingFix`).

## Why this fork

Supporting creators is fair, whether that means watching a few ads or
subscribing to skip them. It stops being fair when the ad load makes streams
unwatchable — viewers should be encouraged to support a creator, not worn down
into subscribing. That is the reason this project is still maintained.

Scope is deliberately narrower than upstream: only `vaft`, only as
`vaft.user.js`. The uBlock Origin variant and the other tools from the
original repository (`strip`, `video-swap-new`) are not part of this fork for
now.

## Configuration

All options live in `declareOptions()` at the top of `vaft.user.js`. Edit the
installed script in your userscript manager.

| Option | Default | What it does |
| --- | --- | --- |
| `PreventAutoDownscale` | `true` | Asks Twitch for the highest available quality and stops it downscaling a backgrounded tab. See below. |
| `IsAdStrippingEnabled` | `true` | Strip ad segments when no clean stream could be obtained. |
| `ReloadPlayerAfterAd` | `true` | Reload the player when the break ends instead of pause/play. |
| `AlwaysReloadPlayerOnAd` | `false` | Pause/play on both entering and leaving a break. |
| `SkipPlayerReloadOnHevc` | `false` | Skip the reload on 2k/4k streams. Enable if you get error #4000 / #3000 or a spinning wheel. |
| `PlayerBufferingFix` | `true` | Detect a player stuck buffering and pause/play it. |
| `ForceAccessTokenPlayerType` | `'popout'` | Player type sent in the `PlaybackAccessToken` request. |
| `BackupPlayerTypes` | `embed`, `popout`, `autoplay` | Player types tried, in order, when looking for an ad-free stream. |
| `FallbackPlayerType` | `'embed'` | Used when every backup type still has ads. |

Buffering behaviour can be tuned further with `PlayerBufferingDelay`,
`PlayerBufferingSameStateCount`, `PlayerBufferingMinRepeatDelay`,
`PlayerBufferingDangerZone`, `PlayerBufferingDoPlayerReload`,
`PlayerBufferingPrerollCheckEnabled` / `PlayerBufferingPrerollCheckOffset`,
and — for when the mitigation turns out to be achieving nothing —
`PlayerBufferingEscalateAfter`, `PlayerBufferingMaxIneffectiveAttempts` and
`PlayerBufferingIneffectiveBackoff`. Recovering a player left paused by our own
pause/play is controlled by `PlayerResumeVerify` and its `Delay`, `Attempts` and
`MaxWaits` counterparts, and `ResumeOnTabFocus` covers a player found paused
when you come back to the tab. Each one is documented inline in the script.

### PreventAutoDownscale (background video quality)

Twitch lowers the stream quality when it decides you are not actively
watching, and switching to another tab is enough: the stream drops to 360p
until you come back. It reaches that conclusion two ways — page visibility,
and `document.hasFocus()`.

`vaft` has always hidden page visibility from Twitch. `PreventAutoDownscale`,
ported from CommanderRoot's "Disable automatic video downscale", covers the
rest: it answers `hasFocus()` as always `true` and turns on Twitch's own
`video-quality-highest-available` setting, so the quality follows whatever the
channel offers rather than a fixed resolution. A side effect is that Drops
keep progressing with the tab in the background and the audio muted.

On a 2k/4k channel the highest variant is the HEVC one, which is also what
triggers the player reload at ad breaks — see `SkipPlayerReloadOnHevc` if that
causes trouble.

Setting the option to `false` restores the real `hasFocus()` and leaves only
the ad blocking behaviour. It does not restore page visibility: `vaft` hides
that from everything running on the page, so extensions that react to it —
BetterTTV's "Mute Invisible Player", for one — stay inert either way.

## Reading the console

Every message is prefixed with `[VAFT]`, so filtering on that in DevTools
shows exactly what the script is doing. The lines worth knowing:

| Line | Meaning |
| --- | --- |
| `Blocking…` / `Finished blocking ads` | An ad break was detected and handled. |
| `ModifiedM3U8 fallback now in use …` | On a 2k/4k channel, the HEVC variant was swapped for a non-HEVC one so the player can be reloaded during the break. |
| `Reloading Twitch player` | A player reload was triggered. |
| `Attempt to fix buffering position:` | `PlayerBufferingFix` stepped in. |
| `Player state unchanged after … backing off` | The mitigation had no effect at all, so it stops retrying every few seconds and drops to one reload per minute. |
| `Player still paused after our own resume` | A pause/play or reload left the player paused and the script is getting it going again. |
| `Tab focused with the video paused, resuming` | You came back to the tab and the player was sitting paused, usually because it was still starting up — after a page load or the reload at the end of an ad break. |
| `play() rejected after …` | The resume did not complete. `AbortError` is the player taking over and finishing the job itself, which is normal here; `NotAllowedError` would mean the browser's autoplay policy blocked it. |
| `Replaced 'site' player type with 'popout' player type` | `ForceAccessTokenPlayerType` rewrote the token request. |
| `hookWorkerFetch` | Printed from inside each Twitch worker. More than one is normal. |
| `Twitch worker #N created in top frame` | Twitch creates one worker per player instance; a second one at startup is the mini player above chat, and every player reload adds another. |
| `Denied picture-by-picture access token locally for …` | The mini player in the chat column is being suppressed. Twitch asks for this token roughly every 8 minutes whether it is granted or not, so the line repeating is normal. |
| `skipping vaft in nested frame` | The script stayed out of one of Twitch's hidden iframes. |
| `skipping vaft as there's another script active` | Another TwitchAdSolutions script is installed — remove it. |
| `Ads will leak due to missing resolution info for …` | No ad-free variant could be matched for that resolution. |
| `setQualitySettings failed` / `localStorageHooks failed` | `localStorage` was not writable; `PreventAutoDownscale` and the quality/volume preservation are degraded. |
| `Could not find player` / `player state` / `react root` | Twitch changed its internals — likely the script needs an update. |

When opening an issue, this output is what makes a report actionable. Please
do not attach HAR files or `chrome://net-export` captures: they contain your
session tokens.

## Known issues (inherited from upstream)

- Freezing / buffering / repeating segments around ad transitions — see the
  `PlayerBuffering*` options
  ([#1](https://github.com/scamorza/TwitchAdBlock/issues/1)).
- Streams can appear "offline" during ad breaks
  ([#2](https://github.com/scamorza/TwitchAdBlock/issues/2)).
- No mobile (`m.twitch.tv`) support — out of scope for this fork, so there is
  no issue tracking it.

## Project status

Twitch periodically changes its player and internal APIs, which breaks
scripts like this one — expect ongoing maintenance, not a one-time fix.

## Credits and licence

Thanks to [pixeltris](https://github.com/pixeltris) for `vaft` and for every
other tool in the original repository, and to
[CommanderRoot](https://github.com/CommanderRoot) for the automatic downscale
script that `PreventAutoDownscale` is based on. MIT licensed, see
[`LICENSE`](LICENSE).

## Disclaimer

Twitch does not approve of or endorse ad-blocking tools like this one, and
using it goes against their Terms of Service. Using `vaft` is entirely at
your own risk, including the possibility of account suspension or a ban.
This project is provided "as is", with no warranty of any kind — the
author(s) take no responsibility for any consequences, direct or indirect,
resulting from its use.
