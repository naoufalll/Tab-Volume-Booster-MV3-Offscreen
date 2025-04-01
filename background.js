// --- background.js (Refactored) ---
console.log('[BG] Service Worker starting...');

// --- Constants ---
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const STORAGE_KEY_VOLUMES = 'tabVolumes';
const TARGET_OFFSCREEN = 'offscreen';
const DEFAULT_VOLUME = 100;
const SAVE_DEBOUNCE_MS = 500;
const CLOSE_OFFSCREEN_DEBOUNCE_MS = 2000; // Increased slightly for safety margin
const ONUPDATED_RESTART_DEBOUNCE_MS = 350; // Adjusted debounce for nav restarts
const GET_STREAM_ID_TIMEOUT_MS = 5000; // Timeout for getMediaStreamId

// Message Types (Exported implicitly via usage)
const MSG_TYPE_GET_VOLUME = 'GET_VOLUME';
const MSG_TYPE_SET_VOLUME = 'SET_VOLUME';
const MSG_TYPE_GET_ACTIVE_TABS = 'GET_ACTIVE_TABS';
// Internal Message Types (To Offscreen)
const MSG_TYPE_START_CAPTURE = 'startOrUpdateCapture';
const MSG_TYPE_STOP_CAPTURE = 'stopCapture';
const MSG_TYPE_UPDATE_VOLUME = 'updateVolume';

// Logging Prefixes
const LOG_PREFIX = '[BG]';
const LOG_PREFIX_CORE = '[BG Core]';
const LOG_PREFIX_OFFSCREEN = '[BG Offscreen]';
const LOG_PREFIX_STORAGE = '[BG Storage]';
const LOG_PREFIX_TABS = '[BG Tabs]';
const LOG_PREFIX_LIFECYCLE = '[BG Lifecycle]';
const LOG_PREFIX_MSG = '[BG Msg]';


// --- Global State ---
let tabVolumes = {}; // { tabId: volumePercent } - In-memory cache
const activeTabOperations = new Set(); // Tracks tabIds currently undergoing an async operation (start/stop/update)
const onUpdatedRestartTimers = {}; // { tabId: timerId } - For debouncing restarts on navigation

// Timers
let closeOffscreenTimer; // Timer ID for debouncing offscreen close checks
let saveTimeout; // Timer ID for debouncing volume saves

// --- Initialization ---
async function initialize() {
    console.log(`${LOG_PREFIX} Initializing...`);
    await loadInitialVolumes();
    // Initial check to close offscreen if it somehow exists and isn't needed
    await closeOffscreenDocumentIfNeeded(true); // Force immediate check without debounce on init
    console.log(`${LOG_PREFIX} Initialization complete. Listeners added.`);
}

async function loadInitialVolumes() {
    try {
        const result = await chrome.storage.local.get([STORAGE_KEY_VOLUMES]);
        tabVolumes = result[STORAGE_KEY_VOLUMES] || {};
        console.log(`${LOG_PREFIX_STORAGE} Loaded initial volumes:`, JSON.stringify(tabVolumes));
        await cleanupStaleVolumeEntries();
    } catch (error) {
        console.error(`${LOG_PREFIX_STORAGE} Error loading initial volumes:`, error);
        tabVolumes = {};
    }
}

async function cleanupStaleVolumeEntries() {
    const storedTabIds = Object.keys(tabVolumes).map(id => parseInt(id, 10));
    if (storedTabIds.length === 0) return;

    try {
        const existingTabs = await chrome.tabs.query({});
        const existingTabIds = new Set(existingTabs.map(tab => tab.id));
        let changed = false;
        for (const tabId of storedTabIds) {
            if (!existingTabIds.has(tabId)) {
                console.log(`${LOG_PREFIX_STORAGE} Cleanup: Removing stale volume for non-existent tab ${tabId}`);
                delete tabVolumes[tabId];
                changed = true;
            }
        }
        if (changed) {
            await saveVolumes(true); // Save immediately after cleanup
        }
    } catch (error) {
        console.error(`${LOG_PREFIX_STORAGE} Error during stale entry cleanup:`, error);
    }
}

