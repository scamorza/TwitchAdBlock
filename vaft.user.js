// ==UserScript==
// @name         TwitchAd (vaft)
// @namespace    https://github.com/scamorza/TwitchAdBlock
// @version      2.0.0
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
        // In order. embed/popout give the full ladder; autoplay is capped ~360p but most likely clean.
        BackupPlayerTypes: ['embed', 'popout', 'autoplay'],
        FallbackPlayerType: 'embed',
        // Also strips parent_domains, which is what stops the embed-shaped fake ads.
        ForceAccessTokenPlayerType: 'popout',
        StripAdSegments: true,
        // OFF: where a new player session buys a pre-roll, the end-of-break reload buys another ad,
        // which ends, which reloads again. Pause/play is used instead and resyncs fine.
        ReloadPlayerAfterAd: false,
        // Grace before declaring a break over, for pods where markers vanish briefly. Costs its own
        // duration in stalled video; raise only if the log shows 'ad markers returned after Nms'.
        AdEndGraceSeconds: 0,
        // Loop guard: a second reload inside this window degrades to pause/play.
        ReloadCooldownSeconds: 90,
        // Prime suspect in that loop; first thing to try if it reappears.
        RefreshTokenOnReload: true,

        // -- overlay / squeezeback ads -------------------------------------------------------
        // Nothing is stitched into the segments and the stream never stops: the picture is shrunk,
        // or an ad pod plays above chat. Detection only -- DeclineClientSideAds stops these, and
        // this stays on to catch one that gets through anyway.
        WatchOverlayAds: true,

        // -- client-side (display) ads --------------------------------------------------------
        // Decided in the browser, so none of the playlist machinery above ever sees them. Twitch's
        // ad manager drains its queue as:
        //     this.declineReason ? cmd.decline(this.declineReason) : this.isReady && cmd.fn()
        // cmd.fn() holds the fetch to the ad edge, so setting declineReason stops the request that
        // would have produced the creative -- upstream of the container, not around it.
        DeclineClientSideAds: true,
        // From Twitch's own enum: the reason is passed to each declined command and tracked from
        // there, so an invented string would stand out.
        AdDeclineReason: 'player_size',
        // 500ms apart. The bundle defining the manager can take ~20s to arrive on a cold cache.
        AdDeclineAttempts: 240,

        // -- page visibility -----------------------------------------------------------------
        // Always reports the page as visible: no pause of a backgrounded player mid-ad, and no
        // background downscale (a hidden tab fell 720p60 -> 360p30 in ~2 min without it). Cost:
        // player-core's onSinkStop only touches the player when the document is not hidden, so a
        // stalled sink now reaches a local pause() -- the only reason RecoverBlockedPlayback exists.
        HideVisibility: true,
        // Minimising stops the media sink, and with document.hidden forced false player-core pauses
        // in the branch that emits no event at all, so nothing else notices.
        ResumeOnFocus: true,

        // -- quality -------------------------------------------------------------------------
        // Twitch's own 'video-quality-highest-available'. Does NOT prevent the background downscale
        // despite vaft's similarly-named option claiming so -- measured: with quality pinned it
        // still fell to 360p on schedule. HideVisibility is what stops that.
        PinHighestQuality: true,

        // -- recovery ------------------------------------------------------------------------
        // onSinkStop has three exits: unmuted -> mute and replay (AudioBlocked); muted -> pause +
        // PlaybackBlocked with no retry; else a silent pause. Only the middle one strands the
        // stream with nobody coming, so it is the only one acted on.
        RecoverBlockedPlayback: true,
        ResumeVerifyDelayMs: 2000,
        ResumeVerifyAttempts: 2,

        // OFF: player-core runs its own playback monitor on the same condition and a second loop
        // fights it. Enable only if the player dies outright and stays dead.
        StallBackstop: false,
        StallBackstopSeconds: 20,

        // A decode error tears the media element down and player-core does not retry: it renders
        // "Errore #3000" and waits for a click. Nothing else in here noticed -- the player sat
        // dead for six minutes with not one line in the log -- so this is the backstop for the
        // player being not merely stalled but destroyed. Held for a while before acting, because
        // the same signature appears for a second or two during any ordinary load.
        RecoverDeadPlayer: true,
        DeadPlayerSeconds: 12,

        // Stripping freezes the picture for the whole break. Instead, step down to the best variant
        // of a different codec: costs a second of rebuffer and a rung of quality, both given back
        // when the break ends. OFF makes stripping the final answer again.
        StepDownCodecInsteadOfStripping: true,

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
        counters: { breaks: 0, reloads: 0, backupFailures: 0, recoveries: 0, deadPlayers: 0 }
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

    function getPlayer() {
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
        return instance && controller ? { player: instance, controller } : null;
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

    // Codec step-down, the escape hatch from stripping.
    //
    // On an hevc-source channel the ladder is one hevc rung and five avc transcodes, so a backup
    // search that insists on the same codec has one candidate and a break reaching that rung has
    // nowhere to go. Stepping down to the top avc rung unlocks the five that were always there.
    //
    // Must be the player's own setQuality, not a playlist swapped in underneath: handing an avc
    // playlist to a pipeline opened for hevc stops playback dead, while setQuality rebuilds the
    // pipeline. Measured on 1440p60 hevc: Buffering at 300ms, Playing again at 1000ms.
    //
    // It does NOT touch 'video-quality-highest-available' -- Twitch writes that from its own menu
    // handler, which setQuality on the instance goes around -- so the pin survives a tab closed
    // mid-break. wasAuto matters as much as the name: setQuality takes the player out of automatic,
    // so restoring a name to someone on Auto would leave them quietly pinned to a rung they never
    // chose.
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
    function startStallBackstop() {
        if (!Config.StallBackstop) {
            return;
        }
        let lastBufferedPosition = null;
        let frozenSince = 0;
        setInterval(() => {
            try {
                const found = getPlayer();
                const player = found?.player;
                if (!player?.core || player.isPaused?.() || State.adActive) {
                    frozenSince = 0;
                    return;
                }
                const buffered = player.core?.state?.bufferedPosition;
                if (buffered === undefined) {
                    return;
                }
                if (buffered !== lastBufferedPosition) {
                    lastBufferedPosition = buffered;
                    frozenSince = 0;
                    return;
                }
                if (!frozenSince) {
                    frozenSince = Date.now();
                    return;
                }
                if (Date.now() - frozenSince >= Config.StallBackstopSeconds * 1000) {
                    frozenSince = 0;
                    log('warn', 'buffer frozen for ' + Config.StallBackstopSeconds + 's, nudging the player');
                    pauseResumePlayer();
                }
            } catch (err) {
                log('debug', 'stall backstop error: ' + err);
            }
        }, 2000);
    }

    // Separate from the stall backstop: that one watches a player alive but not advancing, and
    // competes with player-core. This one watches for the player being gone, which player-core
    // does not retry -- so there is nobody else to fight.
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
            text.textContent = 'Blocking' + (State.adIsMidroll ? ' midroll' : '') + ' ads' +
                (State.strippingSegments ? ' (stripping)' : '') +
                (State.activeBackupPlayerType ? ' (' + State.activeBackupPlayerType + ')' : '');
        }
        overlay.style.display = State.adActive ? 'block' : 'none';
    }

    // Detection keys on an effect no implementation can avoid -- the video getting smaller than
    // its container -- and records into a rolling buffer, because by the time an occurrence is
    // noticed the ad is over and the DOM is clean. pbyp state is context, not a trigger: watched
    // during a live occurrence it stayed idle throughout.
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
            // Iframe count is recorded but is NOT a trigger: it fired on every page load, because
            // the baseline came from the first sample, before Twitch's ordinary iframes existed.
            // Aspect equality is what separates a squeezeback from letterboxing -- without it every
            // non-16:9 window looks like an ad.
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
            const indici = [];
            const resto = [];
            operations.forEach((op, i) => { (isPictureByPicture(op) ? indici : resto).push(i); });
            log('debug', 'picture-by-picture batched with ' + resto.length + ' other operation(s)' +
                ' -- denying position(s) ' + indici.join(',') + ' and passing the rest');
            const magro = resto.map((i) => operations[i]);
            const inviare = { ...init, body: JSON.stringify(magro) };
            return realFetch('https://gql.twitch.tv/gql', inviare).then(async (response) => {
                if (response.status !== 200) { return response; }
                const risposte = await response.json();
                const array = Array.isArray(risposte) ? risposte : [risposte];
                const ricomposto = [];
                let k = 0;
                operations.forEach((op, i) => {
                    ricomposto[i] = isPictureByPicture(op)
                        ? { data: { streamPlaybackAccessToken: null, videoPlaybackAccessToken: null } }
                        : array[k++];
                });
                return new Response(JSON.stringify(ricomposto), {
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

// Overrides stream.currentVariant when choosing a backup rendition. currentVariant is whatever the
// player wants at this instant, and right after a codec step-down that is the bottom of the ladder
// it is ramping up from -- aiming at it locked a whole break to 640x360. A backup swap hands the
// player one fixed variant with no ladder left to climb, so the transient value cannot be undone.
var preferredVariant = null;
var streamsByChannel = Object.create(null);
var streamsByPlaylistUrl = Object.create(null);
var adSegments = new Map();
var pendingFetches = new Map();
var lastReloadAt = 0;
var onceMessages = new Map();

// The reply must carry no codec configuration at all, because we never learn which codec the
// SourceBuffer was opened with. This used to be a one-frame mp4 carrying an avc1 sample
// description: harmless on h264, fatal on hevc, where the decoder gets an H.264 track config and
// the player dies with Errore #3000 and never comes back. Zero bytes is the only answer correct
// for every codec -- MSE treats the append as a no-op, and the player still gets its 200.
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
    // An invented device id must never travel with the page's real Client-Integrity: that token is
    // minted for one device, and the same token under another is what a replay looks like. The
    // server burns it, and from then on the page's OWN requests fail their integrity check. The
    // window is real -- Twitch's first token request of a page load carries no device id either.
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

// Twitch's own client sends the full document, not this hash, so the hash is an optimisation we
// are not entitled to assume keeps working. On the first refusal, switch for the session.
function requestAccessToken(channel, playerType) {
    var variables = {
        isLive: true, login: channel, isVod: false, vodID: '',
        playerType: playerType, platform: playerType === 'autoplay' ? 'android' : 'web'
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
            // First clean rung wins. A lower rendition beats a frozen picture, and the viewer gets
            // their quality back when the break ends.
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
        var thisIndex = index;
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
                // Depth pretends the earlier player types still have ads, so 3 forces the fall to
                // autoplay -- on a 2k/4k channel, the codec-mismatch case.
                if (CONFIG.simulatedAdDepth > 0 && thisIndex < CONFIG.simulatedAdDepth - 1) {
                    wlog('debug', 'simulateAd: pretending ' + playerType + ' still has ads');
                    return attempt();
                }
                stream.activeBackup = playerType;
                return { playerType: playerType, text: text };
            })
            .catch(function (err) {
                wlogOnce('backup:' + playerType, 'debug', 'backup stream unavailable via ' + playerType + ': ' + (err && err.message ? err.message : err));
                return attempt();
            });
    }
    return attempt();
}

// One clean playlist, or null with a reason recorded.
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
                return searchPlayerTypes(stream, realFetch);
            })
            .catch(function (err) {
                wlogOnce('backup:' + current, 'debug', 'backup stream via ' + current + ' failed: ' + (err && err.message ? err.message : err));
                stream.activeBackup = null;
                return searchPlayerTypes(stream, realFetch);
            });
    }
    return searchPlayerTypes(stream, realFetch);
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
            adActive: false, stripping: false, cleanSince: null,
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

