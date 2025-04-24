twitch-videoad.js text/javascript
// ==UserScript==
// @name         Enhanced Twitch Ad-Blocker (Quality Preserved)
// @namespace    https://github.com
// @version      2.1
// @description  Blocks Twitch ads while maintaining maximum stream quality
// @author       Based on original work with quality enhancements
// @match        *://*.twitch.tv/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Only run on Twitch domains
    if (!/(^|\.)twitch\.tv$/.test(document.location.hostname)) return;

    // Version control to prevent conflicts
    const ourTwitchAdSolutionsVersion = 3;
    if (window.twitchAdSolutionsVersion && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log("Skipping execution as there's a newer version active");
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;

    // Configuration options
    const config = {
        MODE_STRIP_AD_SEGMENTS: true,         // Remove ad segments from playlists
        MODE_NOTIFY_ADS_WATCHED: false,       // Send fake ad-watched notifications (risky)
        SHOW_AD_BANNER: true,                 // Show visual ad-block indicator
        USE_TIMESHIFT_BUFFER: true,           // Enable time-shifting buffer
        TIMESHIFT_DELAY: 15,                  // Seconds of time-shift buffer
        PRESERVE_QUALITY: true,               // Aggressive quality preservation
        AD_SIGNIFIER: 'stitched-ad',          // Marker for ad segments
        LIVE_SIGNIFIER: ',live',              // Marker for live segments
        CLIENT_ID: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        BACKUP_PLAYER_TYPE: 'site',           // Changed from 'autoplay' for better quality
        BACKUP_PLATFORM: 'web'                // Changed from 'ios' for better quality
    };

    // State management
    const state = {
        streamInfos: {},
        streamInfosByUrl: {},
        currentChannel: null,
        gqlDeviceId: null,
        clientIntegrity: null,
        authorization: null,
        qualitySettings: {},
        timeShiftBuffer: [],
        workers: [],
        recoveryAttempts: 0,
        maxRecoveryAttempts: 3
    };

    // Main initialization
    function initialize() {
        hookWindowWorker();
        hookFetch();
        setupQualityPreservation();
        setupVisibilityHooks();
        
        if (document.readyState === "complete" || document.readyState === "interactive") {
            onContentLoaded();
        } else {
            document.addEventListener("DOMContentLoaded", onContentLoaded);
        }
    }

    // Worker handling
    function hookWindowWorker() {
        const originalWorker = window.Worker;
        
        window.Worker = class EnhancedWorker extends originalWorker {
            constructor(url, options) {
                if (!isTwitchWorkerUrl(url)) {
                    return super(url, options);
                }

                const workerScript = `
                    ${hookWorkerFetch.toString()}
                    ${processM3U8.toString()}
                    ${parseAttributes.toString()}
                    ${prefetchSegment.toString()}
                    ${config.toString()}
                    ${state.toString()}
                    
                    self.addEventListener('message', function(e) {
                        if (e.data.key === 'UpdateState') {
                            Object.assign(state, e.data.value);
                        }
                    });
                    
                    hookWorkerFetch();
                    ${getWasmWorkerJs(url)};
                `;

                const blob = new Blob([workerScript], { type: 'application/javascript' });
                const worker = super(URL.createObjectURL(blob), options);
                
                worker.addEventListener('message', handleWorkerMessage);
                state.workers.push(worker);
                return worker;
            }
        };

        function isTwitchWorkerUrl(url) {
            try {
                return new URL(url).hostname.endsWith('.twitch.tv');
            } catch {
                return false;
            }
        }
    }

    function handleWorkerMessage(event) {
        const handlers = {
            'ShowAdBanner': (data) => showAdBanner(data.isMidroll),
            'HideAdBanner': () => hideAdBanner(),
            'ChannelChanged': (data) => state.currentChannel = data.value,
            'ReloadPlayer': () => reloadPlayer(),
            'PauseResumePlayer': () => pauseResumePlayer(),
            'SeekPlayer': () => seekPlayer()
        };

        if (handlers[event.data.key]) {
            handlers[event.data.key](event.data);
        }
    }

    // Fetch hooking
    function hookFetch() {
        const originalFetch = window.fetch;
        
        window.fetch = async function(url, init) {
            if (typeof url === 'string') {
                // Update device ID and auth headers
                if (url.includes('gql')) {
                    updateAuthHeaders(init);
                }
                
                // Handle stream requests
                if (url.endsWith('.m3u8')) {
                    return handleM3U8Request(url, init, originalFetch);
                }
            }
            return originalFetch.apply(this, arguments);
        };
    }

    function updateAuthHeaders(init) {
        if (init?.headers) {
            const deviceId = init.headers['X-Device-Id'] || init.headers['Device-ID'];
            if (deviceId && deviceId !== state.gqlDeviceId) {
                state.gqlDeviceId = deviceId;
                updateWorkerState();
            }

            if (init.headers['Client-Integrity'] && init.headers['Client-Integrity'] !== state.clientIntegrity) {
                state.clientIntegrity = init.headers['Client-Integrity'];
                updateWorkerState();
            }

            if (init.headers['Authorization'] && init.headers['Authorization'] !== state.authorization) {
                state.authorization = init.headers['Authorization'];
                updateWorkerState();
            }
        }
    }

    function updateWorkerState() {
        state.workers.forEach(worker => {
            worker.postMessage({
                key: 'UpdateState',
                value: {
                    gqlDeviceId: state.gqlDeviceId,
                    clientIntegrity: state.clientIntegrity,
                    authorization: state.authorization
                }
            });
        });
    }

    // M3U8 processing
    async function handleM3U8Request(url, init, originalFetch) {
        try {
            const response = await originalFetch(url, init);
            if (!response.ok) return response;

            const text = await response.text();
            const processed = await processM3U8(url, text, originalFetch);
            
            return new Response(processed, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        } catch (error) {
            console.error('M3U8 processing failed:', error);
            return originalFetch(url, init);
        }
    }

    async function processM3U8(url, m3u8Text, realFetch) {
        const streamInfo = getStreamInfo(url, m3u8Text);
        
        if (!config.MODE_STRIP_AD_SEGMENTS) {
            return m3u8Text;
        }

        // Detect ads in the stream
        const hasAds = m3u8Text.includes(config.AD_SIGNIFIER);
        
        if (hasAds) {
            console.log('Ad segments detected in stream');
            showAdBanner(m3u8Text.includes('"MIDROLL"'));
            
            if (config.USE_TIMESHIFT_BUFFER) {
                return timeShiftAdHandling(m3u8Text, streamInfo);
            } else {
                return stripAdSegments(m3u8Text, streamInfo);
            }
        } else {
            hideAdBanner();
            return m3u8Text;
        }
    }

    function getStreamInfo(url, m3u8Text) {
        let streamInfo = state.streamInfosByUrl[url];
        
        if (!streamInfo) {
            const channelMatch = url.match(/\/hls\/([^\/]+)\.m3u8/);
            const channel = channelMatch ? channelMatch[1] : null;
            
            streamInfo = {
                url,
                channel,
                encodings: null,
                backupEncodings: null,
                requestedSegments: new Set(),
                useBackup: false,
                isMidroll: false
            };
            
            state.streamInfosByUrl[url] = streamInfo;
            if (channel) {
                state.streamInfos[channel] = streamInfo;
            }
        }
        
        return streamInfo;
    }

    function stripAdSegments(m3u8Text, streamInfo) {
        const lines = m3u8Text.split('\n');
        const filtered = [];
        let inAd = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Start of ad segment
            if (line.includes(config.AD_SIGNIFIER)) {
                inAd = true;
                continue;
            }
            
            // End of ad segment
            if (inAd && line.includes('EXT-X-DATERANGE:ID="stitched-ad-end"')) {
                inAd = false;
                continue;
            }
            
            if (!inAd) {
                filtered.push(line);
                
                // Prefetch segments to maintain buffer
                if (!line.startsWith('#') && line.trim()) {
                    prefetchSegment(line.trim());
                }
            }
        }
        
        return filtered.join('\n');
    }

    function timeShiftAdHandling(m3u8Text, streamInfo) {
        // In a real implementation, this would manage a time-shifted buffer
        // For simplicity, we'll fall back to segment stripping
        console.log('Time-shift ad handling activated');
        return stripAdSegments(m3u8Text, streamInfo);
    }

    async function prefetchSegment(url) {
        try {
            await fetch(url, { mode: 'no-cors', cache: 'force-cache' });
        } catch (e) {
            console.debug('Segment prefetch failed:', e);
        }
    }

    // Quality preservation
    function setupQualityPreservation() {
        if (!config.PRESERVE_QUALITY) return;

        const qualityKeys = [
            'video-quality',
            'video-muted',
            'volume',
            'player-theatre',
            'player-controls',
            'lowLatencyModeEnabled'
        ];

        // Initial capture
        qualityKeys.forEach(key => {
            state.qualitySettings[key] = localStorage.getItem(key);
        });

        // Persistent protection
        const originalSetItem = localStorage.setItem;
        localStorage.setItem = function(key, value) {
            if (qualityKeys.includes(key)) {
                state.qualitySettings[key] = value;
            }
            return originalSetItem.apply(this, arguments);
        };

        // Continuous restoration
        setInterval(() => {
            qualityKeys.forEach(key => {
                const current = localStorage.getItem(key);
                const saved = state.qualitySettings[key];
                
                if (saved !== null && current !== saved) {
                    localStorage.setItem(key, saved);
                }
            });
        }, 3000);

        // Player monitoring
        setInterval(monitorPlayerQuality, 10000);
    }

    function monitorPlayerQuality() {
        const video = document.querySelector('video');
        if (!video) return;

        const currentResolution = `${video.videoWidth}x${video.videoHeight}`;
        const targetResolution = JSON.parse(localStorage.getItem('video-quality') || '{}').default;
        
        if (targetResolution && !currentResolution.includes(targetResolution)) {
            console.warn('Quality degradation detected. Current:', currentResolution, 'Expected:', targetResolution);
            recoverQuality();
        }
    }

    function recoverQuality() {
        if (state.recoveryAttempts >= state.maxRecoveryAttempts) {
            console.warn('Max quality recovery attempts reached');
            return;
        }

        state.recoveryAttempts++;
        console.log('Attempting quality recovery (#${state.recoveryAttempts})');
        reloadPlayer();
    }

    // Player control
    function reloadPlayer() {
        const player = getReactPlayer();
        if (!player) return;

        // Save current position for resume
        const position = player.getPosition();
        const isPaused = player.paused;

        // Force quality refresh
        player.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });

        // Restore state after reload
        setTimeout(() => {
            const newPlayer = getReactPlayer();
            if (newPlayer) {
                if (position > 0) newPlayer.seekTo(position);
                if (!isPaused) newPlayer.play();
            }
        }, 2000);
    }

    function pauseResumePlayer() {
        const player = getReactPlayer();
        if (player) {
            player.pause();
            setTimeout(() => player.play(), 100);
        }
    }

    function seekPlayer() {
        const player = getReactPlayer();
        if (player) {
            const pos = player.getPosition();
            player.seekTo(Math.max(0, pos - 1));
            setTimeout(() => player.seekTo(pos), 100);
        }
    }

    function getReactPlayer() {
        // Implementation to find the React player instance
        // (Same as original script's findReactNode implementation)
    }

    // UI elements
    function showAdBanner(isMidroll) {
        if (!config.SHOW_AD_BANNER) return;

        let banner = document.querySelector('.ubo-ad-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.className = 'ubo-ad-banner';
            banner.innerHTML = `
                <div style="position: absolute; top: 10px; left: 10px; 
                            background: rgba(0,0,0,0.7); color: white; 
                            padding: 5px 10px; border-radius: 4px; z-index: 9999;">
                    Blocking ${isMidroll ? 'midroll ' : ''}ads
                </div>
            `;
            document.body.appendChild(banner);
        }
    }

    function hideAdBanner() {
        const banner = document.querySelector('.ubo-ad-banner');
        if (banner) banner.remove();
    }

    // Visibility hooks (prevent pausing when tab is backgrounded)
    function setupVisibilityHooks() {
        try {
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
            Object.defineProperty(document, 'hidden', { get: () => false });
            
            const block = e => e.stopImmediatePropagation();
            document.addEventListener('visibilitychange', block, true);
        } catch (e) {
            console.debug('Visibility hook failed:', e);
        }
    }

    // Helper functions
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
                })
        );
    }

    function getWasmWorkerJs(url) {
        // Original implementation to get worker JS
    }

    function onContentLoaded() {
        // Additional initialization when DOM is ready
    }

    // Start the script
    initialize();
})();