// --- Offscreen Document Management ---

async function hasOffscreenDocument() {
    // Recommended: Check using client matching. More reliable.
    if (self.clients && typeof self.clients.matchAll === 'function') {
        try {
            const clients = await self.clients.matchAll({
                type: 'window', // Offscreen documents are treated as windows
                includeUncontrolled: true // Important for matching documents not controlled by this SW instance yet
            });
            const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
            return clients.some(client => client.url === offscreenUrl);
        } catch (error) {
             console.warn(`${LOG_PREFIX_OFFSCREEN} Error checking clients.matchAll:`, error);
             // Fallback or assume true/false depending on error type if needed
        }
    }

    // Fallback: Use chrome.runtime.getContexts (less preferred but works)
    try {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
            documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
        });
        return contexts.length > 0;
    } catch (error) {
        console.warn(`${LOG_PREFIX_OFFSCREEN} Error checking contexts:`, error);
        return false; // Assume no document on error
    }
}


async function setupOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        // console.log(`${LOG_PREFIX_OFFSCREEN} Document already exists.`); // Verbose
        return;
    }
    console.log(`${LOG_PREFIX_OFFSCREEN} Creating document...`);
    try {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: [chrome.offscreen.Reason.USER_MEDIA],
            justification: 'Tab audio processing for volume control',
        });
        console.log(`${LOG_PREFIX_OFFSCREEN} Document create command issued.`);
        // Small delay *might* sometimes be needed for the doc to fully initialize,
        // but often message passing handles the readiness check implicitly.
        // await new Promise(resolve => setTimeout(resolve, 150));
    } catch (error) {
        console.error(`${LOG_PREFIX_OFFSCREEN} Failed to create document:`, error);
        // Handle specific error "Only a single offscreen document may be created."
        if (error.message.toLowerCase().includes("single offscreen document")) {
            console.warn(`${LOG_PREFIX_OFFSCREEN} Creation failed likely due to race condition (already exists).`);
            // No need to throw, assume it exists or will be handled by subsequent checks.
        } else {
            throw error; // Re-throw other errors
        }
    }
}

async function closeOffscreenDocumentIfNeeded(immediate = false) {
    clearTimeout(closeOffscreenTimer); // Clear any pending timer

    const checkAndClose = async () => {
        const needsCapture = Object.values(tabVolumes).some(v => v !== DEFAULT_VOLUME);
        const activeOperations = activeTabOperations.size > 0;
        // console.log(`${LOG_PREFIX_OFFSCREEN} Close check: NeedsCapture=${needsCapture}, ActiveOps=${activeOperations}`); // Verbose

        if (!needsCapture && !activeOperations) {
            if (await hasOffscreenDocument()) {
                console.log(`${LOG_PREFIX_OFFSCREEN} Closing document (no tabs require capture/ops).`);
                chrome.offscreen.closeDocument()
                    .then(() => console.log(`${LOG_PREFIX_OFFSCREEN} Close successful.`))
                    .catch(err => {
                        const msg = err.message.toLowerCase();
                        if (!msg.includes("has already been closed") && !msg.includes("closing")) {
                            console.warn(`${LOG_PREFIX_OFFSCREEN} Error closing doc:`, err);
                        }
                    });
            }
        }
    };

    if (immediate) {
        // console.log(`${LOG_PREFIX_OFFSCREEN} Performing immediate close check.`); // Verbose
        await checkAndClose();
    } else {
        // console.log(`${LOG_PREFIX_OFFSCREEN} Scheduling debounced close check.`); // Verbose
        closeOffscreenTimer = setTimeout(checkAndClose, CLOSE_OFFSCREEN_DEBOUNCE_MS);
    }
}


// --- Volume State Management ---

