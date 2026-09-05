// ==UserScript==
// @name         TwitchAd (vaft)
// @namespace    https://github.com/scamorza/TwitchAdBlock
// @version      2.2.0
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
// different playerType and serve that.
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
        // Tried in order. mobile_feed (as android) is ad-free and uncapped; popout is a second
        // chance at full quality but not always clean; autoplay is ad-free but capped at 640x360.
        BackupPlayerTypes: ['mobile_feed', 'popout', 'autoplay'],
        // Every segment the player fetches passes our worker hook, and we know the number we gave
        // it: any request that is not (last + 1) is a splice we caused.
        TraceContinuity: true,
        // Prime suspect in the reload loop; first thing to try if it reappears.
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

        // -- page visibility -----------------------------------------------------------------
        // Always reports the page visible: stops the background downscale (720p60 -> 360p30 in ~2
        // min). Cost: a stalled sink now reaches a local pause(), which RecoverBlockedPlayback undoes.
        HideVisibility: true,
        // One switch, two names. Minimising stops the media sink, and with document.hidden forced
        // false player-core pauses in a branch that emits no event at all -- so the resume exists
        // to pay for the line above and is meaningless without it.
        get ResumeOnFocus() { return this.HideVisibility; },

        // -- quality -------------------------------------------------------------------------
        // Twitch's own 'video-quality-highest-available'. Does NOT prevent the background downscale
        // despite vaft's similarly-named option claiming so: HideVisibility is what stops that.
        PinHighestQuality: true,

        // -- recovery ------------------------------------------------------------------------
        // onSinkStop has three exits; only the muted one (pause + PlaybackBlocked, no retry) strands
        // the stream with nobody coming, so it is the only one acted on.
        RecoverBlockedPlayback: true,


        // A decode error tears the media element down and player-core does not retry -- it renders
        // "Error #3000" and waits for a click. Held before acting: the same signature appears for
        // a second or two during any ordinary load.
        RecoverDeadPlayer: true,

        // -- diagnostics ---------------------------------------------------------------------
        ShowBanner: true,
        // 'debug' | 'info' | 'warn' | 'off'
        LogLevel: 'info',
        // Report the player's own stitchedadstart/stitchedadend next to our own detection: one
        // without the other means AD_SIGNIFIER has drifted.
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
        lastBackupFailure: null,
        workers: [],
        playerAdEvent: null,
        gqlTokenMode: 'persisted',
        counters: { breaks: 0, reloads: 0, backupFailures: 0, recoveries: 0, deadPlayers: 0, continuityBreaks: 0 }
    };

    // Anything writing persistent state here also removes it: leaving the key behind when the
    // option is off leaves the setting applied to a browser that no longer asks for it.
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

    // Walking the fiber tree is by far this script's main-thread cost, so the result is cached.
    // The instances it finds change only when the player is rebuilt, and the <video> the player
    // owns is detached when that happens -- so isConnected is an O(1) test for "still the pair".
    let playerCache = null;

    // player-core guards every method with `this.core || warn('Method called on deleted player
    // instance.')`, so a destroyed instance has core falsy. Reading the property costs nothing and
    // prints nothing, where asking a torn-down instance for its video element spams that warning
    // for as long as the cache points at it. Absent property means an instance shaped differently
    // from the one we know: unknown, not dead.
    function playerIsDeleted(p) {
        return !!p && 'core' in p && !p.core;
    }

    function playerCacheIsLive() {
        if (!playerCache) { return false; }
        try {
            if (typeof playerCache.controller.setSrc !== 'function') { return false; }
            if (playerIsDeleted(playerCache.player)) { return false; }
            // Captured with the pair, not asked for again: it is detached when the player is
            // rebuilt, which is the whole test. Cached before the element existed it is null, and
            // adopting it here is what keeps that entry from failing this test forever.
            if (!playerCache.video) {
                playerCache.video = playerCache.player.getHTMLVideoElement?.() || null;
            }
            return !!playerCache.video && playerCache.video.isConnected;
        } catch {
            return false;
        }
    }

    function getPlayer() {
        if (playerCacheIsLive()) {
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
        // A torn-down player stays in the tree: taking the first match re-cached the dead one and
        // the check that rejected it ran again on the next call, forever. Skip it in the walk.
        let instance = findReactNode(reactRoot, (n) => {
            if (!n.setPlayerActive || !n.props?.mediaPlayerInstance) { return false; }
            const mp = n.props.mediaPlayerInstance;
            return !playerIsDeleted(mp.playerInstance || mp);
        });
        instance = instance?.props?.mediaPlayerInstance || null;
        if (instance?.playerInstance) {
            instance = instance.playerInstance;
        }
        const controller = findReactNode(reactRoot, (n) => n.setSrc && n.setInitialPlaybackSettings);
        let video = null;
        try { video = instance?.getHTMLVideoElement?.() || null; } catch { video = null; }
        playerCache = instance && controller ? { player: instance, controller, video } : null;
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

    // How long after our play() we check that it took, and how many times we escalate. Sub-
    // parameters of RecoverBlockedPlayback: meaningless with it off.
    const RESUME_VERIFY_DELAY_MS = 2000;
    const RESUME_VERIFY_ATTEMPTS = 2;
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
                if (Resume.attempts < RESUME_VERIFY_ATTEMPTS) {
                    Resume.attempts++;
                    log('debug', 'still paused after our resume, retrying play (' + Resume.attempts + '/' + RESUME_VERIFY_ATTEMPTS + ')');
                    playPlayer(found.player, 'resume retry');
                    verifyResumed(false);
                } else {
                    log('warn', 'player did not resume after ' + Resume.attempts + ' retries; leaving it alone rather than reloading in a loop');
                }
            } catch (err) {
                log('debug', 'resume verification failed: ' + err);
            }
        }, RESUME_VERIFY_DELAY_MS);
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
        if (base.startsWith('av0')) { return 'av1'; }
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

    // The real latency, asked of the player instead of scraped from the panel (the
    // facade exposes getLiveLatency). One read, and getPlayer is already cached.
    function readLiveLatency() {
        try {
            const v = getPlayer()?.player?.getLiveLatency?.();
            return (typeof v === 'number' && isFinite(v)) ? v : null;
        } catch (err) {
            return null;
        }
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
                // has begun, and the trace reads a buffer the player no longer has.
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

    // Loop guard: a second reload inside this window degrades to pause/play. A reload that
    // settled nothing is a genuinely stuck player, not a routine exit -- shortening it is what
    // turns the mitigation back into the loop it exists to break.
    const RELOAD_COOLDOWN_MS = 90000;
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
        if (lastReloadAt && sinceLast < RELOAD_COOLDOWN_MS) {
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
    // Held before acting: the same signature appears for a second or two during any ordinary
    // load, so a shorter wait reloads healthy players mid-startup.
    const DEAD_PLAYER_SECONDS = 12;

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
                if (downFor < DEAD_PLAYER_SECONDS) {
                    return;
                }
                if (!reported) {
                    reported = true;
                    State.counters.deadPlayers++;
                    log('warn', 'the player is gone -- no media, no buffer, ' + downFor + 's' +
                        (State.adActive ? ' (during an ad break)' : '') +
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
            // the console and in status().
            text.textContent = 'Blocking' + (State.adIsMidroll ? ' midroll' : '') + ' ads';
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
        const carried = State.adActive;
        Navigation.left = previous;
        State.adActive = false;
        State.adIsMidroll = false;
        State.activeBackupPlayerType = null;
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

        // Releases the worker's copy of the break.
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
        pbypSkips: 0,
        buffer: [],
        bufferLimit: 180,
        anomalyActive: false,
        seen: 0,
        styleEl: null,
        hidden: [],
        strip: null
    };

    // 20 ticks of the 500ms overlay poll: one sweep every 10s while the mini-player is absent,
    // instead of two a second.
    const PBYP_LOOKUP_EVERY = 20;

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

        // The walk below is the same whole-fiber sweep getPlayer() is cached against,
        // and the mini-player is absent in the ordinary case -- so an unconditional lookup ran it
        // twice a second for the life of the tab, on the axis this script most has to stay cheap.
        // Once found it is kept; while missing it is retried every PBYP_LOOKUP_EVERY ticks, which
        // is well inside the life of an ad pod.
        if (!OverlayAds.pbypInstance || !OverlayAds.pbypInstance.state) {
            if (OverlayAds.pbypSkips > 0) {
                OverlayAds.pbypSkips--;
            } else {
                OverlayAds.pbypInstance = findPictureByPictureContext();
                OverlayAds.pbypSkips = OverlayAds.pbypInstance ? 0 : PBYP_LOOKUP_EVERY;
            }
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
    // From Twitch's own enum: the reason is passed to each declined command and tracked from
    // there, so an invented string would stand out.
    const AD_DECLINE_REASON = 'player_size';
    // 500ms apart. The bundle defining the manager can take ~20s to arrive on a cold cache, so the
    // budget is two minutes; shorter fails silently on exactly the slow loads it exists for.
    const AD_DECLINE_ATTEMPTS = 240;
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
        found.manager.decline(AD_DECLINE_REASON, { sendEvent: false });
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
            if (AdManager.attempts >= AD_DECLINE_ATTEMPTS) {
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

    // Generous against the two a page actually runs.
    const WORKER_KEEP = 8;

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
                            // The method has to be carried: the batch-splice path re-sends this
                            // object, and without it fetch defaults to GET, refuses to take a body,
                            // and the rejection lands on the player's own token request -- exactly
                            // what splicing instead of emptying the batch exists to avoid.
                            const shim = { method: input.method, body, headers: input.headers };
                            const rewritten = rewriteGqlBody(shim, realFetch);
                            if (rewritten) {
                                return rewritten;
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

        // No playerType rewrite here on purpose: it costs a fixed second of latency, and the
        // exemption it buys does not hold on a logged-in account.
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
var streamsByChannel = Object.create(null);
var streamsByPlaylistUrl = Object.create(null);
var adSegments = new Map();
var pendingFetches = new Map();
var lastReloadAt = 0;
var onceMessages = new Map();
var workerRealFetch = null;

// Zero bytes, because we never learn which codec the SourceBuffer was opened with. A one-frame
// mp4 with an avc1 sample description is harmless on h264 and fatal on hevc (Error #3000).
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

// An optimisation: Twitch's own client sends the full document, so a refusal just switches
// the session over to it.
var PERSISTED_HASH = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
var TOKEN_QUERY = 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {' +
    ' streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature }' +
    ' videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature }' +
    ' }';

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


// The substring Twitch puts in a stitched break. A fact about their playlist format, not a
// preference: any other value silently stops every detection in this file.
var AD_SIGNIFIER = 'stitched';

function hasAdMarkers(text) {
    return text.indexOf(AD_SIGNIFIER) >= 0;
}

// Removes ad segments, the low-latency prefetch hints while an ad is running, and the DATERANGEs
// that light Twitch's own ad UI.
function stripAds(text, stream) {
    var lines = text.replace(/\\r/g, '').split('\\n');
    var stripped = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        // The overlay comes up from the marker alone, whether or not an ad segment ever plays.
        // Of the DATERANGE classes Twitch publishes these two are the only ones exclusive to a
        // break; the others appear in ordinary playback and stay. The
        // ad URL and click-tracking attributes ride on the stitched-ad line and go with it.
        if (line.indexOf('#EXT-X-DATERANGE') === 0 &&
            (line.indexOf('CLASS="twitch-stitched-ad"') >= 0 ||
             line.indexOf('CLASS="twitch-ad-quartile"') >= 0)) {
            lines[i] = '';
            continue;
        }
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
    return lines.filter(function (l) { return l !== ''; }).join('\\n');
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

function workerSleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

function onMasterPlaylist(url, text, realFetch) {
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
            adActive: false,
            // Per player type, kept across breaks: valid for the session, so the next break starts
            // warm instead of paying for the token round-trip again.
            backupMasters: Object.create(null)
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
    // Warm the token and the backup master here, a second before the first media playlist:
    // opening the lane only when that arrives leaves a preroll -- which by definition lands on
    // an empty ledger -- with nothing to serve. Per player type, not per rung, so it costs one
    // token and one usher for the whole channel.
    if (realFetch && CONFIG.backupPlayerTypes.length) {
        fetchBackupMaster(stream, CONFIG.backupPlayerTypes[0], realFetch)
            .catch(function () {});
    }
    return text;
}

// Reads back what we served, for the continuity trace only. What we serve is numbered by the
// ledger below, not by shifting this.
var SEQ_TAG = '#EXT-X-MEDIA-SEQUENCE:';

function seqRead(text) {
    var at = text.indexOf(SEQ_TAG);
    if (at < 0) { return null; }
    var end = text.indexOf('\\n', at);
    var value = parseInt(text.substring(at + SEQ_TAG.length, end < 0 ? text.length : end), 10);
    return isNaN(value) ? null : value;
}

var LIVE_SEQ_TAG = '#EXT-X-TWITCH-LIVE-SEQUENCE:';

// ---- live-sequence ledger -----------------------------------------------------------------
// EXT-X-TWITCH-LIVE-SEQUENCE is positional -- it numbers the segment that follows -- and it is
// global to the broadcast, so it survives the session reset a stitched ad causes. Indexing every
// source on it is what lets two sessions be matched segment for segment, and
// gives the ad detector for free: a segment with no live number is not stream content.
//
// A DISCONTINUITY ends the run the last LIVE-SEQUENCE declared; only a new one restarts it.
// Carrying the cursor across would number ad segments with the live numbers they displaced.

var PDT_TAG = '#EXT-X-PROGRAM-DATE-TIME:';
var INF_TAG = '#EXTINF:';
var MAP_TAG = '#EXT-X-MAP:';
var PREFETCH_TAG = '#EXT-X-TWITCH-PREFETCH:';
var MEDIA_SEQ_TAG = '#EXT-X-MEDIA-SEQUENCE:';
var DISC_TAG = '#EXT-X-DISCONTINUITY';
var TARGET_DUR_TAG = '#EXT-X-TARGETDURATION:';
var ENDLIST_TAG = '#EXT-X-ENDLIST';
// The window Twitch publishes, and a bound on the served one, not a segment count: the
// cadence is the stream's to choose.
var WINDOW_SECONDS = 30;

function parsePlaylist(text) {
    var out = { version: null, targetDur: null, ended: false, items: [], ok: false };
    if (typeof text !== 'string' || text.indexOf('#EXTM3U') < 0) { return out; }
    out.ok = true;
    var lines = text.replace(/\\r/g, '').split('\\n');
    var seq = null, map = null, pdt = null, dur = null, title = null;
    for (var i = 0; i < lines.length; i++) {
        var L = lines[i];
        if (!L) { continue; }
        if (L.charAt(0) !== '#') {
            out.items.push({ seq: seq, url: L, dur: dur, title: title, pdt: pdt, map: map, hint: false });
            if (seq !== null) { seq++; }
            pdt = null; dur = null; title = null;
            continue;
        }
        if (L.indexOf(LIVE_SEQ_TAG) === 0) {
            var n = parseInt(L.substring(LIVE_SEQ_TAG.length), 10);
            if (!isNaN(n)) { seq = n; }
        } else if (L.indexOf(TARGET_DUR_TAG) === 0) {
            out.targetDur = parseInt(L.substring(TARGET_DUR_TAG.length), 10);
        } else if (L.indexOf(ENDLIST_TAG) === 0) {
            out.ended = true;
        } else if (L.indexOf('#EXT-X-VERSION:') === 0) {
            out.version = parseInt(L.substring(15), 10);
        } else if (L.indexOf(MAP_TAG) === 0) {
            map = L.substring(MAP_TAG.length);
        } else if (L.indexOf(PDT_TAG) === 0) {
            pdt = L.substring(PDT_TAG.length);
        } else if (L.indexOf(DISC_TAG) === 0) {
            seq = null;
        } else if (L.indexOf(INF_TAG) === 0) {
            var body = L.substring(INF_TAG.length), comma = body.indexOf(',');
            dur = parseFloat(comma < 0 ? body : body.substring(0, comma));
            title = comma < 0 ? '' : body.substring(comma + 1);
        } else if (L.indexOf(PREFETCH_TAG) === 0) {
            out.items.push({ seq: seq, url: L.substring(PREFETCH_TAG.length), dur: null,
                             title: null, pdt: null, map: map, hint: true });
            if (seq !== null) { seq++; }
        }
    }
    return out;
}


function newLedger() {
    return { bySeq: {}, hint: {}, dur: {}, first: null, last: null, version: null,
             targetDur: {}, ended: {}, floor: null };
}

// Every source writes into the same table. Which URL is served is decided in servePlaylist,
// not by whoever answered first.
function ledgerAbsorb(ledger, model, source) {
    if (model.version && (!ledger.version || model.version > ledger.version)) { ledger.version = model.version; }
    // Kept as the source declares it: it is a rounded-up ceiling, well above the real segment
    // durations, and the player times its playlist reloads off it. Per source like the PDTs --
    // the backup is another packager and declares its own, which is not our window's ceiling.
    if (model.targetDur && ledger.targetDur[source] === undefined) {
        ledger.targetDur[source] = model.targetDur;
    }
    for (var i = 0; i < model.items.length; i++) {
        var it = model.items[i];
        if (it.seq === null) { continue; }
        // Below the floor it has already been served and pruned: re-adding it would grow the
        // table again from the other end.
        if (ledger.floor !== null && it.seq < ledger.floor) { continue; }
        // Per source like the segments. First writer wins across sources would hand the player
        // the backup's URL whenever that session's poll got there first, which off our cadence is
        // often -- and the look-ahead is the row the player actually fetches.
        if (it.hint) {
            if (ledger.hint[it.seq] === undefined) { ledger.hint[it.seq] = { urls: {}, maps: {} }; }
            var hn = ledger.hint[it.seq];
            if (hn.urls[source] === undefined) { hn.urls[source] = it.url; }
            // Recorded, never announced: a MAP in the look-ahead is a decoder-facing change.
            if (it.map && hn.maps[source] === undefined) { hn.maps[source] = it.map; }
            continue;
        }
        if (ledger.bySeq[it.seq] === undefined) {
            ledger.bySeq[it.seq] = { urls: {}, maps: {}, pdts: {} };
        }
        var e = ledger.bySeq[it.seq];
        if (e.urls[source] === undefined) { e.urls[source] = it.url; }
        if (it.map && e.maps[source] === undefined) { e.maps[source] = it.map; }
        // Per source like the rest: the two sessions label the same number ~2 s apart, so keeping
        // whichever answered first would put a foreign clock in the timeline.
        if (it.pdt && e.pdts[source] === undefined) { e.pdts[source] = it.pdt; }
        if (it.dur && ledger.dur[it.seq] === undefined) { ledger.dur[it.seq] = it.dur; }
        if (ledger.first === null || it.seq < ledger.first) { ledger.first = it.seq; }
        if (ledger.last === null || it.seq > ledger.last) { ledger.last = it.seq; }
    }
    // After the loop: the closing playlist still carries its own tail, so the number recorded has
    // to include it. It is the last number this source will ever carry, and servePlaylist only
    // emits the tag once the window has reached it -- earlier would cut the tail off.
    if (model.ended && ledger.ended[source] === undefined) {
        ledger.ended[source] = ledger.last;
    }
}

// The longest run ending at the highest number held. A hole below it truncates the run: a short
// window is recoverable, a window with a hole in it is a stall the player cannot report.
// Stops at the floor, not at the bottom: in ordinary playback the ledger is contiguous back to
// the start of the session, and walking all of it on every playlist is a cost that grows with
// the session -- 1800 steps an hour, twice a second.
function ledgerTail(ledger) {
    if (ledger.last === null) { return null; }
    var floor = (ledger.floor === null) ? 0 : ledger.floor;
    var lo = ledger.last;
    while (lo > floor && ledger.bySeq[lo - 1] !== undefined) { lo--; }
    return { lo: lo, hi: ledger.last };
}

// Everything below the window we just served will never be asked for again.
var LEDGER_KEEP = 64;
// How far the stamped clock is carried over a hole before a source PDT is read instead.
var PDT_BRIDGE_MAX = 8;
// The largest forward correction the page's clock is allowed to apply to the carried one.
var PDT_RESYNC_MAX_MS = 2000;

function ledgerPrune(ledger, lo) {
    var floor = lo - LEDGER_KEEP;
    if (floor <= (ledger.floor === null ? -1 : ledger.floor)) { return; }
    for (var k in ledger.bySeq) { if (+k < floor) { delete ledger.bySeq[k]; } }
    for (var d in ledger.dur)   { if (+d < floor) { delete ledger.dur[d]; } }
    for (var h in ledger.hint)  { if (+h < floor) { delete ledger.hint[h]; } }
    ledger.floor = floor;
    if (ledger.first === null || ledger.first < floor) { ledger.first = floor; }
}

function newServeState() { return { from: null, pdt: {}, url: {}, hint: {}, top: null }; }

function ledgerDur(ledger, seq) {
    var d = ledger.dur[seq];
    return (typeof d === 'number' && d > 0) ? d : 2;
}

function isoTime(ms) { return new Date(ms).toISOString().replace(/(\\.\\d{3})\\d*Z$/, '$1Z'); }

// One clock, ours. A live number is stamped once and never restamped: the two sessions label the
// same content with PDTs seconds apart, so copying makes the timeline jump at every handover and
// recomputing makes it move under a player that has already read it.
function mainPdt(e) {
    return (e && e.pdts['main'] !== undefined) ? e.pdts['main'] : null;
}

// The page's own clock is the reference; a backup's is only better than nothing.
function anchorPdt(e) {
    if (!e) { return null; }
    var m = mainPdt(e);
    if (m !== null) { return m; }
    for (var k in e.pdts) { return e.pdts[k]; }
    return null;
}

function stampPdt(ledger, state, lo, hi) {
    for (var s = lo; s <= hi; s++) {
        if (state.pdt[s] !== undefined) { continue; }
        var prev = state.pdt[s - 1], t, k;
        if (prev !== undefined) {
            t = prev + Math.round(ledgerDur(ledger, s - 1) * 1000);
        } else if (state.top && s > state.top.seq && s - state.top.seq <= PDT_BRIDGE_MAX) {
            // A short hole is spanned on our own clock rather than re-read from a source: every
            // break ends in one, and re-anchoring there adopts that source's offset for good.
            t = state.top.t;
            for (k = state.top.seq; k < s; k++) { t += Math.round(ledgerDur(ledger, k) * 1000); }
        } else {
            t = Date.parse(anchorPdt(ledger.bySeq[s]));
            if (isNaN(t)) { t = Date.now(); }
            // Past the bridge the carried clock is guesswork, so a real PDT is worth its offset.
            // The timeline may stretch, never fold back.
            if (state.top && s > state.top.seq) {
                var floorT = state.top.t + Math.round(ledgerDur(ledger, state.top.seq) * 1000);
                if (t < floorT) { t = floorT; }
            }
        }
        // A stitch shifts the live clock forward by less than a segment -- the part of the break
        // that did not fall on the cadence. The carried chain cannot see it and drifts behind by
        // that much for good; main's own PDT is the only place it is written down. Forward only,
        // and never by more than one segment, so a wrong value cannot become a jump.
        if (prev !== undefined) {
            var truth = Date.parse(mainPdt(ledger.bySeq[s]));
            if (!isNaN(truth) && truth > t && truth - t <= PDT_RESYNC_MAX_MS) { t = truth; }
        }
        state.pdt[s] = t;
        if (!state.top || s > state.top.seq) { state.top = { seq: s, t: t }; }
    }
}

// Builds the playlist to serve. Returns null when there is not yet enough contiguous content.
// preferHint is separate from prefer because the two answer to different sources: inside a break
// Twitch publishes no look-ahead at all, so there the backup is the only one that has any.
function servePlaylist(ledger, state, prefer, preferHint) {
    // Omitting it must not fall back to whoever answered first: that is the defect itself.
    if (preferHint === undefined) { preferHint = prefer; }
    var run = ledgerTail(ledger);
    if (!run) { return null; }
    var hi = run.hi, lo = hi, acc = ledgerDur(ledger, hi);
    // acc counts lo..hi inclusive, so the next segment is priced before it is taken: adding it
    // after the decrement left the window one segment longer than WINDOW_SECONDS ever allowed.
    while (lo > run.lo && acc + ledgerDur(ledger, lo - 1) <= WINDOW_SECONDS) {
        acc += ledgerDur(ledger, lo - 1); lo--;
    }
    // MEDIA-SEQUENCE never goes backward: undershoot is the one error the player cannot recover.
    if (state.from !== null && lo < state.from) { lo = state.from; }
    if (lo > hi) { return null; }
    stampPdt(ledger, state, lo, hi);

    var needMap = false, ver = 3, s, e;
    for (s = lo; s <= hi; s++) {
        e = ledger.bySeq[s];
        for (var k in (e && e.maps) || {}) { needMap = true; break; }
    }
    if (ledger.version && ledger.version > ver) { ver = ledger.version; }
    if (needMap && ver < 6) { ver = 6; }

    var maxDur = 0;
    for (s = lo; s <= hi; s++) { var d = ledgerDur(ledger, s); if (d > maxDur) { maxDur = d; } }
    // The page's session declares it; a backup's is only better than nothing. The segments are a
    // floor under it: it is a ceiling, and one below a segment we serve is the one way this tag
    // can be wrong.
    var declared = ledger.targetDur['main'];
    if (declared === undefined) { declared = ledger.targetDur[firstKey(ledger.targetDur)]; }
    var target = Math.max(declared || 0, Math.ceil(maxDur || 2));

    var parts = ['#EXTM3U', '#EXT-X-VERSION:' + ver,
                 TARGET_DUR_TAG + target,
                 MEDIA_SEQ_TAG + lo, LIVE_SEQ_TAG + lo];
    var lastMap = null, used = {};
    for (s = lo; s <= hi; s++) {
        e = ledger.bySeq[s];
        // Frozen on first serve: a live number the player has read must not change URL under it.
        if (state.url[s] === undefined) {
            var src = (prefer && e.urls[prefer] !== undefined) ? prefer : firstKey(e.urls);
            state.url[s] = src;
        }
        var src2 = state.url[s];
        used[src2] = (used[src2] || 0) + 1;
        var mp = e.maps[src2] || null;
        if (mp && mp !== lastMap) {
            // A new init segment redefines the tracks. Announcing it inside a window declared
            // continuous asks the decoder for two incompatible things.
            if (lastMap !== null) { parts.push(DISC_TAG); }
            parts.push(MAP_TAG + mp);
            lastMap = mp;
        }
        parts.push(PDT_TAG + isoTime(state.pdt[s]));
        parts.push(INF_TAG + ledgerDur(ledger, s).toFixed(3) + ',live');
        parts.push(e.urls[src2]);
    }
    // The look-ahead Twitch publishes; without it the player sits ~4 s further from the edge.
    // Never emit fewer than the sources can cover: the player answers a missing look-ahead by
    // buying buffer, and it does not give it back -- the latency it adds lasts the session. Twitch
    // publishes none for much of a break, so inside one the backup is the only source that has any.
    for (var h = hi + 1; h <= hi + 2; h++) {
        if (ledger.bySeq[h] !== undefined) { continue; }
        var hint = ledger.hint[h];
        if (!hint) { break; }
        // Frozen on first serve like the window URLs, and for a sharper reason: the player
        // fetches a look-ahead row the moment it reads it, so moving one to the other session
        // downloads the same live number twice.
        if (state.hint[h] === undefined) {
            state.hint[h] = (preferHint && hint.urls[preferHint] !== undefined)
                ? preferHint : firstKey(hint.urls);
        }
        parts.push(PREFETCH_TAG + hint.urls[state.hint[h]]);
    }
    // The page's own session decides the end: the backup is another session and stops on its own
    // clock. Without this the player never learns the broadcast is over -- it keeps polling a
    // window that no longer moves, drains its buffer and sits in Buffering, where Twitch would
    // have shown the offline screen.
    var endedAt = ledger.ended['main'];
    if (endedAt !== undefined && endedAt !== null && hi >= endedAt) {
        parts.push(ENDLIST_TAG);
    }
    parts.push('');

    state.from = lo;
    for (var p in state.pdt) { if (+p < lo - LEDGER_KEEP) { delete state.pdt[p]; delete state.url[p]; } }
    // On its own key, not with the PDTs: a number hinted but never published never gets one.
    for (var q in state.hint) { if (+q < lo - LEDGER_KEEP) { delete state.hint[q]; } }
    ledgerPrune(ledger, lo);
    return { text: parts.join('\\n'), from: lo, to: hi, used: used };
}

function firstKey(o) { for (var k in o) { return k; } return null; }

// ---- backup lane --------------------------------------------------------------------------
// One ledger per rendition the page asks for, fed by two sources: the page's own playlist, and
// a backup player type polled continuously. Kept warm outside breaks too -- a ledger opened when
// the ad has already started holds none of the numbers the ad took.

var LANE_HOT_MS = 12000;
// Covers the whole backup chain on a cold channel: token, usher master, first playlist. With
// the master warmed above only the last leg is left, so this budget is slack, not a target.
var LANE_WAIT_MS = 3000;
var LANE_WAIT_STEP_MS = 100;
// Consecutive non-200s from the backup before its master is treated as stale.
var LANE_MISS_LIMIT = 5;
// Re-mints allowed before the lane is declared down rather than re-minted again.
var LANE_REMINT_LIMIT = 2;
// How long a lane that found nothing stands down. Without it laneFor reopened the whole chain on
// every media playlist -- a token round-trip per player type, twice a second, logged once.
var LANE_RETRY_MS = 30000;

function laneFor(stream, url, realFetch) {
    if (!stream.lanes) { stream.lanes = {}; }
    var lane = stream.lanes[url];
    if (!lane) {
        lane = stream.lanes[url] = { ledger: newLedger(), state: newServeState(), seen: 0,
                                     backupUrl: null, playerType: null, resolution: null,
                                     polling: false, misses: 0, reminted: 0, coldUntil: 0,
                                     srcHead: null, srcHeadAt: 0, bridged: 0 };
    }
    lane.seen = Date.now();
    // Unconditional, not just on creation: poll() stops the lane once the rendition has gone
    // LANE_HOT_MS unasked, so a rung the player left and came back to -- a quality change, a
    // pause -- would otherwise keep a lane that never polls again, and every later break on it
    // would fall through to stripAds. laneOpenBackup is a no-op while the lane is still polling.
    laneOpenBackup(stream, url, lane, realFetch);
    return lane;
}

// Resolves the backup variant for this rendition, then polls it for as long as the page keeps
// asking for the rendition. pickVariant enforces the codec family: a playlist the decoder cannot
// swallow is worse than none.
function laneOpenBackup(stream, url, lane, realFetch) {
    if (lane.polling || Date.now() < lane.coldUntil) { return; }
    lane.polling = true;
    var types = CONFIG.backupPlayerTypes.slice();
    var want = stream.variants[url] || null;

    function attempt() {
        if (!types.length) {
            wlogOnce('lane:' + url, 'warn', 'no backup lane for this rendition -- ads will pass,' +
                ' retrying every ' + (LANE_RETRY_MS / 1000) + 's');
            lane.polling = false;
            lane.coldUntil = Date.now() + LANE_RETRY_MS;
            return;
        }
        var playerType = types.shift();
        fetchBackupMaster(stream, playerType, realFetch)
            .then(function (masterText) {
                var candidates = pickVariant(masterText, want);
                if (!candidates || !candidates.length) { throw new Error('no comparable variant'); }
                lane.backupUrl = candidates[0].url;
                lane.playerType = playerType;
                lane.resolution = candidates[0].resolution || null;
                wlogOnce('lane:' + url, 'debug', 'backup lane via ' + playerType + ' at ' +
                    (candidates[0].resolution || '?'));
                poll();
            })
            .catch(function () { attempt(); });
    }

    // A cached master outlives the session it was minted for: when Twitch rotates that session
    // its playlist answers 404 for good, and a lane that only swallowed the status would poll a
    // dead url once a second while quietly feeding the ledger nothing -- every later break on
    // this rendition falling through with no line saying why. The count clears on the first good
    // body; once it is spent the lane stands down and reopens from the top rather than holding a
    // url that has stopped existing.
    function poll() {
        if (Date.now() - lane.seen > LANE_HOT_MS) { lane.polling = false; return; }
        realFetch(lane.backupUrl)
            .then(function (r) { return r.status === 200 ? r.text() : null; })
            .then(function (t) {
                if (t) {
                    lane.misses = 0;
                    lane.reminted = 0;
                    ledgerAbsorb(lane.ledger, parsePlaylist(t), 'backup');
                    return true;
                }
                lane.misses++;
                if (lane.misses < LANE_MISS_LIMIT) { return true; }
                lane.misses = 0;
                lane.polling = false;
                lane.backupUrl = null;
                delete stream.backupMasters[lane.playerType];
                if (lane.reminted >= LANE_REMINT_LIMIT) {
                    lane.reminted = 0;
                    lane.coldUntil = Date.now() + LANE_RETRY_MS;
                    wlog('warn', 'backup lane is not answering -- standing down for ' +
                        (LANE_RETRY_MS / 1000) + 's');
                    return false;
                }
                lane.reminted++;
                wlog('warn', 'backup lane stopped answering -- re-minting the master');
                laneOpenBackup(stream, url, lane, realFetch);
                return false;
            })
            .catch(function () { return true; })
            .then(function (avanti) {
                if (avanti === false) { return; }
                return workerSleep(1000).then(poll);
            });
    }

    attempt();
}


// MEDIA-SEQUENCE and LIVE-SEQUENCE are served equal, so the gap between them is a constant zero
// and no walk-back exists any more. The original's own gap is not a target to converge on: it is
// session-relative against a global number and drifts a segment further apart at every break, so
// arriving there would tell the player it is minutes behind live.

// A session restart needs no special case: the floor raises the numbering and it carries on. Do
// not add a detector that serves the original raw -- a variant switch looks identical, and the
// numbering the player has already read would drop back to the session's own.


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
    var where = stream && stream.adActive ? 'during a break' : 'in the clear';
    self.postMessage({ key: 'ContinuityBreak', channel: stream ? stream.channel : null,
        from: last.n, to: hit.n, delta: gap, where: where,
        wall: Math.round((now - last.at) / 100) / 10 });
}

function onMediaPlaylist(url, text, realFetch) {
    var stream = streamsByPlaylistUrl[url];
    if (!stream) { return Promise.resolve(text); }
    stream.currentVariant = stream.variants[url] || stream.currentVariant;

    var lane = laneFor(stream, url, realFetch);
    ledgerAbsorb(lane.ledger, parsePlaylist(text), 'main');

    var stitched = hasAdMarkers(text);
    if (!stitched && stream.adActive) {
        stream.adActive = false;
        self.postMessage({ key: 'AdEnded', channel: stream.channel });
    } else if (stitched && !stream.adActive) {
        stream.adActive = true;
        self.postMessage({ key: 'AdStarted', channel: stream.channel,
            isMidroll: text.indexOf('"MIDROLL"') >= 0 || text.indexOf('"midroll"') >= 0 });
    }

    // Preferring 'main' keeps ordinary playback on the page's own session; the backup only fills
    // the live numbers the ad took away.
    return laneServe(stream, lane, text, stitched, LANE_WAIT_MS);
}

// How long both sources may be quiet inside a break before it is bridged.
var LANE_STALL_MS = 4000;

// Both sources can go quiet inside a break -- the backup gone, main carrying nothing but ad
// segments -- and then the ledger head stops and servePlaylist hands the player the same window
// until the break ends, which is a dead origin as far as the player can tell. The break's own
// segments are answered empty by the fetch hook, so they can stand in for the live numbers the ad
// displaced and keep the window moving, numbered forward from the head and never below it.
// One number per ad segment bar the last: the pod ends on a partial that takes a media slot
// without displacing a live one. Falling short leaves a hole
// the run heals from above; overshooting would serve an empty body over real content that has
// come back, so the count errs short.
function laneBridge(lane, text) {
    var ledger = lane.ledger;
    if (ledger.last === null) { return 0; }
    var lines = text.replace(/\\r/g, '').split('\\n');
    var urls = [];
    for (var i = 0; i < lines.length - 1; i++) {
        if (lines[i].indexOf('#EXTINF') === 0 && lines[i].indexOf(',live') < 0) {
            adSegments.set(lines[i + 1], Date.now());
            urls.push(lines[i + 1]);
        }
    }
    var want = urls.length - 1, added = 0;
    for (var n = lane.bridged; n < want; n++) {
        var seq = ledger.last + 1;
        // Never over a number a source has already filled.
        if (ledger.bySeq[seq] !== undefined) { break; }
        // No map and no PDT: an ad init segment must never be announced to the decoder, and the
        // clock stays the one stampPdt is already carrying.
        ledger.bySeq[seq] = { urls: { bridge: urls[n] }, maps: {}, pdts: {} };
        ledger.last = seq;
        lane.bridged = n + 1;
        added++;
    }
    // Carried, so only main or the backup can clear the stall this armed.
    lane.srcHead = ledger.last;
    return added;
}

// Never hand a stitched playlist over: its DATERANGEs light Twitch's own ad UI and its segments
// are fetched and played. A preroll arrives on an empty ledger by definition, so when there is
// nothing to serve yet the answer is to wait for the backup, not to pass the original through.
function laneServe(stream, lane, text, stitched, budget) {
    // The head the two real sources have reached. laneBridge carries it forward with the ledger,
    // so a stall is only ever cleared by main or the backup.
    if (lane.srcHead !== lane.ledger.last) {
        lane.srcHead = lane.ledger.last;
        lane.srcHeadAt = Date.now();
    }
    if (!stitched) {
        lane.bridged = 0;
    } else if (lane.srcHeadAt && Date.now() - lane.srcHeadAt > LANE_STALL_MS) {
        if (laneBridge(lane, text)) {
            wlogOnce('lane:bridge:' + stream.channel, 'warn',
                'no clean source for this break -- bridging it on the original, picture frozen');
        }
    }

    // The segments stay on the page's own session; only the look-ahead follows the break, because
    // a hint main published just before the pod names a live number the pod has displaced.
    var out = servePlaylist(lane.ledger, lane.state, 'main', stitched ? 'backup' : 'main');
    if (out) {
        if (stitched && (out.used.backup || out.used.bridge)) {
            self.postMessage({ key: 'AdBlocked', channel: stream.channel,
                playerType: out.used.backup ? lane.playerType : null,
                resolution: out.used.backup ? (lane.resolution || null) : null });
        }
        return Promise.resolve(out.text);
    }
    if (!stitched) { return Promise.resolve(text); }
    if (budget <= 0) {
        wlogOnce('lane:starve:' + stream.channel, 'warn',
            'backup did not arrive in time -- serving the break stripped');
        return Promise.resolve(stripAds(text, stream));
    }
    return workerSleep(LANE_WAIT_STEP_MS).then(function () {
        return laneServe(stream, lane, text, stitched, budget - LANE_WAIT_STEP_MS);
    });
}

function installFetchHook() {
    var realFetch = self.fetch;
    // Kept outside this closure: the backup lane fetches from the message listener, off the
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
            // parent_domains is how the backend decides the player is embedded, and it is what
            // produces the embed-shaped fake ads.
            var stripped = new URL(url);
            stripped.searchParams.delete('parent_domains');
            url = stripped.href;
            return realFetch(url, options).then(function (response) {
                if (response.status !== 200) { return response; }
                return response.text().then(function (text) {
                    var serverTime = readServerTime(text);
                    var out = onMasterPlaylist(url, text, realFetch);
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
    ChannelChanged: 1
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
    if (data.key === 'ChannelChanged') {
        // onMediaPlaylist is what ends a break, and the playlist being left stops being polled, so
        // its break never ends: returning later would resume it. The cached master playlists
        // survive on purpose; the backup in use does not, and dropping the lanes is what releases
        // it -- coming back the player is a new session, and a ledger or a floor from the previous
        // visit describes numbers it never asked for.
        var left = data.value && streamsByChannel[data.value];
        if (left) {
            left.adActive = false;
            left.lanes = {};
            // traceLastRequest lives outside the stream, keyed by playlist url: release what
            // belonged to its renditions, or it stays attached to urls nobody will ask for again.
            var urls = left.variants ? Object.keys(left.variants) : [];
            for (var u = 0; u < urls.length; u++) { delete traceLastRequest[urls[u]]; delete traceSegDur[urls[u]]; }
        }
        return;
    }
    if (data.key === 'UpdateAuthorization') { GQLState.authorization = data.value; return; }
    if (data.key === 'PlayerReloaded') { lastReloadAt = Date.now(); return; }
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
                        backupPlayerTypes: Config.BackupPlayerTypes.slice(),
                        traceContinuity: Config.TraceContinuity !== false,
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

                // A terminated Worker still accepts postMessage without complaining, so there is
                // no way to ask which of these are dead. Bounded instead: a page runs two at a
                // time, and every reload leaves another behind for the life of the tab.
                State.workers.push(this);
                while (State.workers.length > WORKER_KEEP) { State.workers.shift(); }
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
                            // Baseline for the exit line below: without a reading from before
                            // the break, the one after it has nothing to be compared against.
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
                            logOnce('blocking', 'info', data.playerType
                                ? 'serving a clean stream via ' + data.playerType +
                                    (data.resolution ? ' at ' + data.resolution : '')
                                : 'no clean stream available, stripping ad segments');
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
                            clearOnce('blocking');
                            clearOnce('leak');
                            log('info', 'ad break finished -- watched at ' + describePlayback());
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
