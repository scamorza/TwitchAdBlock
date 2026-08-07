# Status of the two inherited issues

Both were carried over from `pixeltris/TwitchAdSolutions` and describe the older script, down to
option names that no longer exist. This is where the rewritten script leaves them.

---

## #2 — Stream can appear "offline" during ad breaks

**Reproduced, and one cause traced.** It shows up reliably on HEVC channels, because that is where
segment stripping is reached on almost every break: an HEVC source sits above a ladder of AVC
transcodes, so a backup player type rarely carries a variant the player can decode, and stripping is
what is left.

The mechanism is not the one the issue guessed at. Stripping used to delete the ad segment lines
from the playlist. On a break where every segment is an ad that leaves a playlist with no media at
all, the player runs out of timeline, goes to `Ended`, and Twitch renders the channel as offline.

**Mitigated, two ways.**

- The segment lines are kept and each one is answered with an empty body (HTTP 200, zero bytes). The
  playlist stays structurally intact, so the player never runs out of timeline. The reply must carry
  no codec configuration at all: the previous placeholder was a one-frame MP4 with an `avc1` sample
  description, harmless on H.264 and fatal on HEVC, where it reached a SourceBuffer opened for
  `hvc1` and killed the player outright with a decode error.
- Reaching stripping now also steps the player down to the best rung of a different codec, which
  turns the backup search's single candidate into the whole ladder. Where that works, stripping is
  skipped and the failure cannot occur.

**The issue's own hypothesis has been tested, and is not supported.** It had two halves. The first —
that rewriting the player type on the access-token request is what does it — is refuted by ordinary
use: that rewrite is active on every page load, so the offline state would appear constantly rather
than only during breaks.

The second — that serving the player a stream fetched under a different player type is what does it —
was isolated with `simulateAd()`, which forces exactly that swap with no real break behind it: same
playlist substitution, no ad markers, no stripped segments. Eight forced swaps, alternating between
the first usable backup (`embed`, quality held) and the fall all the way to `autoplay` (640x360, the
most abrupt swap available). Detection watched several signals rather than one: the viewer count and
the LIVE indicator disappearing, a player content gate appearing, and the player reaching `Ended`,
that last one being the mechanism we traced ourselves and had to keep distinct.

Zero offline states across all eight. The swap alone does not produce it.

Eight trials on one channel is an absence rather than a proof, and the symptom is intermittent by
nature. But it is more than the issue had, which was a hypothesis nobody had put to the test. What
remains is the mechanism above — playlist without media, player to `Ended`, channel rendered
offline — which is the only one with evidence behind it, and it is fixed.

**Still unestablished** is whether that traced mechanism is the one external reporters were hitting.
Their channels were mostly AVC, where a backup usually exists and stripping is never reached.

---

## #1 — Freezing / buffering / repeated segments around ad transitions

**Improved, not eliminated, and complete elimination is not a realistic goal.** Twitch buffers on its
own around any playlist discontinuity, so a baseline of stalling survives whatever we do. Measuring
against zero would be measuring against something that does not exist even with the script removed.

**What changed.** The end-of-break player reload is off by default — on channels that serve a
pre-roll to new player sessions it bought another ad, which ended, which reloaded again. Pause/play
resyncs instead. A second reload inside 90 seconds degrades to pause/play rather than repeating an
action that settled nothing. A stall backstop and a dead-player watch cover the cases where
player-core has given up, and the codec step-down replaces an indefinite freeze with about a second
of rebuffer and one rung of quality, given back when the break ends.

**What is still ours, and known.** The junction between the real playlist and the swapped-in one is
unmarked: different media sequence, different timeline, resynced by pause/play rather than by
rewriting `#EXT-X-MEDIA-SEQUENCE` and emitting `#EXT-X-DISCONTINUITY`, which is what HLS provides for
exactly this. That is the mechanism behind segments being shown twice, and it is untested rather than
attempted. Separately, where no rung of a different codec exists, stripping still drains the buffer
and freezes the picture for the length of the break by design — it exists to keep the playlist valid,
not to preserve continuity.

---

## Both

Both are closed on the tracker. What is left is breadth, not depth, and it needs channels we do not
have: which ones reach stripping, whether the offline state still appears where a backup is
available, and how often the unmarked junction shows as a repeat rather than a brief stall.

A useful report carries the `[VAFT2]` console output across the break — `ad break started`, which
player type is serving, any `stepping down`, `ad break finished` — plus whether the channel is 2k/4k,
and whether pause/play recovers it.