/** Saves the current state of tabVolumes to storage. Debounced by default. */
async function saveVolumes(immediate = false) {
    clearTimeout(saveTimeout);

    const saveAction = async () => {
        // console.log(`${LOG_PREFIX_STORAGE} Saving volumes:`, JSON.stringify(tabVolumes)); // Verbose
        try {
            await chrome.storage.local.set({ [STORAGE_KEY_VOLUMES]: tabVolumes });
            // console.log(`${LOG_PREFIX_STORAGE} Volumes saved.`); // Verbose
        } catch (error) {
             console.error(`${LOG_PREFIX_STORAGE} Error saving volumes:`, error);
             // Potentially notify user or retry? For now, just log.
        }
    };

    if (immediate) {
        await saveAction();
    } else {
        saveTimeout = setTimeout(saveAction, SAVE_DEBOUNCE_MS);
    }
}

// --- Core Audio Handling Logic ---

/** Checks if a tab exists. */
async function _checkTabExists(tabId) {
    try {
        await chrome.tabs.get(tabId);
        return true;
    } catch (error) {
        // Error typically means the tab doesn't exist
        return false;
    }
}

/**
 * Main orchestrator for volume changes. Determines action (start/stop/update)
 * and manages locking and error handling.
 */
async function handleVolumeChange(tabId, newVolume, oldVolume) {
    console.log(`${LOG_PREFIX_CORE} Handling volume change for tab ${tabId}. New: ${newVolume}%, Old: ${oldVolume}%`);

    // 1. Check Tab Existence
    if (!await _checkTabExists(tabId)) {
        console.warn(`${LOG_PREFIX_CORE} Tab ${tabId} does not exist. Cleaning up state if necessary.`);
        if (tabVolumes[tabId] && tabVolumes[tabId] !== DEFAULT_VOLUME) {
            delete tabVolumes[tabId];
            await saveVolumes(); // Debounced save
            await closeOffscreenDocumentIfNeeded();
        }
        // Don't throw an error here, just abort the operation for this non-existent tab.
        return;
    }

    // 2. Determine Required Action
    const isCurrentlyCapturingBasedOnOldVol = oldVolume !== undefined && oldVolume !== DEFAULT_VOLUME;
    const shouldBeCapturing = newVolume !== DEFAULT_VOLUME;
    // isForcedRestart: Used when nav requires restarting even if old/new volume are same non-default
    const isForcedRestart = oldVolume === DEFAULT_VOLUME && shouldBeCapturing;

    console.log(`${LOG_PREFIX_CORE} Tab ${tabId}: ShouldBeCapturing=${shouldBeCapturing}, OldVolCaptureState=${isCurrentlyCapturingBasedOnOldVol}, ForcedRestart=${isForcedRestart}`);

    // 3. Acquire Lock
    if (activeTabOperations.has(tabId)) {
        console.warn(`${LOG_PREFIX_CORE} Operation already in progress for tab ${tabId}. Aborting duplicate request.`);
        throw new Error("Operation busy, please wait."); // User-friendly message
    }
    activeTabOperations.add(tabId);

    // 4. Execute Action
    try {
        // --- Case 1: Stop Capture (Transition TO 100%) ---
        if (!shouldBeCapturing && isCurrentlyCapturingBasedOnOldVol) {
            console.log(`${LOG_PREFIX_CORE} Tab ${tabId}: Stopping capture.`);
            await _stopCaptureProcess(tabId);
        }
        // --- Case 2: Start/Restart Capture (Transition FROM 100% or Forced Restart) ---
        else if (shouldBeCapturing && (!isCurrentlyCapturingBasedOnOldVol || isForcedRestart)) {
            console.log(`${LOG_PREFIX_CORE} Tab ${tabId}: Starting/Restarting capture.`);
            if (isForcedRestart) {
                console.log(`${LOG_PREFIX_CORE} Explicitly stopping existing capture before forced restart for tab ${tabId}...`);
                await _sendStopMessageToOffscreen(tabId); // Ensure offscreen cleans up first
                await new Promise(resolve => setTimeout(resolve, 100)); // Short pause
            }
            await _startCaptureProcess(tabId, newVolume);
        }
        // --- Case 3: Update Capture (Changing between non-100% levels) ---
        else if (shouldBeCapturing && isCurrentlyCapturingBasedOnOldVol && !isForcedRestart) {
            console.log(`${LOG_PREFIX_CORE} Tab ${tabId}: Updating capture volume.`);
            await _updateCaptureProcess(tabId, newVolume);
        }
        // --- Case 4: No Change Needed (e.g., staying at 100%) ---
        else {
             // console.log(`${LOG_PREFIX_CORE} Tab ${tabId}: No capture action needed (e.g., remains 100%).`); // Verbose
        }

        // 5. Update State & Save (on success)
        tabVolumes[tabId] = newVolume;
        await saveVolumes(); // Debounced save

    } catch (error) {
        console.error(`${LOG_PREFIX_CORE} FAILURE during handleVolumeChange for tab ${tabId}:`, error);
        // Attempt to clean up offscreen state if a start/update failed
        // Avoid calling stop if the error was related to stopping itself
        if (shouldBeCapturing && !error.message.toLowerCase().includes("stop")) {
            console.warn(`${LOG_PREFIX_CORE} Attempting offscreen cleanup after failure for tab ${tabId}.`);
            await _sendStopMessageToOffscreen(tabId);
        }
        // Rethrow the original error to be handled by the message listener
        throw error;
    } finally {
        // 6. Release Lock (ALWAYS)
        activeTabOperations.delete(tabId);
        // console.log(`${LOG_PREFIX_CORE} Released lock for tab ${tabId}`); // Verbose
        // 7. Check if Offscreen can be closed
        await closeOffscreenDocumentIfNeeded();
    }
}


