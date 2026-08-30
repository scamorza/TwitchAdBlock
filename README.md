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
believes in, and much of the script is that. The backup is a different session: it numbers segments
from its own base and does not count the ads, so what gets served is renumbered onto the numbering
the player already has, live-edge tags included. The distance from the live edge is held steady
across the seam and walked back gradually rather than arriving as one step, which the player would
otherwise chase and drain its buffer for. The original's ad markers are carried onto the clean
playlist so the player still raises its own buffer target during the break, and the backup's first
segments are fetched early so the CDN edge already has them when the player asks.

Where no clean stream exists at all — rare now that `mobile_feed` covers the HEVC channels — the
player is stepped down to the best rung of another codec, which turns one candidate into a whole
ladder. Until that lands, ad segments are answered with an empty body: the playlist keeps its
structure, so the player does not run out of media and get rendered as offline.

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

The defaults are the tested configuration. The two worth knowing are `StripAdSegments`, which
decides what happens when no clean stream exists, and `DeclineClientSideAds`, which is the only
thing standing between you and display ads.

## Reading the console

Everything is prefixed `[VAFT2]`. Filtering on that in DevTools shows what the script is doing.
Default level is `info`, which is a few lines per break; `window.vaft2.setLogLevel('debug')` opens it
up. The console entry points are listed on load.

Channel names are never printed. Which channel a line belongs to is whichever tab it came from.

| Line | Meaning |
| --- | --- |
| `v2 active -- <version>` | Loaded, followed by the list of callable entry points. |
| `client-side ad manager declined at …` | Display ads will not be requested. Its absence means they will. |
| `ad break started -- <quality> <codec>` | A break was detected. The codec is there because it decides which path the break takes. |
| `serving a clean stream via <type> at <resolution>` | A backup stream was found. The resolution is what is actually being served, not what the player label says. |
| `backup via <type> had ads at every rendition` | That player type was stitched at every rung; moving to the next. |
| `stepping down from … to …` | No same-codec backup, so the player was moved to another codec to unlock one. |
| `ad break finished -- watched at <quality>` | Over; quality is handed back on the next line. |
| `left the channel mid-break -- state cleared` | Channel changed during a break, so the break state was dropped instead of carried over. A fresh break on the new channel a second later is Twitch's own: arriving is a new player session, and that is its own auction. |
| `denied a picture-by-picture token locally` | The mini player above chat was refused. |
| `cushion stuck at <n>s … moving the playhead forward <n>s` | The player had settled further behind live than it needs to be, so the playhead was moved into buffer already downloaded. No reload, no rebuffer. |
| `OVERLAY AD suspected …` | A display ad got through the decline. Worth an issue. |
| `no clean playlist and stripping is off -- ads will be shown` | Exactly what it says. |
| `client-side ad manager not found …` | The lookup failed. Display ads are **not** blocked. |
| `the player is gone -- no media, no buffer …` | A decode error tore the player down; it is being reloaded. |

Three tagged families are diagnostics rather than status, and matter only when something looks
wrong. `[SEQ]` and `[GAP]` report the renumbering and the live-edge handling at each seam.
`[TRACE]` reports what the playback actually did: `break exit CLEAN` / `STALLED` / `DEGRADED` grades
every break by whether the buffer stayed in one piece and the playhead kept moving, `stall #n`
counts stalls and says whether they cluster after a break or happen in clear play, and
`continuity break` fires when the player asks for a segment number that is not the one we served
next — the one line that reads back what the player did instead of what the script intended.

`window.vaft2.status()` prints the whole state, which is more useful than any single line.

When opening an issue this output is what makes a report actionable. Please do not attach HAR files
or `chrome://net-export` captures: they contain your session tokens.

## What to expect

Not defects. These follow from how the thing works.

- **Quality can drop during a break**, but only if `mobile_feed` and `popout` both come back stitched
  and the break falls to `autoplay`, whose ladder Twitch caps at 640x360. Restored when it ends.
- **The picture can freeze for the length of a break**, where the ladder carries no rung of a
  different codec and ad segments are answered with an empty body. That keeps the stream alive,
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
