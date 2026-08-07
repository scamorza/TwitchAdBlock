# `window.vaft2.config` — options

Every option, what it does, and when touching it is justified. Defaults are what ships.

Read the object to see the current state, write to it to change behaviour. **When a change takes
effect depends on who consumes it** — see [Scope](#scope) at the bottom before expecting a live edit
to do anything.

---

## Ad blocking

| Option | Default | What it does | When to change |
|---|---|---|---|
| `BlockAds` | `true` | Master switch for the playlist machinery. | Only to measure what the page does untreated. |
| `AdSignifier` | `'stitched'` | The marker searched for in the playlist to detect a break. | If breaks stop being detected. `CrossCheckAdEvents` is what tells you it has drifted. |
| `BackupPlayerTypes` | `['mobile_feed','popout','autoplay']` | Order in which a clean stream is looked for. Exemption is decided on the pair `playerType` + `platform`, the only two client-controlled fields reaching the signed token: `mobile_feed` asked as `android` is both ad-free and uncapped (1080p on avc, 1440p `hev1` on HEVC), so a break costs no rendition change. `popout` is the full-quality second chance — each request is its own ad auction, so it often comes back clean. `autoplay` is ad-free too, but capped at 640x360. | Reorder only with measurements. Dropping `autoplay` means some breaks have no backup at all and fall to stripping. |
| `ForceAccessTokenPlayerType` | `'popout'` | Rewrites the player type on the access-token request. Also strips `parent_domains`, which is what stops embed-shaped fake ads. | Setting it empty disables the rewrite and brings those back. |
| `StripAdSegments` | `true` | With no clean backup, ad segments are answered with an empty body instead of being served. | Off means ads play. Only useful to confirm a break is genuinely unavoidable. |
| `ReloadPlayerAfterAd` | `false` | Rebuild the player when the break ends instead of pause/play. | Leave off. Where a new player session buys a pre-roll, the reload buys another ad, which ends, which reloads again. |
| `AdEndGraceSeconds` | `0` | Wait before declaring a break over, for pods where markers vanish briefly. | Raise only if the log shows `ad markers returned after Nms`. Costs its own duration in stalled video. |
| `ReloadCooldownSeconds` | `90` | Below this gap, a second reload degrades to pause/play. | Lower only if reloads are genuinely settling breaks and you want them sooner. |
| `RefreshTokenOnReload` | `true` | Ask for a fresh access token when rebuilding the player. | First thing to turn off if a reload loop reappears. |

## Client-side (display) ads

Ads decided in the browser: the pod above chat, squeezeback, lower third, pause ads. The playlist
machinery never sees them.

| Option | Default | What it does | When to change |
|---|---|---|---|
| `DeclineClientSideAds` | `true` | Declines Twitch's own ad manager, so the request that would produce the creative never leaves. | Off only to reproduce a display ad on purpose. Nothing else stops them — there is no second layer. |
| `AdDeclineReason` | `'player_size'` | The reason we declare. Taken from Twitch's own enum, because it is passed to each declined command and tracked from there. | Only for another value from their enum. Never an invented string. |
| `AdDeclineAttempts` | `240` | Lookup retries, 500 ms apart, so two minutes. | Raise on a very slow connection: the bundle defining the manager can take ~20 s on a cold cache. `status().layers.adManagerAttempts` shows what it actually took. |
| `WatchOverlayAds` | `true` | Detection only, feeding `overlayBuffer()`. Does not stop anything. | Leave on. It is the only thing that reports a display ad getting through if the decline ever fails. |

## Page visibility

| Option | Default | What it does | When to change |
|---|---|---|---|
| `HideVisibility` | `true` | Always reports the page as visible. Stops the background pause mid-ad and the background downscale — a hidden tab fell 720p60 → 360p30 in about two minutes without it. | Off if you suspect the visibility override is confusing the player. Its cost is that `onSinkStop` now reaches a local `pause()`, which is why `RecoverBlockedPlayback` exists. |
| `ResumeOnFocus` | `true` | Resumes a stream found paused when the window comes back. | Leave on. Minimising stops the media sink and player-core pauses in a branch that emits no event, so nothing else notices. |

## Quality

| Option | Default | What it does | When to change |
|---|---|---|---|
| `PinHighestQuality` | `true` | Writes Twitch's own `video-quality-highest-available`. | Off if you want Twitch's automatic selection. It does **not** prevent the background downscale — measured: quality pinned, still fell to 360p on schedule. `HideVisibility` is what stops that. |
| `StepDownCodecInsteadOfStripping` | `true` | On reaching stripping, drops to the best rung of a different codec so the backup search has candidates. Costs about a second of rebuffer and one rung, both given back when the break ends. | Off makes stripping the final answer again: the picture freezes for the whole break. Only relevant where the ladder mixes codecs — on an all-AVC channel it never fires. |

## Recovery

| Option | Default | What it does | When to change |
|---|---|---|---|
| `RecoverBlockedPlayback` | `true` | Resumes on `PlayerPlaybackBlocked` — muted, sink stopped, Twitch pauses and will not retry. | Leave on. It is the one case nothing else picks up. |
| `ResumeVerifyDelayMs` | `2000` | How long after a resume to check it actually took. | Raise on a slow connection where the player legitimately needs longer to leave `Buffering`. |
| `ResumeVerifyAttempts` | `2` | Retries before giving up and saying so. | Raising it risks fighting a player that has decided to stay paused. |
| `StallBackstop` | `false` | Nudges a player whose buffer has not advanced. | Leave off: player-core runs its own monitor on the same condition and a second loop fights it. Enable only if the player dies outright and stays dead. |
| `StallBackstopSeconds` | `20` | How long the buffer must be frozen first. | Only with `StallBackstop` on. |
| `RecoverDeadPlayer` | `true` | Reloads the player when the media element is torn down — decode error, `Errore #3000`, which player-core does not retry. | Leave on. Without it the player sat dead for six minutes with nothing in the log. |
| `DeadPlayerSeconds` | `12` | How long the dead signature must hold before acting. | Do not lower much: the same signature appears for a second or two during any ordinary load. |

## Diagnostics

| Option | Default | What it does | When to change |
|---|---|---|---|
| `ShowBanner` | `true` | Draws `Blocking ads` over the player during a break, with the backup type and whether it is stripping. | Off if you want the picture clean. It is also the quickest way to see a break happen at all. |
| `LogLevel` | `'info'` | `debug` \| `info` \| `warn` \| `off`. | `debug` when investigating; `warn` for daily use. Not persistent — back to the shipped value on reload. |
| `CrossCheckAdEvents` | `true` | Logs Twitch's own `stitchedadstart`/`stitchedadend` beside our detection. | Leave on: one without the other is how you learn `AdSignifier` has drifted. |

---

## Scope

Three groups, and the difference matters when editing live from the console.

**Immediate.** `LogLevel`, `AdEndGraceSeconds`, `ReloadCooldownSeconds`, `RefreshTokenOnReload`,
`ShowBanner`, `ResumeOnFocus`, `ResumeVerifyDelayMs`, `ResumeVerifyAttempts`, `DeadPlayerSeconds`,
`StallBackstopSeconds`, `StepDownCodecInsteadOfStripping`, `AdDeclineReason`. Read each time they are
used, so a write takes effect on the next break.

**Needs a page reload.** `HideVisibility`, `DeclineClientSideAds`, `PinHighestQuality`,
`WatchOverlayAds`, `StallBackstop`, `RecoverDeadPlayer`, `CrossCheckAdEvents`. The layer they control
is installed once at startup; flipping the flag afterwards changes nothing.

**Needs a page reload, and lives in the worker.** `BlockAds`, `AdSignifier`, `BackupPlayerTypes`,
`StripAdSegments`, `ForceAccessTokenPlayerType`. These are embedded into the worker source when it is
wrapped, deliberately: a config sent by message races Twitch's own worker startup, whose `onmessage`
throws on anything it did not send itself. Editing `window.vaft2.config` cannot reach them.

Nothing here is persistent. Every option returns to the shipped value on reload; to make a change
stick, edit the `Config` block in the script.