async function _getMediaStreamIdWithTimeout(tabId) {
    console.log(`${LOG_PREFIX_CORE} Getting MediaStreamId for tab ${tabId}...`);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`tabCapture.getMediaStreamId timed out after ${GET_STREAM_ID_TIMEOUT_MS}ms. Is tab audible?`));
        }, GET_STREAM_ID_TIMEOUT_MS);

        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
            clearTimeout(timer);
            const lastError = chrome.runtime.lastError;
            if (lastError || !id) {
                const errorMsg = `tabCapture.getMediaStreamId failed: ${lastError?.message || "No stream ID returned."} (Tab might not be audible, muted, or capture requires user gesture)`;
                console.error(`${LOG_PREFIX_CORE} getMediaStreamId FAILED for tab ${tabId}:`, errorMsg);
                reject(new Error(errorMsg)); // Use the constructed message
            } else {
                console.log(`${LOG_PREFIX_CORE} Got stream ID ${id} for tab ${tabId}`);
                resolve(id);
            }
        });
    });
}

/** Helper: Starts capture process, including getting stream ID and messaging offscreen. */
async function _startCaptureProcess(tabId, volume) {
    await setupOffscreenDocument(); // Ensure doc exists

    let streamId;
    try {
        streamId = await _getMediaStreamIdWithTimeout(tabId);
    } catch (error) {
        // Add context for better error message
        throw new Error(`Cannot capture tab audio: ${error.message}`);
    }

    console.log(`${LOG_PREFIX_CORE} Sending '${MSG_TYPE_START_CAPTURE}' to offscreen for tab ${tabId}`);
    try {
        const response = await chrome.runtime.sendMessage({
            type: MSG_TYPE_START_CAPTURE,
            target: TARGET_OFFSCREEN,
            targetTabId: tabId,
            streamId: streamId,
            volume: volume
        });
        if (!response || !response.success) {
            const offscreenError = response?.error ? `: ${response.error}` : ". Unknown offscreen error";
            throw new Error(`Internal audio processor error (start)${offscreenError}`);
        }
        console.log(`${LOG_PREFIX_CORE} Offscreen confirmed capture start for tab ${tabId}`);
    } catch (error) {
        // Handle specific connection errors
        if (error.message.includes("Could not establish connection") || error.message.includes("Receiving end does not exist")) {
            console.error(`${LOG_PREFIX_CORE} Failed to connect to offscreen document for tab ${tabId}. It might be closing or crashed.`, error);
            throw new Error(`Internal audio processor unavailable for tab ${tabId}.`);
        }
        console.error(`${LOG_PREFIX_CORE} Error sending '${MSG_TYPE_START_CAPTURE}' or processing response for tab ${tabId}:`, error);
        // Rethrow potentially already specific errors, or a generic one
        throw new Error(error.message.startsWith('Internal audio processor error') ? error.message : `Internal audio processor error (send): ${error.message}`);
    }
}

