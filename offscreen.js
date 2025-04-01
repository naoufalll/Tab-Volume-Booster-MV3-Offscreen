// --- offscreen.js (Refactored) ---
console.log("[Offscreen] Document loaded.");

// --- Constants ---
const TARGET_OFFSCREEN = 'offscreen';
const MSG_TYPE_START_CAPTURE = 'startOrUpdateCapture';
const MSG_TYPE_STOP_CAPTURE = 'stopCapture';
const MSG_TYPE_UPDATE_VOLUME = 'updateVolume';

// Logging Prefixes
const LOG_PREFIX = '[Offscreen]';
const LOG_PREFIX_AUDIO = '[Offscreen Audio]';
const LOG_PREFIX_MSG = '[Offscreen Msg]';
const LOG_PREFIX_CLEANUP = '[Offscreen Cleanup]';

// --- Limiter Configuration ---
const LIMITER_THRESHOLD = -1.0; // dB
const LIMITER_KNEE = 0;         // dB
const LIMITER_RATIO = 20;       // Ratio (e.g., 20:1)
const LIMITER_ATTACK = 0.003;   // Seconds (Fast attack)
const LIMITER_RELEASE = 0.050;  // Seconds (Relatively fast release)

// --- Global State ---
// Stores active audio processing graphs, keyed by targetTabId
const activeStreams = {}; // { targetTabId: { context, source, gainNode, limiterNode, stream } }

// --- Message Handling ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Validate message source and target
    if (message.target !== TARGET_OFFSCREEN || sender.id !== chrome.runtime.id) {
        return false; // Indicate message not handled
    }
    console.log(`${LOG_PREFIX_MSG} Received: ${message.type} for tab ${message.targetTabId || 'N/A'}`);

    // Use a Promise to handle async operations and ensure response is sent
    const messageHandlerPromise = new Promise(async (resolve, reject) => {
        const { targetTabId } = message; // Common parameter

        try {
            switch (message.type) {
                case MSG_TYPE_START_CAPTURE:
                    if (typeof targetTabId !== 'number' || !message.streamId || typeof message.volume !== 'number') {
                        throw new Error("Missing/invalid parameters for startOrUpdateCapture.");
                    }
                    await handleStartOrUpdateCapture(targetTabId, message.streamId, message.volume);
                    resolve({ success: true });
                    break;

                case MSG_TYPE_UPDATE_VOLUME:
                     if (typeof targetTabId !== 'number' || typeof message.volume !== 'number' || isNaN(message.volume)) {
                        throw new Error("Missing/invalid parameters for updateVolume.");
                    }
                    handleUpdateVolume(targetTabId, message.volume);
                    resolve({ success: true });
                    break;

                case MSG_TYPE_STOP_CAPTURE:
                     if (typeof targetTabId !== 'number') {
                        throw new Error("Missing targetTabId for stopCapture.");
                    }
                    handleStopCapture(targetTabId); // Stop is synchronous cleanup
                    resolve({ success: true });
                    break;

                default:
                    console.warn(`${LOG_PREFIX_MSG} Unrecognized message type: ${message.type}`);
                    reject(new Error(`Unrecognized message type: ${message.type}`));
                    break;
            }
        } catch (error) {
            console.error(`${LOG_PREFIX_MSG} Error processing ${message.type} for tab ${targetTabId}:`, error);
            // Reject the promise with a potentially more specific error from handlers
            reject(error);
        }
    });

    // Send response back to background script
    messageHandlerPromise
        .then(response => sendResponse(response))
        .catch(error => sendResponse({ success: false, error: error.message || "Unknown offscreen error" }));

    // Return true to indicate that the response will be sent asynchronously.
    return true;
});

// --- Audio Processing Functions ---

/**
 * Handles starting or updating the audio capture and processing pipeline.
 * Stops existing capture for the tab first.
 */
