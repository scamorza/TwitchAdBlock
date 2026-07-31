// ==UserScript==
// @name         TwitchAd (vaft)
// @namespace    https://github.com/scamorza/TwitchAdBlock
// @version      1.3.1
// @description  Twitch ad blocking (vaft), forked from TwitchAdSolutions
// @updateURL    https://github.com/scamorza/TwitchAdBlock/raw/master/vaft.user.js
// @downloadURL  https://github.com/scamorza/TwitchAdBlock/raw/master/vaft.user.js
// @author       https://github.com/scamorza
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==
(function() {
    'use strict';
    // Our @match hits every *.twitch.tv frame, including the hidden auth/ads/analytics ones. Only run
    // in the top frame or in a real embed player. window.frameElement is no use here, it returns null
    // instead of throwing when the parent is cross-origin (which is the case for those frames)
    if (window.self !== window.top) {
        const host = document.location.hostname;
        const path = document.location.pathname;
        // The clip embed is clips.twitch.tv/embed?clip=... (no trailing slash). The chat-only embed
        // has no player, so it stays out even though it lives under /embed/
        const isChatEmbed = /^\/embed\/[^/]+\/chat\/?$/.test(path);
        const isEmbedContext = !isChatEmbed && (host === 'player.twitch.tv' || host === 'embed.twitch.tv'
            || host === 'clips.twitch.tv' || host === 'm.twitch.tv'
            || path === '/embed' || path.startsWith('/embed/'));
        if (!isEmbedContext) {
            console.log('[VAFT] skipping vaft in nested frame');
            return;
        }
    }
    const ourTwitchAdSolutionsVersion = 1;// Used to prevent conflicts with outdated versions of the scripts
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log("[VAFT] skipping vaft as there's another script active. ourVersion:" + ourTwitchAdSolutionsVersion + " activeVersion:" + window.twitchAdSolutionsVersion);
        window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    function declareOptions(scope) {
        scope.AdSignifier = 'stitched';
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            'embed',//Source
            'popout',//Source
            'autoplay',//360p
            //'picture-by-picture-CACHED'//360p (-CACHED is an internal suffix and is removed)
        ];
        scope.FallbackPlayerType = 'embed';
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.SkipPlayerReloadOnHevc = false;// If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers)
        scope.AlwaysReloadPlayerOnAd = false;// Always pause/play when entering/leaving ads
        scope.ReloadPlayerAfterAd = true;// After the ad finishes do a player reload instead of pause/play
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 2;//autoplay
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = [];
        scope.StreamInfosByUrl = [];
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = true;// If true this will pause/play the player when it gets stuck buffering
        scope.PlayerBufferingDelay = 600;// How often should we check the player state (in milliseconds)
        scope.PlayerBufferingSameStateCount = 3;// How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
        scope.PlayerBufferingDangerZone = 1;// The buffering time left (in seconds) when we should ignore the players playback position in the player state check
        scope.PlayerBufferingDoPlayerReload = false;// If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
        scope.PlayerBufferingMinRepeatDelay = 8000;// Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
        scope.PlayerBufferingPrerollCheckEnabled = false;// Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
        scope.PlayerBufferingPrerollCheckOffset = 5;// How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
        scope.PlayerBufferingEscalateAfter = 2;// Consecutive attempts leaving the player state completely untouched before escalating from pause/play to a player reload
        scope.PlayerBufferingMaxIneffectiveAttempts = 4;// Consecutive attempts leaving the player state completely untouched before backing off. The player can wedge below the level pause/play reaches (dead stream, torn down worker), where retrying every ~10s achieves nothing
        scope.PlayerBufferingIneffectiveBackoff = 60000;// While backed off, how long (in milliseconds) between reload attempts. Recovery is still possible (the network may come back), it just stops spamming
        scope.PlayerResumeVerify = true;// After vaft pauses or reloads the player, check that it actually came back. A play() that doesn't take used to strand the player paused for good: the buffering monitor skips paused players, and the only auto-resume on tab refocus requires the video to be muted
        scope.PlayerResumeVerifyDelay = 2000;// How long (in milliseconds) to wait before checking the player resumed. Deliberately short, so a pause the user made themselves is never mistaken for a failed resume
        scope.PlayerResumeVerifyAttempts = 2;// How many extra play() calls to try before forcing a player reload
        scope.PlayerResumeVerifyMaxWaits = 5;// How many checks to let pass while the player is still buffering. A player that is loading is working on it, not stranded, and a reload looks exactly like this while it starts up
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.PreventAutoDownscale = true;// Asks Twitch for the highest available quality and stops it detecting focus loss while the tab is backgrounded (ported from CommanderRoot's "Disable automatic video downscale" script). On 2k/4k channels the top variant is the HEVC one, so this also makes the player reload at ad breaks more likely. Set to false to disable and keep only vaft's own ad blocking behavior.
    }
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    const twitchWorkers = [];
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            } else {
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            Object.setPrototypeOf(reinsert[i], parent);
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        return !workerStringConflicts.some((x) => workerString.includes(x))
            || workerStringAllow.some((x) => workerString.includes(x))
            || workerStringReinsert.some((x) => workerString.includes(x));
    }
    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends getCleanWorker(window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${stripAdSegments.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    GQLDeviceID = ${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = ${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = ${ClientSession ? "'" + ClientSession + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject } = pendingFetchRequests.get(responseData.id);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // Create a Response object from the response data
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('[VAFT] SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('[VAFT] AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    eval(workerString);
                `;
                super(URL.createObjectURL(new Blob([newBlobStr])), options);
                twitchWorkers.push(this);
                // 'hookWorkerFetch' is logged from inside the worker and can't say which frame or player
                // instance it came from. Twitch makes one worker per player, so more than one is normal
                console.log('[VAFT] Twitch worker #' + twitchWorkers.length + ' created in '
                    + (window.self === window.top ? 'top frame' : 'nested frame'));
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        updateAdblockBanner(e.data);
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('[VAFT] Attempt to set twitch worker denied');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        return req.responseText;
    }
    function hookWorkerFetch() {
        console.log('[VAFT] hookWorkerFetch');
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Promise(function(resolve, reject) {
                        const send = function() {
                            return realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA', options).then(function(response) {
                                resolve(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(function(response) {
                                processAfter(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/)[0];
                    if (ForceAccessTokenPlayerType) {
                        // parent_domains is used to determine if the player is embeded and stripping it gets rid of fake ads
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null && (await realFetch(streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m)[0])).status !== 200) {
                                    // The cached encodings are dead (the stream probably restarted)
                                    streamInfo = null;
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    StreamInfos[channelName] = streamInfo = {
                                        ChannelName: channelName,
                                        IsShowingAd: false,
                                        LastPlayerReload: 0,
                                        EncodingsM3U8: encodingsM3u8,
                                        ModifiedM3U8: null,
                                        ModifiedM3U8Swaps: [],// Described here, reported only if the fallback is ever put in use
                                        IsUsingModifiedM3U8: false,
                                        UsherParams: (new URL(url)).search,
                                        RequestedAds: new Set(),
                                        Urls: [],// xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0 }
                                        ResolutionList: [],
                                        BackupEncodingsM3U8Cache: [],
                                        ActiveBackupPlayerType: null,
                                        IsMidroll: false,
                                        IsStrippingAdSegments: false,
                                        NumStrippedAdSegments: 0
                                    };
                                    const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'],
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs.startsWith('avc') || element.Codecs.startsWith('av0'));
                                    if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => element.Codecs.startsWith('hev') || element.Codecs.startsWith('hvc')) && !SkipPlayerReloadOnHevc)) {
                                        if (nonHevcResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    if (resSettings[codecsKey].startsWith('hev') || resSettings[codecsKey].startsWith('hvc')) {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const targetFrameRate = Number(resSettings['FRAME-RATE']) || 0;
                                                        const newResolutionInfo = nonHevcResolutionList.sort((a, b) => {
                                                            const [streamWidthA, streamHeightA] = a.Resolution.split('x').map(Number);
                                                            const [streamWidthB, streamHeightB] = b.Resolution.split('x').map(Number);
                                                            const areaDiff = Math.abs((streamWidthA * streamHeightA) - (targetWidth * targetHeight)) - Math.abs((streamWidthB * streamHeightB) - (targetWidth * targetHeight));
                                                            if (areaDiff !== 0) {
                                                                return areaDiff;
                                                            }
                                                            // Same pixel count (720p60 vs 720p30). Whichever came first in the playlist used to
                                                            // win, and the rewritten line keeps advertising the original FRAME-RATE, so a drop
                                                            // here is invisible to both the player and the quality menu
                                                            return Math.abs((Number(a.FrameRate) || 0) - targetFrameRate) - Math.abs((Number(b.FrameRate) || 0) - targetFrameRate);
                                                        })[0];
                                                        // Recorded, not logged: this playlist is only served once IsUsingModifiedM3U8 is
                                                        // set at the start of an ad, and it may never be. Logging here fired on every page
                                                        // load, once per HEVC variant, and read as though the quality had already dropped
                                                        streamInfo.ModifiedM3U8Swaps.push(resSettings[codecsKey] + ' to ' + newResolutionInfo.Codecs + ' oldRes:' + oldResolution + '@' + targetFrameRate + ' newRes:' + newResolutionInfo.Resolution + '@' + (newResolutionInfo.FrameRate || 0));
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);// The stream doesn't load unless each url line is unique
                                                    }
                                                }
                                            }
                                        }
                                        if (nonHevcResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\n');
                                        }
                                    }
                                }
                                streamInfo.LastPlayerReload = Date.now();
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(function(response) {
                                processAfter(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches.length > 1 ? matches[1] : null;
        }
        const matches = encodingsM3u8.match('SERVER-TIME="([0-9.]+)"');
        return matches.length > 1 ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(new RegExp('(SERVER-TIME=")[0-9.]+"'), `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        const lines = textStr.replaceAll('\r', '').split('\n');
        const newAdUrl = 'https://twitch.tv';
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            // Remove tracking urls which appear in the overlay UI
            line = line
                .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`)
                .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`);
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            }
            if (line.includes(AdSignifier)) {
                hasStrippedAdSegments = true;
            }
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                // No low latency during ads (otherwise it's possible for the player to prefetch and display ad segments)
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        AdSegmentCache.forEach((value, key, map) => {
            if (value < Date.now() - 120000) {
                map.delete(key);
            }
        });
        return lines.join('\n');
    }
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.replaceAll('\r', '').split('\n');
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;
        let closestResolutionUrl = null;
        let closestResolutionDifference = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && encodingsLines[i + 1].includes('.m3u8')) {
                const attributes = parseAttributes(encodingsLines[i]);
                const resolution = attributes['RESOLUTION'];
                const frameRate = attributes['FRAME-RATE'];
                if (resolution) {
                    if (resolution == resolutionInfo.Resolution && (!matchedResolutionUrl || (!matchedFrameRate && frameRate == resolutionInfo.FrameRate))) {
                        matchedResolutionUrl = encodingsLines[i + 1];
                        matchedFrameRate = frameRate == resolutionInfo.FrameRate;
                        if (matchedFrameRate) {
                            return matchedResolutionUrl;
                        }
                    }
                    const [width, height] = resolution.split('x').map(Number);
                    const difference = Math.abs((width * height) - (targetWidth * targetHeight));
                    if (difference < closestResolutionDifference) {
                        closestResolutionUrl = encodingsLines[i + 1];
                        closestResolutionDifference = difference;
                    }
                }
            }
        }
        return closestResolutionUrl;
    }
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        const haveAdTags = textStr.includes(AdSignifier) || SimulatedAdsDepth > 0;
        if (haveAdTags) {
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false
                });
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.replaceAll('\r', '').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            // Only request one .ts file per .m3u8 request to avoid making too many requests
                            //console.log('Fetch ad .ts file');
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            fetch(lines[i + 1]).then((response)=>{response.blob()});
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                console.log('[VAFT] Ads will leak due to missing resolution info for ' + url);
                return textStr;
            }
            const isHevc = currentResolution.Codecs.startsWith('hev') || currentResolution.Codecs.startsWith('hvc');
            if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
                streamInfo.IsUsingModifiedM3U8 = true;
                console.log('[VAFT] ModifiedM3U8 fallback now in use, was on ' + currentResolution.Codecs + ' ' + currentResolution.Resolution + '@' + (currentResolution.FrameRate || 0) + (streamInfo.ModifiedM3U8Swaps?.length ? ' | ' + streamInfo.ModifiedM3U8Swaps.join(' | ') : ''));
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            }
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                // When doing player reload there are a lot of requests which causes the backup stream to load in slow. Briefly prefer using a single version to prevent long delays
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < BackupPlayerTypes.length; playerTypeIndex++) {
                const playerType = BackupPlayerTypes[playerTypeIndex];
                const realPlayerType = playerType.replace('-CACHED', '');
                const isFullyCachedPlayerType = playerType != realPlayerType;
                for (let i = 0; i < 2; i++) {
                    // This caches the m3u8 if it doesn't have ads. If the already existing cache has ads it fetches a new version (second loop)
                    let isFreshM3u8 = false;
                    let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                    if (!encodingsM3u8) {
                        isFreshM3u8 = true;
                        try {
                            const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
                            if (accessTokenResponse.status === 200) {
                                const accessToken = await accessTokenResponse.json();
                                const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                                urlInfo.searchParams.set('sig', accessToken.data.streamPlaybackAccessToken.signature);
                                urlInfo.searchParams.set('token', accessToken.data.streamPlaybackAccessToken.value);
                                const encodingsM3u8Response = await realFetch(urlInfo.href);
                                if (encodingsM3u8Response.status === 200) {
                                    encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                                }
                            }
                        } catch (err) {}
                    }
                    if (encodingsM3u8) {
                        try {
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status == 200) {
                                const m3u8Text = await streamM3u8Response.text();
                                if (m3u8Text) {
                                    if (playerType == FallbackPlayerType) {
                                        fallbackM3u8 = m3u8Text;
                                    }
                                    if ((!m3u8Text.includes(AdSignifier) && (SimulatedAdsDepth == 0 || playerTypeIndex >= SimulatedAdsDepth - 1)) || (!fallbackM3u8 && playerTypeIndex >= BackupPlayerTypes.length - 1)) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    if (isFullyCachedPlayerType) {
                                        break;
                                    }
                                    if (isDoingMinimalRequests) {
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                }
                            }
                        } catch (err) {}
                    }
                    streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) {
                        break;
                    }
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                backupPlayerType = FallbackPlayerType;
                backupM3u8 = fallbackM3u8;
            }
            if (backupM3u8) {
                textStr = backupM3u8;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    console.log(`[VAFT] Blocking${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (${backupPlayerType})`);
                }
            }
            // TODO: Improve hevc stripping. It should always strip when there is a codec mismatch (both ways)
            const stripHevc = isHevc && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripHevc) {
                textStr = stripAdSegments(textStr, stripHevc, streamInfo);
            }
        } else if (streamInfo.IsShowingAd) {
            console.log('[VAFT] Finished blocking ads');
            streamInfo.IsShowingAd = false;
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
            streamInfo.ActiveBackupPlayerType = null;
            if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd) {
                streamInfo.IsUsingModifiedM3U8 = false;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            } else {
                postMessage({
                    key: 'PauseResumePlayer'
                });
            }
        }
        postMessage({
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments
        });
        return textStr;
    }
    function parseAttributes(str) {
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    function getAccessToken(channelName, playerType) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                platform: playerType == 'autoplay' ? 'android' : 'web'
            },
            extensions: {
                persistedQuery: {
                    version:1,
                    sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body, playerType);
    }
    function gqlRequest(body, playerType) {
        if (!GQLDeviceID) {
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            pendingFetchRequests.set(requestId, {
                resolve,
                reject
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    let playerForMonitoringBuffering = null;
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        lastFixTime: 0,
        lastAttemptSignature: null,
        ineffectiveAttempts: 0,
        isBackingOff: false,
        isLive: true
    };
    function monitorPlayerBuffering() {
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                      const fileName = new URL(m3u8Url).pathname.split('/').pop();
                      if (fileName?.endsWith('.m3u8')) {
                          const channelName = fileName.slice(0, -5);
                          if (playerBufferState.channelName != channelName) {
                              playerBufferState.channelName = channelName;
                              playerBufferState.hasStreamStarted = false;
                              playerBufferState.numSame = 0;
                              playerBufferState.lastAttemptSignature = null;
                              playerBufferState.ineffectiveAttempts = 0;
                              playerBufferState.isBackingOff = false;
                              //console.log('Channel changed to ' + channelName);
                          }
                      }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    if (position !== undefined && bufferedPosition !== undefined) {
                        //console.log('position:' + position + ' bufferDuration:' + bufferDuration + ' bufferPosition:' + bufferedPosition + ' state: ' + player.core?.state?.state + ' started: ' + playerBufferState.hasStreamStarted);
                        // NOTE: This could be improved. It currently lets the player fully eat the full buffer before it triggers pause/play
                        if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            (playerBufferState.position == position || bufferDuration < PlayerBufferingDangerZone)  &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                playerBufferState.numSame = 0;
                                // An attempt that leaves all three values bit for bit identical did nothing at all.
                                // Count those: a wedged player never recovers from pause/play, and without this the
                                // mitigation repeats every ~10s indefinitely while achieving nothing
                                const stateSignature = position + '|' + bufferedPosition + '|' + bufferDuration;
                                if (stateSignature !== playerBufferState.lastAttemptSignature) {
                                    playerBufferState.lastAttemptSignature = stateSignature;
                                    playerBufferState.ineffectiveAttempts = 0;
                                    playerBufferState.isBackingOff = false;
                                }
                                const ineffective = playerBufferState.ineffectiveAttempts;
                                const shouldBackOff = ineffective >= PlayerBufferingMaxIneffectiveAttempts;
                                if (shouldBackOff && !playerBufferState.isBackingOff) {
                                    playerBufferState.isBackingOff = true;
                                    console.log('[VAFT] Player state unchanged after ' + ineffective + ' attempts, backing off to one reload every ' + (PlayerBufferingIneffectiveBackoff / 1000) + 's');
                                }
                                if (!shouldBackOff || playerBufferState.lastFixTime <= Date.now() - PlayerBufferingIneffectiveBackoff) {
                                    const isReload = PlayerBufferingDoPlayerReload || ineffective >= PlayerBufferingEscalateAfter;
                                    if (!shouldBackOff) {
                                        console.log('[VAFT] Attempt to fix buffering position:' + position + ' bufferedPosition:' + bufferedPosition + ' bufferDuration:' + bufferDuration + ' state:' + player.core?.state?.state + (isReload ? ' (reload)' : ''));
                                    }
                                    doTwitchPlayerTask(!isReload, isReload);
                                    playerBufferState.lastFixTime = Date.now();
                                    playerBufferState.ineffectiveAttempts++;
                                }
                            }
                        } else {
                            playerBufferState.numSame = 0;
                        }
                        playerBufferState.position = position;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                console.error('[VAFT] error when monitoring player for buffering: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        if (!playerForMonitoringBuffering) {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
            }
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        playerBufferState.isLive = isLive;
        setTimeout(monitorPlayerBuffering, PlayerBufferingDelay);
    }
    function updateAdblockBanner(data) {
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = null;
            adBlockDiv = playerRootDiv.querySelector('.adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                isActivelyStrippingAds = data.isStrippingAdSegments;
                adBlockDiv.P.textContent = 'Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + (data.isStrippingAdSegments ? ' (stripping)' : '');// + (data.numStrippedAdSegments > 0 ? ` (${data.numStrippedAdSegments})` : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
        }
    }
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        return  {
            player: player,
            state: playerState
        };
    }
    // play() hands back the video element's promise, and we used to drop it. A rejection is the
    // difference between the browser refusing the call (NotAllowedError, the autoplay policy on a
    // backgrounded tab) and the call going through while the player stays paused anyway, which is
    // exactly what we can't tell apart today
    function playPlayer(player, context) {
        const result = player.play();
        result?.catch?.((err) => console.log('[VAFT] play() rejected after ' + context + ': ' + (err?.name || err)));
        return result;
    }
    const playerResumeState = {
        timer: null,
        attempts: 0,
        waits: 0,
        escalated: false
    };
    // A play() that doesn't take leaves the player paused, and nothing else in the script can
    // recover it: the buffering monitor skips paused players and the refocus handler only
    // resumes muted ones. Check shortly after our own resume, so a pause the user made
    // themselves (which would come later) is never mistaken for one of ours
    function verifyPlayerResumed() {
        if (!PlayerResumeVerify) {
            return;
        }
        clearTimeout(playerResumeState.timer);
        playerResumeState.timer = setTimeout(() => {
            try {
                const player = getPlayerAndState()?.player;
                if (!player?.core || (!player.isPaused() && !player.core?.paused)) {
                    // Gone, or playing again
                    playerResumeState.attempts = 0;
                    playerResumeState.waits = 0;
                    playerResumeState.escalated = false;
                    return;
                }
                // A player that is still buffering is working on it, not stranded, and a reload
                // looks exactly like this while the new instance starts up. Keep watching rather
                // than calling play() over it or aborting the load with another reload
                if (player.core?.state?.state === 'Buffering' && playerResumeState.waits < PlayerResumeVerifyMaxWaits) {
                    playerResumeState.waits++;
                    verifyPlayerResumed();
                    return;
                }
                if (playerResumeState.attempts < PlayerResumeVerifyAttempts) {
                    playerResumeState.attempts++;
                    console.log('[VAFT] Player still paused after our own resume, retrying play (' + playerResumeState.attempts + '/' + PlayerResumeVerifyAttempts + ')');
                    playPlayer(player, 'resume retry');
                    verifyPlayerResumed();
                } else if (!playerResumeState.escalated) {
                    // Only once, otherwise the reload's own play() would restart this cycle
                    playerResumeState.escalated = true;
                    console.log('[VAFT] Player still paused after ' + playerResumeState.attempts + ' retries, forcing a reload');
                    doTwitchPlayerTask(false, true, true);
                }
            } catch (err) {
                console.error('[VAFT] error when verifying the player resumed: ' + err);
            }
        }, PlayerResumeVerifyDelay);
    }
    function doTwitchPlayerTask(isPausePlay, isReload, ignorePaused) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('[VAFT] Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('[VAFT] Could not find player');
            return;
        }
        if (!playerState) {
            console.log('[VAFT] Could not find player state');
            return;
        }
        // ignorePaused is for our own resume recovery, which exists precisely to act on a
        // paused player. Everywhere else this guard keeps us off a pause the user made
        if (!ignorePaused && (player.isPaused() || player.core?.paused)) {
            return;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            playPlayer(player, 'pause/play');
            verifyPlayerResumed();
            return;
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            try {
                currentQualityLS = localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            console.log('[VAFT] Reloading Twitch player');
            playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            playPlayer(player, 'reload');
            verifyPlayerResumed();
            if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) {
                            localStorage.setItem(lsKeyQuality, currentQualityLS);
                        }
                        if (currentMutedLS) {
                            localStorage.setItem(lsKeyMuted, currentMutedLS);
                        }
                        if (currentVolumeLS) {
                            localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        }
                    } catch {}
                }, 3000);
            }
            return;
        }
    }
    window.reloadTwitchPlayer = () => {
        doTwitchPlayerTask(false, true);
    };
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({key: key, value: value});
        });
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        try {
            const response = await window.realFetch(fetchRequest.url, fetchRequest.options);
            const responseBody = await response.text();
            const responseObject = {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
            return responseObject;
        } catch (error) {
            return {
                id: fetchRequest.id,
                error: error.message
            };
        }
    }
    function hookFetch() {
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = function(url, init, ...args) {
            if (typeof url === 'string') {
                if (url.includes('gql')) {
                    let deviceId = init.headers['X-Device-Id'];
                    if (typeof deviceId !== 'string') {
                        deviceId = init.headers['Device-ID'];
                    }
                    if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                        GQLDeviceID = deviceId;
                        postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                    }
                    if (typeof init.headers['Client-Version'] === 'string' && init.headers['Client-Version'] !== ClientVersion) {
                        postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = init.headers['Client-Version']);
                    }
                    if (typeof init.headers['Client-Session-Id'] === 'string' && init.headers['Client-Session-Id'] !== ClientSession) {
                        postTwitchWorkerMessage('UpdateClientSession', ClientSession = init.headers['Client-Session-Id']);
                    }
                    if (typeof init.headers['Client-Integrity'] === 'string' && init.headers['Client-Integrity'] !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = init.headers['Client-Integrity']);
                    }
                    if (typeof init.headers['Authorization'] === 'string' && init.headers['Authorization'] !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = init.headers['Authorization']);
                    }
                    // Get rid of mini player above chat. Denied locally instead of sending an empty body for
                    // the server to reject; Twitch creates the player's worker either way. Keep above the
                    // ForceAccessTokenPlayerType block, which would rewrite this request's playerType
                    if (init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && init.body.includes('picture-by-picture')) {
                        // A null token with no errors array is still a complete GQL response, and the mini
                        // player has nothing to start from either way. The errors array was reaching
                        // Twitch's Apollo client, which reported our own denial back to the user as a
                        // console error, and a failure shaped like that is also the kind Twitch retries
                        // (#3). Put errors: [{message: 'forbidden'}] back if the mini player returns
                        const deniedToken = () => ({
                            data: {streamPlaybackAccessToken: null, videoPlaybackAccessToken: null}
                        });
                        // Sending the empty body used to get back a 400 'unable to read request body'. A 200
                        // is less likely to be retried, but that 400 is the fallback if the mini player returns
                        const jsonResponse = (body) => Promise.resolve(new Response(JSON.stringify(body), {
                            status: 200,
                            headers: {'Content-Type': 'application/json'}
                        }));
                        const isPictureByPicture = (operation) => typeof operation?.variables?.playerType === 'string'
                            && operation.variables.playerType.includes('picture-by-picture');
                        // Which channel the mini player is asking for. A login we aren't watching means
                        // Twitch is rotating a recommendation preview rather than retrying our denial (#3)
                        const deniedFor = (operation) => operation?.variables?.login || operation?.variables?.vodID || 'unknown';
                        try {
                            const operations = JSON.parse(init.body);
                            if (!Array.isArray(operations)) {
                                if (isPictureByPicture(operations)) {
                                    console.log('[VAFT] Denied picture-by-picture access token locally for ' + deniedFor(operations));
                                    return jsonResponse(deniedToken());
                                }
                            } else if (operations.length > 0 && operations.every(isPictureByPicture)) {
                                console.log('[VAFT] Denied picture-by-picture access token batch locally for ' + operations.map(deniedFor).join(', '));
                                return jsonResponse(operations.map(() => deniedToken()));
                            } else if (operations.some(isPictureByPicture)) {
                                // Responses are matched by position, so denying one entry of a batch means
                                // splicing it back at its index. Emptying the body instead took the real
                                // player's token down with it, which is far worse than the mini player
                                // showing up. Twitch doesn't batch this one; the log is here to tell us
                                // if that ever changes
                                console.log('[VAFT] picture-by-picture batched with other operations, letting it through');
                            }
                        } catch {
                            // String-matched but unreadable, so we don't know what else the body carries.
                            // Same reasoning: leaving it alone is the direction that fails safe
                            console.log('[VAFT] Could not read a picture-by-picture token request, letting it through');
                        }
                    }
                    if (ForceAccessTokenPlayerType && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                        let replacedPlayerType = '';
                        const newBody = JSON.parse(init.body);
                        if (Array.isArray(newBody)) {
                            for (let i = 0; i < newBody.length; i++) {
                                if (newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                    replacedPlayerType = newBody[i].variables.playerType;
                                    newBody[i].variables.playerType = ForceAccessTokenPlayerType;
                                }
                            }
                        } else {
                            if (newBody?.variables?.playerType && newBody?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                replacedPlayerType = newBody.variables.playerType;
                                newBody.variables.playerType = ForceAccessTokenPlayerType;
                            }
                        }
                        if (replacedPlayerType) {
                            console.log(`[VAFT] Replaced '${replacedPlayerType}' player type with '${ForceAccessTokenPlayerType}' player type`);
                            init.body = JSON.stringify(newBody);
                        }
                    }
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function onContentLoaded() {
        // This stops Twitch from pausing the player when in another tab and an ad shows.
        // Taken from https://github.com/saucettv/VideoAdBlockForTwitch/blob/cefce9d2b565769c77e3666ac8234c3acfe20d83/chrome/content.js#L30
        try {
            Object.defineProperty(document, 'visibilityState', {
                get() {
                    return 'visible';
                }
            });
        }catch{}
        let hidden = document.__lookupGetter__('hidden');
        let webkitHidden = document.__lookupGetter__('webkitHidden');
        try {
            Object.defineProperty(document, 'hidden', {
                get() {
                    return false;
                }
            });
        }catch{}
        if (PreventAutoDownscale) {
            try {
                document.hasFocus = () => true;
            } catch {}
        }
        const block = e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        let wasVideoPlaying = true;
        // Lets the first visibilitychange through when a stream was opened in a background tab,
        // otherwise the video stays black until the next one
        const initialHidden = hidden ? hidden.apply(document) === true : false;
        let didInitialPlay = false;
        const visibilityChange = e => {
            const isChrome = typeof chrome !== 'undefined';
            const videos = document.getElementsByTagName('video');
            const isHidden = (hidden && hidden.apply(document) === true) || (webkitHidden && webkitHidden.apply(document) === true);
            if (videos.length > 0) {
                if (isHidden) {
                    wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        //console.log('Tab focused. Stream should be active');
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !videos[0].ended && videos[0].paused && videos[0].muted) {
                        videos[0].play();
                    }
                }
            }
            if (PreventAutoDownscale && !isHidden && initialHidden === true && didInitialPlay === false && e.type === 'visibilitychange') {
                // Only the unprefixed event, which is the one Twitch listens to. The three listeners
                // below share this handler, so the first alias to fire would otherwise eat the one shot
                didInitialPlay = true;
            } else {
                block(e);
            }
        };
        document.addEventListener('visibilitychange', visibilityChange, true);
        document.addEventListener('webkitvisibilitychange', visibilityChange, true);
        document.addEventListener('mozvisibilitychange', visibilityChange, true);
        document.addEventListener('hasFocus', block, true);
        try {
            if (/Firefox/.test(navigator.userAgent)) {
                Object.defineProperty(document, 'mozHidden', {
                    get() {
                        return false;
                    }
                });
            } else {
                Object.defineProperty(document, 'webkitHidden', {
                    get() {
                        return false;
                    }
                });
            }
        }catch{}
        // Hooks for preserving volume / resolution
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',// Low Latency
                'persistenceEnabled',// Mini Player
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            };
            const realGetItem = localStorage.getItem;
            localStorage.getItem = function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            };
            if (!localStorage.getItem.toString().includes(Object.keys({cachedValues})[0])) {
                // These hooks are useful to preserve player state on player reload
                // Firefox doesn't allow hooking of localStorage functions but chrome does
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('[VAFT] localStorageHooks failed ' + err)
            localStorageHookFailed = true;
        }
    }
    // Ported from CommanderRoot's "Disable automatic video downscale" script.
    function setQualitySettings() {
        try {
            localStorage.setItem('s-qs-ts', Date.now());
            // Twitch's own flag for "always take the top variant". It overrides video-quality, so
            // there is no per-channel label to work out and nothing to write at the wrong moment
            localStorage.setItem('video-quality-highest-available', 'true');
            // video-quality and quality-bitrate are both left alone. Twitch maintains them to match
            // the quality actually in use, and video-quality also holds the user's own choice for
            // if they ever turn this option off
        } catch (err) {
            console.log('[VAFT] setQualitySettings failed ' + err);
        }
    }
    declareOptions(window);
    hookWindowWorker();
    hookFetch();
    if (PreventAutoDownscale) {
        setQualitySettings();
        // Reapply when switching page without a full reload (e.g. from a Clip back to a live stream).
        // popstate only covers back/forward, link clicks go through pushState. Only on a real path
        // change, replaceState fires a lot and this writes to localStorage
        let lastPath = document.location.pathname;
        const onNavigation = () => {
            if (document.location.pathname === lastPath) {
                return;
            }
            lastPath = document.location.pathname;
            setQualitySettings();
        };
        window.addEventListener('popstate', onNavigation);
        ['pushState', 'replaceState'].forEach(name => {
            const original = history[name];
            if (typeof original !== 'function') {
                return;
            }
            history[name] = function() {
                const result = original.apply(this, arguments);
                onNavigation();
                return result;
            };
        });
    }
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "loaded" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('[VAFT] Ad depth paramter required (0 = no simulated ad, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
})();