/** Helper: Sends stop message to offscreen. */
async function _stopCaptureProcess(tabId) {
    await _sendStopMessageToOffscreen(tabId);
}

/** Helper: Sends update message to offscreen. Handles cases where offscreen might need restart. */
async function _updateCaptureProcess(tabId, volume) {
    console.log(`${LOG_PREFIX_CORE} Sending '${MSG_TYPE_UPDATE_VOLUME}' to offscreen for tab ${tabId}`);

    // Quick check if offscreen exists, if not, try full restart
    if (!await hasOffscreenDocument()) {
        console.warn(`${LOG_PREFIX_CORE} Offscreen doc not found during update attempt for tab ${tabId}. Triggering full restart.`);
        await _startCaptureProcess(tabId, volume); // This will re-run the full setup
        return;
    }

    try {
        const response = await chrome.runtime.sendMessage({
            type: MSG_TYPE_UPDATE_VOLUME,
            target: TARGET_OFFSCREEN,
            targetTabId: tabId,
            volume: volume
        });
        if (!response || !response.success) {
             const offscreenError = response?.error ? `: ${response.error}` : ". Unknown offscreen error";
             // If update fails, often best to try restarting the capture entirely
             console.warn(`${LOG_PREFIX_CORE} Offscreen failed to update volume for tab ${tabId}${offscreenError}. Triggering restart.`);
             await _startCaptureProcess(tabId, volume);
             // Do not throw here, as we attempted recovery. Let caller know it completed (via restart).
        } else {
            console.log(`${LOG_PREFIX_CORE} Offscreen confirmed volume update for tab ${tabId}`);
        }
    } catch (error) {
        if (error.message.includes("Could not establish connection") || error.message.includes("Receiving end does not exist")) {
            console.warn(`${LOG_PREFIX_CORE} Update failed for tab ${tabId} (connection issue). Triggering full restart.`);
            await _startCaptureProcess(tabId, volume); // Attempt recovery
        } else {
            console.error(`${LOG_PREFIX_CORE} Error sending '${MSG_TYPE_UPDATE_VOLUME}' or processing response for tab ${tabId}:`, error);
            // Propagate other errors after attempting restart as a fallback? Or just fail? Let's try restart.
            console.warn(`${LOG_PREFIX_CORE} Update failed for tab ${tabId} due to other error. Triggering full restart as fallback.`);
            await _startCaptureProcess(tabId, volume);
            // If restart fails, the error from it will propagate. If it succeeds, operation completed.
        }
    }
}

/** Internal helper: Safely sends stop message to offscreen. */
async function _sendStopMessageToOffscreen(tabId) {
    if (await hasOffscreenDocument()) {
        // console.log(`${LOG_PREFIX_CORE} Sending '${MSG_TYPE_STOP_CAPTURE}' to offscreen for tab ${tabId}`); // Verbose
        try {
            await chrome.runtime.sendMessage({
                type: MSG_TYPE_STOP_CAPTURE,
                target: TARGET_OFFSCREEN,
                targetTabId: tabId
            });
            // console.log(`${LOG_PREFIX_CORE} Sent stopCapture for tab ${tabId}`); // Verbose
        } catch (err) {
            // Ignore connection errors as the doc might be closing/gone.
            const msg = err.message.toLowerCase();
            if (!msg.includes("could not establish connection") && !msg.includes("receiving end does not exist")) {
                console.warn(`${LOG_PREFIX_CORE} Error sending stopCapture to offscreen (tab ${tabId}):`, err);
            }
        }
    }
}

