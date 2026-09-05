# TwitchAdBlock

A Twitch ad-blocking userscript. It works on two fronts, because Twitch serves ads two different
ways: it gets you a clean stream when ads are stitched into the playlist, and it stops the browser
from ever requesting the ads that are decided client-side.

Started as a fork of `vaft` from
[pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) and has since been
rewritten around the same core idea. Little of the original code remains; the idea is still his.

## Install

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open
   [`vaft.user.js`](https://github.com/scamorza/TwitchAdBlock/raw/master/vaft.user.js).
   The manager will prompt you to install it.

Updates are automatic: the script declares `@updateURL`, so the manager pulls new versions on its
own schedule.

**If you already have another script from the TwitchAdSolutions family, remove it first.** Two of
them will both hook `Worker` and `fetch`. They recognise each other and exactly one runs, but which
one is a race. The console tells you it happened:
`standing down, <marker> is already set -- another ad blocker got here first`.

## How it works

Twitch serves ads two ways, and the script answers each one separately.

**Stitched ads** arrive inside the HLS playlist itself, so there is no request to block. The script
hooks `window.Worker` and `window.fetch` and works on the playlist: when ad markers appear, it asks
for a playback access token under a different player type and serves that stream instead. Player
types are tried in order, and within each one every rung of the quality ladder, so a break where the
top rendition is stitched can still be served from a lower one.

Which request comes back clean is decided by `playerType` + `platform`, the only client-controlled
fields that reach the signed token. `mobile_feed` asked as `android` is both ad-free and uncapped —
1080p on AVC, 1440p on HEVC — so a break served from it costs no rendition change, which is what the
player stalls on. `popout` is the second chance at full quality, since each request is its own ad
auction, and `autoplay` is last: ad-free too, but capped at 640x360.

Swapping the stream is the easy half. The hard half is handing the player back a timeline it still
believes in, and most of the script is that. The two sessions cannot be matched on
`MEDIA-SEQUENCE`: that number is per session and counts ad segments, so an ad-free backup drifts
further from it at every break. They are matched on `EXT-X-TWITCH-LIVE-SEQUENCE` instead, which is
positional and global to the broadcast, so it survives the session reset a stitched ad causes.

Both sessions write into one table indexed on that number, and the playlist the player receives is
built from it rather than passed through. Segments come from the page's own session; the backup
only fills the numbers an ad took away. Timestamps are stamped on a single clock — ours — because
the two sessions label the same content seconds apart, and copying either one makes the timeline
jump at every handover. The low-latency look-ahead follows the same rule with one exception: Twitch
publishes none of it for much of a break, so inside one the backup is the only source that has any.

Ad segments are not removed from the playlist, they are answered with an empty body. Removing them
leaves a playlist with no media at all when every segment is an ad, and the player then runs out of
timeline and Twitch renders the channel as offline. The ad `DATERANGE`s are stripped, though: they
light Twitch's own "ad in progress" overlay whether or not an ad ever plays. When the broadcast
really does end, `EXT-X-ENDLIST` is carried through, so the player stops instead of sitting on a
window that no longer moves.

**Display ads** — the pod above chat, squeezeback, lower third, pause ads — are decided in the
browser, so none of the above ever sees them. Twitch's own ad manager holds every ad request in a
queue and drains it as `declineReason ? decline() : isReady && fn()`, where `fn()` is the fetch to
the ad exchange. Setting `declineReason` stops the request that would have produced the creative —
upstream of the container, not a hidden overlay — using Twitch's own decline path. The **mini player
above chat** is refused separately, by denying its access token locally rather than sending
something the server will reject.

Blocking ads breaks playback in its own ways, so a fair part of the script exists to put it back
together: resuming a stream Twitch paused and will not retry, restoring quality after a break,
reloading a player whose media element was torn down by a decode error, and pulling latency back
down when the player settles further behind live than it needs to be.

## Configuration

`Config` at the top of the script. The defaults are the tested configuration, and every entry left
in it is one you can genuinely turn off — anything that only breaks when touched has been taken out
and made a constant.

The one worth knowing is **`DeclineClientSideAds`**, which is the only thing standing between you
and display ads. **`BackupPlayerTypes`** decides the order the clean stream is looked for in.
**`LogLevel`** is `info` by default; `window.vaft2.setLogLevel('debug')` opens it up for a session
without editing anything. The rest are the recovery watchers and the diagnostics, on by default.

`HideVisibility` and `ResumeOnFocus` are deliberately one switch under two names: reporting the page
visible is what stops Twitch downscaling a background tab, and the resume exists only to pay for the
side effect of that lie. Turning one off without the other leaves a stream that can pause with
nobody coming.

## What to expect

Not defects. These follow from how the thing works.

- **Quality can drop during a break**, but only if `mobile_feed` and `popout` both come back stitched
  and the break falls to `autoplay`, whose ladder Twitch caps at 640x360. Restored when it ends.
- **The picture can freeze for the length of a break**, when no player type comes back clean and
  both sources go quiet. The break is then bridged on the original: empty bodies keep the playlist
  moving so the player does not give up, but nothing new is decoded. It keeps the stream alive,
  not moving.
- **Twitch buffers on its own** around any discontinuity, so a baseline of stalling survives whatever
  the script does.
- **No mobile** (`m.twitch.tv`), and no plans for it.

## Why

Supporting creators is fair, whether by watching ads or subscribing to skip them. It stops being
fair when the ad load makes streams unwatchable — viewers should be encouraged to support someone,
not worn down into it.

## Project status

Twitch changes its player and internal APIs regularly, and that breaks scripts like this one. Expect
ongoing maintenance rather than a finished thing.

Where it can, the script avoids depending on things that change for no reason: Twitch's ad manager is
found by the names of its static methods rather than by module id or asset hash, so a rebuild does
not break it. Other places have no such option and are matched by value — the `stitched` marker in
the playlist, the React root the player hangs off. Those are the likely breakage points, and they are
the reason the console reports what it did rather than only what failed: a break handled with no
`ad break started` line, or that line without Twitch's own `stitchedadstart` beside it, is how you
find out something drifted before anyone files an issue.

## Credits and licence

Thanks to [pixeltris](https://github.com/pixeltris) for `vaft` and the rest of TwitchAdSolutions —
the approach this is built on is his. Thanks to [CommanderRoot](https://github.com/CommanderRoot),
whose downscale script is where the quality-preference handling originally came from.

MIT licensed, see [`LICENSE`](LICENSE).

## Disclaimer

Twitch does not approve of or endorse ad-blocking tools like this one, and using it goes against
their Terms of Service. Use is entirely at your own risk, including the possibility of account
suspension or a ban. Provided "as is", with no warranty of any kind — the authors take no
responsibility for any consequences, direct or indirect, resulting from its use.
