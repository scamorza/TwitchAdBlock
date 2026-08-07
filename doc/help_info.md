# `window.vaft2` — console entry points

Reference for the methods `help()` lists on load: arguments, what comes back, and where it matters,
what each one does **not** do.

The object exists in the top frame only. With an iframe selected in the console's context picker you
get `undefined`.

---

## `status()`

No arguments. Returns the full state, read at the moment of the call.

| field | meaning |
|---|---|
| `version` | script version |
| `adActive` | `true` while a break detected in the manifest is running |
| `adIsMidroll` | midroll or pre-roll |
| `backupPlayerType` | which `playerType` is serving the clean stream (`embed`, `popout`, `autoplay`), `null` if none |
| `strippingSegments` | `true` when no clean source is available and ad segments are being emptied |
| `playerAdEvent` | last ad event reported by Twitch's own player |
| `tokenMode` | current GraphQL token rewriting mode |
| `counters` | cumulative since load: `breaks`, `reloads`, `backupFailures`, `recoveries`, `deadPlayers` |
| `layers` | state of the installed layers, below |
| `player` | player state, below |
| `workers` | how many of Twitch's workers we hooked |

### `layers`

| field | meaning |
|---|---|
| `hideVisibility` | the tab-visibility layer is installed |
| `adManagerDeclined` | whether the client-side ad manager was declined. `false` means display ads are **not** blocked |
| `adManagerReason` | the value written into their `declineReason` (normally `player_size`) |
| `adManagerModule` | webpack module and export name where the class was found, e.g. `528461.F` |
| `adManagerAttempts` | how many attempts it took to find it; `240` means it gave up |
| `pinHighestQuality` | option state |
| `qualityFlagInStorage` | the actual value in `localStorage`, to confirm the option really wrote it |

### `player`

| field | meaning |
|---|---|
| `found` | the player was hooked |
| `state` | Twitch's own state (`Playing`, `Idle`, …) |
| `quality` | the quality label that was picked — **not** what is actually being decoded |
| `autoQualityMode` | `true` if quality is on automatic |
| `reallyHidden` | whether the tab is genuinely hidden, ignoring what we make the page believe |

---

## `help()`

No arguments. Reprints the list of callable methods, the same block shown on load.

The list comes from `Object.keys(window.vaft2)`, so it cannot drift from the code — and for the same
reason it knows nothing about arguments: it prints `setLogLevel()` and `simulateAd()` with empty
parentheses though both require one.

---

## `setLogLevel(level)`

**Required argument**, one of:

| level | what you see |
|---|---|
| `debug` | everything, including intermediate attempts and internal plumbing |
| `info` | *(default)* start, which clean source is serving, codec step-down, end. Three or four lines per break |
| `warn` | only degraded outcomes, or things you can act on |
| `off` | nothing |

An unrecognised value changes nothing and prints the valid levels.

Not persistent: back to `info` on every load. To make it stick, change `LogLevel` in `config`.

Three lines ignore the level and always print — the help on load, the level list on a bad value, and
the stand-down when another ad blocker already claimed the page.

---

## `simulateAd(depth)`

**Required argument**, an integer. Forces the ad path with no real break, so the interesting cases
can be reached on demand.

| value | effect |
|---|---|
| `0` | off |
| `1` | takes the first backup `playerType` that works |
| `2` | pretends the first still has ads, so it falls to the second |
| `3` | pretends they are all busy, all the way down to `autoplay` |

Depth works by pretending the earlier player types are still serving ads. `3` is the one that matters
on a 2k/4k channel: `autoplay`'s ladder carries a different codec from the one playing, which is the
case where no backup is usable and only stripping is left.

Negative values clamp to `0`, and the number is truncated to an integer.

It stays on until `simulateAd(0)`: it does not expire on its own and it survives real breaks.

---

## `reloadPlayer()`

No arguments, returns `undefined`. Rebuilds the player — the same action taken at the end of a break
when needed.

Three conditions make it do nothing, and it logs which one:

- the player was not found → `warn`
- the player is paused with the media underneath intact: a pause you made yourself is not touched. If
  the media has been torn down there is no user pause to respect and the reload goes ahead
- another reload happened less than `ReloadCooldownSeconds` ago (90 by default) → falls back to
  pause/play

When it does go ahead it increments `counters.reloads`, and asks for a fresh token if
`RefreshTokenOnReload` is set.

---

## `overlayBuffer()`

No arguments. Returns a **copy** of the overlay-ad sampling ring: up to 180 samples taken every
500 ms, so roughly 90 seconds of history, oldest first.

Use it right after an `OVERLAY AD suspected` — the evidence is already there, because reacting to the
event as it happens is too late.

Each sample:

| field | meaning |
|---|---|
| `t` | `hh:mm:ss` in **UTC** |
| `vw`, `vh` | width and height of the `<video>` |
| `cw`, `ch` | width and height of the `.video-player` container |
| `ratio` | `vw / cw`. Normal playback sits at `1`; below `1` the picture is smaller than its box |
| `videoAspect`, `containerAspect` | the two aspect ratios. They stay equal in a squeezeback and diverge under ordinary letterboxing, which is what tells the two apart |
| `iframes` | iframes on the page. Recorded only, triggers nothing |
| `adIframes` | how many of those belong to an ad network |
| `iframeList` | their `src`, truncated to 90 characters |
| `streamAd` | whether a manifest break was running at the same time |
| `playerState` | player state at that instant |
| `pbyp` | picture-by-picture context state, or `null` |

`pbyp` holds `isShowing`, `showingMirrorPod`, `status`, `rollType`, `adSessionID`, `hasMetadata`.
**`hasMetadata` and `showingMirrorPod` are the two that matter**: the pod above chat announces itself
with `hasMetadata` turning `true`, and `showingMirrorPod` follows about a second later.

---

## `overlayLayout()`

No arguments. Returns `{ chain: [...] }`, the element chain above the video from the `<video>`
upwards, as it stands at the instant of the call. Unlike `overlayBuffer()` it keeps no history.

| field | meaning |
|---|---|
| `tag` | tag name |
| `cls` | first three classes, truncated to 60 characters |
| `inline` | the `style` attribute, truncated to 140 characters |
| `x`, `y`, `w`, `h` | the element's box |

Use it to see who is imposing a size. `inline` is the useful part: Twitch sizes with inline `calc()`,
which beats any author stylesheet.

---

## `config`

Not a method: the live configuration object. Read it to see how things are set, write to it to change
behaviour without reloading.

Every option, its default and its effect are in [`config.md`](config.md) — including which ones a
live write can actually reach. Some are read each time they are used, others were baked into a layer
or into the worker at startup and need a page reload.

---

## Globals outside `vaft2`

Not entry points, so `help()` does not list them:

| name | what it is |
|---|---|
| `vaftVersion` | our presence marker |
| `twitchAdSolutionsVersion` | the same value under the name the rest of the family uses. It is how two scripts recognise each other instead of both hooking `Worker` and `fetch` |
| `__vaft2RealFetch` | the original `fetch`, saved before the hook was installed. Calling it skips our rewrites, useful for comparing what Twitch answers without us |
