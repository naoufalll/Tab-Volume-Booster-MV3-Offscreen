// --- offscreen.js (Refactored - No Inactivity Listener) ---
console.log("[Offscreen] Document loaded.");

// --- Constants ---
const TARGET_OFFSCREEN = 'offscreen';
const MSG_TYPE_START_CAPTURE = 'startOrUpdateCapture';
const MSG_TYPE_STOP_CAPTURE = 'stopCapture';
const MSG_TYPE_UPDATE_VOLUME = 'updateVolume';

// --- Limiter Configuration ---
// These values create a hard limiter effect. Adjust if needed.
const LIMITER_THRESHOLD = -1.0; // dB. Start limiting slightly below clipping (0dBFS).
const LIMITER_KNEE = 0;         // dB. Hard knee - limit immediately at the threshold.
const LIMITER_RATIO = 20;       // Ratio. High ratio for strong limiting (20:1).
const LIMITER_ATTACK = 0.001;   // Seconds. Very fast attack to catch peaks.
const LIMITER_RELEASE = 0.050;  // Seconds. Relatively fast release.

// --- Global State ---
// Stores active audio processing graphs, keyed by the original targetTabId
const activeStreams = {}; // { targetTabId: { context, source, gainNode, limiterNode, stream } }

// --- Message Handling ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Basic validation: Only handle messages explicitly targeted to offscreen
    if (message.target !== TARGET_OFFSCREEN) {
        return false; // Indicate message not handled
    }
    console.log(`[Offscreen] Received message: ${message.type} for tab ${message.targetTabId || 'N/A'}`);

    // Use a Promise to handle async operations and ensure response is sent
    const messageHandlerPromise = new Promise(async (resolve, reject) => {
        try {
            switch (message.type) {
                case MSG_TYPE_START_CAPTURE:
                    // Ensure required parameters are present
                    if (typeof message.targetTabId !== 'number' || !message.streamId || typeof message.volume !== 'number') {
                        throw new Error("Missing required parameters for startOrUpdateCapture.");
                    }
                    await handleStartOrUpdateCapture(message.targetTabId, message.streamId, message.volume);
                    resolve({ success: true });
                    break;

                case MSG_TYPE_UPDATE_VOLUME:
                     if (typeof message.targetTabId !== 'number' || typeof message.volume !== 'number') {
                        throw new Error("Missing required parameters for updateVolume.");
                    }
                    handleUpdateVolume(message.targetTabId, message.volume);
                    resolve({ success: true });
                    break;

                case MSG_TYPE_STOP_CAPTURE:
                     if (typeof message.targetTabId !== 'number') {
                        throw new Error("Missing targetTabId for stopCapture.");
                    }
                    handleStopCapture(message.targetTabId);
                    resolve({ success: true });
                    break;

                default:
                    console.warn(`[Offscreen] Unrecognized message type: ${message.type}`);
                    reject(new Error(`Unrecognized message type: ${message.type}`));
                    break;
            }
        } catch (error) {
            console.error(`[Offscreen] Error processing message ${message.type} for tab ${message.targetTabId}:`, error);
            reject(error); // Reject the promise with the error
        }
    });

    // Send response back to background script
    messageHandlerPromise
        .then(response => sendResponse(response))
        .catch(error => sendResponse({ success: false, error: error.message || "Unknown error" }));

    // Return true to indicate that the response will be sent asynchronously.
    return true;
});

// --- Audio Processing Functions ---

/**
 * Handles starting or updating the audio capture and processing pipeline.
 * Stops existing capture first if any.
 */