// --- Event Listeners ---

// Listen for messages from Popup or other extension contexts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Basic validation: Ignore messages not from the extension or targeted elsewhere
    if (sender.id !== chrome.runtime.id || message.target === TARGET_OFFSCREEN) {
        return false; // Not handled here (or already handled if targeted to offscreen)
    }

    // Handle messages from popup (identified by lack of sender.tab)
    if (!sender.tab) {
        console.log(`${LOG_PREFIX_MSG} Received message type ${message.type} from popup.`);
        switch (message.type) {
            case MSG_TYPE_GET_VOLUME: {
                const { tabId } = message;
                if (typeof tabId !== 'number') {
                     sendResponse({ error: "Invalid tabId" }); return false;
                }
                const volume = tabVolumes[tabId] ?? DEFAULT_VOLUME; // Use nullish coalescing
                sendResponse({ volume: volume });
                return false; // Synchronous response
            }

            case MSG_TYPE_SET_VOLUME: {
                const { tabId, volume } = message;
                if (typeof tabId !== 'number' || typeof volume !== 'number' || isNaN(volume)) {
                    console.error(`${LOG_PREFIX_MSG} Invalid SET_VOLUME request:`, message);
                    sendResponse({ status: "error", error: "Invalid request parameters." });
                    return false;
                }

                const oldVolume = tabVolumes[tabId];

                 // Avoid processing if volume hasn't changed *and* no operation is pending (which might fix a broken state)
                 if (oldVolume === volume && !activeTabOperations.has(tabId)) {
                     console.log(`${LOG_PREFIX_MSG} Volume for tab ${tabId} already ${volume}%. No change needed.`);
                     sendResponse({ status: "success", message: "No change needed" });
                     return false;
                 }

                // --- Initiate Volume Change ---
                // Note: We update tabVolumes *after* handleVolumeChange succeeds now.
                handleVolumeChange(tabId, volume, oldVolume)
                    .then(() => {
                        console.log(`${LOG_PREFIX_MSG} SET_VOLUME successful for tab ${tabId} to ${volume}%.`);
                        sendResponse({ status: "success" });
                    })
                    .catch(error => {
                        console.error(`${LOG_PREFIX_MSG} SET_VOLUME failed for tab ${tabId}:`, error);
                        // Error message is likely already specific from handleVolumeChange/helpers
                        sendResponse({ status: "error", error: error.message || "Unknown error setting volume." });
                        // No need to revert tabVolumes here, as it wasn't changed yet.
                    });
                return true; // Indicate asynchronous response
            }

            case MSG_TYPE_GET_ACTIVE_TABS: {
                console.log(`${LOG_PREFIX_MSG} Received GET_ACTIVE_TABS request.`);
                const boostedTabIds = Object.entries(tabVolumes)
                    .filter(([, vol]) => vol !== DEFAULT_VOLUME && typeof vol === 'number')
                    .map(([id]) => parseInt(id, 10));

                if (boostedTabIds.length === 0) {
                    sendResponse({ activeTabs: [] });
                    return false; // Sync response
                }

                // Fetch details concurrently
                const getTabDetailsPromises = boostedTabIds.map(tabId =>
                    chrome.tabs.get(tabId).catch(async error => {
                        console.warn(`${LOG_PREFIX_TABS} Error getting details for boosted tab ${tabId} (likely closed):`, error.message);
                        // Clean up state if tab doesn't exist
                        if (tabVolumes[tabId]) {
                            delete tabVolumes[tabId];
                            await saveVolumes(); // Debounced
                            await closeOffscreenDocumentIfNeeded();
                        }
                        return null; // Indicate failure for this tab
                    })
                );

                Promise.all(getTabDetailsPromises).then(tabResults => {
                    const activeTabsData = tabResults
                        .filter(tab => tab !== null && tabVolumes[tab.id] !== undefined) // Filter out failures AND tabs cleaned up concurrently
                        .map(tab => ({
                            tabId: tab.id,
                            title: tab.title || `Tab ID: ${tab.id}`,
                            volume: tabVolumes[tab.id], // Get current volume from state
                            favIconUrl: tab.favIconUrl || null // Use null if missing
                        }));
                    console.log(`${LOG_PREFIX_MSG} Sending active tabs list (${activeTabsData.length} items).`);
                    sendResponse({ activeTabs: activeTabsData });
                }).catch(err => {
                    // Should not happen with individual catches, but safety first
                     console.error(`${LOG_PREFIX_MSG} Unexpected error in Promise.all for GET_ACTIVE_TABS:`, err);
                     sendResponse({ activeTabs: [], error: "Failed to retrieve tab details." });
                });

                return true; // Indicate asynchronous response
            }

            default:
                console.warn(`${LOG_PREFIX_MSG} Received unknown message type from popup: ${message.type}`);
                sendResponse({ status: "error", error: "Unknown message type" });
                return false;
        }
    }
    // Message wasn't for the popup or wasn't handled
    return false;
});

