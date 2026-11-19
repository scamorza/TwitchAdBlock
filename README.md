# TwitchAdBlock

A userscript that blocks Twitch ads while keeping the stream at full quality.

Based on `vaft` from [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions),
since rewritten around the same core idea.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`vaft.user.js`](https://github.com/scamorza/TwitchAdBlock/raw/master/vaft.user.js) and
   confirm the installation.

Updates are automatic.

Remove any other script from the TwitchAdSolutions family first: only one can run, and which one
wins is a race.

## How it works

**Stitched ads** are inserted into the stream playlist. When ad markers appear, the script requests
the same channel under an ad-free player type (`mobile_feed` as `android`, at full quality) and
fills the gap with those segments. Both streams are aligned on `EXT-X-TWITCH-LIVE-SEQUENCE`, so the
player sees one continuous timeline. If no ad-free source is available, `popout` and then
`autoplay` (capped at 640x360) are tried.

**Display ads** (pod above chat, squeezeback, pause ads) are declined through Twitch's own ad
manager before they are requested. The mini player above chat is refused locally.

The script also recovers the player when Twitch pauses or drops it after a break.

## Ad indicator

While an ad is being blocked, an icon is shown over the player. It can be customised from the
browser console on twitch.tv:

```js
vaft2.banner({ ColorBanner: '#9146ff', SizeBanner: 28 })   // apply and save
vaft2.banner()                                              // show current settings
vaft2.banner(null)                                          // restore defaults
```

| Setting | Default | Description |
|---|---|---|
| `ShowBanner` | `true` | Show the icon |
| `BlurBanner` | `false` | Faded, blurred icon |
| `SizeBanner` | `20` | Size in pixels |
| `ColorBanner` | `'white'` | Any CSS color |
| `HaloBanner` | `'rgba(0,0,0,.9)'` | Outline color, `''` for none |

Settings are saved in the browser and survive script updates. Changes made by assigning
`vaft2.config` directly are not saved.

## Configuration

Options are in `Config` at the top of the script; the defaults are the tested setup. Edits there
are overwritten by updates.

- `DeclineClientSideAds`: blocks display ads.
- `BackupPlayerTypes`: order in which ad-free sources are tried.
- `HideVisibility`: reports the page as visible, so Twitch does not lower quality in background
  tabs.
- `LogLevel`: `info` by default; `vaft2.setLogLevel('debug')` changes it for the session.

`vaft2.help()` lists every console command. `vaft2.status()` prints the current state, useful when
reporting an issue.

## Known limitations

- If no ad-free source is available, quality can drop to 640x360 during a break, or the picture can
  hold until the break ends. Both recover on their own.
- Twitch itself buffers around ad transitions; some stalling is not caused by the script.
- Mobile (`m.twitch.tv`) is not supported.
- Twitch changes its player regularly. Updates follow when it does.

## Credits and licence

Thanks to [pixeltris](https://github.com/pixeltris) for `vaft` and TwitchAdSolutions, and to
[CommanderRoot](https://github.com/CommanderRoot), whose downscale script inspired the quality
handling.

MIT licensed, see [`LICENSE`](LICENSE).

## Disclaimer

Twitch does not endorse ad-blocking tools, and using one goes against its Terms of Service. Use at
your own risk, including possible account suspension. Provided "as is", without warranty of any
kind.