async function handleStartOrUpdateCapture(targetTabId, streamId, volume) {
    console.log(`[Offscreen Audio] === START/UPDATE Capture for tab ${targetTabId} | Vol: ${volume}% ===`);

    // Ensure any previous stream for this tab is stopped before starting a new one
    // This is important for handling navigation where the background sends start again.
    handleStopCapture(targetTabId);

    if (!streamId) {
        console.error("[Offscreen Audio] No streamId provided for capture start.");
        throw new Error("Invalid stream ID provided.");
    }
    if (typeof volume !== 'number' || isNaN(volume)) {
        console.error("[Offscreen Audio] Invalid volume provided for capture start:", volume);
        throw new Error("Invalid volume value.");
    }


    let stream = null;
    try {
        console.log(`[Offscreen Audio] Attempting getUserMedia with streamId: ${streamId}`);
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId,
                },
            },
            video: false // No video needed
        });
        console.log(`[Offscreen Audio] Got MediaStream successfully for tab ${targetTabId}`);
    } catch (error) {
        console.error(`[Offscreen Audio] getUserMedia FAILED for tab ${targetTabId} with streamId ${streamId}:`, error);
        // Provide a more specific error message back to the background script
        throw new Error(`Failed to get media stream: ${error.message}. Ensure tab is audible and permissions are granted.`);
    }

    // --- Setup Web Audio API graph ---
    let audioContext, source, gainNode, limiterNode;
    try {
        console.log("[Offscreen Audio] Creating AudioContext...");
        audioContext = new AudioContext();
        // Resume context if it starts suspended (sometimes happens)
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        console.log("[Offscreen Audio] AudioContext state:", audioContext.state); // Log state after potential resume

        console.log("[Offscreen Audio] Creating MediaStreamSource...");
        source = audioContext.createMediaStreamSource(stream);

        console.log("[Offscreen Audio] Creating GainNode...");
        gainNode = audioContext.createGain();
        const targetGain = Math.max(0, volume / 100); // Ensure gain is not negative
        // Set initial value accurately
        gainNode.gain.setValueAtTime(targetGain, audioContext.currentTime);
        console.log(`[Offscreen Audio] Initial gain set to ${targetGain} (${volume}%)`);

        console.log("[Offscreen Audio] Creating DynamicsCompressorNode (Limiter)...");
        limiterNode = audioContext.createDynamicsCompressor();

        console.log("[Offscreen Audio] Configuring Limiter...");
        // Using setValueAtTime for immediate effect, more robust than direct assignment
        limiterNode.threshold.setValueAtTime(LIMITER_THRESHOLD, audioContext.currentTime);
        limiterNode.knee.setValueAtTime(LIMITER_KNEE, audioContext.currentTime);
        limiterNode.ratio.setValueAtTime(LIMITER_RATIO, audioContext.currentTime);
        limiterNode.attack.setValueAtTime(LIMITER_ATTACK, audioContext.currentTime);
        limiterNode.release.setValueAtTime(LIMITER_RELEASE, audioContext.currentTime);
        console.log(`[Offscreen Audio] Limiter configured for tab ${targetTabId}`);

        console.log("[Offscreen Audio] Connecting audio nodes: Source -> Gain -> Limiter -> Destination");
        source.connect(gainNode);
        gainNode.connect(limiterNode);
        limiterNode.connect(audioContext.destination);

        console.log("[Offscreen Audio] Storing references for tab", targetTabId);
        activeStreams[targetTabId] = {
            context: audioContext,
            source: source,
            gainNode: gainNode,
            limiterNode: limiterNode,
            stream: stream // Store the stream to stop its tracks later
        };

        // No 'inactive' listener here anymore

        console.log(`[Offscreen Audio] === Audio pipeline setup COMPLETE for tab ${targetTabId} ===`);

    } catch (error) {
        console.error(`[Offscreen Audio] Error during Web Audio setup for tab ${targetTabId}:`, error);
        // Cleanup partially created resources if setup fails
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().catch(e => console.warn(`[Offscreen Cleanup] Error closing context during setup failure for ${targetTabId}:`, e));
        }
        // Remove any potentially partial entry from activeStreams
        delete activeStreams[targetTabId];
        throw new Error(`AudioContext setup failed: ${error.message}`);
    }
}