// Listen for Tab Closure
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    console.log(`${LOG_PREFIX_TABS} Tab ${tabId} removed.`);

    // Clean up lock if tab is removed mid-operation
    if (activeTabOperations.has(tabId)) {
        console.warn(`${LOG_PREFIX_TABS} Tab ${tabId} removed during active operation. Clearing lock.`);
        activeTabOperations.delete(tabId);
        // Any ongoing operation related to this tab will likely fail now, which is handled.
    }

    // Clear any pending restart timer for this tab
    if (onUpdatedRestartTimers[tabId]) {
        clearTimeout(onUpdatedRestartTimers[tabId]);
        delete onUpdatedRestartTimers[tabId];
        console.log(`${LOG_PREFIX_TABS} Cleared pending restart timer for removed tab ${tabId}.`);
    }

    // Clean up volume state and stop capture if needed
    if (tabVolumes[tabId] !== undefined) {
        const wasCapturing = tabVolumes[tabId] !== DEFAULT_VOLUME;
        console.log(`${LOG_PREFIX_TABS} Cleaning up volume state for closed tab ${tabId}. Was capturing: ${wasCapturing}.`);
        delete tabVolumes[tabId];
        await saveVolumes(); // Debounced

        if (wasCapturing) {
            await _sendStopMessageToOffscreen(tabId); // Tell offscreen to stop
        }
    }

    // Always check if the offscreen document can be closed after cleanup
    await closeOffscreenDocumentIfNeeded();
});