function onMediaPlaylist(url, text, realFetch) {
    var stream = streamsByPlaylistUrl[url];
    if (!stream) { return Promise.resolve(text); }
    stream.currentVariant = stream.variants[url] || stream.currentVariant;

    // Waiting for a midroll on a particular channel is not a workable way to reach the interesting
    // cases, the codec mismatch on a 2k/4k channel above all.
    if (CONFIG.simulatedAdDepth > 0) {
        if (!stream.adActive) {
            stream.adActive = true;
            wclearOnce('rungs:');
            self.postMessage({ key: 'AdStarted', channel: stream.channel, isMidroll: true, simulated: true });
        }
        return findCleanPlaylist(stream, realFetch).then(function (clean) {
            if (clean) {
                self.postMessage({ key: 'AdBlocked', channel: stream.channel, playerType: clean.playerType, isMidroll: true, stripping: false, resolution: stream.servedResolution || null });
                return clean.text;
            }
            // Falls through to stripping exactly like the real path, otherwise the simulation
            // cannot exercise the branch that matters most on 2k/4k channels -- where no backup
            // carries HEVC and stripping is the only thing left.
            if (CONFIG.stripAdSegments) {
                var strippedText = stripAds(text, stream);
                self.postMessage({ key: 'AdBlocked', channel: stream.channel, playerType: null, isMidroll: true, stripping: true });
                return strippedText;
            }
            wlogOnce('sim', 'warn', 'simulateAd: no clean playlist at depth ' + CONFIG.simulatedAdDepth);
            return text;
        });
    }

    if (!hasAdMarkers(text)) {
        if (stream.adActive) {
            // Multi-ad pods drop the markers for a poll or two between videos, and calling that
            // the end meant resyncing mid-break. The clean playlist is still served during the
            // grace window, so only the end-of-break decision waits, not the content.
            if (!stream.cleanSince) {
                stream.cleanSince = Date.now();
            }
            if (Date.now() - stream.cleanSince >= CONFIG.adEndGraceMs) {
                stream.adActive = false;
                stream.stripping = false;
                stream.cleanSince = null;
                // Released so the next break picks a player type on its own merits. The cached
                // master playlists deliberately survive: they are what make the next break start
                // without paying for the token round-trip all over again.
                stream.activeBackup = null;
                self.postMessage({ key: 'AdEnded', channel: stream.channel });
            }
        }
        return Promise.resolve(text);
    }
    // Markers are back: whatever gap we were in was between ads, not the end of the break
    if (stream.cleanSince) {
        wlog('debug', 'ad markers returned after ' + (Date.now() - stream.cleanSince) + 'ms of clean playlist - same break, still one pod');
        stream.cleanSince = null;
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
            return clean.text;
        }
        if (CONFIG.stripAdSegments) {
            var strippedText = stripAds(text, stream);
            self.postMessage({ key: 'AdBlocked', channel: stream.channel, playerType: null, isMidroll: isMidroll, stripping: true });
            return strippedText;
        }
        wlogOnce('leak', 'warn', 'no clean playlist and stripping is off -- ads will be shown');
        return text;
    });
}