/**
 * Handles updating the volume (gain) for an existing capture.
 */
function handleUpdateVolume(targetTabId, volume) {
    const audioInfo = activeStreams[targetTabId];

    if (typeof volume !== 'number' || isNaN(volume)) {
         console.error(`[Offscreen Audio] Invalid volume received for update: ${volume} for tab ${targetTabId}`);
         throw new Error("Invalid volume value provided for update.");
    }

    if (audioInfo && audioInfo.gainNode && audioInfo.context && audioInfo.context.state === 'running') {
        const targetGain = Math.max(0, volume / 100);
        // Use setTargetAtTime for slightly smoother transitions (optional)
        // audioInfo.gainNode.gain.setTargetAtTime(targetGain, audioInfo.context.currentTime, 0.015);
        // Or set value directly for immediate change:
        audioInfo.gainNode.gain.setValueAtTime(targetGain, audioInfo.context.currentTime);
        console.log(`[Offscreen Audio] Volume updated to ${volume}% (Gain: ${targetGain}) for tab ${targetTabId}`);
    } else {
        console.warn(`[Offscreen Audio] Could not update volume for tab ${targetTabId}. No active/running audio stream found. State: ${audioInfo?.context?.state}`);
        // Do not throw an error here by default, as background might try to recover via restart
        // throw new Error("Cannot update volume: No active stream found.");
    }
}

/**
 * Stops the capture and cleans up all associated resources for a given tab.
 * Safe to call even if capture is not active.
 */
function handleStopCapture(targetTabId) {
    const audioInfo = activeStreams[targetTabId];
    if (audioInfo) {
        console.log(`[Offscreen Cleanup] === Stopping capture and cleaning up resources for tab ${targetTabId} ===`);

        // 1. Stop the MediaStream tracks
        try {
            if (audioInfo.stream) {
                audioInfo.stream.getTracks().forEach(track => track.stop());
                console.log(`[Offscreen Cleanup] Stopped MediaStream tracks for tab ${targetTabId}`);
            }
        } catch (err) {
            console.warn(`[Offscreen Cleanup] Minor error stopping stream tracks for tab ${targetTabId}:`, err);
        }

        // 2. Disconnect Web Audio nodes (best practice: disconnect in reverse order)
        try {
            // Check if nodes exist before disconnecting
            if (audioInfo.limiterNode) audioInfo.limiterNode.disconnect();
            if (audioInfo.gainNode) audioInfo.gainNode.disconnect();
            if (audioInfo.source) audioInfo.source.disconnect();
            // console.log(`[Offscreen Cleanup] Disconnected audio nodes for tab ${targetTabId}`); // Verbose
        } catch (err) {
            console.warn(`[Offscreen Cleanup] Minor error disconnecting nodes for tab ${targetTabId}:`, err);
        }

        // 3. Close the AudioContext
        try {
            if (audioInfo.context && audioInfo.context.state !== 'closed') {
                audioInfo.context.close()
                    .then(() => console.log(`[Offscreen Cleanup] AudioContext closed successfully for tab ${targetTabId}`))
                    .catch(e => console.warn(`[Offscreen Cleanup] Error during AudioContext close for tab ${targetTabId}:`, e));
            }
        } catch (err) {
            // Catch sync errors just in case, though close() returns a Promise
            console.warn(`[Offscreen Cleanup] Minor error initiating AudioContext close for tab ${targetTabId}:`, err);
        } finally {
            // 4. Remove the entry from our tracking object MUST be done last
            delete activeStreams[targetTabId];
            console.log(`[Offscreen Cleanup] Removed state entry for tab ${targetTabId}`);
            console.log(`[Offscreen Cleanup] === Cleanup COMPLETE for tab ${targetTabId} ===`);
        }
    } else {
        // console.log(`[Offscreen Cleanup] stopCapture called for tab ${targetTabId}, but no active stream found.`); // Verbose
    }
}

console.log("[Offscreen] Initial setup complete. Listening for messages.");