async function handleStartOrUpdateCapture(targetTabId, streamId, volume) {
    console.log(`${LOG_PREFIX_AUDIO} === START/UPDATE Capture Request for tab ${targetTabId} | Vol: ${volume}% ===`);

    // **Crucial:** Stop any existing stream/context for this tab before starting anew.
    // This prevents resource leaks and ensures clean restarts on navigation.
    console.log(`${LOG_PREFIX_AUDIO} Ensuring previous resources for tab ${targetTabId} are stopped first.`);
    handleStopCapture(targetTabId); // Synchronously cleans up existing resources if any

    // Validate inputs again locally
    if (!streamId) {
        console.error(`${LOG_PREFIX_AUDIO} No streamId provided.`);
        throw new Error("Invalid stream ID provided.");
    }
     if (typeof volume !== 'number' || isNaN(volume)) {
         console.error(`${LOG_PREFIX_AUDIO} Invalid volume: ${volume}`);
         throw new Error("Invalid volume value.");
     }

    let stream = null;
    let audioContext = null; // Define here for cleanup scope

    try {
        // 1. Get MediaStream
        console.log(`${LOG_PREFIX_AUDIO} Attempting getUserMedia with streamId: ${streamId}`);
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId,
                },
            },
            video: false
        });
        console.log(`${LOG_PREFIX_AUDIO} Got MediaStream successfully for tab ${targetTabId}`);

        // Check if stream has active audio tracks
        if (!stream.getAudioTracks().some(track => track.enabled && track.readyState === 'live')) {
            console.warn(`${LOG_PREFIX_AUDIO} Acquired stream for tab ${targetTabId}, but it has no active/live audio tracks.`);
            // Don't throw error yet, but setup might fail later or produce silence.
            // Consider throwing if this is consistently problematic:
            // throw new Error("Acquired stream has no active audio tracks.");
        }


        // 2. Setup Web Audio API graph
        console.log(`${LOG_PREFIX_AUDIO} Creating AudioContext...`);
        audioContext = new AudioContext();

        // Ensure context is running
        if (audioContext.state === 'suspended') {
            console.log(`${LOG_PREFIX_AUDIO} AudioContext is suspended, attempting to resume...`);
            await audioContext.resume();
        }
        console.log(`${LOG_PREFIX_AUDIO} AudioContext state: ${audioContext.state}`);
        if (audioContext.state !== 'running') {
             throw new Error(`AudioContext failed to start or resume. State: ${audioContext.state}`);
        }

        const source = audioContext.createMediaStreamSource(stream);
        const gainNode = audioContext.createGain();
        const limiterNode = audioContext.createDynamicsCompressor();

        // Configure Gain
        const targetGain = Math.max(0, volume / 100); // Clamp gain at 0 minimum
        gainNode.gain.setValueAtTime(targetGain, audioContext.currentTime);
        console.log(`${LOG_PREFIX_AUDIO} Initial gain set to ${targetGain.toFixed(2)} (${volume}%)`);

        // Configure Limiter (using constants)
        limiterNode.threshold.setValueAtTime(LIMITER_THRESHOLD, audioContext.currentTime);
        limiterNode.knee.setValueAtTime(LIMITER_KNEE, audioContext.currentTime);
        limiterNode.ratio.setValueAtTime(LIMITER_RATIO, audioContext.currentTime);
        limiterNode.attack.setValueAtTime(LIMITER_ATTACK, audioContext.currentTime);
        limiterNode.release.setValueAtTime(LIMITER_RELEASE, audioContext.currentTime);
        console.log(`${LOG_PREFIX_AUDIO} Limiter configured for tab ${targetTabId}`);

        // Connect nodes: Source -> Gain -> Limiter -> Destination
        source.connect(gainNode);
        gainNode.connect(limiterNode);
        limiterNode.connect(audioContext.destination);
        console.log(`${LOG_PREFIX_AUDIO} Audio nodes connected.`);

        // 3. Store references
        activeStreams[targetTabId] = {
            context: audioContext,
            source: source,
            gainNode: gainNode,
            limiterNode: limiterNode,
            stream: stream // Store stream for track stopping later
        };

        // Optional: Listen for track ending (though background handles explicit stops)
        // stream.getTracks().forEach(track => {
        //     track.onended = () => {
        //         console.log(`${LOG_PREFIX_AUDIO} Track ended for tab ${targetTabId}. Initiating cleanup.`);
        //         // Note: This might fire if the source stops producing audio,
        //         // but background should handle tab closure/nav explicitly.
        //         // Calling handleStopCapture here could interfere with explicit stops.
        //         // It's generally safer to rely on background script's state management.
        //         // handleStopCapture(targetTabId);
        //     };
        // });


        console.log(`${LOG_PREFIX_AUDIO} === Audio pipeline setup COMPLETE for tab ${targetTabId} ===`);

    } catch (error) {
        console.error(`${LOG_PREFIX_AUDIO} Error during audio setup for tab ${targetTabId}:`, error);
        // --- Cleanup on Failure ---
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            console.log(`${LOG_PREFIX_CLEANUP} Stopped stream tracks after setup failure for tab ${targetTabId}.`);
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().catch(e => console.warn(`${LOG_PREFIX_CLEANUP} Error closing context during setup failure cleanup for ${targetTabId}:`, e));
        }
        // Remove potentially partial entry
        delete activeStreams[targetTabId];
        // Rethrow a more informative error for the background script
        throw new Error(`Audio setup failed for tab ${targetTabId}: ${error.message}`);
    }
}

