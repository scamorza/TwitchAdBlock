// ==UserScript==
// @name         TwitchAd (vaft)
// @namespace    https://github.com/scamorza/TwitchAdBlock
// @version      2.1.0
// @description  Twitch ad blocking
// @updateURL    https://github.com/scamorza/TwitchAdBlock/raw/master/vaft.user.js
// @downloadURL  https://github.com/scamorza/TwitchAdBlock/raw/master/vaft.user.js
// @author       https://github.com/scamorza
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

// Same core trick as vaft: when a playlist carries ad markers, refetch the channel under a
// different playerType and serve that. Rewritten around it: worker authored as worker source (not
// toString of page functions), no silent failures, options can undo their own persistent state,
// access token falls back to the full GQL document.
//
// Logs under [VAFT2].

(function () {
    'use strict';

    // @match covers every *.twitch.tv frame, including hidden auth/ads ones. frameElement is no
    // help: it returns null instead of throwing on a cross-origin parent.
    if (window.self !== window.top) {
        const host = document.location.hostname;
        const path = document.location.pathname;
        const isChatEmbed = /^\/embed\/[^/]+\/chat\/?$/.test(path);
        const isPlayerEmbed = !isChatEmbed && (
            host === 'player.twitch.tv' || host === 'embed.twitch.tv' ||
            host === 'clips.twitch.tv' || host === 'm.twitch.tv' ||
            path === '/embed' || path.startsWith('/embed/')
        );
        if (!isPlayerEmbed) {
            return;
        }
    }

    // Install two ad blockers and exactly one runs, whichever got there first; otherwise both hook
    // Worker and fetch. twitchAdSolutionsVersion is the name vaft and the pixeltris original use --
    // dropping it would make the two scripts invisible to each other.
    const OUR_VERSION = 1;
    const VERSION_MARKERS = ['vaftVersion', 'twitchAdSolutionsVersion'];
    const claimedBy = VERSION_MARKERS.find((name) => {
        return typeof window[name] !== 'undefined' && window[name] >= OUR_VERSION;
    });
    if (claimedBy) {
        console.log('[VAFT2] standing down, ' + claimedBy + ' is already set -- another ad blocker got here first');
        return;
    }
    VERSION_MARKERS.forEach((name) => { window[name] = OUR_VERSION; });

    const Config = {
        // -- ad blocking ---------------------------------------------------------------------
        BlockAds: true,
        AdSignifier: 'stitched',
        // Tried in order. mobile_feed (as android) is ad-free and uncapped; popout is a second
        // chance at full quality, clean ~4 times in 10; autoplay is ad-free but capped at 640x360.
        BackupPlayerTypes: ['mobile_feed', 'popout', 'autoplay'],
        // Also strips parent_domains, which is what stops the embed-shaped fake ads.
        ForceAccessTokenPlayerType: 'popout',
        StripAdSegments: true,
        // Renumbers the served playlist onto the numbering the player already believes in, or the
        // gap between the two sessions grows by a break's worth every time and never comes back.
        RenumberSequence: true,
        // Carries the original's ad DATERANGEs onto what we serve, so the player re-arms its own
        // defence during the break (see carryAdMarkers). Turn off to go back to the older
        // behaviour, where the player crosses the seam without knowing there was a break.
        CarryAdMarkers: true,
        // Holds the MEDIA-LIVE gap continuous across the seam and walks it back to the true value
        // one segment at a time (see liveGapServe). Turn off to compare against the older
        // behaviour, where the whole step arrived at once.
        HoldLiveGap: true,
        // Every segment the player fetches passes our worker hook, and we know the number we gave
        // it: any request that is not (last + 1) is a splice we caused.
        TraceContinuity: true,
        // Loop guard: a second reload inside this window degrades to pause/play -- a reload that
        // settled nothing is a genuinely stuck player, not a routine exit.
        ReloadCooldownSeconds: 90,
        // The backup's URLs are new to the CDN edge, so its first segment cost 1.051s of ttfb
        // against the usual 0.10 -- enough to stall. We pull its start as soon as we adopt it.
        WarmBackupSegments: true,
        // Moving the playhead is the only way to cut latency without consuming buffer: left alone
        // the player only speeds up to 1.03x, which consumes more than it receives.
        // The guards below matter more than the jump: firing while the player rebuilds after a
        // stall destroys the defence it is building.
        LatencyTrim: true,
        // Only trim above this much cushion: below it there is nothing to reclaim.
        LatencyTrimThresholdSeconds: 4.0,
        // 2.5 and not less: the player floors itself at 1s in low latency and 2-3s after a stall,
        // so leaving it 1.2 handed it back already below its own target.
        LatencyTrimResidualSeconds: 2.5,
        // It has to stay high for a while: the cushion swings ~0.5s every segment (sawtooth from
        // chunked delivery) and trimming on an isolated peak would be trimming on noise.
        LatencyTrimPersistenceSeconds: 20,
        // How long to let the player heal after a stall before touching its cushion.
        LatencyTrimStallGraceSeconds: 120,
        LatencyTrimCooldownSeconds: 60,
        // Prime suspect in that loop; first thing to try if it reappears.
        RefreshTokenOnReload: true,

        // -- overlay / squeezeback ads -------------------------------------------------------
        // Nothing is stitched in and the stream never stops: the picture shrinks, or a pod plays
        // above chat. Detection only; DeclineClientSideAds is what stops them.
        WatchOverlayAds: true,

        // -- client-side (display) ads --------------------------------------------------------
        // Twitch's ad manager drains its queue as:
        //     this.declineReason ? cmd.decline(this.declineReason) : this.isReady && cmd.fn()
        // cmd.fn() holds the fetch to the ad edge, so declineReason stops the request itself.
        DeclineClientSideAds: true,
        // From Twitch's own enum: the reason is passed to each declined command and tracked from
        // there, so an invented string would stand out.
        AdDeclineReason: 'player_size',
        // 500ms apart. The bundle defining the manager can take ~20s to arrive on a cold cache.
        AdDeclineAttempts: 240,

        // -- page visibility -----------------------------------------------------------------
        // Always reports the page visible: stops the background downscale (720p60 -> 360p30 in ~2
        // min). Cost: a stalled sink now reaches a local pause(), which RecoverBlockedPlayback undoes.
        HideVisibility: true,
        // Minimising stops the media sink, and with document.hidden forced false player-core pauses
        // in the branch that emits no event at all, so nothing else notices.
        ResumeOnFocus: true,

        // -- quality -------------------------------------------------------------------------
        // Twitch's own 'video-quality-highest-available'. Does NOT prevent the background downscale
        // despite vaft's similarly-named option claiming so: HideVisibility is what stops that.
        PinHighestQuality: true,

        // -- recovery ------------------------------------------------------------------------
        // onSinkStop has three exits; only the muted one (pause + PlaybackBlocked, no retry) strands
        // the stream with nobody coming, so it is the only one acted on.
        RecoverBlockedPlayback: true,
        ResumeVerifyDelayMs: 2000,
        ResumeVerifyAttempts: 2,


        // A decode error tears the media element down and player-core does not retry -- it renders
        // "Errore #3000" and waits for a click. Held before acting: the same signature appears for
        // a second or two during any ordinary load.
        RecoverDeadPlayer: true,
        DeadPlayerSeconds: 12,

        // Stripping freezes the picture for the whole break. Instead, step down to the best variant
        // of a different codec: costs a second of rebuffer and a rung of quality, both given back
        // when the break ends. OFF makes stripping the final answer again.
        StepDownCodecInsteadOfStripping: true,

        // Reuse the player and controller found by the React tree walk until the player is
        // rebuilt. OFF walks the tree on every getPlayer() -- up to four full walks a second.
        CachePlayerLookup: true,

        // -- diagnostics ---------------------------------------------------------------------
        ShowBanner: true,
        // 'debug' | 'info' | 'warn' | 'off'
        LogLevel: 'info',
        // Report the player's own stitchedadstart/stitchedadend next to our own detection: one
        // without the other means AdSignifier has drifted.
        CrossCheckAdEvents: true
    };

    const LEVELS = { debug: 10, info: 20, warn: 30, off: 99 };
    const VERSION = (typeof GM_info !== 'undefined' && GM_info?.script?.version) || 'dev';
    const seenOnce = new Map();

    function log(level, message) {
        if ((LEVELS[level] || 20) < (LEVELS[Config.LogLevel] || 20)) {
            return;
        }
        const line = '[VAFT2] ' + message;
        if (level === 'warn') {
            console.warn(line);
        } else {
            console.log(line);
        }
    }

    // For conditions that repeat every playlist request: the first occurrence is never swallowed.
    function logOnce(key, level, message) {
        if (seenOnce.get(key) === message) {
            return;
        }
        seenOnce.set(key, message);
        log(level, message);
    }

    function clearOnce(key) {
        seenOnce.delete(key);
    }

    const State = {
        adActive: false,
        adIsMidroll: false,
        activeBackupPlayerType: null,
        strippingSegments: false,
        lastBackupFailure: null,
        workers: [],
        playerAdEvent: null,
        gqlTokenMode: 'persisted',
        counters: { breaks: 0, reloads: 0, backupFailures: 0, recoveries: 0, deadPlayers: 0, continuityBreaks: 0 },
        // probeRealPreroll's in-flight calls, keyed by request id. Nothing survives past resolution.
        pendingProbes: new Map()
    };

    // Anything writing persistent state here also removes it: leaving the key behind when the
    // option is off silently invalidates any measurement made without it.
    const QUALITY_KEY = 'video-quality-highest-available';
    const QUALITY_STAMP_KEY = 's-qs-ts';

    function applyQualityPreference(enabled) {
        try {
            if (enabled) {
                localStorage.setItem(QUALITY_STAMP_KEY, Date.now());
                // Must stay a string: Twitch reads it through a facade that JSON.parses on the
                // way out, and anything that is not valid JSON makes it drop the key entirely.
                localStorage.setItem(QUALITY_KEY, 'true');
            } else {
                localStorage.removeItem(QUALITY_KEY);
                localStorage.removeItem(QUALITY_STAMP_KEY);
            }
        } catch (err) {
            log('debug', 'could not ' + (enabled ? 'set' : 'clear') + ' the quality preference: ' + err);
        }
    }

    function installVisibilityLayer() {
        if (!Config.HideVisibility) {
            return;
        }
        // Captured before the overrides go in, so the rest of the script can still ask the real
        // question.
        const nativeHidden = document.__lookupGetter__('hidden');
        const nativeWebkitHidden = document.__lookupGetter__('webkitHidden');
        Visibility.isReallyHidden = () =>
            (nativeHidden ? nativeHidden.apply(document) === true : false) ||
            (nativeWebkitHidden ? nativeWebkitHidden.apply(document) === true : false);

        const define = (prop, value) => {
            try {
                Object.defineProperty(document, prop, { get() { return value; } });
            } catch (err) {
                log('warn', 'could not override document.' + prop + ': ' + err);
            }
        };
        define('visibilityState', 'visible');
        define('hidden', false);
        define(/Firefox/.test(navigator.userAgent) ? 'mozHidden' : 'webkitHidden', false);

        const swallow = (e) => {
            // We run first and see the real event before swallowing it -- the only chance to
            // notice the window going away or coming back.
            const reallyHidden = Visibility.isReallyHidden();
            const video = document.getElementsByTagName('video')[0];
            if (reallyHidden) {
                Visibility.wasPlaying = !!(video && !video.paused && !video.ended);
            } else if (Config.ResumeOnFocus && Visibility.wasPlaying && video && video.paused && !video.ended) {
                // With document.hidden forced false, onSinkStop reaches a local pause() in the
                // branch that emits nothing, so RecoverBlockedPlayback never hears about it.
                Visibility.wasPlaying = false;
                log('debug', 'window came back with the stream paused, resuming');
                const found = getPlayer();
                playPlayer(found ? found.player : video, 'window focus');
                verifyResumed(true);
            }
            // A stream opened straight into a background tab needs the first real visibilitychange
            // to reach Twitch or the video never starts. Unprefixed only: all three aliases share
            // this handler, and the first to fire would otherwise consume the single allowance.
            if (Visibility.allowNextVisibilityChange && e.type === 'visibilitychange' && !reallyHidden) {
                Visibility.allowNextVisibilityChange = false;
                log('debug', 'letting the first visibilitychange through so a background-opened stream starts');
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        ['visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange'].forEach((name) => {
            document.addEventListener(name, swallow, true);
        });
        // Backstop: minimising does not reliably produce a visibilitychange on every platform.
        window.addEventListener('focus', () => {
            if (!Config.ResumeOnFocus) {
                return;
            }
            const video = document.getElementsByTagName('video')[0];
            if (Visibility.wasPlaying && video && video.paused && !video.ended) {
                Visibility.wasPlaying = false;
                log('debug', 'window focused with the stream paused, resuming');
                const found = getPlayer();
                playPlayer(found ? found.player : video, 'window focus');
                verifyResumed(true);
            }
        });
        window.addEventListener('blur', () => {
            const video = document.getElementsByTagName('video')[0];
            if (video && !video.paused && !video.ended) {
                Visibility.wasPlaying = true;
            }
        });
        Visibility.installed = true;
    }

    const Visibility = {
        installed: false,
        wasPlaying: false,
        isReallyHidden: () => false,
        allowNextVisibilityChange: false
    };

    function findReactNode(root, predicate) {
        if (root.stateNode && predicate(root.stateNode)) {
            return root.stateNode;
        }
        let node = root.child;
        while (node) {
            const found = findReactNode(node, predicate);
            if (found) {
                return found;
            }
            node = node.sibling;
        }
        return null;
    }

    // The walk below is the script's whole main-thread cost: 98.5% of it, claim 052. The instances
    // it finds change only when the player is rebuilt, and the <video> the player owns is detached
    // when that happens -- so isConnected is an O(1) test for "still the live pair".
    let playerCache = null;

    function playerCacheIsLive() {
        if (!playerCache) { return false; }
        try {
            if (typeof playerCache.controller.setSrc !== 'function') { return false; }
            const video = playerCache.player.getHTMLVideoElement?.();
            return !!video && video.isConnected;
        } catch {
            return false;
        }
    }

    function getPlayer() {
        if (Config.CachePlayerLookup !== false && playerCacheIsLive()) {
            return playerCache;
        }
        const rootNode = document.querySelector('#root');
        if (!rootNode) {
            return null;
        }
        let reactRoot = null;
        if (rootNode._reactRootContainer?._internalRoot?.current) {
            reactRoot = rootNode._reactRootContainer._internalRoot.current;
        } else {
            const key = Object.keys(rootNode).find((x) => x.startsWith('__reactContainer'));
            reactRoot = key ? rootNode[key] : null;
        }
        if (!reactRoot) {
            return null;
        }
        let instance = findReactNode(reactRoot, (n) => n.setPlayerActive && n.props?.mediaPlayerInstance);
        instance = instance?.props?.mediaPlayerInstance || null;
        if (instance?.playerInstance) {
            instance = instance.playerInstance;
        }
        const controller = findReactNode(reactRoot, (n) => n.setSrc && n.setInitialPlaybackSettings);
        playerCache = instance && controller ? { player: instance, controller } : null;
        return playerCache;
    }

    // play() hands back a promise. Dropping it loses the difference between the browser refusing
    // the call and the call going through with the player staying paused anyway.
    function playPlayer(player, context) {
        try {
            const result = player.play();
            result?.catch?.((err) => log('debug', 'play() rejected after ' + context + ': ' + (err?.name || err)));
        } catch (err) {
            log('debug', 'play() threw after ' + context + ': ' + err);
        }
    }

    const Resume = { timer: null, attempts: 0 };

    function verifyResumed(isNewAttempt) {
        if (!Config.RecoverBlockedPlayback) {
            return;
        }
        if (isNewAttempt) {
            // Only on a genuinely new resume, not on this function rescheduling itself: without
            // the distinction one failed escalation disables recovery for the page's life.
            Resume.attempts = 0;
        }
        clearTimeout(Resume.timer);
        Resume.timer = setTimeout(() => {
            try {
                const found = getPlayer();
                const video = found?.player?.getHTMLVideoElement?.();
                // The <video> is ground truth: isPaused() and core.paused can go stale against it.
                if (!found || !video || (!video.paused && !video.ended)) {
                    Resume.attempts = 0;
                    return;
                }
                if (found.player.core?.state?.state === 'Buffering') {
                    // Working on it, not stranded. A reload looks exactly like this while it starts.
                    verifyResumed(false);
                    return;
                }
                if (Resume.attempts < Config.ResumeVerifyAttempts) {
                    Resume.attempts++;
                    log('debug', 'still paused after our resume, retrying play (' + Resume.attempts + '/' + Config.ResumeVerifyAttempts + ')');
                    playPlayer(found.player, 'resume retry');
                    verifyResumed(false);
                } else {
                    log('warn', 'player did not resume after ' + Resume.attempts + ' retries; leaving it alone rather than reloading in a loop');
                }
            } catch (err) {
                log('debug', 'resume verification failed: ' + err);
            }
        }, Config.ResumeVerifyDelayMs);
    }

    let listenersAttachedTo = null;

    function attachPlayerListeners(player) {
        if (!player?.addEventListener || listenersAttachedTo === player) {
            return;
        }
        listenersAttachedTo = player;
        const on = (event, handler) => {
            try {
                player.addEventListener(event, handler);
            } catch (err) {
                log('warn', 'could not listen for ' + event + ': ' + err);
            }
        };

        if (Config.RecoverBlockedPlayback) {
            // The one case player-core abandons: muted, sink stopped, pauses with no retry.
            on('PlayerPlaybackBlocked', () => {
                State.counters.recoveries++;
                log('info', 'PlaybackBlocked -- Twitch paused the muted stream and will not retry; resuming');
                playPlayer(player, 'playback blocked');
                verifyResumed(true);
            });
            // Reported, not undone: unmuting walks back into the same sink stop, and the browser
            // will not allow audible playback without a real gesture anyway.
            on('PlayerAudioBlocked', () => {
                log('warn', 'AudioBlocked -- Twitch muted the stream to keep it playing; unmute manually to get sound back');
            });
        }

        if (Config.CrossCheckAdEvents) {
            on('stitchedadstart', () => {
                State.playerAdEvent = 'start';
                log('debug', 'player reports stitchedadstart' + (State.adActive ? '' : ' -- we have NOT detected an ad, AdSignifier may have drifted'));
            });
            on('stitchedadend', () => {
                State.playerAdEvent = 'end';
                log('debug', 'player reports stitchedadend');
            });
        }
    }

    // The player instance is replaced on reload, so re-check when we touch it rather than polling.
    function ensurePlayerWired() {
        const found = getPlayer();
        if (found?.player) {
            attachPlayerListeners(found.player);
        }
        return found;
    }

    // A paused player and a destroyed one look identical through the player object: both report
    // isPaused() and sit in Idle. The <video> tells them apart -- a user pause leaves the media
    // loaded, a decode error leaves readyState 0, no buffered ranges and no frame.
    function mediaIsTornDown() {
        try {
            const video = document.getElementsByTagName('video')[0];
            if (!video) {
                return false;
            }
            return video.readyState === 0 && video.buffered.length === 0 && !video.videoHeight;
        } catch {
            return false;
        }
    }

    // hev1 and hvc1 are the same decoder; everything else compares on the part before the first
    // dot. Duplicated from the worker's copy: different realms, and the worker is built from text.
    function codecFamilyOf(codecs) {
        const base = String(codecs || '').split(',')[0].trim().split('.')[0].toLowerCase();
        if (base === 'hev1' || base === 'hvc1') { return 'hevc'; }
        if (base.startsWith('avc')) { return 'avc'; }
        return base || '?';
    }

    // A hole in buffered is the defect the viewer sees: one range means clean. Sampled twice
    // because the first segments after a swap have not arrived when the break is declared over.
    function readBufferedRanges() {
        const video = document.getElementsByTagName('video')[0];
        if (!video || !video.buffered) { return null; }
        const out = [];
        for (let i = 0; i < video.buffered.length; i++) {
            out.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
        }
        return { at: video.currentTime, ranges: out, ready: video.readyState,
                 head: out.length ? out[0].start : null, tail: out.length ? out[out.length - 1].end : null };
    }

    function describeBuffered(sample) {
        if (!sample || !sample.ranges.length) { return 'no buffer'; }
        if (sample.ranges.length === 1) { return 'contiguous'; }
        const holes = [];
        for (let i = 1; i < sample.ranges.length; i++) {
            holes.push((sample.ranges[i].start - sample.ranges[i - 1].end).toFixed(3) + 's at ' +
                sample.ranges[i - 1].end.toFixed(3));
        }
        return sample.ranges.length + ' ranges, hole(s) ' + holes.join(', ');
    }

    // Stall census. MEASUREMENT ONLY: it never touches the player.
    // Three samples and the buffer head alongside the playhead, because a stall and a rebuilt media
    // element look identical on currentTime alone: if the buffer head jumps back too the timeline
    // was rebuilt. Both counts are kept -- stalls near an exit and stalls per minute of clear play
    // -- since the question is whether they cluster after a break.
    const STALL_WINDOW_MS = 30000;
    const Stalls = { seen: 0, nearExit: 0, clear: 0, during: 0, exits: 0, lastExitAt: null,
                     clearMs: 0, prevAt: null, prevCt: null, prevEl: null, frozen: 0, inStall: false,
                     aheadAtFreeze: null, latAtFreeze: null, lastStallAt: null };

    // The real latency, asked of the player instead of scraped from the panel (claim 083: the
    // facade exposes getLiveLatency). One read, and getPlayer is already cached.
    function readLiveLatency() {
        try {
            const v = getPlayer()?.player?.getLiveLatency?.();
            return (typeof v === 'number' && isFinite(v)) ? v : null;
        } catch (err) {
            return null;
        }
    }

    const Trim = { above: 0, cuts: 0, lastAt: 0, lastCut: null , lastStarveAt: null };

    // Trims the excess cushion by moving the playhead forward into buffer already downloaded.
    // Measured live on 27/08 on a natural degradation: latency 3.666 -> 1.673 in three seconds,
    // cushion 3.560 -> 1.452, no pause, readyState 4, playbackRate 1.
    function startLatencyTrim() {
        if (!Config.LatencyTrim) { return; }
        log('info', 'latency trim on: moves the playhead forward when the cushion stays above ' +
            Config.LatencyTrimThresholdSeconds + 's for ' +
            Config.LatencyTrimPersistenceSeconds + 's, leaving ' +
            Config.LatencyTrimResidualSeconds + 's, at most once every ' +
            Config.LatencyTrimCooldownSeconds + 's');
        setInterval(() => {
            try {
                const el = document.getElementsByTagName('video')[0];
                // Starvation is recorded before any early return: the guards below bail out first,
                // and detecting after them would never see the state we want to protect.
                if (el && el.buffered && el.buffered.length) {
                    var tail = el.buffered.end(el.buffered.length - 1);
                    if (el.readyState < 3 || (tail - el.currentTime) < 0.15) {
                        Trim.lastStarveAt = Date.now();
                    }
                }
                if (!el || el.paused || el.seeking || el.readyState < 4 || State.adActive ||
                    !el.buffered || !el.buffered.length) {
                    Trim.above = 0; return;
                }
                // Never while the player is already chasing: if it is speeding up it is working
                // its own way back, and the jump pulls the ground from under it. Measured: with the
                // trim off the player sits at 1.03x for whole minutes without ever getting there.
                if (el.playbackRate > 1.001) { Trim.above = 0; return; }
                // Never right after a stall: the high cushion there is not excess, it is the
                // defence the player is rebuilding. The signal cannot be our own census, which
                // undercounts -- starvation is observed here, on the same tick.
                if (Trim.lastStarveAt && (Date.now() - Trim.lastStarveAt) <
                    Config.LatencyTrimStallGraceSeconds * 1000) { Trim.above = 0; return; }
                const be = el.buffered.end(el.buffered.length - 1);
                const cushion = be - el.currentTime;
                if (!(cushion > Config.LatencyTrimThresholdSeconds)) { Trim.above = 0; return; }
                Trim.above += 1;
                if (Trim.above < Config.LatencyTrimPersistenceSeconds) { return; }
                const now = Date.now();
                if (Trim.lastAt && (now - Trim.lastAt) < Config.LatencyTrimCooldownSeconds * 1000) { return; }
                const target = be - Config.LatencyTrimResidualSeconds;
                const jump = target - el.currentTime;
                // A cut of a few tenths is not worth the jump: wait until it is.
                if (jump < 0.5) { Trim.above = 0; return; }
                Trim.above = 0; Trim.lastAt = now; Trim.cuts += 1;
                Trim.lastCut = { at: new Date().toISOString(), cushion: Math.round(cushion * 100) / 100,
                                 jump: Math.round(jump * 100) / 100 };
                log('warn', '[rate ' + el.playbackRate.toFixed(3) + ', rs ' + el.readyState +
                    ', last starve ' + (Trim.lastStarveAt ? Math.round((now - Trim.lastStarveAt) / 1000) + 's ago' : 'never') +
                    '] cushion stuck at ' + cushion.toFixed(2) + 's for ' +
                    Config.LatencyTrimPersistenceSeconds + 's -- moving the playhead forward ' +
                    jump.toFixed(2) + 's (no reload)');
                el.currentTime = target;
            } catch (err) { log('debug', 'latency trim error: ' + err); }
        }, 1000);
    }

    function startStallCensus() {
        if (!Config.TraceContinuity) { return; }
        setInterval(() => {
            try {
                const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                const gap = Stalls.prevAt === null ? 0 : now - Stalls.prevAt;
                const el = document.getElementsByTagName('video')[0] || null;
                const prevEl = Stalls.prevEl, prevCt = Stalls.prevCt;
                Stalls.prevAt = now;
                Stalls.prevEl = el;
                Stalls.prevCt = el ? el.currentTime : null;
                // A background tab throttles timers, and a late sample describes no interval at
                // all: it cannot be read as a stall, and its clear seconds must not be counted
                // either, or the denominator grows while the numerator does not.
                if (!el || el !== prevEl || prevCt === null || gap > 2000) {
                    Stalls.frozen = 0; Stalls.inStall = false; return;
                }
                // When it starves the player PAUSES the element, so bailing out on el.paused would
                // skip the stalls themselves. Starvation is told from a user pause by two things
                // together: buffer end against the playhead, and readyState down to 2.
                const tail = el.buffered.length ? el.buffered.end(el.buffered.length - 1) : null;
                const starving = el.paused && el.readyState <= 2 &&
                    tail !== null && (tail - el.currentTime) < 0.5;
                if (el.seeking || (el.paused && !starving)) {
                    Stalls.frozen = 0; Stalls.inStall = false; return;
                }
                const nearExit = Stalls.lastExitAt !== null && (now - Stalls.lastExitAt) <= STALL_WINDOW_MS;
                if (!State.adActive && !nearExit) { Stalls.clearMs += gap; }
                if (el.currentTime - prevCt > 0.05) { Stalls.frozen = 0; Stalls.inStall = false; return; }
                // Two consecutive frozen samples, not one: at 500ms a single frozen sample is also
                // just a long frame. And it counts on the edge, not repeatedly: a 10s stall is ONE
                // stall.
                Stalls.frozen++;
                // Read on the FIRST frozen sample, not at the declaration: by frozen>=2 the refill
                // has begun, and the trace reported 1.572s of buffer where there were 0.100.
                if (Stalls.frozen === 1) {
                    Stalls.lastStallAt = Date.now();
                    const atFreeze = readBufferedRanges();
                    Stalls.aheadAtFreeze = (atFreeze && atFreeze.tail !== null)
                        ? atFreeze.tail - atFreeze.at : null;
                    Stalls.latAtFreeze = readLiveLatency();
                }
                if (Stalls.frozen < 2 || Stalls.inStall) { return; }
                Stalls.inStall = true;
                Stalls.seen++;
                let where;
                if (State.adActive) { Stalls.during++; where = 'during a break'; }
                else if (nearExit) {
                    Stalls.nearExit++;
                    where = ((now - Stalls.lastExitAt) / 1000).toFixed(1) + 's after a break exit';
                } else { Stalls.clear++; where = 'in clear play'; }
                const ahead = Stalls.aheadAtFreeze;
                const lat = Stalls.latAtFreeze;
                log('warn', '[TRACE] stall #' + Stalls.seen + ' at ' + el.currentTime.toFixed(3) +
                    (ahead === null ? '' : ', buffer ' + ahead.toFixed(3) + 's ahead') +
                    (lat === null ? '' : ', latency ' + lat.toFixed(2) + 's') + ', ' + where +
                    ' -- ' + Stalls.nearExit + ' within ' + (STALL_WINDOW_MS / 1000) + 's of an exit over ' +
                    Stalls.exits + ' exit(s), ' + Stalls.clear + ' in ' +
                    (Stalls.clearMs / 60000).toFixed(1) + ' min of clear play' +
                    (Stalls.during ? ', ' + Stalls.during + ' during a break' : ''));
            } catch (err) {
                log('debug', 'stall census error: ' + err);
            }
        }, 500);
    }

    function reportExitBuffer() {
        // Read and cleared here, not at the bottom: the report has two early returns, and a value
        // that survives an unmeasurable exit is later subtracted from ANOTHER break's depth,
        // printing a delta that was never measured.
        const depthAtBreak = State.depthAtBreak;
        const latencyAtBreak = State.latencyAtBreak;
        const latencyAtHandover = State.latencyAtHandover;
        State.depthAtBreak = null;
        State.latencyAtBreak = null;
        State.latencyAtHandover = null;
        // The two ends must belong to the same playback: a channel change between the samples once
        // produced "STALLED -42.604s" while playback was perfectly smooth.
        const el0 = document.getElementsByTagName('video')[0] || null;
        const ch0 = Navigation.channel;
        const s0 = readBufferedRanges();
        // Elapsed time is MEASURED. setTimeout fires after "at least" N ms, never exactly N, and a
        // playhead advancing 8.004s in 8.004s of wall clock, read as "+8.004 over 8", looks like an
        // excess that is not there.
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const ground = () => {
            const el = document.getElementsByTagName('video')[0] || null;
            if (Navigation.channel !== ch0) { return 'the channel changed'; }
            if (el !== el0) { return 'the player replaced its video element'; }
            if (State.adActive) { return 'another ad started'; }
            return null;
        };
        const sign = n => (n >= 0 ? '+' : '') + n.toFixed(3) + 's';
        setTimeout(() => {
            const moved1 = ground();
            const s1 = readBufferedRanges();
            setTimeout(() => {
                const moved = moved1 || ground();
                if (moved) {
                    log('info', '[TRACE] break exit not measurable -- ' + moved + ' while sampling');
                    return;
                }
                const s2 = readBufferedRanges();
                if (!s2 || !s1) { log('warn', '[TRACE] break exit: no player to sample'); return; }
                const wall = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) / 1000;
                const advanced = s2.at - s1.at;                    // over the last 6s
                const jumped = s0 ? s2.at - s0.at : null;
                const headMoved = (s0 && s0.head !== null && s2.head !== null) ? s2.head - s0.head : null;
                // A timeline restart must be recognised BEFORE judging progress: if the timeline
                // restarted between the two samples, "how far it advanced" means nothing.
                const rebuilt = jumped !== null && headMoved !== null && jumped < -1 && headMoved < -1;
                let verdict;
                if (s2.ranges.length !== 1) { verdict = 'DEGRADED'; }
                else if (rebuilt) { verdict = 'CLEAN (timeline rebuilt at the exit)'; }
                else if (jumped !== null && jumped < -1) { verdict = 'DEGRADED (playhead seeked back)'; }
                else if (advanced < 4) { verdict = 'STALLED'; }
                else { verdict = 'CLEAN'; }
                log(verdict.indexOf('CLEAN') === 0 ? 'info' : 'warn',
                    '[TRACE] break exit ' + verdict + ' -- buffer ' + describeBuffered(s2) +
                    ', playhead ' + sign(advanced) + ' over the last 6s' +
                    (jumped === null ? '' : ', ' + sign(jumped) + ' in ' + wall.toFixed(3) + 's of wall clock') +
                    (headMoved === null ? '' : ', buffer head ' + sign(headMoved)) +
                    ', readyState ' + s2.ready +
                    (function () {
                        if (s2.tail === null) { return ''; }
                        const depth = s2.tail - s2.at;
                        if (typeof depthAtBreak !== 'number') { return ', depth ' + depth.toFixed(3) + 's'; }
                        return ', depth ' + depthAtBreak.toFixed(3) + 's -> ' + depth.toFixed(3) +
                            's (' + sign(depth - depthAtBreak) + ' across the break)';
                    })() +
                    (function () {
                        const now = readLiveLatency();
                        if (now === null) { return ''; }
                        const mid = (typeof latencyAtHandover === 'number')
                            ? latencyAtHandover.toFixed(2) + 's at the handover -> ' : '';
                        if (typeof latencyAtBreak !== 'number') { return ', latency ' + mid + now.toFixed(2) + 's'; }
                        return ', latency ' + latencyAtBreak.toFixed(2) + 's -> ' + mid + now.toFixed(2) +
                            's (' + sign(now - latencyAtBreak) + ' across the break' +
                            (typeof latencyAtHandover === 'number'
                                ? ': ' + sign(latencyAtHandover - latencyAtBreak) + ' during, ' +
                                  sign(now - latencyAtHandover) + ' after'
                                : '') + ')';
                    })());
            }, 6000);
        }, 2000);
    }

    function describePlayback() {
        try {
            const player = getPlayer()?.player;
            const quality = player?.getQuality?.();
            if (!quality) {
                return 'quality unknown';
            }
            const mine = codecFamilyOf(quality.codecs);
            let siblings = '';
            try {
                const ladder = player.getQualities?.() || [];
                const same = ladder.filter((q) => codecFamilyOf(q.codecs) === mine).length;
                siblings = ', ' + same + '/' + ladder.length + ' variant(s) share the codec';
            } catch {}
            // The label is the player's opinion and goes stale during a backup swap: it keeps the
            // name it had while we hand it a different variant. videoWidth is what was decoded.
            let real = '';
            try {
                const video = document.getElementsByTagName('video')[0];
                if (video?.videoWidth) {
                    const actual = video.videoWidth + 'x' + video.videoHeight;
                    real = ' [decoding ' + actual + (actual === quality.width + 'x' + quality.height
                        ? '' : ' -- NOT what the label says') + ']';
                }
            } catch {}
            return quality.name + ' ' + mine + ' (' + quality.codecs + ')' + siblings + real;
        } catch (err) {
            return 'quality unreadable: ' + err;
        }
    }

    // Codec step-down, the escape hatch from stripping. On an hevc-source channel a same-codec
    // backup search has one candidate; stepping down to the top avc rung unlocks five.
    // Must be the player's own setQuality: handing an avc playlist to a pipeline opened for hevc
    // stops playback dead, while setQuality rebuilds it.
    // wasAuto matters as much as the name -- setQuality leaves automatic mode, so restoring only the
    // name would pin an Auto viewer to a rung they never chose.
    const QualityFallback = { originalName: null, wasAuto: false, active: false };

    function stepDownFromStrippedCodec() {
        if (!Config.StepDownCodecInsteadOfStripping || QualityFallback.active) {
            return;
        }
        try {
            const player = getPlayer()?.player;
            const current = player?.getQuality?.();
            const ladder = player?.getQualities?.() || [];
            if (!current || !ladder.length) {
                log('warn', 'wanted to step down out of stripping but the quality ladder is unreadable');
                return;
            }
            const mine = codecFamilyOf(current.codecs);
            const pixels = (q) => (q.width || 0) * (q.height || 0);
            const others = ladder.filter((q) => codecFamilyOf(q.codecs) !== mine);
            if (!others.length) {
                log('warn', 'stripping with no way out: every variant in the ladder is ' + mine);
                return;
            }
            // Down, never up. Where the only hevc rung is the source, a viewer on 360p avc has one
            // other-family option and it is that 2k source -- they picked 360p for a reason, and an
            // ad break is not the moment to overrule it.
            const affordable = others
                .filter((q) => pixels(q) <= pixels(current))
                .sort((a, b) => pixels(b) - pixels(a));
            if (!affordable.length) {
                log('warn', 'not stepping down: the only ' +
                    codecFamilyOf(others[0].codecs) + ' variant available is ' + others[0].name +
                    ', larger than the ' + current.name + ' being watched -- staying on stripping' +
                    ' rather than forcing a higher bitrate');
                return;
            }
            const target = affordable[0];
            QualityFallback.originalName = current.name;
            QualityFallback.wasAuto = !!player.isAutoQualityMode?.();
            QualityFallback.active = true;
            player.setQuality(target);
            // Told to the worker rather than inferred: setQuality restarts the player at the bottom
            // of the ladder, so anything read from it for the next few seconds names the wrong
            // rendition, and the backup search only gets one shot.
            postToWorkers({
                key: 'PreferVariant',
                value: {
                    resolution: target.width + 'x' + target.height,
                    frameRate: target.framerate || target.frameRate || null,
                    codecs: target.codecs
                }
            });
            log('info', 'stepping down from ' + current.name + ' ' + mine + ' to ' + target.name + ' ' +
                codecFamilyOf(target.codecs) + ' so the backup search has variants to pick from' +
                ' -- will return to ' + (QualityFallback.wasAuto ? 'automatic quality' : current.name) +
                ' when the break ends');
        } catch (err) {
            QualityFallback.active = false;
            log('warn', 'codec step-down failed, staying on stripping: ' + err);
        }
    }

    function restoreQualityAfterAdBreak() {
        if (!QualityFallback.active) {
            return;
        }
        const wanted = QualityFallback.originalName;
        const wasAuto = QualityFallback.wasAuto;
        QualityFallback.active = false;
        // Leaving the override in place would aim every later break at a rendition nobody asked for.
        postToWorkers({ key: 'PreferVariant', value: null });
        QualityFallback.originalName = null;
        QualityFallback.wasAuto = false;
        try {
            const player = getPlayer()?.player;
            if (wasAuto) {
                player.setAutoQualityMode(true);
                log('info', 'break over, handing quality back to automatic');
                return;
            }
            // By name: the ladder is rebuilt across a break, and the old objects are not the ones
            // setQuality accepts.
            const target = (player?.getQualities?.() || []).find((q) => q.name === wanted);
            if (!target) {
                log('warn', 'cannot return to ' + wanted + ', it is no longer in the ladder');
                return;
            }
            player.setQuality(target);
            log('info', 'break over, returning to ' + wanted);
        } catch (err) {
            log('warn', 'could not return to ' + (wasAuto ? 'automatic quality' : wanted) + ': ' + err);
        }
    }

    let lastReloadAt = 0;

    function reloadPlayer() {
        const found = ensurePlayerWired();
        if (!found) {
            log('warn', 'asked to reload but the player could not be found');
            return;
        }
        // Never act on a pause the user made -- unless the media is gone, in which case there is
        // no user pause to respect.
        if ((found.player.isPaused?.() || found.player.core?.paused) && !mediaIsTornDown()) {
            log('debug', 'skipping reload, the player is paused');
            return;
        }
        const sinceLast = Date.now() - lastReloadAt;
        if (lastReloadAt && sinceLast < Config.ReloadCooldownSeconds * 1000) {
            // Repeating a reload that settled nothing is what turns a mitigation into a loop.
            log('warn', 'second reload requested ' + Math.round(sinceLast / 1000) + 's after the last one' +
                ' -- using pause/play instead, the reload is not settling the break');
            pauseResumePlayer();
            return;
        }
        lastReloadAt = Date.now();
        State.counters.reloads++;
        log('info', 'reloading the player');
        try {
            found.controller.setSrc({
                isNewMediaPlayerInstance: true,
                refreshAccessToken: Config.RefreshTokenOnReload
            });
            playerCache = null;
        } catch (err) {
            log('warn', 'setSrc failed: ' + err);
            return;
        }
        postToWorkers({ key: 'PlayerReloaded' });
        playPlayer(found.player, 'reload');
        verifyResumed(true);
    }

    function pauseResumePlayer() {
        const found = ensurePlayerWired();
        if (!found || found.player.isPaused?.() || found.player.core?.paused) {
            return;
        }
        try {
            found.player.pause();
        } catch (err) {
            log('warn', 'pause failed: ' + err);
            return;
        }
        playPlayer(found.player, 'pause/play');
        verifyResumed(true);
    }

    // Coarse and off by default: player-core already recovers shallow underruns. The only gap
    // worth covering is a player frozen long enough that nobody is coming for it.
    // The player is not stalled: it is gone outright, and player-core does not retry.
    function startDeadPlayerWatch() {
        if (!Config.RecoverDeadPlayer) {
            return;
        }
        let everHealthy = false;
        let deadSince = 0;
        let reported = false;
        setInterval(() => {
            try {
                if (!mediaIsTornDown()) {
                    // One healthy sample licenses the watcher: without it a destroyed player and a
                    // page still loading look the same.
                    everHealthy = true;
                    deadSince = 0;
                    reported = false;
                    return;
                }
                if (!everHealthy) {
                    return;
                }
                if (!deadSince) {
                    deadSince = Date.now();
                    return;
                }
                const downFor = Math.round((Date.now() - deadSince) / 1000);
                if (downFor < Config.DeadPlayerSeconds) {
                    return;
                }
                if (!reported) {
                    reported = true;
                    State.counters.deadPlayers++;
                    log('warn', 'the player is gone -- no media, no buffer, ' + downFor + 's' +
                        (State.adActive ? ' (during an ad break' +
                            (State.strippingSegments ? ', while stripping segments' : '') + ')' : '') +
                        '; reloading it');
                }
                deadSince = Date.now();
                State.counters.recoveries++;
                reloadPlayer();
            } catch (err) {
                log('debug', 'dead-player watch error: ' + err);
            }
        }, 3000);
    }

    function updateBanner() {
        if (!Config.ShowBanner) {
            return;
        }
        const root = document.querySelector('.video-player');
        if (!root) {
            return;
        }
        let overlay = root.querySelector('.vaft2-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'vaft2-overlay';
            overlay.innerHTML = '<div style="color:white;background-color:rgba(0,0,0,0.8);position:absolute;top:0;left:0;padding:5px;"><p></p></div>';
            overlay.style.display = 'none';
            root.appendChild(overlay);
        }
        const text = overlay.querySelector('p');
        if (text) {
            // No backup player type: the banner ends up in screenshots and recordings. It stays in
            // the console and in status(). Stripping stays, it warns the picture is about to freeze.
            text.textContent = 'Blocking' + (State.adIsMidroll ? ' midroll' : '') + ' ads' +
                (State.strippingSegments ? ' (stripping)' : '');
        }
        overlay.style.display = State.adActive ? 'block' : 'none';
    }

    // Switching channel replaces the stream without a reload, and the playlist that would report
    // the end of the break stops being polled. Nothing expires on its own.
    const Navigation = { channel: null, left: null };

    // A playlist response for the channel being left can land after the reset and repopulate it.
    // Narrow on purpose: dropping everything that is not the current channel would also drop real
    // breaks on embed players, where the location names no channel at all.
    function messageIsStale(data) {
        const channel = data.channel && String(data.channel).toLowerCase();
        if (!channel || channel === 'simulation' || !Navigation.left) {
            return false;
        }
        return channel === Navigation.left && channel !== Navigation.channel;
    }

    // Not exhaustive on purpose: a page mistaken for a channel still reads as a change on the way out.
    const NOT_A_CHANNEL = {
        directory: 1, videos: 1, settings: 1, subscriptions: 1, wallet: 1, drops: 1,
        friends: 1, downloads: 1, jobs: 1, turbo: 1, prime: 1, search: 1, u: 1, p: 1, '': 1
    };

    function channelFromLocation() {
        try {
            const parts = document.location.pathname.split('/').filter(Boolean);
            if (!parts.length) {
                return null;
            }
            if (parts[0] === 'popout' || parts[0] === 'moderator') {
                return parts[1] ? parts[1].toLowerCase() : null;
            }
            return NOT_A_CHANNEL[parts[0]] ? null : parts[0].toLowerCase();
        } catch (err) {
            log('debug', 'could not read a channel from the location: ' + err);
            return null;
        }
    }

    function resetForChannelChange(previous, next, how) {
        const carried = State.adActive || QualityFallback.active;
        Navigation.left = previous;
        State.adActive = false;
        State.adIsMidroll = false;
        State.activeBackupPlayerType = null;
        State.strippingSegments = false;
        State.playerAdEvent = null;
        // Buffer depth belongs to the playback that measured it: comparing it with another
        // channel's is the same mistake as the "STALLED -42.604s" one.
        State.depthAtBreak = null;
        State.latencyAtBreak = null;
        State.latencyAtHandover = null;
        Stalls.lastExitAt = null;
        Stalls.prevEl = null;
        Stalls.prevCt = null;
        Stalls.frozen = 0;
        Stalls.inStall = false;
        clearOnce('blocking');
        clearOnce('leak');

        // setQuality is what took the viewer out of automatic, so that much is ours to undo. The
        // remembered rung is not re-applied: it names a ladder that no longer exists.
        const stepped = QualityFallback.active;
        const wasAuto = QualityFallback.wasAuto;
        QualityFallback.active = false;
        QualityFallback.originalName = null;
        QualityFallback.wasAuto = false;
        if (stepped && wasAuto) {
            try {
                getPlayer()?.player?.setAutoQualityMode(true);
            } catch (err) {
                log('debug', 'could not hand quality back to automatic after a channel change: ' + err);
            }
        }

        // Releases the worker's copy of the break and the step-down's variant preference.
        postToWorkers({ key: 'ChannelChanged', value: previous });

        // Swept, not left to updateBanner: that only reaches the overlay under the current
        // .video-player, and React may have replaced it.
        try {
            document.querySelectorAll('.vaft2-overlay').forEach((el) => { el.style.display = 'none'; });
        } catch (err) {
            log('debug', 'could not hide the banner after a channel change: ' + err);
        }
        updateBanner();

        // No pause/play and no reload: Twitch is already rebuilding the stream.
        if (carried) {
            log('info', 'left the channel mid-break -- state cleared');
        } else {
            log('debug', 'channel changed (nothing carried) via ' + how);
        }
    }

    // Keyed on history rather than on anything of Twitch's: pushState, replaceState and popstate are
    // the only ways a single-page app changes the URL, and they do not get renamed in a rebuild.
    function installNavigationWatch() {
        Navigation.channel = channelFromLocation();
        // how is logged: every change arriving as 'poll' means the history hooks are not reached.
        const onNavigate = (how) => {
            try {
                const next = channelFromLocation();
                if (next === Navigation.channel) {
                    return;
                }
                const previous = Navigation.channel;
                Navigation.channel = next;
                playerCache = null;
                resetForChannelChange(previous, next, how);
            } catch (err) {
                log('debug', 'navigation watch error: ' + err);
            }
        };
        ['pushState', 'replaceState'].forEach((name) => {
            const original = history[name];
            if (typeof original !== 'function') {
                return;
            }
            history[name] = function () {
                const result = original.apply(this, arguments);
                // After the call: the location only updates once the original has run.
                onNavigate(name);
                return result;
            };
        });
        window.addEventListener('popstate', () => onNavigate('popstate'));
        // Backstop for a navigation landing through neither: two seconds of stale banner at worst,
        // against the state staying stuck for the session.
        setInterval(() => onNavigate('poll'), 2000);
    }

    // Keys on the one effect no implementation can avoid: the video getting smaller than its
    // container. Recorded into a rolling buffer -- by the time it is noticed the DOM is clean.
    const OverlayAds = {
        pbypInstance: null,
        buffer: [],
        bufferLimit: 180,
        anomalyActive: false,
        seen: 0,
        styleEl: null,
        hidden: [],
        strip: null
    };

    function findPictureByPictureContext() {
        const rootNode = document.querySelector('#root');
        const key = rootNode && Object.keys(rootNode).find((x) => x.startsWith('__reactContainer'));
        if (!key) {
            return null;
        }
        const seen = new Set();
        let found = null;
        (function walk(node, depth) {
            if (!node || found || depth > 4000 || seen.has(node)) {
                return;
            }
            seen.add(node);
            const state = node.stateNode && node.stateNode.state;
            if (state && typeof state === 'object' &&
                ('isShowingMirrorPbyPAdPod' in state || 'mirrorPbyPAdMetadata' in state)) {
                found = node.stateNode;
                return;
            }
            let child = node.child;
            while (child && !found) {
                walk(child, depth + 1);
                child = child.sibling;
            }
        })(rootNode[key], 0);
        return found;
    }

    function sampleOverlayState() {
        const video = document.getElementsByTagName('video')[0];
        const container = document.querySelector('.video-player');
        const videoRect = video ? video.getBoundingClientRect() : null;
        const containerRect = container ? container.getBoundingClientRect() : null;
        const iframes = [...document.querySelectorAll('iframe')].map((f) => String(f.src).slice(0, 90));

        if (!OverlayAds.pbypInstance || !OverlayAds.pbypInstance.state) {
            OverlayAds.pbypInstance = findPictureByPictureContext();
        }
        const pbyp = OverlayAds.pbypInstance && OverlayAds.pbypInstance.state;

        return {
            t: new Date().toISOString().slice(11, 19),
            vw: videoRect ? Math.round(videoRect.width) : null,
            vh: videoRect ? Math.round(videoRect.height) : null,
            cw: containerRect ? Math.round(containerRect.width) : null,
            ch: containerRect ? Math.round(containerRect.height) : null,
            // Normal playback sits at 1.
            ratio: videoRect && containerRect && containerRect.width
                ? Math.round((videoRect.width / containerRect.width) * 100) / 100
                : null,
            // Letterboxing shrinks the picture legitimately when the container is not the stream's
            // aspect. A squeezeback leaves the two aspects equal: the box could have fitted the
            // whole picture and did not.
            videoAspect: videoRect && videoRect.height
                ? Math.round((videoRect.width / videoRect.height) * 100) / 100 : null,
            containerAspect: containerRect && containerRect.height
                ? Math.round((containerRect.width / containerRect.height) * 100) / 100 : null,
            iframes: iframes.length,
            adIframes: iframes.filter((s) => /amazon-adsystem|doubleclick|imasdk/.test(s)).length,
            iframeList: iframes,
            streamAd: State.adActive,
            playerState: (() => { try { return getPlayer()?.player?.getState?.(); } catch { return null; } })(),
            pbyp: pbyp ? {
                isShowing: pbyp.isShowing, showingMirrorPod: pbyp.isShowingMirrorPbyPAdPod,
                status: pbyp.status, rollType: pbyp.rollType, adSessionID: pbyp.adSessionID,
                hasMetadata: !!pbyp.mirrorPbyPAdMetadata
            } : null
        };
    }

    function pollOverlayAds() {
        try {
            const sample = sampleOverlayState();
            OverlayAds.buffer.push(sample);
            if (OverlayAds.buffer.length > OverlayAds.bufferLimit) {
                OverlayAds.buffer.shift();
            }
            // Iframe count is recorded but is NOT a trigger: it fired on every page load. Aspect
            // equality is what separates a squeezeback from letterboxing.
            const sameAspect = sample.videoAspect !== null && sample.containerAspect !== null &&
                Math.abs(sample.videoAspect - sample.containerAspect) <= sample.containerAspect * 0.05;
            const shrunk = sample.ratio !== null && sample.ratio < 0.9 && sameAspect;
            // hasMetadata is out: it means the subsystem has metadata loaded, not that an ad is on
            // screen. Every occurrence with it as the only true field had no mini player up.
            const pbypActive = !!(sample.pbyp && (sample.pbyp.showingMirrorPod || sample.pbyp.isShowing ||
                sample.pbyp.rollType || sample.pbyp.adSessionID));
            const anomalous = shrunk || pbypActive;

            if (anomalous && !OverlayAds.anomalyActive) {
                OverlayAds.anomalyActive = true;
                OverlayAds.seen++;
                State.counters.overlayAds = OverlayAds.seen;
                log('warn', 'OVERLAY AD suspected (shrunk=' + shrunk +
                    ' pbypActive=' + pbypActive + ') -- ' + JSON.stringify(sample));
                log('debug', 'OVERLAY AD layout: ' + JSON.stringify(describeOverlayLayout()));
                // What moved first is what a future detector should key on.
                const before = OverlayAds.buffer.slice(-21, -1);
                log('debug', 'OVERLAY AD preceding 20 samples: ' + JSON.stringify(before));
            } else if (!anomalous && OverlayAds.anomalyActive) {
                OverlayAds.anomalyActive = false;
                log('warn', 'OVERLAY AD ended -- ' + JSON.stringify(sample));
            }
        } catch (err) {
            log('debug', 'overlay-ad poll error: ' + err);
        }
    }

    // Observation only. Twitch's class names are hashed and change between builds, so this records
    // what was there rather than matching by name.
    function describeOverlayLayout() {
        const video = document.getElementsByTagName('video')[0];
        if (!video) {
            return { err: 'no video' };
        }
        const box = (el) => {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        };
        const chain = [];
        for (let node = video, i = 0; node && node.tagName !== 'BODY' && i < 8; node = node.parentElement, i++) {
            chain.push(Object.assign({
                tag: node.tagName,
                cls: String(node.className || '').split(' ').slice(0, 3).join(' ').slice(0, 60),
                inline: (node.getAttribute('style') || '').slice(0, 140)
            }, box(node)));
        }
        return { chain };
    }

    // -- client-side ad manager ---------------------------------------------------------------
    // Found through webpack's module registry by the names of its static methods, which
    // minification keeps. No module id, asset hash or url is hardcoded, so it survives releases.
    const AdManager = { applied: false, attempts: 0, reason: null, moduleId: null };

    function webpackRequire() {
        const key = Object.keys(window).find((k) => /^webpackChunk/i.test(k));
        const queue = key ? window[key] : null;
        if (!queue || typeof queue.push !== 'function') {
            return null;
        }
        // The runtime callback fires synchronously, but only once webpack owns the array. Before
        // that this is a plain append, so the entry has to be taken back out.
        let req = null;
        const entry = [[Symbol('vaft2')], {}, (r) => { req = r; }];
        queue.push(entry);
        if (!req) {
            const at = queue.indexOf(entry);
            if (at !== -1) {
                queue.splice(at, 1);
            }
            return null;
        }
        return req;
    }

    function findAdManagerClass(req) {
        const factories = req.m || {};
        for (const id of Object.keys(factories)) {
            let source;
            try {
                source = Function.prototype.toString.call(factories[id]);
            } catch { continue; }
            // Both markers: the component that calls startProcessingRequests matches the first
            // alone and does not hold the class.
            if (source.indexOf('startProcessingRequests') === -1 || source.indexOf('declineReason') === -1) {
                continue;
            }
            let exports;
            try {
                exports = req(id);
            } catch { continue; }
            if (!exports) {
                continue;
            }
            for (const name of Object.keys(exports)) {
                let value;
                try {
                    value = exports[name];
                } catch { continue; }
                if (typeof value === 'function'
                    && typeof value.startProcessingRequests === 'function'
                    && typeof value.decline === 'function') {
                    return { id, name, manager: value };
                }
            }
        }
        return null;
    }

    function declineClientSideAds() {
        const req = webpackRequire();
        if (!req) {
            return false;
        }
        const found = findAdManagerClass(req);
        if (!found) {
            return false;
        }
        AdManager.moduleId = found.id + '.' + found.name;
        if (found.manager.declineReason) {
            // Twitch got there first -- turbo, an experiment, a savant flag. Logged apart only so
            // the reason is attributable.
            AdManager.applied = true;
            AdManager.reason = String(found.manager.declineReason);
            log('info', 'client-side ad manager was already declined by Twitch (' + AdManager.reason + ')');
            return true;
        }
        // {sendEvent:false} is their own switch for not reporting the decline, so this costs no
        // telemetry -- unlike faking currentUser.hasTurbo, which reaches the same gate but is
        // echoed back to them on every pageview.
        found.manager.decline(Config.AdDeclineReason, { sendEvent: false });
        AdManager.reason = String(found.manager.declineReason || '');
        AdManager.applied = !!AdManager.reason;
        if (!AdManager.applied) {
            log('warn', 'ad manager found at ' + AdManager.moduleId + ' but decline did not take');
            return false;
        }
        log('info', 'client-side ad manager declined at ' + AdManager.moduleId
            + ' (' + AdManager.reason + ') -- display ads will not be requested');
        return true;
    }

    function startAdManagerDecline() {
        if (!Config.DeclineClientSideAds) {
            return;
        }
        // Applying before Twitch calls startProcessingRequests() is the point: the queue checks
        // declineReason when it drains, so the first request of the session never leaves either.
        (function attempt() {
            AdManager.attempts++;
            let done = false;
            try {
                done = declineClientSideAds();
            } catch (err) {
                log('debug', 'ad manager lookup failed: ' + (err?.message || err));
            }
            if (done) {
                return;
            }
            if (AdManager.attempts >= Config.AdDeclineAttempts) {
                log('warn', 'client-side ad manager not found after ' + AdManager.attempts
                    + ' attempts -- display ads are NOT blocked');
                return;
            }
            setTimeout(attempt, 500);
        })();
    }

    function startOverlayAdWatch() {
        if (!Config.WatchOverlayAds) {
            return;
        }
        // 500ms: fast enough that a shrink transition lands in the buffer, and it costs two
        // getBoundingClientRect calls.
        setInterval(pollOverlayAds, 500);
        pollOverlayAds();
    }

    // The worker cannot see the page's auth headers.
    const GQL = {
        clientId: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        deviceId: null,
        clientVersion: null,
        clientSession: null,
        integrity: null,
        authorization: undefined
    };

    async function performWorkerFetch(request) {
        try {
            const response = await window.__vaft2RealFetch(request.url, request.options);
            return {
                id: request.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: await response.text()
            };
        } catch (err) {
            return { id: request.id, error: err?.message || String(err) };
        }
    }

    function postToWorkers(message) {
        State.workers.forEach((worker) => {
            try {
                worker.postMessage(message);
            } catch (err) {
                log('debug', 'could not post to a worker: ' + err);
            }
        });
    }

    // fetch takes a string, a URL or a Request, and Twitch uses all three. Testing for a string
    // skipped the other two: fetch(new Request(url, {...})) never reached the pbyp denial, and its
    // body is not in init either -- it lives in the Request and only comes out through a clone.
    function urlOfRequest(input) {
        try {
            if (typeof input === 'string') { return input; }
            if (typeof URL !== 'undefined' && input instanceof URL) { return input.href; }
            if (input && typeof input.url === 'string') { return input.url; }
        } catch {}
        return '';
    }

    function installFetchHook() {
        const realFetch = window.fetch;
        window.__vaft2RealFetch = realFetch;

        window.fetch = function (input, init) {
            // Not async on purpose: anything thrown here escapes synchronously into Twitch's own
            // code, so every access below has to tolerate the shape it is given.
            const caller = this;
            const original = arguments;
            try {
                const url = urlOfRequest(input);
                if (url.includes('gql.twitch.tv')) {
                    captureGqlHeaders(init && init.headers ? init : input);
                    if (init && typeof init.body === 'string') {
                        const rewritten = rewriteGqlBody(init, realFetch);
                        if (rewritten) {
                            return rewritten;
                        }
                    } else if (input && typeof input.clone === 'function' && typeof input.text === 'function') {
                        // Reading a Request body consumes it, so the clone is not optional. On any
                        // failure the original call goes through untouched.
                        return input.clone().text().then((body) => {
                            const shim = { body, headers: input.headers };
                            const rewritten = rewriteGqlBody(shim, realFetch);
                            if (rewritten) {
                                return rewritten;
                            }
                            if (shim.body !== body) {
                                return realFetch.call(caller, new Request(input, { body: shim.body }));
                            }
                            return realFetch.apply(caller, original);
                        }).catch(() => realFetch.apply(caller, original));
                    }
                }
            } catch (err) {
                log('warn', 'fetch hook error, passing the request through untouched: ' + err);
            }
            return realFetch.apply(this, arguments);
        };
    }

    function readHeader(headers, name) {
        if (!headers) {
            return undefined;
        }
        // Headers.get is case-insensitive, a plain object is not, so neither shape can be handled
        // by bracket access alone.
        if (typeof headers.get === 'function') {
            return headers.get(name) ?? undefined;
        }
        if (headers[name] !== undefined) {
            return headers[name];
        }
        const lower = name.toLowerCase();
        const key = Object.keys(headers).find((x) => x.toLowerCase() === lower);
        return key === undefined ? undefined : headers[key];
    }

    function captureGqlHeaders(init) {
        const headers = init && init.headers;
        if (!headers) {
            return;
        }
        const pairs = [
            ['deviceId', readHeader(headers, 'X-Device-Id') ?? readHeader(headers, 'Device-ID'), 'UpdateDeviceId'],
            ['clientVersion', readHeader(headers, 'Client-Version'), 'UpdateClientVersion'],
            ['clientSession', readHeader(headers, 'Client-Session-Id'), 'UpdateClientSession'],
            ['integrity', readHeader(headers, 'Client-Integrity'), 'UpdateIntegrity'],
            ['authorization', readHeader(headers, 'Authorization'), 'UpdateAuthorization']
        ];
        for (const [field, value, message] of pairs) {
            if (typeof value === 'string' && GQL[field] !== value) {
                GQL[field] = value;
                postToWorkers({ key: message, value });
            }
        }
    }

    function rewriteGqlBody(init, realFetch) {
        if (!init || typeof init.body !== 'string' || !init.body.includes('PlaybackAccessToken')) {
            return null;
        }
        let parsed;
        try {
            parsed = JSON.parse(init.body);
        } catch {
            log('debug', 'unreadable PlaybackAccessToken body, left alone');
            return null;
        }
        const operations = Array.isArray(parsed) ? parsed : [parsed];
        const isPictureByPicture = (op) => typeof op?.variables?.playerType === 'string' &&
            op.variables.playerType.includes('picture-by-picture');

        // Mini player above chat. Denied locally rather than by sending something the server will
        // reject: a rejection shaped like an error is the kind Twitch retries.
        if (operations.length > 0 && operations.every(isPictureByPicture)) {
            const denied = () => ({ data: { streamPlaybackAccessToken: null, videoPlaybackAccessToken: null } });
            const body = Array.isArray(parsed) ? operations.map(denied) : denied();
            // At info: the only record that this defence runs at all.
            log('info', 'denied a picture-by-picture token locally');
            return Promise.resolve(new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }));
        }
        if (Array.isArray(parsed) && operations.some(isPictureByPicture)) {
            // Responses are matched by position, so the batch goes out without the mini-player
            // entries and their denials are spliced back at the indices they came from. Emptying
            // the body instead would take the real player's token down with it.
            const denyAt = [];
            const kept = [];
            operations.forEach((op, i) => { (isPictureByPicture(op) ? denyAt : kept).push(i); });
            log('debug', 'picture-by-picture batched with ' + kept.length + ' other operation(s)' +
                ' -- denying position(s) ' + denyAt.join(',') + ' and passing the rest');
            const trimmed = kept.map((i) => operations[i]);
            const outgoing = { ...init, body: JSON.stringify(trimmed) };
            return realFetch('https://gql.twitch.tv/gql', outgoing).then(async (response) => {
                if (response.status !== 200) { return response; }
                const answers = await response.json();
                const array = Array.isArray(answers) ? answers : [answers];
                const recomposed = [];
                let k = 0;
                operations.forEach((op, i) => {
                    recomposed[i] = isPictureByPicture(op)
                        ? { data: { streamPlaybackAccessToken: null, videoPlaybackAccessToken: null } }
                        : array[k++];
                });
                return new Response(JSON.stringify(recomposed), {
                    status: 200, headers: { 'Content-Type': 'application/json' }
                });
            }).catch((err) => {
                log('warn', 'splicing the picture-by-picture batch failed, sending it untouched: ' + err);
                return realFetch('https://gql.twitch.tv/gql', init);
            });
        }

        if (!Config.ForceAccessTokenPlayerType) {
            return null;
        }
        let replaced = null;
        for (const op of operations) {
            const current = op?.variables?.playerType;
            if (current && current !== Config.ForceAccessTokenPlayerType && !isPictureByPicture(op)) {
                replaced = current;
                op.variables.playerType = Config.ForceAccessTokenPlayerType;
            }
        }
        if (replaced) {
            init.body = JSON.stringify(parsed);
            logOnce('playerType', 'debug', "rewrote playerType '" + replaced + "' as '" + Config.ForceAccessTokenPlayerType + "'");
        }
        return null;
    }

    // Authored as worker code, not page functions put through toString(), so there is no hidden
    // dependency on page scope. No template literals below: this block is itself inside one.
    const WORKER_SOURCE = `
'use strict';

// VAFT2_INIT is prepended as a JSON literal. Config arrives embedded rather than by postMessage:
// Twitch's wasm worker reads every message delivered to the worker, took our Init as one of its own
// and threw during startup. Whatever still has to be sent is hidden from it below.
var CONFIG = VAFT2_INIT.config;
var GQLState = VAFT2_INIT.gql;

// Overrides stream.currentVariant when choosing a backup rendition: right after a codec step-down
// that is the bottom of the ladder, and a backup swap leaves no ladder to climb back up.
var preferredVariant = null;
var streamsByChannel = Object.create(null);
var streamsByPlaylistUrl = Object.create(null);
var adSegments = new Map();
var pendingFetches = new Map();
var lastReloadAt = 0;
var onceMessages = new Map();
var workerRealFetch = null;

// Zero bytes, because we never learn which codec the SourceBuffer was opened with. A one-frame
// mp4 with an avc1 sample description is harmless on h264 and fatal on hevc (Errore #3000).
// MSE treats an empty append as a no-op and the player still gets its 200.
function emptySegmentResponse() {
    return new Response(new ArrayBuffer(0), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': '0' }
    });
}

function wlog(level, message) {
    self.postMessage({ key: 'Log', level: level, message: message });
}

function wlogOnce(key, level, message) {
    if (onceMessages.get(key) === message) { return; }
    onceMessages.set(key, message);
    wlog(level, message);
}

// Cleared by prefix so every break reports its own state: a census suppressed because it matched
// the previous break's is the one case where seeing it twice is the point.
function wclearOnce(prefix) {
    onceMessages.forEach(function (value, key) {
        if (key.indexOf(prefix) === 0) { onceMessages.delete(key); }
    });
}

function parseAttributes(line) {
    var out = Object.create(null);
    var parts = line.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
        var idx = parts[i].indexOf('=');
        if (idx < 0) { continue; }
        var key = parts[i].substring(0, idx);
        var raw = parts[i].substring(idx + 1);
        var num = Number(raw);
        out[key] = Number.isNaN(num) ? (raw.charAt(0) === '"' ? JSON.parse(raw) : raw) : num;
    }
    return out;
}

// Both dialects tried regardless of what the URL suggested: the flag is derived from a URL that
// may not be the one this text came from, and a mismatch left a promise that never settled.
function readServerTime(text) {
    var v2 = text.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
    if (v2 && v2.length > 1) { return v2[1]; }
    var v1 = text.match(/SERVER-TIME="([0-9.]+)"/);
    return v1 && v1.length > 1 ? v1[1] : null;
}

function writeServerTime(text, serverTime) {
    if (!serverTime) { return text; }
    if (text.indexOf('#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME"') >= 0) {
        return text.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, '$1' + serverTime + '$2');
    }
    return text.replace(/(SERVER-TIME=")[0-9.]+"/, 'SERVER-TIME="' + serverTime + '"');
}

function gqlRequest(body) {
    // An invented device id must never travel with the page's real Client-Integrity: that looks
    // like a replay, the server burns the token, and the page's own requests start failing.
    var inventedDeviceId = false;
    if (!GQLState.deviceId) {
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        var id = '';
        for (var i = 0; i < 32; i++) { id += chars.charAt(Math.floor(Math.random() * chars.length)); }
        GQLState.deviceId = id;
        inventedDeviceId = true;
        GQLState.deviceIdInvented = true;
    }
    var headers = { 'Client-ID': GQLState.clientId, 'X-Device-Id': GQLState.deviceId };
    if (GQLState.authorization) { headers['Authorization'] = GQLState.authorization; }
    if (GQLState.integrity && !GQLState.deviceIdInvented) {
        headers['Client-Integrity'] = GQLState.integrity;
    } else if (GQLState.integrity) {
        wlogOnce('integrity-held', 'warn', 'holding back Client-Integrity: the device id is one we' +
            ' invented, and pairing the two would invalidate the token the page itself is using');
    }
    if (inventedDeviceId) {
        wlogOnce('device-invented', 'warn', 'no device id captured from the page yet, using a' +
            ' generated one for this request');
    }
    if (GQLState.clientVersion) { headers['Client-Version'] = GQLState.clientVersion; }
    if (GQLState.clientSession) { headers['Client-Session-Id'] = GQLState.clientSession; }
    return new Promise(function (resolve, reject) {
        var id = Math.random().toString(36).substring(2, 15);
        pendingFetches.set(id, { resolve: resolve, reject: reject });
        self.postMessage({
            key: 'FetchRequest',
            value: { id: id, url: 'https://gql.twitch.tv/gql', options: { method: 'POST', body: JSON.stringify(body), headers: headers } }
        });
    });
}

var PERSISTED_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
var TOKEN_QUERY = 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {' +
    ' streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }' +
    ' videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature }' +
    ' }';

// Twitch's own client sends the full document, so the hash is an optimisation: on the first
// refusal, switch for the session.
// Player types that must be asked for as a mobile client -- the same mobile_feed asked as web comes
// back stitched every time, so the exemption needs the pair.
var PLATFORM_MOBILE = { autoplay: 1, mobile_feed: 1 };

function requestAccessToken(channel, playerType) {
    var variables = {
        isLive: true, login: channel, isVod: false, vodID: '',
        playerType: playerType, platform: PLATFORM_MOBILE[playerType] ? 'android' : 'web'
    };
    var body = { operationName: 'PlaybackAccessToken', variables: variables };
    if (CONFIG.tokenMode === 'persisted') {
        body.extensions = { persistedQuery: { version: 1, sha256Hash: PERSISTED_HASH } };
    } else {
        body.query = TOKEN_QUERY;
    }
    return gqlRequest(body).then(function (response) {
        if (response.status !== 200) {
            throw new Error('token request returned ' + response.status);
        }
        return response.json();
    }).then(function (json) {
        if (json && json.data && json.data.streamPlaybackAccessToken) {
            return json.data.streamPlaybackAccessToken;
        }
        if (CONFIG.tokenMode === 'persisted') {
            CONFIG.tokenMode = 'document';
            self.postMessage({ key: 'TokenModeChanged', value: 'document' });
            wlog('debug', 'the persisted-query hash was refused; falling back to the full GQL document');
            return requestAccessToken(channel, playerType);
        }
        var errors = json && json.errors ? json.errors.map(function (e) { return e.message; }).join(', ') : 'no token in the response';
        throw new Error(errors);
    });
}

function buildUsherUrl(stream, token) {
    var url = new URL(stream.usherBase);
    url.searchParams.set('sig', token.signature);
    url.searchParams.set('token', token.value);
    return url.href;
}

// hev1 and hvc1 are both HEVC and interchangeable here; everything else is compared on the part
// before the first dot, which is what distinguishes the decoders.
function codecFamily(codecs) {
    if (!codecs) { return null; }
    var base = String(codecs).split(',')[0].trim().split('.')[0].toLowerCase();
    if (base === 'hev1' || base === 'hvc1') { return 'hevc'; }
    if (base.indexOf('avc') === 0) { return 'avc'; }
    if (base.indexOf('av0') === 0) { return 'av1'; }
    return base;
}

// Same codec is mandatory: handing an avc1 playlist to a player decoding hev1 stops it dead until
// the page is reloaded by hand. No compatible variant means null and the caller moves on.
function pickVariant(masterText, want) {
    var lines = masterText.replace(/\\r/g, '').split('\\n');
    var all = [];
    for (var i = 0; i < lines.length - 1; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0 || lines[i + 1].indexOf('.m3u8') < 0) { continue; }
        var attrs = parseAttributes(lines[i]);
        if (!attrs['RESOLUTION']) { continue; }
        all.push({ url: lines[i + 1], resolution: attrs['RESOLUTION'], frameRate: attrs['FRAME-RATE'], codecs: attrs['CODECS'] });
    }
    if (!all.length) { return null; }

    var pool = all;
    var wantFamily = want && codecFamily(want.codecs);
    if (wantFamily) {
        pool = all.filter(function (v) { return codecFamily(v.codecs) === wantFamily; });
        if (!pool.length) {
            wlogOnce('codec', 'warn', 'backup ladder carries no ' + wantFamily + ' variant while the player is decoding ' + wantFamily + ' - skipping it, a codec swap stops playback outright');
            return null;
        }
    }

    var wantPixels = 0;
    if (want && want.resolution) {
        var wh = want.resolution.split('x');
        wantPixels = Number(wh[0]) * Number(wh[1]);
    }
    // Ranked, not chosen: abandoning a player type because one rung is stitched throws away the
    // rest of a ladder already paid for. Usually every rendition is stitched at once, but the cost
    // of finding out is one playlist fetch.
    var ranked = pool.slice().map(function (v) {
        var parts = v.resolution.split('x');
        var px = Number(parts[0]) * Number(parts[1]);
        var sameRes = want && v.resolution === want.resolution;
        var sameFps = want && String(v.frameRate) === String(want.frameRate);
        return { url: v.url, resolution: v.resolution, rank: (sameRes && sameFps) ? -2 : (sameRes ? -1 : 1),
                 delta: Math.abs(px - wantPixels) };
    });
    ranked.sort(function (a, b) { return a.rank - b.rank || a.delta - b.delta; });
    return ranked;
}

// Everything the master declares, before our filtering. "Two candidates left" and "two renditions
// exist" look identical in pickVariant's output and mean very different things.
function describeMaster(text) {
    var lines = String(text).replace(/\\r/g, '').split('\\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0) { continue; }
        var attrs = parseAttributes(lines[i]);
        var next = lines[i + 1] === undefined ? '' : lines[i + 1];
        out.push((attrs['RESOLUTION'] || 'no-resolution') + '/' +
            String(attrs['CODECS'] || '?').split(',')[0].replace(/"/g, '') +
            (next.indexOf('.m3u8') < 0 ? '/not-a-playlist' : ''));
    }
    return out.length ? out.join(' ') : 'no #EXT-X-STREAM-INF at all';
}

function hasAdMarkers(text) {
    return text.indexOf(CONFIG.adSignifier) >= 0;
}

// Same predicate stripAds uses, counted rather than acted on.
function countAdSegments(text) {
    var lines = text.replace(/\\r/g, '').split('\\n');
    var n = 0;
    for (var i = 0; i < lines.length - 1; i++) {
        if (lines[i].indexOf('#EXTINF') === 0 && lines[i].indexOf(',live') < 0) { n++; }
    }
    return n;
}

// Removes ad segments and, while an ad is running, the low-latency prefetch hints -- a prefetched
// ad segment would be displayed before we ever saw the playlist entry for it.
function stripAds(text, stream) {
    var lines = text.replace(/\\r/g, '').split('\\n');
    var stripped = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
            .replace(/(X-TV-TWITCH-AD-URL=")[^"]*(")/g, '$1https://twitch.tv$2')
            .replace(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")[^"]*(")/g, '$1https://twitch.tv$2');
        lines[i] = line;
        if (i < lines.length - 1 && line.indexOf('#EXTINF') === 0 && line.indexOf(',live') < 0) {
            // Cached, NOT removed. Deleting the lines leaves a playlist with no media at all when
            // every segment is an ad: the player runs out of timeline, goes to Ended, and Twitch
            // renders the channel as offline. Kept, they are answered with an empty body instead.
            adSegments.set(lines[i + 1], Date.now());
            stripped = true;
        }
    }
    if (stripped) {
        // Prefetch hints do get removed: a prefetched ad segment is displayed before we ever see
        // the playlist entry that would have let us cache it.
        for (var j = 0; j < lines.length; j++) {
            if (lines[j].indexOf('#EXT-X-TWITCH-PREFETCH:') === 0) { lines[j] = ''; }
        }
    }
    var cutoff = Date.now() - 120000;
    adSegments.forEach(function (at, key) { if (at < cutoff) { adSegments.delete(key); } });
    stream.stripping = stripped;
    return lines.filter(function (l) { return l !== ''; }).join('\\n');
}

// On seeing the ad DATERANGEs the player leaves low latency and doubles its buffer target. The
// backup never carries them, so without this it crosses the seam with half its own protection.
// Content stays clean; only the markers are carried, with tracking URLs sanitised as in stripAds.

function carryAdMarkers(origText, servedText) {
    if (!CONFIG.carryAdMarkers) { return servedText; }
    if (typeof servedText !== 'string' || typeof origText !== 'string') { return servedText; }
    // Already present (the stripping path): do not duplicate them.
    if (servedText.indexOf(CONFIG.adSignifier) >= 0) { return servedText; }
    var lines = origText.replace(/\\r/g, '').split('\\n'), markers = [];
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('#EXT-X-DATERANGE:') !== 0) { continue; }
        if (lines[i].indexOf(CONFIG.adSignifier) < 0) { continue; }
        markers.push(lines[i]
            .replace(/(X-TV-TWITCH-AD-URL=")[^"]*(")/g, '$1https://twitch.tv$2')
            .replace(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")[^"]*(")/g, '$1https://twitch.tv$2'));
    }
    if (!markers.length) { return servedText; }
    // At the top, before the first segment: DATERANGEs belong in the header. If no insertion
    // point is found the text is left as it is rather than inventing one.
    var out = lines.length ? servedText.replace(/\\r/g, '').split('\\n') : null;
    if (!out) { return servedText; }
    var at = -1;
    for (var j = 0; j < out.length; j++) {
        var r = out[j];
        if (r.indexOf('#EXT-X-PROGRAM-DATE-TIME:') === 0 || r.indexOf('#EXTINF') === 0 ||
            r.indexOf('#EXT-X-MAP') === 0) { at = j; break; }
    }
    if (at < 0) { return servedText; }
    return out.slice(0, at).concat(markers, out.slice(at)).join('\\n');
}

// A master only changes when the stream restarts, but fetching one costs a GQL token round-trip
// bridged through the page plus an usher request. Uncached, every playlist poll during a break
// repeated that for every player type: up to nine round-trips every couple of seconds.
function fetchBackupMaster(stream, playerType, realFetch) {
    if (stream.backupMasters[playerType]) {
        return Promise.resolve(stream.backupMasters[playerType]);
    }
    return requestAccessToken(stream.channel, playerType)
        .then(function (token) { return realFetch(buildUsherUrl(stream, token)); })
        .then(function (response) {
            if (response.status !== 200) { throw new Error('usher returned ' + response.status); }
            return response.text();
        })
        .then(function (text) {
            stream.backupMasters[playerType] = text;
            return text;
        });
}

// Resolves to the playlist text if this player type is currently ad-free, null if it still has
// ads, and rejects if it could not be reached at all -- three outcomes the caller treats apart.
function tryPlayerType(stream, playerType, realFetch) {
    return fetchBackupMaster(stream, playerType, realFetch)
        .then(function (masterText) {
            var want = preferredVariant || stream.currentVariant;
            var candidates = pickVariant(masterText, want);
            if (!candidates || !candidates.length) {
                throw new Error('no comparable variant in the backup ladder');
            }
            // Aiming badly and being offered nothing better look identical from the picture alone.
            wlogOnce('rungs:' + playerType, 'debug', playerType + ' master declares [' +
                describeMaster(masterText) + '] -- of which usable ' +
                candidates.map(function (v) { return v.resolution; }).join(', ') +
                ' -- aiming at ' + ((want && want.resolution) || 'unknown') +
                (preferredVariant ? ' (asked for by the page)' : ' (what the player is on)'));
            // Stay on the rendition this break picked: pinning only the player type let the encode
            // change under the player -- another resolution, another EXT-X-MAP -- while the
            // renumbering still claimed the segments were contiguous.
            // Released when the player moves on its own, or a reload during a preroll would hold the
            // whole break on the rung it woke up at.
            if (stream.activeVariantUrl && want && stream.servedResolution &&
                want.resolution !== stream.servedResolution) {
                stream.activeVariantUrl = null;
            }

            var pinned = -1;
            if (stream.activeVariantUrl) {
                for (var p = 0; p < candidates.length; p++) {
                    if (candidates[p].url === stream.activeVariantUrl) { pinned = p; break; }
                }
                if (pinned > 0) { candidates = [candidates[pinned]].concat(candidates.slice(0, pinned), candidates.slice(pinned + 1)); }
            }

            var i = 0;
            function attempt() {
                // Do not log the urls to chase an external probe finding this player type clean:
                // they are identical down to the token. The discriminator is the request context --
                // the same usher url returns stitched variants when fetched from the browser.
                if (i >= candidates.length) { return Promise.resolve(null); }
                var index = i++;
                return realFetch(candidates[index].url)
                    .then(function (response) {
                        if (response.status !== 200) {
                            // A cached master outlives its variant urls when the stream restarts.
                            stream.backupMasters[playerType] = null;
                            throw new Error('backup playlist returned ' + response.status);
                        }
                        return response.text();
                    })
                    .then(function (text) {
                        if (!text) { throw new Error('empty backup playlist'); }
                        if (!hasAdMarkers(text)) {
                            // The player keeps the label it had when we swapped the playlist under
                            // it, so its own reading is worthless during a break.
                            stream.servedResolution = candidates[index].resolution;
                            if (stream.activeVariantUrl !== candidates[index].url) {
                                if (stream.activeVariantUrl) {
                                    wlog('info', 'backup rendition changed mid-break to ' +
                                        candidates[index].resolution + ' -- the previous one is gone or stitched');
                                }
                                stream.activeVariantUrl = candidates[index].url;
                            }
                            if (index > 0) {
                                wlog('info', 'backup via ' + playerType + ' was stitched at the' +
                                    ' closest rendition, took rendition ' + (index + 1) + ' of ' +
                                    candidates.length + ' instead');
                            }
                            return text;
                        }
                        return attempt();
                    });
            }
            return attempt();
        });
}

function searchPlayerTypes(stream, realFetch) {
    var index = 0;
    function attempt() {
        if (index >= CONFIG.backupPlayerTypes.length) {
            return Promise.resolve(null);
        }
        var playerType = CONFIG.backupPlayerTypes[index++];
        return tryPlayerType(stream, playerType, realFetch)
            .then(function (text) {
                if (!text) {
                    // At info: this is the line that explains a break ending up at 640x360, and
                    // without it the only visible trace is the low resolution itself.
                    wlog('info', 'backup via ' + playerType + ' had ads at every rendition,' +
                        ' trying the next player type');
                    return attempt();
                }
                stream.activeBackup = playerType;
                // On adoption only, not every poll: the first segment is the only one that pays
                // the trip to the origin.
                warmBackupSegments(text, realFetch);
                return { playerType: playerType, text: text };
            })
            .catch(function (err) {
                wlogOnce('backup:' + playerType, 'debug', 'backup stream unavailable via ' + playerType + ': ' + (err && err.message ? err.message : err));
                return attempt();
            });
    }
    return attempt();
}

// Warms the CDN edge before the player asks: a Range slice is enough, what matters is that the
// edge goes to the origin. Blocks nothing and never fails visibly.
var warmed = {};
function warmBackupSegments(text, realFetch) {
    if (!CONFIG.warmBackupSegments || !text) { return; }
    try {
        var lines = text.replace(/\\r/g, '').split('\\n');
        var last = null;
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (l && l.charAt(0) !== '#' && l.indexOf('http') === 0) { last = l; }
        }
        if (!last || warmed[last]) { return; }
        warmed[last] = 1;
        // The ring must not grow for the whole session.
        var keys = Object.keys(warmed);
        if (keys.length > 200) { for (var k = 0; k < 100; k++) { delete warmed[keys[k]]; } }
        realFetch(last, { headers: { Range: 'bytes=0-65535' } })
            .then(function (r) { return r && r.arrayBuffer ? r.arrayBuffer() : null; })
            .then(function () { wlogOnce('warm', 'debug', 'backup segments warmed on the CDN edge'); })
            .catch(function () {});
    } catch (e) { /* a warm-up must never bring the swap down */ }
}

function findCleanPlaylist(stream, realFetch) {
    // Stay on whatever is already serving this break: re-running the search every poll changed
    // player type mid-break, which is a second stream swap with nothing to resynchronise it.
    if (stream.activeBackup) {
        var current = stream.activeBackup;
        return tryPlayerType(stream, current, realFetch)
            .then(function (text) {
                if (text) { return { playerType: current, text: text }; }
                wlog('debug', 'backup ' + current + ' picked up ads, searching again');
                stream.activeBackup = null;
                stream.activeVariantUrl = null;
                return searchPlayerTypes(stream, realFetch);
            })
            .catch(function (err) {
                wlogOnce('backup:' + current, 'debug', 'backup stream via ' + current + ' failed: ' + (err && err.message ? err.message : err));
                stream.activeBackup = null;
                stream.activeVariantUrl = null;
                return searchPlayerTypes(stream, realFetch);
            });
    }
    return searchPlayerTypes(stream, realFetch);
}

// -- probeRealPreroll ---------------------------------------------------------------------------
// Console-only, one-shot. Mints a token for a session Twitch has never seen -- a fresh anonymous
// session reliably gets a real stitched preroll -- and fetches that session's view of the channel.
// LIMITATION: the playlist belongs to that OTHER session, so its MEDIA-SEQUENCE is not ours. It
// proves marker detection and stripAds against a real ad, not anything about our own numbering.
function randomDeviceId() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var i = 0; i < 32; i++) { id += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return id;
}

function anonymousAccessToken(channel) {
    var body = {
        operationName: 'PlaybackAccessToken', query: TOKEN_QUERY,
        variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: 'site', platform: 'web' }
    };
    return new Promise(function (resolve, reject) {
        var id = Math.random().toString(36).substring(2, 15);
        pendingFetches.set(id, { resolve: resolve, reject: reject });
        self.postMessage({
            key: 'FetchRequest',
            value: { id: id, url: 'https://gql.twitch.tv/gql', options: { method: 'POST', body: JSON.stringify(body),
                headers: { 'Client-ID': GQLState.clientId, 'X-Device-Id': randomDeviceId() } } }
        });
    }).then(function (response) {
        if (response.status !== 200) { throw new Error('anonymous token request returned ' + response.status); }
        return response.json();
    }).then(function (json) {
        var token = json && json.data && json.data.streamPlaybackAccessToken;
        if (token) { return token; }
        var reason = json && json.errors ? json.errors.map(function (e) { return e.message; }).join(', ') : 'no token in the response';
        throw new Error('no token for a fresh anonymous session: ' + reason);
    });
}

function workerSleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

// A preroll does not always exist the instant a session's first playlist is fetched -- Twitch's
// own client only sees one because it keeps polling while it plays. One session, polled, not a
// fresh token per poll: PROBE_TIMEOUT_MS bounds the whole one-shot call.
var PROBE_POLL_MS = 1000;
var PROBE_TIMEOUT_MS = 40000;

function pollForAdMarkers(mediaUrl, deadline) {
    return workerRealFetch(mediaUrl).then(function (r) {
        if (r.status !== 200) { throw new Error('anonymous media playlist returned ' + r.status); }
        return r.text();
    }).then(function (text) {
        if (hasAdMarkers(text)) { return text; }
        if (Date.now() >= deadline) { return null; }
        return workerSleep(PROBE_POLL_MS).then(function () { return pollForAdMarkers(mediaUrl, deadline); });
    });
}

function probeRealPreroll(channel) {
    var stream = streamsByChannel[channel];
    if (!stream || !stream.usherBase) {
        return Promise.reject(new Error('that channel is not tracked yet -- let the stream load first'));
    }
    var variantResolution = null;
    return anonymousAccessToken(channel)
        .then(function (token) { return workerRealFetch(buildUsherUrl(stream, token)); })
        .then(function (response) {
            if (response.status !== 200) { throw new Error('anonymous usher master returned ' + response.status); }
            return response.text();
        })
        .then(function (masterText) {
            var candidates = pickVariant(masterText, stream.currentVariant);
            if (!candidates || !candidates.length) { throw new Error('anonymous master has no comparable variant'); }
            variantResolution = candidates[0].resolution;
            return pollForAdMarkers(candidates[0].url, Date.now() + PROBE_TIMEOUT_MS);
        })
        .then(function (text) {
            // LOUD FAILURE: exercising the ad path on content that was never an ad measures the
            // wrong thing. A clean anonymous view must never be mistaken for a probe result.
            if (!text) {
                throw new Error('a fresh anonymous session stayed CLEAN for ' +
                    (PROBE_TIMEOUT_MS / 1000) + 's -- no ad markers, nothing to probe. Twitch does not' +
                    ' stitch every anonymous view; try again.');
            }
            var dateRange = text.match(/#EXT-X-DATERANGE:[^\\n]*CLASS="twitch-stitched-ad"[^\\n]*/);
            var carried = countAdSegments(text);
            var cacheBefore = adSegments.size;
            stripAds(text, {});
            return {
                channel: channel,
                stitched: true,
                dateRange: dateRange ? dateRange[0] : null,
                adSegmentsCarried: carried,
                stripped: adSegments.size - cacheBefore,
                variantResolution: variantResolution,
                playlistText: text
            };
        });
}

function onMasterPlaylist(url, text) {
    var match = new URL(url).pathname.match(/([^\\/]+)(?=\\.\\w+$)/);
    if (!match) {
        wlog('warn', 'could not read a channel name from ' + url);
        return text;
    }
    var channel = match[0];
    var stream = streamsByChannel[channel];
    if (!stream) {
        stream = streamsByChannel[channel] = {
            channel: channel, usherBase: null, variants: Object.create(null), currentVariant: null,
            adActive: false, stripping: false,
            // Per player type, kept across breaks: valid for the session, so the next break starts
            // warm instead of paying for the token round-trip again.
            backupMasters: Object.create(null),
            activeBackup: null
        };
    }
    var usher = new URL(url);
    usher.searchParams.delete('parent_domains');
    usher.searchParams.delete('sig');
    usher.searchParams.delete('token');
    stream.usherBase = usher.href;

    var lines = text.replace(/\\r/g, '').split('\\n');
    for (var i = 0; i < lines.length - 1; i++) {
        if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0 || lines[i + 1].indexOf('.m3u8') < 0) { continue; }
        var attrs = parseAttributes(lines[i]);
        if (!attrs['RESOLUTION']) { continue; }
        var info = { resolution: attrs['RESOLUTION'], frameRate: attrs['FRAME-RATE'], codecs: attrs['CODECS'] };
        stream.variants[lines[i + 1]] = info;
        streamsByPlaylistUrl[lines[i + 1]] = stream;
    }
    return text;
}

// -- sequence renumbering ----------------------------------------------------------------------
// MEDIA-SEQUENCE is per session and counts ads, so an ad-free backup drifts behind by a break's
// worth every time. We renumber what we serve, moving the offset only at the edges of a break.
var SEQ_TAG = '#EXT-X-MEDIA-SEQUENCE:';

function seqRead(text) {
    var at = text.indexOf(SEQ_TAG);
    if (at < 0) { return null; }
    var end = text.indexOf('\\n', at);
    var value = parseInt(text.substring(at + SEQ_TAG.length, end < 0 ? text.length : end), 10);
    return isNaN(value) ? null : value;
}

function seqWrite(text, value) {
    var at = text.indexOf(SEQ_TAG);
    if (at < 0) { return null; }
    var end = text.indexOf('\\n', at);
    if (end < 0) { end = text.length; }
    if (end > 0 && text.charAt(end - 1) === '\\r') { end--; }
    return text.substring(0, at) + SEQ_TAG + value + text.substring(end);
}

// Renumbering MEDIA-SEQUENCE alone makes it diverge from LIVE-SEQUENCE by the injected offset, and
// the playlist declares a live edge before its own window -- the player then believes it is behind,
// speeds up, and drains itself. The GAP is shifted, not the value: the two tags have a distance of
// their own inside the original.
var LIVE_SEQ_TAG = '#EXT-X-TWITCH-LIVE-SEQUENCE:';

function tagShift(text, tag, delta) {
    var at = text.indexOf(tag);
    if (at < 0) { return text; }
    var end = text.indexOf('\\n', at);
    if (end < 0) { end = text.length; }
    if (end > 0 && text.charAt(end - 1) === '\\r') { end--; }
    var value = parseInt(text.substring(at + tag.length, end), 10);
    if (isNaN(value)) { return text; }
    var shifted = value + delta;
    // Like MEDIA-SEQUENCE: it is unsigned, it does not go below zero.
    if (shifted < 0) { shifted = 0; }
    return text.substring(0, at) + tag + shifted + text.substring(end);
}

// The two sources declare different gaps from the live edge, and at the handover the player turns
// the jump into latency: +1 segment is reabsorbed in 47-70s, +2 is not reabsorbed at all -- the
// player sits at 1.03x and stalls every ~80s. So the served gap is held continuous across the seam
// and walked back one segment at a time, each step under the threshold.
var LIVE_GAP_STEP_MS = 90000;

function liveGapServe(stream, url, text, servedHead) {
    if (!CONFIG.holdLiveGap) { return text; }
    var at = text.indexOf(LIVE_SEQ_TAG);
    if (at < 0) { return text; }
    var end = text.indexOf('\\n', at);
    if (end < 0) { end = text.length; }
    if (end > 0 && text.charAt(end - 1) === '\\r') { end--; }
    var servedLive = parseInt(text.substring(at + LIVE_SEQ_TAG.length, end), 10);
    if (isNaN(servedLive)) { return text; }
    var actual = servedHead - servedLive;
    var target = stream.liveGap[url];
    // First playlist of this rendition: adopt the gap as it is, touching nothing.
    if (target === undefined || target === null) {
        stream.liveGap[url] = actual;
        stream.liveGapAt[url] = Date.now();
        return text;
    }
    if (target !== actual) {
        var movedAt = stream.liveGapAt[url] || 0;
        if (Date.now() - movedAt >= LIVE_GAP_STEP_MS) {
            target += (actual > target) ? 1 : -1;
            stream.liveGap[url] = target;
            stream.liveGapAt[url] = Date.now();
            wlog('debug', '[GAP] ' + url.slice(-18) + ': served gap -> ' + target +
                ' (true ' + actual + ')');
        }
    } else {
        stream.liveGapAt[url] = Date.now();
    }
    if (target === actual) { return text; }
    var shifted = servedHead - target;
    if (shifted < 0) { return text; }
    return text.substring(0, at) + LIVE_SEQ_TAG + shifted + text.substring(end);
}

// The tail: the only anchor meaning the same instant in both sessions, since the original's head
// freezes during a break while its tail follows the live edge.
function seqTail(text) {
    var seq = seqRead(text);
    if (seq === null) { return null; }
    var n = (text.match(/^#EXTINF:/gm) || []).length;
    if (!n) { return null; }
    return { n: seq + n - 1, seq: seq, count: n };
}

// The floor is per rendition: they share one stream object, but their playlists do not tick
// together, and a rendition a segment behind another would raise the offset for the whole channel
// and advertise a segment that does not exist yet.
function seqServe(stream, url, text, seq, field) {
    var last = stream.seqHeads[url];
    var floor = (last === null || last === undefined) ? 0 : last;
    if (floor < 0) { floor = 0; }
    var head = seq + stream[field];
    if (head < floor) {
        // Raise the offset, not the number: pinning it turns the step into a stall, the playlist
        // advancing while the number does not. Floor at zero, MEDIA-SEQUENCE is unsigned.
        stream[field] = floor - seq;
        head = floor;
    }
    stream.seqHeads[url] = head;
    stream.seqServedHead = head;
    // The earlier early return also skipped the gap handling, which is needed precisely when we do
    // not renumber: the backup->original seam changes the gap even with the offset unchanged.
    var out = text;
    if (head !== seq) {
        var rewritten = seqWrite(text, head);
        // The same shift on LIVE-SEQUENCE, or the two tags diverge and the player believes it is
        // head-seq segments behind, segments that do not exist.
        if (rewritten !== null) { out = tagShift(rewritten, LIVE_SEQ_TAG, head - seq); }
    }
    return liveGapServe(stream, url, out, head);
}

// Anything from the original -- outside a break, or a stripped one -- takes the session offset.
// Always through seqServe, so the floor sees it.
function seqApplySessionOffset(stream, url, text) {
    var seq = seqRead(text);
    if (seq === null) { return text; }
    return seqServe(stream, url, text, seq, 'seqOffset');
}

// A session restart needs no special case: the floor raises the offset and the numbering carries
// on. Do not add a detector that serves raw -- a variant switch looks identical, and the append is
// then refused.


// Backup to original needs no search: the two carry the same clean numbering, so the same media
// must get the same served number and the offset is the one already in use. Applies equally to the
// break exit and to falling back to stripping mid-break.
function seqAdoptBackupOffset(stream, why) {
    stream.seqOffset = stream.seqBackupOffset;
    stream.seqSource = 'orig';
    stream.seqBlind = false;
    wlog('info', '[SEQ] ' + why + ': offset ' + stream.seqOffset + ' adopted from the backup offset');
}

function seqStrippedBreak(stream, url, text) {
    if (!CONFIG.renumberSequence) { return text; }
    // The backup vanished mid-break: same transition as the exit, and it is derived the same way.
    if (stream.seqInBreak && stream.seqSource !== 'orig') {
        seqAdoptBackupOffset(stream, 'backup lost mid-break');
    }
    // Still a break, or the exit never re-anchors.
    if (!stream.seqInBreak) {
        stream.seqInBreak = true;
        stream.seqSource = 'orig';
    }
    var served = seqApplySessionOffset(stream, url, text);
    return served;
}

// Outside a break, and the moment one ends: the original advanced by every stitched segment while
// we were away, so the offset is re-anchored here.
function seqOutsideBreak(stream, url, text) {
    if (!CONFIG.renumberSequence) { return text; }
    // On adActive, not the markers: a pod drops them between videos and the break stays open.
    if (stream.seqInBreak && !stream.adActive) {
        // The source is read BEFORE it is cleared. Written the other way round, the branch below
        // never ran once (claim 073) -- dead code that looked live, and the clean exits that seemed
        // to confirm it were being produced by the pattern instead.
        var fromBackup = stream.seqSource && stream.seqSource.indexOf('backup:') === 0;
        stream.seqInBreak = false;
        stream.seqSource = 'orig';
        if (fromBackup) { seqAdoptBackupOffset(stream, 'break exit'); }
    }
    return seqApplySessionOffset(stream, url, text);
}

function seqInsideBreak(stream, url, text, cleanText) {
    if (!CONFIG.renumberSequence) { return cleanText; }
    // No tail: use the backup's own offset. The session offset on a backup number gets written back
    // into seqOffset by the floor and corrupts it for good.
    var backup = seqTail(cleanText);
    if (!backup) {
        if (stream.seqInBreak) {
            return seqServe(stream, url, cleanText, seqRead(cleanText), 'seqBackupOffset');
        }
        return cleanText;
    }

    // The backup changes identity when its player type picks up ads, and another session numbers
    // from another base.
    var source = 'backup:' + (stream.activeBackup || '?');
    if (stream.seqInBreak && stream.seqSource !== source) {
        // Backup to backup: they all carry the live numbering, so the offset must not move. Only
        // measured for mobile_feed and popout, so the transition is logged rather than silent.
        wlog('info', '[SEQ] backup changed ' + stream.seqSource + ' -> ' + source +
            ', keeping offset ' + stream.seqBackupOffset);
        stream.seqSource = source;
    }

    if (!stream.seqInBreak) {
        stream.seqInBreak = true;
        stream.seqSource = source;
        // Channel-wide, not this rendition: a switch at the break edge would otherwise read as a
        // pre-roll and ride the whole break blind.
        if (stream.seqServedHead === null || stream.seqServedHead === undefined) {
            // Nothing seen outside the break, so the player's numbers are unknown and a drift would
            // drag it backwards. Ride what is in flight, re-anchor at the exit. Every pre-roll.
            stream.seqBackupOffset = 0;
            stream.seqBlind = true;
        } else {
            var original = seqTail(text);
            if (!original) { stream.seqInBreak = false; return cleanText; }
            stream.seqBackupOffset = stream.seqOffset + (original.n - backup.n);
        }
    }

    return seqServe(stream, url, cleanText, backup.seq, 'seqBackupOffset');
}

// -- continuity trace ---------------------------------------------------------------------------
// What we served, keyed by the url the player will fetch. Bounded: the map lives as long as the
// tab, and the player never reaches back further than one window.
var TRACE_MAX = 400;
var tracedSegments = {};
var tracedOrder = [];
var traceLastRequest = {};
var traceSegDur = {};

function traceServed(playlistUrl, servedText) {
    if (!CONFIG.traceContinuity) { return; }
    var seq = seqRead(servedText);
    if (seq === null) { return; }
    var lines = servedText.replace(/\\r/g, '').split('\\n'), n = seq;
    // Duration is read from the EXTINFs, NOT from TARGETDURATION: that is the rounded-up ceiling
    // and Twitch declares it 5 or 6 on 2.000s segments. Using it inflates every distance by 2.5x
    // and turns any long absence into an invented splice.
    var durSum = 0, durN = 0;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.charAt(0) === '#') {
            var xi = /^#EXTINF:([0-9.]+)/.exec(line);
            if (xi) { var xv = parseFloat(xi[1]); if (xv > 0) { durSum += xv; durN++; } }
        }
        if (!line || line.charAt(0) === '#') { continue; }
        if (tracedSegments[line] === undefined) {
            tracedSegments[line] = { n: n, playlist: playlistUrl };
            tracedOrder.push(line);
        }
        n++;
    }
    if (durN > 0) { traceSegDur[playlistUrl] = durSum / durN; }
    while (tracedOrder.length > TRACE_MAX) { delete tracedSegments[tracedOrder.shift()]; }
}

// Called on every segment the player actually fetches. The only place in this script that observes
// the player instead of predicting it.
function traceRequested(url) {
    var hit = tracedSegments[url];
    if (!hit) { return; }
    var now = Date.now();
    var last = traceLastRequest[hit.playlist];
    traceLastRequest[hit.playlist] = { n: hit.n, at: now };
    if (last === undefined) { return; }
    if (hit.n === last.n + 1) { return; }
    // The cursor is per rendition and lives as long as the channel, so a rung the player left and
    // came back to shows a large distance that is not a splice. A real splice is media gained
    // without spending wall clock; an absence costs as much clock as media.
    var gap = hit.n - last.n - 1;
    if (gap > 0) {
        var dur = traceSegDur[hit.playlist] || 0;
        if (dur > 0) {
            // The tolerance has to grow with the absence: media and clock drift by about 0.3%,
            // which over twenty minutes is a few seconds -- a fixed one-segment margin mistakes it
            // for a splice. One segment PLUS half a percent of the wait.
            var media = gap * dur, wall = (now - last.at) / 1000;
            if (media - wall <= dur + wall * 0.005) { return; }
        }
    }
    var stream = streamsByPlaylistUrl[hit.playlist];
    var where = stream && stream.adActive ? 'during a break' : (stream && stream.seqInBreak ? 'at the exit' : 'in the clear');
    self.postMessage({ key: 'ContinuityBreak', channel: stream ? stream.channel : null,
        from: last.n, to: hit.n, delta: gap, where: where,
        wall: Math.round((now - last.at) / 100) / 10 });
}

function onMediaPlaylist(url, text, realFetch) {
    var stream = streamsByPlaylistUrl[url];
    if (!stream) { return Promise.resolve(text); }
    stream.currentVariant = stream.variants[url] || stream.currentVariant;
    if (stream.seqOffset === undefined) {
        stream.seqOffset = 0;
        stream.seqHeads = {};
        stream.seqServedHead = null;
        stream.seqInBreak = false;
        // Per rendition, like seqHeads and for the same reason: two renditions do not tick
        // together, and they can declare different gaps.
        stream.liveGap = {};
        stream.liveGapAt = {};
    }

    if (!hasAdMarkers(text)) {
        if (stream.adActive) {
            stream.adActive = false;
            stream.stripping = false;
            // Released so the next break picks a player type on its own merits. The cached
            // master playlists deliberately survive: they are what make the next break start
            // without paying for the token round-trip all over again.
            stream.activeBackup = null;
            stream.activeVariantUrl = null;
            self.postMessage({ key: 'AdEnded', channel: stream.channel });
        }
        return Promise.resolve(seqOutsideBreak(stream, url, text));
    }
    var isMidroll = text.indexOf('"MIDROLL"') >= 0 || text.indexOf('"midroll"') >= 0;
    if (!stream.adActive) {
        stream.adActive = true;
        // Each break reports its own ladders. Two breaks minutes apart can see different ones --
        // that is the whole reason to log them -- so carrying the suppression across is what makes
        // the census useless exactly when it would have been informative.
        wclearOnce('rungs:');
        self.postMessage({ key: 'AdStarted', channel: stream.channel, isMidroll: isMidroll });
    }

    if (!CONFIG.blockAds) {
        return Promise.resolve(text);
    }

    return findCleanPlaylist(stream, realFetch).then(function (clean) {
        if (clean) {
            self.postMessage({ key: 'AdBlocked', channel: stream.channel, playerType: clean.playerType, isMidroll: isMidroll, stripping: false, resolution: stream.servedResolution || null });
            // The rendition belongs in the key: a backup that changes rung mid-break is another
            // encode, another seam, and it is invisible if only the player type is compared.
            return carryAdMarkers(text, seqInsideBreak(stream, url, text, clean.text));
        }
        if (CONFIG.stripAdSegments) {
            var strippedText = stripAds(text, stream);
            self.postMessage({ key: 'AdBlocked', channel: stream.channel, playerType: null, isMidroll: isMidroll, stripping: true });
            return seqStrippedBreak(stream, url, strippedText);
        }
        wlogOnce('leak', 'warn', 'no clean playlist and stripping is off -- ads will be shown');
        return seqStrippedBreak(stream, url, text);
    });
}

function installFetchHook() {
    var realFetch = self.fetch;
    // Kept outside this closure too: probeRealPreroll runs from the message listener, off the
    // fetch-hook call path entirely, and still needs the unhooked fetch.
    workerRealFetch = realFetch;
    self.fetch = function (input, options) {
        if (typeof input !== 'string') {
            return realFetch.apply(this, arguments);
        }
        var url = input.trimEnd();

        if (adSegments.has(url)) {
            return Promise.resolve(emptySegmentResponse());
        }

        if (CONFIG.traceContinuity && tracedSegments[url] !== undefined) {
            traceRequested(url);
        }

        if (url.indexOf('/channel/hls/') >= 0 && url.indexOf('picture-by-picture') < 0) {
            if (CONFIG.forcePlayerType) {
                // parent_domains is how the backend decides the player is embedded, and leaving it
                // on while the playerType says otherwise is what produces the embed-shaped fake ads
                var stripped = new URL(url);
                stripped.searchParams.delete('parent_domains');
                url = stripped.href;
            }
            return realFetch(url, options).then(function (response) {
                if (response.status !== 200) { return response; }
                return response.text().then(function (text) {
                    var serverTime = readServerTime(text);
                    var out = onMasterPlaylist(url, text);
                    return new Response(writeServerTime(out, serverTime), { status: 200 });
                });
            });
        }

        if (url.endsWith('m3u8')) {
            return realFetch(url, options).then(function (response) {
                if (response.status !== 200) { return response; }
                return response.text()
                    .then(function (text) { return onMediaPlaylist(url, text, realFetch); })
                    .then(function (out) { traceServed(url, out); return new Response(out, { status: 200 }); });
            });
        }

        return realFetch.apply(this, arguments);
    };
}

var OUR_MESSAGE_KEYS = {
    UpdateDeviceId: 1, UpdateClientVersion: 1, UpdateClientSession: 1,
    UpdateIntegrity: 1, UpdateAuthorization: 1, PlayerReloaded: 1, FetchResponse: 1,
    ProbeRealPreroll: 1, PreferVariant: 1, ChannelChanged: 1
};

// Registered before Twitch's worker is loaded, so this listener runs first and can stop our own
// messages reaching its onmessage. Its handler assumes every message is one of its own and throws
// on anything else, which during startup is enough to leave it uninitialised and the player dead.
self.addEventListener('message', function (e) {
    var data = e.data || {};
    if (OUR_MESSAGE_KEYS[data.key]) {
        e.stopImmediatePropagation();
    }
    if (data.key === 'UpdateDeviceId') {
        // The page's real id supersedes anything we generated, and clears the hold on integrity:
        // once the two match again there is nothing replay-shaped about sending them together.
        GQLState.deviceId = data.value;
        GQLState.deviceIdInvented = false;
        return;
    }
    if (data.key === 'UpdateClientVersion') { GQLState.clientVersion = data.value; return; }
    if (data.key === 'UpdateClientSession') { GQLState.clientSession = data.value; return; }
    if (data.key === 'UpdateIntegrity') { GQLState.integrity = data.value; return; }
    // What rendition the backup search should aim at, when the page knows better than the player
    // does. Sent after a codec step-down and cleared at the end of the break.
    if (data.key === 'PreferVariant') { preferredVariant = data.value || null; return; }
    if (data.key === 'ChannelChanged') {
        // onMediaPlaylist is what ends a break, and the playlist being left stops being polled, so
        // its break never ends: returning later would resume it. The cached master playlists survive
        // on purpose, the backup in use does not.
        preferredVariant = null;
        var left = data.value && streamsByChannel[data.value];
        if (left) {
            left.adActive = false;
            left.stripping = false;
            left.activeBackup = null;
            left.activeVariantUrl = null;
            // Same for the sequence state: coming back the player is a new session, and an offset
            // or a floor from the previous visit would be applied to numbers it never described.
            left.seqOffset = 0;
            left.seqHeads = {};
            left.seqServedHead = null;
            left.seqInBreak = false;
            left.seqSource = null;
            left.seqBackupOffset = 0;
            left.seqBlind = false;
            left.liveGap = {};
            left.liveGapAt = {};
            // Our own numbering goes too: coming back the player is a new session with numbers of
            // its own, and a stale floor would block it instead of protecting it.
            left.servedSource = null;
            // traceLastRequest lives outside the stream, keyed by playlist url: release what
            // belonged to its renditions, or it stays attached to urls nobody will ask for again.
            var urls = left.variants ? Object.keys(left.variants) : [];
            for (var u = 0; u < urls.length; u++) { delete traceLastRequest[urls[u]]; delete traceSegDur[urls[u]]; }
        }
        return;
    }
    if (data.key === 'UpdateAuthorization') { GQLState.authorization = data.value; return; }
    if (data.key === 'PlayerReloaded') { lastReloadAt = Date.now(); return; }
    if (data.key === 'ProbeRealPreroll') {
        // One-shot: no config flag, nothing left "on" after this resolves.
        probeRealPreroll(data.channel).then(function (result) {
            self.postMessage({ key: 'ProbeRealPrerollResult', id: data.id, ok: true, result: result });
        }, function (err) {
            self.postMessage({ key: 'ProbeRealPrerollResult', id: data.id, ok: false, error: err && err.message ? err.message : String(err) });
        });
        return;
    }
    if (data.key === 'FetchResponse') {
        var payload = data.value;
        var pending = pendingFetches.get(payload.id);
        if (!pending) { return; }
        pendingFetches.delete(payload.id);
        if (payload.error) {
            pending.reject(new Error(payload.error));
        } else {
            pending.resolve(new Response(payload.body, { status: payload.status, statusText: payload.statusText, headers: payload.headers }));
        }
    }
});

// Load Twitch's own worker only after the hook is in place. importScripts is the documented way
// to do this; the synchronous XHR plus eval below is the fallback for environments that refuse a
// blob URL here.
function loadTwitchWorker(url) {
    try {
        self.importScripts(url);
        return;
    } catch (err) {
        wlog('debug', 'importScripts failed (' + err + '), falling back to XHR');
    }
    var request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.overrideMimeType('text/javascript');
    request.send();
    // eslint-disable-next-line no-eval
    (0, eval)(request.responseText);
}

installFetchHook();
`;

    function installWorkerHook() {
        const NativeWorker = window.Worker;

        class HookedWorker extends NativeWorker {
            constructor(scriptUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(scriptUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(scriptUrl, options);
                    return;
                }

                // Embedded, not posted. See the note at the top of WORKER_SOURCE: a config message
                // races Twitch's own worker startup and its onmessage throws on anything it did
                // not send itself.
                const init = {
                    config: {
                        blockAds: Config.BlockAds,
                        adSignifier: Config.AdSignifier,
                        backupPlayerTypes: Config.BackupPlayerTypes.slice(),
                        stripAdSegments: Config.StripAdSegments,
                        renumberSequence: Config.RenumberSequence !== false,
                        carryAdMarkers: Config.CarryAdMarkers !== false,
                        holdLiveGap: Config.HoldLiveGap !== false,
                        warmBackupSegments: Config.WarmBackupSegments !== false,
                        traceContinuity: Config.TraceContinuity !== false,
                        forcePlayerType: !!Config.ForceAccessTokenPlayerType,
                        tokenMode: State.gqlTokenMode
                    },
                    gql: {
                        clientId: GQL.clientId,
                        deviceId: GQL.deviceId,
                        clientVersion: GQL.clientVersion,
                        clientSession: GQL.clientSession,
                        integrity: GQL.integrity,
                        authorization: GQL.authorization
                    }
                };
                const source = 'var VAFT2_INIT = ' + JSON.stringify(init) + ';\n' +
                    WORKER_SOURCE + '\nloadTwitchWorker(' + JSON.stringify(scriptUrl) + ');\n';
                super(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), options);

                State.workers.push(this);
                log('debug', 'wrapped Twitch worker #' + State.workers.length);

                this.addEventListener('message', async (event) => {
                    const data = event.data || {};
                    if (messageIsStale(data)) {
                        log('debug', 'ignoring a late ' + data.key + ' for a channel that has been left');
                        return;
                    }
                    switch (data.key) {
                        case 'Log':
                            log(data.level || 'info', data.message);
                            break;
                        case 'FetchRequest':
                            this.postMessage({ key: 'FetchResponse', value: await performWorkerFetch(data.value) });
                            break;
                        case 'TokenModeChanged':
                            State.gqlTokenMode = data.value;
                            break;
                        case 'AdStarted':
                            State.counters.breaks++;
                            State.adActive = true;
                            // Buffer held BEFORE the break, to tell whether long-session latency
                            // growth comes from the breaks or from between them.
                            State.latencyAtBreak = readLiveLatency();
                            State.depthAtBreak = (function () {
                                const b = readBufferedRanges();
                                return (b && b.tail !== null) ? b.tail - b.at : null;
                            })();
                            State.adIsMidroll = !!data.isMidroll;
                            // Codec belongs on this line: which path a break takes is decided by
                            // whether the backup ladder can match it, so a line without it cannot
                            // be read afterwards.
                            log('info', 'ad break started' +
                                (data.isMidroll ? ' (midroll)' : '') + ' -- ' + describePlayback());
                            if (Config.CrossCheckAdEvents && State.playerAdEvent !== 'start') {
                                log('debug', 'we saw the ad before the player reported stitchedadstart');
                            }
                            updateBanner();
                            break;
                        case 'AdBlocked':
                            State.activeBackupPlayerType = data.playerType;
                            State.strippingSegments = !!data.stripping;
                            logOnce('blocking', 'info', data.playerType
                                ? 'serving a clean stream via ' + data.playerType +
                                    (data.resolution ? ' at ' + data.resolution : '')
                                : 'no clean stream available, stripping ad segments');
                            // Stripping keeps the player alive but the picture frozen for the whole
                            // break, so it is a floor, not an outcome. Reaching it is the signal to
                            // widen the search rather than to settle.
                            if (!data.playerType) {
                                stepDownFromStrippedCodec();
                            }
                            updateBanner();
                            break;
                        case 'ContinuityBreak':
                            // The worker saw the player ask for a number that is not the next one
                            // we served. Nothing about this line is channel-specific: it is our own
                            // numbering, read back from the player's own request.
                            log('warn', '[TRACE] continuity break ' + data.where +
                                ': player went ' + data.from + ' -> ' + data.to +
                                ' (' + (data.delta > 0
                                    ? data.delta + ' segment(s) of video SKIPPED'
                                    : (-data.delta) + ' segment(s) REPEATED') +
                                ', ' + data.wall + 's of wall clock)');
                            State.counters.continuityBreaks++;
                            break;
                        case 'AdEnded':
                            State.adActive = false;
                            State.activeBackupPlayerType = null;
                            State.strippingSegments = false;
                            clearOnce('blocking');
                            clearOnce('leak');
                            // Before the restore, not after: setQuality is not immediate, so
                            // logging afterwards prints the rung being left beside the line
                            // announcing the return.
                            log('info', 'ad break finished -- watched at ' + describePlayback());
                            restoreQualityAfterAdBreak();
                            updateBanner();
                            if (Config.TraceContinuity) {
                                // Third read, at the INSTANT of the handover. With only two reads
                                // -- break start and 8s after the end -- a latency step cannot be
                                // attributed: is it inside the break or in the source swap?
                                State.latencyAtHandover = readLiveLatency();
                                Stalls.exits++;
                                Stalls.lastExitAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                                reportExitBuffer();
                            }
                            // The exit touches nothing: the numbering is re-anchored before this
                            // fires, and a stuck player is caught by the recovery watchers.
                            break;
                        case 'ProbeRealPrerollResult': {
                            const pending = State.pendingProbes.get(data.id);
                            if (!pending) { break; }
                            State.pendingProbes.delete(data.id);
                            if (data.ok) { pending.resolve(data.result); } else { pending.reject(new Error(data.error)); }
                            break;
                        }
                        default:
                            break;
                    }
                });
            }
        }

        Object.defineProperty(window, 'Worker', {
            configurable: true,
            get() { return HookedWorker; },
            set() { log('debug', 'refused an attempt to replace window.Worker'); }
        });
    }

    // Status surface
    // A report that says "ads are getting through" is not actionable. This is.
    window.vaft2 = {
        config: Config,
        status() {
            const found = getPlayer();
            const player = found?.player;
            let quality = null;
            try {
                const q = player?.getQuality?.();
                quality = q && (q.name || q.group);
            } catch {}
            return {
                version: VERSION,
                adActive: State.adActive,
                adIsMidroll: State.adIsMidroll,
                backupPlayerType: State.activeBackupPlayerType,
                strippingSegments: State.strippingSegments,
                playerAdEvent: State.playerAdEvent,
                tokenMode: State.gqlTokenMode,
                counters: Object.assign({}, State.counters),
                layers: {
                    hideVisibility: Visibility.installed,
                    adManagerDeclined: AdManager.applied,
                    adManagerReason: AdManager.reason,
                    adManagerModule: AdManager.moduleId,
                    adManagerAttempts: AdManager.attempts,
                    pinHighestQuality: Config.PinHighestQuality,
                    qualityFlagInStorage: (() => { try { return localStorage.getItem(QUALITY_KEY); } catch { return 'unreadable'; } })()
                },
                player: {
                    found: !!player,
                    state: (() => { try { return player?.getState?.(); } catch { return null; } })(),
                    quality,
                    autoQualityMode: player?.core?.state?.autoQualityMode ?? null,
                    reallyHidden: Visibility.isReallyHidden()
                },
                workers: State.workers.length
            };
        },
        // The last 90 seconds of overlay-ad sampling. Call it right after seeing one and the
        // evidence is already there -- reacting to the event in real time is always too late.
        overlayBuffer() {
            return OverlayAds.buffer.slice();
        },
        overlayLayout: describeOverlayLayout,
        // One-shot, console-only. See the worker's probeRealPreroll. Nothing is left on.
        probeRealPreroll() {
            const channel = Navigation.channel;
            if (!channel) {
                const err = new Error('probeRealPreroll: no channel page open');
                console.error('[VAFT2] ' + err.message);
                return Promise.reject(err);
            }
            const worker = State.workers[State.workers.length - 1];
            if (!worker) {
                const err = new Error('probeRealPreroll: no player worker yet -- let the stream load first');
                console.error('[VAFT2] ' + err.message);
                return Promise.reject(err);
            }
            const id = Math.random().toString(36).slice(2);
            log('info', 'probeRealPreroll: fetching the channel as a fresh anonymous session...');
            return new Promise((resolve, reject) => {
                State.pendingProbes.set(id, { resolve, reject });
                worker.postMessage({ key: 'ProbeRealPreroll', id, channel });
            }).then((result) => {
                log('info', 'probeRealPreroll: STITCHED -- ' + result.adSegmentsCarried +
                    ' ad segment(s) carried, ' + result.stripped + ' registered for stripping, variant ' +
                    result.variantResolution);
                return result;
            }, (err) => {
                // Loud on purpose: this must never look like success at the console.
                console.error('[VAFT2] probeRealPreroll FAILED: ' + err.message);
                throw err;
            });
        },
        setLogLevel(level) {
            if (!(level in LEVELS)) {
                console.log('[VAFT2] log levels: ' + Object.keys(LEVELS).join(', '));
                return;
            }
            Config.LogLevel = level;
        },
        reloadPlayer,
        // Read off the object, so a new entry point cannot be added and forgotten here. Names in
        // full: a bare 'status()' is not something you can paste into a console.
        help() {
            const names = Object.keys(window.vaft2)
                .map((k) => 'window.vaft2.' + k + (typeof window.vaft2[k] === 'function' ? '()' : ''))
                .sort();
            console.log(['[VAFT2] v2 active -- ' + VERSION].concat(names).join('\n'));
        }
    };

    // Bootstrap
    // Fetch hook first: the worker bridge calls back through __vaft2RealFetch, so it has to exist
    // before any worker can be wrapped
    installFetchHook();
    installWorkerHook();
    applyQualityPreference(Config.PinHighestQuality);

    // Whether the tab was already hidden at document-start decides if the one-shot
    // visibilitychange allowance is needed at all.
    try {
        Visibility.allowNextVisibilityChange = document.visibilityState === 'hidden';
    } catch {}
    installVisibilityLayer();
    // At document-start: the first channel has to be recorded before any navigation can happen.
    installNavigationWatch();
    // Not in onReady: the first ad request of a session can be issued before DOMContentLoaded, and
    // the retry loop costs nothing while the bundle is still loading.
    startAdManagerDecline();

    function onReady() {
        ensurePlayerWired();
        startStallCensus();
        startLatencyTrim();
        startDeadPlayerWatch();
        startOverlayAdWatch();
        // The player instance is replaced on every reload, and there is no event for that, so
        // re-wire on the cheap signals we already get rather than polling for it.
        document.addEventListener('click', () => ensurePlayerWired(), true);
        setTimeout(function rewire() {
            ensurePlayerWired();
            setTimeout(rewire, 5000);
        }, 5000);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        onReady();
    } else {
        window.addEventListener('DOMContentLoaded', onReady);
    }

    // Printed straight to the console rather than through log(), so raising LogLevel to warn does
    // not hide the one line that says how to lower it again.
    window.vaft2.help();

})();
