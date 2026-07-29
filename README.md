# vaft

Forked from [pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions).
Thanks to pixeltris for the work put into this script and into every other
tool in the original repository.

## Why this fork

I personally think it's fair to support creators, whether that means
watching a few ads or subscribing to skip them. The problem starts when
Twitch and streamers begin spamming 150 ads a minute and almost every stream
becomes unwatchable. I believe viewers should be encouraged to support a
creator, not forced into subscribing to the point of exasperation. That's
why I decided to keep this project going.

## What we're carrying forward

Unlike the original repository, this fork only maintains `vaft` in the
Tampermonkey-loadable form (`vaft.user.js`). The uBlock Origin variant and
every other tool from the original repo (`strip`, `video-swap-new`) are not
part of this fork, at least for now — the scope may grow down the line.

`vaft` attempts to get a clean stream as fast as it can. If it fails to get
a clean stream, it removes ad segments instead.

## Usage

Install a userscript manager (e.g. [Tampermonkey](https://www.tampermonkey.net/)
or [Violentmonkey](https://violentmonkey.github.io/)), then open
`vaft.user.js`: the manager should prompt you to install the script.

## Known issues (inherited from upstream)

- Freezing / buffering / repeating segments around ad transitions — see the
  `PlayerBuffering*` options in `vaft.user.js`.
- Streams can appear "offline" during ad breaks.
- No mobile (`m.twitch.tv`) support.

## Project status

Twitch periodically changes its player and internal APIs, which breaks
scripts like this one — expect ongoing maintenance, not a one-time fix.