function installFetchHook() {
    var realFetch = self.fetch;
    self.fetch = function (input, options) {
        if (typeof input !== 'string') {
            return realFetch.apply(this, arguments);
        }
        var url = input.trimEnd();

        if (adSegments.has(url)) {
            return Promise.resolve(emptySegmentResponse());
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
                    .then(function (out) { return new Response(out, { status: 200 }); });
            });
        }

        return realFetch.apply(this, arguments);
    };
}

var OUR_MESSAGE_KEYS = {
    UpdateDeviceId: 1, UpdateClientVersion: 1, UpdateClientSession: 1,
    UpdateIntegrity: 1, UpdateAuthorization: 1, PlayerReloaded: 1, FetchResponse: 1,
    SimulateAd: 1, PreferVariant: 1
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
    if (data.key === 'UpdateAuthorization') { GQLState.authorization = data.value; return; }
    if (data.key === 'PlayerReloaded') { lastReloadAt = Date.now(); return; }
    if (data.key === 'SimulateAd') {
        CONFIG.simulatedAdDepth = data.value | 0;
        wlog('warn', 'simulateAd depth set to ' + CONFIG.simulatedAdDepth + (CONFIG.simulatedAdDepth ? ' - forcing the ad path until set back to 0' : ' - back to real ad detection'));
        if (!CONFIG.simulatedAdDepth) {
            // Release the forced state so the next real break starts from a clean slate
            Object.keys(streamsByChannel).forEach(function (k) {
                streamsByChannel[k].adActive = false;
                streamsByChannel[k].activeBackup = null;
            });
            self.postMessage({ key: 'AdEnded', channel: 'simulation' });
        }
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
                        forcePlayerType: !!Config.ForceAccessTokenPlayerType,
                        adEndGraceMs: Math.max(0, Config.AdEndGraceSeconds * 1000),
                        simulatedAdDepth: 0,
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
                            State.adIsMidroll = !!data.isMidroll;
                            // Codec belongs on this line: which path a break takes is decided by
                            // whether the backup ladder can match it, so a line without it cannot
                            // be read afterwards.
                            log('info', 'ad break started on ' + data.channel +
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
                        case 'AdEnded':
                            State.adActive = false;
                            State.activeBackupPlayerType = null;
                            State.strippingSegments = false;
                            clearOnce('blocking');
                            clearOnce('leak');
                            // Before the restore, not after: setQuality is not immediate, so
                            // logging afterwards prints the rung being left beside the line
                            // announcing the return.
                            log('info', 'ad break finished on ' + data.channel +
                                ' -- watched at ' + describePlayback());
                            restoreQualityAfterAdBreak();
                            updateBanner();
                            if (Config.ReloadPlayerAfterAd) {
                                reloadPlayer();
                            } else {
                                pauseResumePlayer();
                            }
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
        // Depth picks how far down BackupPlayerTypes to fall: 1 takes the first that works, 3
        // forces it to autoplay, the codec-mismatch case on a 2k/4k channel. 0 turns it off.
        simulateAd(depth) {
            const value = Math.max(0, depth | 0);
            postToWorkers({ key: 'SimulateAd', value });
            log('info', value
                ? 'simulating an ad break at depth ' + value + ' - call window.vaft2.simulateAd(0) to stop'
                : 'simulation off');
            return value;
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
    // Not in onReady: the first ad request of a session can be issued before DOMContentLoaded, and
    // the retry loop costs nothing while the bundle is still loading.
    startAdManagerDecline();

    function onReady() {
        ensurePlayerWired();
        startStallBackstop();
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