/**
 * Handles updating the volume (gain) for an existing capture.
 */
function handleUpdateVolume(targetTabId, volume) {
    const audioInfo = activeStreams[targetTabId];

    if (typeof volume !== 'number' || isNaN(volume)) {
         console.error(`${LOG_PREFIX_AUDIO} Invalid volume received for update: ${volume} for tab ${targetTabId}`);
         // No throw here, just log, background might retry/restart
         return; // Don't proceed
    }

    if (audioInfo?.context?.state === 'running') {
        const targetGain = Math.max(0, volume / 100); // Ensure gain >= 0
        // Use setValueAtTime for immediate effect, or setTargetAtTime for smooth transition (less critical here)
        audioInfo.gainNode.gain.setValueAtTime(targetGain, audioInfo.context.currentTime);
        // console.log(`${LOG_PREFIX_AUDIO} Volume updated to ${volume}% (Gain: ${targetGain.toFixed(2)}) for tab ${targetTabId}`); // Verbose
    } else {
        console.warn(`${LOG_PREFIX_AUDIO} Could not update volume for tab ${targetTabId}. No active/running audio stream found. State: ${audioInfo?.context?.state ?? 'N/A'}`);
        // Don't throw - background script might see this failure and initiate a restart.
        // If we threw here, it might mask the root cause or prevent recovery.
    }
}

/**
 * Stops the capture and cleans up all associated resources for a given tab.
 * Designed to be safe to call even if capture is not currently active for the tab.
 */
function handleStopCapture(targetTabId) {
    const audioInfo = activeStreams[targetTabId];

    if (!audioInfo) {
        // console.log(`${LOG_PREFIX_CLEANUP} stopCapture called for tab ${targetTabId}, but no active stream found. Nothing to do.`); // Verbose
        return; // Nothing to stop
    }

    console.log(`${LOG_PREFIX_CLEANUP} === Stopping capture and cleaning up resources for tab ${targetTabId} ===`);

    // 1. Stop the MediaStream tracks (prevents further data flow)
    try {
        if (audioInfo.stream) {
            audioInfo.stream.getTracks().forEach(track => track.stop());
            // console.log(`${LOG_PREFIX_CLEANUP} Stopped MediaStream tracks for tab ${targetTabId}`); // Verbose
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX_CLEANUP} Error stopping stream tracks for tab ${targetTabId}:`, err);
    }

    // 2. Disconnect Web Audio nodes (best practice: reverse order, check existence)
    // This prevents memory leaks from dangling node references.
    try {
        if (audioInfo.limiterNode) audioInfo.limiterNode.disconnect();
        if (audioInfo.gainNode) audioInfo.gainNode.disconnect();
        if (audioInfo.source) audioInfo.source.disconnect(); // Disconnect source last
        // console.log(`${LOG_PREFIX_CLEANUP} Disconnected audio nodes for tab ${targetTabId}`); // Verbose
    } catch (err) {
        console.warn(`${LOG_PREFIX_CLEANUP} Error disconnecting nodes for tab ${targetTabId}:`, err);
    }

    // 3. Close the AudioContext (releases underlying OS resources)
    try {
        if (audioInfo.context && audioInfo.context.state !== 'closed') {
            audioInfo.context.close()
                .then(() => console.log(`${LOG_PREFIX_CLEANUP} AudioContext closed successfully for tab ${targetTabId}`))
                .catch(e => console.warn(`${LOG_PREFIX_CLEANUP} Error during async AudioContext close for tab ${targetTabId}:`, e));
        }
    } catch (err) {
        // Catch synchronous errors just in case, although close() returns Promise
        console.warn(`${LOG_PREFIX_CLEANUP} Synchronous error initiating AudioContext close for tab ${targetTabId}:`, err);
    } finally {
        // 4. Remove the entry from our tracking object (MUST be last step)
        delete activeStreams[targetTabId];
        console.log(`${LOG_PREFIX_CLEANUP} Removed state entry for tab ${targetTabId}. Active streams now: ${Object.keys(activeStreams).length}`);
        console.log(`${LOG_PREFIX_CLEANUP} === Cleanup COMPLETE for tab ${targetTabId} ===`);
    }
}

console.log(`${LOG_PREFIX} Initial setup complete. Listening for messages.`);

// Optional: Add a periodic check for orphaned streams (if background SW crashes unexpectedly)
// setInterval(() => {
//   const now = Date.now(); // Or performance.now()
//   // Check activeStreams against known tabs or last message time? Complex.
//   // Generally rely on background script re-syncing on restart.
// }, 60000); // e.g., every minute