// Listen for Tab Updates (Navigation, Audible State Changes)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Process only if the tab has a non-default volume stored AND is not currently locked/pending restart
    const currentVolume = tabVolumes[tabId];
    const shouldBeCapturing = currentVolume !== undefined && currentVolume !== DEFAULT_VOLUME;

    if (!shouldBeCapturing) {
        return; // No volume management needed for this tab
    }

    // Prevent triggering restart logic if an operation is already locked or a restart timer is pending
    if (activeTabOperations.has(tabId) || onUpdatedRestartTimers[tabId]) {
        // console.log(`${LOG_PREFIX_TABS} onUpdated: Skipping update for tab ${tabId} due to ongoing operation or pending restart timer.`); // Verbose
        return;
    }

    // --- Logic to Re-apply Volume Boost After Navigation ---
    // We need to restart capture when navigation completes *within* a tab that should be boosted.
    // Key indicators: `changeInfo.status === 'complete'` and `tab.status === 'complete'` (redundant check for safety)
    // We also need the tab to be audible *at the time of completion* to likely succeed in getting a stream ID.
    // Note: 'audible' might become true *after* 'complete'. This logic restarts when BOTH are true *after* load.
    // It also handles cases where audible state *changes* after load.
    const isLoadComplete = changeInfo.status === 'complete' && tab.status === 'complete';
    const isAudibleChanged = changeInfo.audible !== undefined; // Check if audible state changed

    // Trigger condition: (Load completes AND tab is audible) OR (Audible state becomes true AFTER load was already complete)
    if ((isLoadComplete && tab.audible) || (tab.status === 'complete' && changeInfo.audible === true)) {

         console.log(`${LOG_PREFIX_TABS} onUpdated: Scheduling capture re-validation check for tab ${tabId} (Load/Audible change detected). Volume: ${currentVolume}%`);

        // Clear any existing timer (shouldn't be needed due to check above, but safety)
        clearTimeout(onUpdatedRestartTimers[tabId]);

        onUpdatedRestartTimers[tabId] = setTimeout(async () => {
            delete onUpdatedRestartTimers[tabId]; // Clear timer reference

            // Final checks before executing: tab still exists, still needs capturing, not locked
             if (!await _checkTabExists(tabId)) {
                console.log(`${LOG_PREFIX_TABS} onUpdated: Debounced check found tab ${tabId} no longer exists. Aborting.`);
                return;
            }
             if (activeTabOperations.has(tabId)) {
                 console.log(`${LOG_PREFIX_TABS} onUpdated: Restart cancelled for tab ${tabId} due to intervening operation lock.`);
                 return;
             }
            const latestVolume = tabVolumes[tabId];
            if (latestVolume === undefined || latestVolume === DEFAULT_VOLUME) {
                 console.log(`${LOG_PREFIX_TABS} onUpdated: Debounced check found tab ${tabId} no longer requires capture (Volume is ${latestVolume}). Aborting.`);
                 return;
             }

             console.log(`${LOG_PREFIX_TABS} onUpdated: DEBOUNCED - Triggering capture restart for tab ${tabId}. Volume: ${latestVolume}%`);

             // Use handleVolumeChange to perform the restart.
             // Pass DEFAULT_VOLUME as oldVolume to force the 'start/restart' path.
             const forceRestartOldVolume = DEFAULT_VOLUME;
             try {
                 await handleVolumeChange(tabId, latestVolume, forceRestartOldVolume);
             } catch (error) {
                 // Log error, but don't crash the listener. Error is already logged within handleVolumeChange.
                 console.warn(`${LOG_PREFIX_TABS} onUpdated: DEBOUNCED - Error re-applying volume for tab ${tabId}: ${error.message}`);
                 // The state (volume setting) remains, but capture might be broken. User might need to manually reset/reapply.
             }

        }, ONUPDATED_RESTART_DEBOUNCE_MS);
    }
    // --- Other potential onUpdated checks could go here (e.g., if tab becomes inaudible?) ---
    // Currently, we rely on the offscreen doc stopping itself if the stream ends,
    // and the background script managing explicit stops via user action or tab closure.
});


// --- Extension Lifecycle Listeners ---
chrome.runtime.onInstalled.addListener((details) => {
    console.log(`${LOG_PREFIX_LIFECYCLE} Extension ${details.reason}. Version: ${chrome.runtime.getManifest().version}`);
    if (details.reason === 'install') {
        // Clean storage just in case (useful during development)
        // chrome.storage.local.clear(() => console.log("Cleared storage on install."));
    } else if (details.reason === 'update') {
        // Reload volumes on update in case of storage changes or new logic
        initialize(); // Re-run initialization logic
    }
});

chrome.runtime.onStartup.addListener(() => {
    console.log(`${LOG_PREFIX_LIFECYCLE} Browser startup detected.`);
    // Re-load volumes and check state on browser startup
    initialize();
});

// --- Initial Run ---
initialize(); // Start the initialization process when the script loads