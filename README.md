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

**Stitched ads** arrive inside the same HLS playlist as the stream, so there is no request to block.
The script hooks `window.Worker` and `window.fetch` and works on the playlist: when it sees ad
markers, it requests a playback access token under a different player type and serves that stream
instead. Player types are tried in order, and within each one every rung of the quality ladder, so a
break where the top rendition is stitched can still be served from a lower one.

Which request comes back clean is decided on the pair `playerType` + `platform` — the only two
client-controlled fields that reach the signed token. `mobile_feed` asked as `android` is the one
combination that is both ad-free and uncapped: 1080p on AVC, 1440p `hev1` on HEVC. Because it carries
the source codec, a break served from it costs no rendition change at all, which is what the player
stalls on. `popout` is the second chance at full quality — each request is its own ad auction, so
asking again is worth one round-trip — and `autoplay` is last, ad-free too but capped at 640x360.

That holds on any channel: where the old chain led with `embed` and `popout` — each its own ad
auction, so a break could still fall through both to `autoplay` — the exemption is now had on the
first request rather than by retrying.

Where no clean stream exists at all — now rare, since `mobile_feed` covers the HEVC channels that
used to have nothing but an AVC ladder underneath them — two things happen. The player is stepped
down to the best rung of a different codec, which turns one candidate into the whole ladder. Until
that lands, ad segments are answered with an empty body: the playlist keeps its structure, so the
player does not run out of media and get rendered as offline.

**Display ads** — the pod above chat, squeezeback, lower third, pause ads — are decided in the
browser, so none of the above ever sees them. Twitch's own ad manager holds every ad request in a
queue and drains it as `declineReason ? decline() : isReady && fn()`, where `fn()` is the fetch to
the ad exchange. Setting `declineReason` stops the request that would have produced the creative.
That is upstream of the container, not a hidden overlay, and it uses Twitch's own decline path
including their flag for not reporting it.

The **mini player above chat** is refused separately, by denying its access token locally rather than
sending something the server will reject.

Blocking ads breaks playback in its own ways, so a fair part of the script exists to put it back
together: resuming a stream Twitch paused and will not retry, restoring quality after a break,
reloading a player whose media element was torn down by a decode error.

## Configuration

Every option, what it does and when touching it is justified: [`doc/config.md`](doc/config.md).

The short version — the defaults are the tested configuration. The two worth knowing are
`StripAdSegments`, which decides what happens when no clean stream exists, and
`DeclineClientSideAds`, which is the only thing standing between you and display ads.

## Reading the console

Everything is prefixed `[VAFT2]`. Filtering on that in DevTools shows what the script is doing.
Default level is `info`, which is a few lines per break; `window.vaft2.setLogLevel('debug')` opens it
up. The console entry points are listed on load and documented in
[`doc/help_info.md`](doc/help_info.md).

| Line | Meaning |
| --- | --- |
| `v2 active -- <version>` | Loaded, followed by the list of callable entry points. |
| `client-side ad manager declined at …` | Display ads will not be requested. Its absence means they will. |
| `ad break started on <channel> -- <quality> <codec>` | A break was detected. The codec is there because it decides which path the break takes. |
| `serving a clean stream via <type> at <resolution>` | A backup stream was found. The resolution is what is actually being served, not what the player label says. |
| `backup via <type> had ads at every rendition` | That player type was stitched at every rung; moving to the next. |
| `stepping down from … to …` | No same-codec backup, so the player was moved to another codec to unlock one. |
| `ad break finished on <channel>` | Over; quality is handed back on the next line. |
| `denied a picture-by-picture token locally` | The mini player above chat was refused. |
| `OVERLAY AD suspected …` | A display ad got through the decline. Worth an issue. |
| `no clean playlist and stripping is off -- ads will be shown` | Exactly what it says. |
| `client-side ad manager not found …` | The lookup failed. Display ads are **not** blocked. |
| `the player is gone -- no media, no buffer …` | A decode error tore the player down; it is being reloaded. |

`window.vaft2.status()` prints the whole state, which is more useful than any single line.

When opening an issue this output is what makes a report actionable. Please do not attach HAR files
or `chrome://net-export` captures: they contain your session tokens.

## Known issues

Both are closed on the tracker. Full detail in [`doc/issue.md`](doc/issue.md).

| Issue | Status | What is left |
|---|---|---|
| [#1](https://github.com/scamorza/TwitchAdBlock/issues/1) — freezing and repeated segments at ad transitions | Closed. 2.0.1 removed the rendition change, which is what stalled the player — measured, unlike the unmarked junction, which costs nothing | The repeats: never measured, and not explained by the junction either way |
| [#2](https://github.com/scamorza/TwitchAdBlock/issues/2) — streams appearing "offline" during breaks | Closed. The traced cause is fixed, and HEVC channels now get a same-codec backup | Never confirmed whether external reporters were hitting that same cause |

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
