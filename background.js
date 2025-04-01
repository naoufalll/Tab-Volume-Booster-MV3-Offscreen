// --- background.js (Refactored with Debounce & Explicit Stop) ---
console.log('[BG] Service Worker starting...');

// --- Constants ---
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const STORAGE_KEY_VOLUMES = 'tabVolumes';
const TARGET_OFFSCREEN = 'offscreen';
const MSG_TYPE_GET_VOLUME = 'GET_VOLUME';
const MSG_TYPE_SET_VOLUME = 'SET_VOLUME';
const MSG_TYPE_START_CAPTURE = 'startOrUpdateCapture';
const MSG_TYPE_STOP_CAPTURE = 'stopCapture';
const MSG_TYPE_UPDATE_VOLUME = 'updateVolume';
const MSG_TYPE_GET_ACTIVE_TABS = 'GET_ACTIVE_TABS';
const DEFAULT_VOLUME = 100;
const SAVE_DEBOUNCE_MS = 500;
const CLOSE_OFFSCREEN_DEBOUNCE_MS = 1500; // Delay before closing offscreen doc
const ONUPDATED_RESTART_DEBOUNCE_MS = 300; // Debounce for restarting capture on nav

// --- Global State ---
let tabVolumes = {}; // { tabId: volumePercent } - In-memory cache
const activeTabOperations = new Set(); // Tracks tabIds currently undergoing an async operation
let closeOffscreenTimer; // Timer ID for debouncing offscreen close checks
let saveTimeout; // Timer ID for debouncing volume saves
let onUpdatedRestartTimers = {}; // { tabId: timerId } - For debouncing restarts

// --- Initialization ---
async function loadInitialVolumes() {
    try {
        const result = await chrome.storage.local.get([STORAGE_KEY_VOLUMES]);
        tabVolumes = result[STORAGE_KEY_VOLUMES] || {};
        console.log("[BG] Loaded initial volumes:", tabVolumes);
        // Optional: Clean up volumes for tabs that no longer exist on startup
        await cleanupStaleVolumeEntries();
        await closeOffscreenDocumentIfNeeded(); // Check if offscreen is needed based on loaded state
    } catch (error) {
        console.error("[BG] Error loading initial volumes:", error);
        tabVolumes = {};
    }
}

// Helper to remove stale entries from storage on startup
async function cleanupStaleVolumeEntries() {
    const storedTabIds = Object.keys(tabVolumes).map(id => parseInt(id, 10));
    if (storedTabIds.length === 0) return;

    try {
        const existingTabs = await chrome.tabs.query({});
        const existingTabIds = new Set(existingTabs.map(tab => tab.id));

        let changed = false;
        for (const tabId of storedTabIds) {
            if (!existingTabIds.has(tabId)) {
                console.log(`[BG Cleanup] Removing stale volume entry for non-existent tab ${tabId}`);
                delete tabVolumes[tabId];
                changed = true;
            }
        }
        if (changed) {
            saveVolumes(); // Save the cleaned-up state
        }
    } catch (error) {
        console.error("[BG Cleanup] Error during stale entry cleanup:", error);
    }

}


loadInitialVolumes(); // Load volumes when the service worker starts

// --- Offscreen Document Management ---

/** Checks if the offscreen document currently exists. */
async function hasOffscreenDocument() {
    try {
        // Use client matching for a more robust check
        const clients = await self.clients.matchAll();
        const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
        for (const client of clients) {
            if (client.url === offscreenUrl) {
                return true;
            }
        }
        // Fallback check if client matching isn't sufficient (less reliable)
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
            documentUrls: [offscreenUrl]
        });
        return existingContexts.length > 0;

    } catch (error) {
        // This can happen if the extension context is invalidated during the call
        console.warn("[BG Offscreen] Error checking for offscreen document (possibly context invalidated):", error);
        return false;
    }
}

/** Creates the offscreen document if it doesn't already exist. */
async function setupOffscreenDocument() {
    // console.log('[BG Offscreen] Checking if setup needed...'); // Verbose
    if (await hasOffscreenDocument()) {
        // console.log("[BG Offscreen] Offscreen document already exists."); // Verbose
        return;
    }
    console.log("[BG Offscreen] Creating offscreen document...");
    try {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: [chrome.offscreen.Reason.USER_MEDIA],
            justification: 'Tab audio processing for volume control',
        });
        console.log("[BG Offscreen] Offscreen document create command issued.");
        // Allow time for the document to load and initialize
        await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
         console.error("[BG Offscreen] Failed to create offscreen document:", error);
         // Re-check existence in case of race condition or specific errors
         if (error.message.toLowerCase().includes("only a single offscreen")) {
             console.warn("[BG Offscreen] Creation failed because document might already exist.");
             return; // Assume it exists now
         }
         throw error; // Re-throw other errors
    }
}

/** Closes the offscreen document if no tabs require audio capture, debounced. */
async function closeOffscreenDocumentIfNeeded() {
    clearTimeout(closeOffscreenTimer);
    closeOffscreenTimer = setTimeout(async () => {
        const needsCapture = Object.values(tabVolumes).some(v => v !== DEFAULT_VOLUME);
        const activeOperations = activeTabOperations.size > 0; // Keep open during operations
        // console.log(`[BG Offscreen] Close check: Needs capture? ${needsCapture}, Active Ops? ${activeOperations}`); // Verbose

        if (!needsCapture && !activeOperations) {
            if (await hasOffscreenDocument()) {
                console.log("[BG Offscreen] Closing offscreen document (no tabs require capture/ops).");
                chrome.offscreen.closeDocument()
                    .then(() => console.log("[BG Offscreen] Offscreen close successful."))
                    .catch(err => {
                        // Avoid spamming console if it's already closed or closing
                        const msg = err.message.toLowerCase();
                        if (!msg.includes("has already been closed") && !msg.includes("closing")) {
                            console.warn("[BG Offscreen] Error closing offscreen doc:", err);
                        }
                    });
            } // else { console.log("[BG Offscreen] No offscreen doc to close."); } // Verbose
        } // else { console.log("[BG Offscreen] Keeping offscreen doc open."); } // Verbose
    }, CLOSE_OFFSCREEN_DEBOUNCE_MS);
}

// --- Volume State Management ---

/** Saves the current state of tabVolumes to storage, debounced. */
function saveVolumes() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        // console.log('[BG Storage] Saving volumes:', tabVolumes); // Verbose
        chrome.storage.local.set({ [STORAGE_KEY_VOLUMES]: tabVolumes }, () => {
            if (chrome.runtime.lastError) {
                console.error("[BG Storage] Error saving volumes:", chrome.runtime.lastError);
            } // else { console.log("[BG Storage] Volumes saved."); } // Verbose
        });
    }, SAVE_DEBOUNCE_MS);
}

// --- Core Audio Handling Logic ---

/**
 * Main function to handle volume changes for a tab.
 * Determines required action (start, stop, update capture) and calls helpers.
 */
async function handleVolumeChange(tabId, newVolume, oldVolume) {
    console.log(`[BG Core] Handling volume change for tab ${tabId}. New: ${newVolume}%, Old: ${oldVolume}%`);

    // Check if tab still exists before proceeding
    try {
        await chrome.tabs.get(tabId);
    } catch (error) {
        console.warn(`[BG Core] Tab ${tabId} does not exist. Aborting handleVolumeChange.`);
        // Clean up state if the volume was non-default
        if (tabVolumes[tabId] && tabVolumes[tabId] !== DEFAULT_VOLUME) {
            delete tabVolumes[tabId];
            saveVolumes();
            await closeOffscreenDocumentIfNeeded();
        }
        return; // Stop execution for this non-existent tab
    }

    // Determine capture states (using provided oldVolume)
    // Note: isCurrentlyCapturing reflects the state *before* this potential change based on the oldVolume parameter passed in.
    const isCurrentlyCapturingBasedOnOldVol = oldVolume !== undefined && oldVolume !== DEFAULT_VOLUME;
    const shouldBeCapturing = newVolume !== DEFAULT_VOLUME;
    const isForcedRestart = oldVolume === DEFAULT_VOLUME && shouldBeCapturing; // Specific check for restarts triggered by onUpdated

    console.log(`[BG Core] ShouldBeCapturing: ${shouldBeCapturing}, IsForcedRestart: ${isForcedRestart}`);

    // Prevent concurrent operations on the same tab
    if (activeTabOperations.has(tabId)) {
        console.warn(`[BG Core] Operation already in progress for tab ${tabId}. Aborting handleVolumeChange.`);
        throw new Error("Operation already in progress for this tab."); // Signal busy state
    }
    activeTabOperations.add(tabId); // Lock the tab

    try {
        // --- Case 1: Stop Capture (Transition TO 100%) ---
        if (!shouldBeCapturing && isCurrentlyCapturingBasedOnOldVol) {
             // This handles user setting volume to 100%
            await _stopCaptureProcess(tabId);
        }
        // --- Case 2: Start/Restart Capture (Transition FROM 100% or Forced Restart) ---
        else if (shouldBeCapturing && (!isCurrentlyCapturingBasedOnOldVol || isForcedRestart)) {
             // This handles initial set > 100% OR forced restarts from navigation
            if (isForcedRestart) {
                 console.log(`[BG Core] Explicitly stopping existing capture before forced restart for tab ${tabId}...`);
                 await _sendStopMessageToOffscreen(tabId);
                 // Brief pause to allow resources to potentially release
                 await new Promise(resolve => setTimeout(resolve, 150));
             }
            await _startCaptureProcess(tabId, newVolume);
        }
        // --- Case 3: Update Capture (Changing between non-100% levels, not a forced restart) ---
        else if (shouldBeCapturing && isCurrentlyCapturingBasedOnOldVol && !isForcedRestart) {
            await _updateCaptureProcess(tabId, newVolume);
        }
        // --- Case 4: Staying at 100% (No action needed) ---
        else {
             // console.log(`[BG Core] Volume remains at 100% for tab ${tabId}. No capture action needed.`); // Verbose
        }
    } catch (error) {
        console.error(`[BG Core] Failure during handleVolumeChange for tab ${tabId}:`, error);
        // Attempt cleanup in offscreen document if an error occurred during start/update
        // Don't try to stop if the error was the stop itself failing
        if (shouldBeCapturing && !error.message.includes("stopCapture")) {
            console.warn(`[BG Core] Attempting to stop capture in offscreen due to error for tab ${tabId}`);
            await _sendStopMessageToOffscreen(tabId); // Try to clean up offscreen state
        }
        throw error; // Re-throw error for the caller (e.g., the message listener)
    } finally {
        activeTabOperations.delete(tabId); // IMPORTANT: Release lock regardless of outcome
        await closeOffscreenDocumentIfNeeded(); // Check if the offscreen document can be closed now
    }
}

/** Helper to start the capture process */
async function _startCaptureProcess(tabId, volume) {
    console.log(`[BG Core] Starting capture process for tab ${tabId} at ${volume}%.`);
    await setupOffscreenDocument(); // Ensure doc exists first

    // Get Media Stream ID
    let streamId;
    try {
        console.log(`[BG Core] Getting MediaStreamId for tab ${tabId}...`);
        streamId = await new Promise((resolve, reject) => {
            // Use a timeout for getting the stream ID, as it can hang if the tab is not audible
            const timeoutMs = 5000; // 5 seconds
            const timer = setTimeout(() => {
                 reject(new Error(`tabCapture.getMediaStreamId timed out after ${timeoutMs}ms. Is tab audible?`));
            }, timeoutMs);

            chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
                clearTimeout(timer); // Clear the timeout if we get a response
                const lastError = chrome.runtime.lastError;
                if (lastError || !id) {
                    const errorMsg = `tabCapture.getMediaStreamId failed: ${lastError?.message || "No stream ID returned."} (Tab might not be audible or another capture is active)`;
                    console.error(`[BG Core] getMediaStreamId FAILED for tab ${tabId}:`, errorMsg);
                    reject(new Error(errorMsg));
                } else {
                    console.log(`[BG Core] Got stream ID ${id} for tab ${tabId}`);
                    resolve(id);
                }
            });
        });
         // Small delay sometimes helps ensure the stream is ready, though often not needed
         // await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
        console.error(`[BG Core] Failed to get stream ID for tab ${tabId}:`, error);
        throw error; // Propagate the error
    }


    // Send 'startOrUpdateCapture' command to offscreen
    console.log(`[BG Core] Sending '${MSG_TYPE_START_CAPTURE}' to offscreen for tab ${tabId}`);
    try {
        const response = await chrome.runtime.sendMessage({
            type: MSG_TYPE_START_CAPTURE,
            target: TARGET_OFFSCREEN,
            targetTabId: tabId,
            streamId: streamId,
            volume: volume
        });
        if (!response || !response.success) {
             // Prepend tab ID to the error message from offscreen for better context
             const offscreenError = response?.error ? `Tab ${tabId}: ${response.error}` : `Tab ${tabId}: Unknown offscreen error`;
             throw new Error(`Offscreen document failed to start capture. ${offscreenError}`);
        }
        console.log(`[BG Core] Offscreen confirmed capture start/update for tab ${tabId}`);
    } catch (error) {
         // Handle cases where the offscreen document might not exist or fails to respond
         if (error.message.includes("Could not establish connection") || error.message.includes("Receiving end does not exist")) {
             console.error(`[BG Core] Failed to connect to offscreen document for tab ${tabId}. It might be closing or crashed.`, error);
             throw new Error(`Failed to connect to audio processor for tab ${tabId}.`);
         }
         console.error(`[BG Core] Error sending '${MSG_TYPE_START_CAPTURE}' or processing response for tab ${tabId}:`, error);
         throw error; // Propagate other errors
    }
}

/** Helper to stop the capture process */
async function _stopCaptureProcess(tabId) {
    console.log(`[BG Core] Stopping capture process for tab ${tabId}.`);
    await _sendStopMessageToOffscreen(tabId);
}

/** Helper to update the volume of an existing capture */
async function _updateCaptureProcess(tabId, volume) {
    console.log(`[BG Core] Updating existing capture for tab ${tabId} to ${volume}%.`);
    // Ensure doc exists (quick check, might have closed unexpectedly)
    // Do NOT call setupOffscreenDocument here, as if it doesn't exist, update shouldn't work anyway
    if (!await hasOffscreenDocument()){
        console.warn(`[BG Core] Update requested for tab ${tabId}, but offscreen doc not found. Attempting full restart.`);
        // If offscreen doc isn't there, the existing capture is gone. Treat as start.
        await _startCaptureProcess(tabId, volume);
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
             const offscreenError = response?.error ? `Tab ${tabId}: ${response.error}` : `Tab ${tabId}: Unknown offscreen error`;
             throw new Error(`Offscreen document failed to update volume. ${offscreenError}`);
         }
        console.log(`[BG Core] Sent '${MSG_TYPE_UPDATE_VOLUME}' to offscreen for tab ${tabId}`);
    } catch (error) {
         if (error.message.includes("Could not establish connection") || error.message.includes("Receiving end does not exist")) {
             console.warn(`[BG Core] Update failed for tab ${tabId} due to connection issue. Attempting full restart.`);
             await _startCaptureProcess(tabId, volume); // Re-trigger start logic
         } else {
            console.error(`[BG Core] Error sending '${MSG_TYPE_UPDATE_VOLUME}' or processing response for tab ${tabId}:`, error);
            // If update fails for other reasons, maybe attempt restart as well?
            console.warn(`[BG Core] Update failed for tab ${tabId}. Attempting full restart.`);
            await _startCaptureProcess(tabId, volume);
            // Note: This restart might fail if the original issue persists (e.g., cannot get stream ID)
         }
    }
}

/** Sends the stopCapture message to the offscreen document, handling potential errors. */
async function _sendStopMessageToOffscreen(tabId) {
    if (await hasOffscreenDocument()) {
        console.log(`[BG Core] Sending '${MSG_TYPE_STOP_CAPTURE}' to offscreen for tab ${tabId}`);
        try {
            await chrome.runtime.sendMessage({
                type: MSG_TYPE_STOP_CAPTURE,
                target: TARGET_OFFSCREEN,
                targetTabId: tabId
            });
            console.log(`[BG Core] Sent stopCapture for tab ${tabId}`);
        } catch (err) {
            // Ignore connection errors - offscreen doc might be closing/closed already
            const msg = err.message.toLowerCase();
            if (!msg.includes("could not establish connection") && !msg.includes("receiving end does not exist")) {
                console.warn(`[BG Core] Error sending stopCapture to offscreen (tab ${tabId}):`, err);
            } else {
                // console.log(`[BG Core] Ignoring connection error during stopCapture for tab ${tabId} (likely closed).`); // Verbose
            }
        }
    } else {
        // console.log(`[BG Core] No offscreen document found to send stopCapture for tab ${tabId}.`); // Verbose
    }
}

// --- Event Listeners ---

// Listen for messages from Popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Ignore messages not from the extension itself (e.g., content scripts) or targeted elsewhere
    if (sender.id !== chrome.runtime.id || message.target) {
        return false; // Not handled here
    }

    // Handle messages from popup (no sender.tab)
    if (!sender.tab) {
        switch (message.type) {
            case MSG_TYPE_GET_VOLUME: {
                const { tabId } = message;
                const volume = tabVolumes[tabId] !== undefined ? tabVolumes[tabId] : DEFAULT_VOLUME;
                sendResponse({ volume: volume });
                return false; // Synchronous response
            }

            case MSG_TYPE_SET_VOLUME: {
                const { tabId, volume } = message;
                 // Basic validation
                 if (typeof tabId !== 'number' || typeof volume !== 'number' || isNaN(volume)) {
                    console.error(`[BG] Invalid SET_VOLUME request:`, message);
                    sendResponse({ status: "error", error: "Invalid request parameters." });
                    return false;
                 }

                console.log(`[BG <- Popup] Request SET_VOLUME for tab ${tabId} to ${volume}%`);

                const oldVolume = tabVolumes[tabId];
                if (oldVolume === volume && activeTabOperations.has(tabId) === false) { // Don't skip if an operation is pending (might fix errors)
                    console.log(`[BG] Volume for tab ${tabId} is already ${volume}%. No change needed.`);
                    sendResponse({ status: "success", message: "No change needed" });
                    return false;
                }

                // Store the new volume setting
                tabVolumes[tabId] = volume;
                saveVolumes(); // Persist the change (debounced)

                handleVolumeChange(tabId, volume, oldVolume)
                    .then(() => {
                        sendResponse({ status: "success" });
                    })
                    .catch(error => {
                        console.error(`[BG] Error response from handleVolumeChange for tab ${tabId} during SET_VOLUME:`, error);
                        // Revert volume in memory if setting failed (storage will be overwritten on next successful save)
                        // Only revert if the error wasn't just 'busy'
                         if (!error.message.includes("Operation already in progress")) {
                             if (oldVolume !== undefined) {
                                 tabVolumes[tabId] = oldVolume;
                             } else {
                                 // If original was undefined (default), setting back to default
                                 tabVolumes[tabId] = DEFAULT_VOLUME;
                             }
                         }
                        // Provide a slightly more specific error if possible
                        let errorMessage = error.message || "Unknown error occurred";
                        if (errorMessage.includes("getMediaStreamId failed") || errorMessage.includes("timed out")) {
                            errorMessage = "Cannot capture tab audio. Is it playing?";
                        } else if (errorMessage.includes("Operation already in progress")) {
                            errorMessage = "Operation busy, please wait.";
                        } else if (errorMessage.includes("offscreen document failed") || errorMessage.includes("Failed to connect to audio processor")) {
                            errorMessage = "Internal audio processor error.";
                        }
                        sendResponse({ status: "error", error: errorMessage });
                    });
                return true; // Indicate asynchronous response
            }

            case MSG_TYPE_GET_ACTIVE_TABS: {
                 console.log("[BG] Received GET_ACTIVE_TABS request.");
                 // Find tabs with volume not equal to default
                 const boostedTabIds = Object.entries(tabVolumes)
                     .filter(([id, vol]) => vol !== DEFAULT_VOLUME && typeof vol === 'number')
                     .map(([id, vol]) => parseInt(id, 10));

                 if (boostedTabIds.length === 0) {
                     sendResponse({ activeTabs: [] });
                     return false; // Sync response
                 }

                 // Fetch details for these tabs concurrently
                 const getTabDetailsPromises = boostedTabIds.map(tabId =>
                     chrome.tabs.get(tabId).catch(error => {
                         // Handle cases where tab might have been closed since volume was set
                         console.warn(`[BG] Error getting details for tab ${tabId} (likely closed):`, error.message);
                         // If tab doesn't exist, remove it from our state
                         if (tabVolumes[tabId]) {
                            delete tabVolumes[tabId];
                            saveVolumes(); // Save the removal
                         }
                         return null; // Indicate failure for this tab
                     })
                 );

                 Promise.all(getTabDetailsPromises).then(tabResults => {
                     const activeTabsData = tabResults
                         .filter(tab => tab !== null) // Filter out tabs that couldn't be fetched
                         .map(tab => ({
                             tabId: tab.id,
                             title: tab.title || "Untitled Tab",
                             volume: tabVolumes[tab.id], // Get volume from our state
                             // Provide a placeholder - the popup should handle missing favicons gracefully
                             favIconUrl: tab.favIconUrl || null
                         }));
                     console.log(`[BG] Sending active tabs list:`, activeTabsData);
                     sendResponse({ activeTabs: activeTabsData });
                 });

                 return true; // Indicate asynchronous response
            }

            default:
                 console.warn(`[BG] Received unknown message type from popup: ${message.type}`);
                 sendResponse({ status: "error", error: "Unknown message type" });
                 return false;
        }
    }
    // Message not handled
    return false;
});

// Listen for Tab Closure
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    // Clean up lock if tab is removed mid-operation
    if (activeTabOperations.has(tabId)) {
        console.warn(`[BG Tabs] Tab ${tabId} removed during active operation. Clearing lock.`);
        activeTabOperations.delete(tabId);
    }

    if (tabVolumes[tabId] !== undefined) {
        const wasCapturing = tabVolumes[tabId] !== DEFAULT_VOLUME;
        console.log(`[BG Tabs] Tab ${tabId} closed. Was capturing: ${wasCapturing}. Cleaning up state.`);
        delete tabVolumes[tabId];
        saveVolumes();

        if (wasCapturing) {
            await _sendStopMessageToOffscreen(tabId); // Tell offscreen to stop for this tab
        }
        // Always check if the document can close after cleanup
        await closeOffscreenDocumentIfNeeded();
    } else {
        // Even if volume wasn't stored, check close condition
        await closeOffscreenDocumentIfNeeded();
    }
});

// Listen for Tab Updates (Audibility, Navigation, Loading Status)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Skip if an operation is already locked for this tab
    // We also check the debounce timer map here - if a timer is pending, skip.
    if (activeTabOperations.has(tabId) || onUpdatedRestartTimers[tabId]) {
        // console.log(`[BG Tabs onUpdated] Skipping update for tab ${tabId} due to ongoing operation or pending restart.`); // Verbose
        return;
    }

    const currentVolume = tabVolumes[tabId];
    const shouldBeCapturing = currentVolume !== undefined && currentVolume !== DEFAULT_VOLUME;

    // --- Corrected Logic for Persisting Volume Across Navigations ---

    // Only proceed if this tab has a non-default volume setting stored
    if (shouldBeCapturing) {

        // RESTART Condition: Page finished loading ('complete') AND is audible.
        if (changeInfo.status === 'complete' && tab.status === 'complete' && tab.audible) {
             console.log(`[BG Tabs] Debouncing capture re-validation check for tab ${tabId} (Page load complete and audible). Volume: ${currentVolume}%`);

             // Clear any existing timer for this tab (shouldn't happen with the check above, but safety)
             clearTimeout(onUpdatedRestartTimers[tabId]);

             // Set a new timer to trigger the actual restart logic
             onUpdatedRestartTimers[tabId] = setTimeout(() => {
                 // Remove the timer ID now that it's running
                 delete onUpdatedRestartTimers[tabId];

                 // Check lock *again* right before executing, in case popup interaction started
                  if (activeTabOperations.has(tabId)) {
                       console.log(`[BG Tabs onUpdated] Restart cancelled for tab ${tabId} due to intervening operation lock.`);
                       return;
                  }

                  console.log(`[BG Tabs] DEBOUNCED: Triggering capture re-validation for tab ${tabId}. Volume: ${currentVolume}%`);

                  // Force a full restart by passing DEFAULT_VOLUME as oldVolume
                  const forceRestartOldVolume = DEFAULT_VOLUME;

                  handleVolumeChange(tabId, currentVolume, forceRestartOldVolume)
                      .catch(error => {
                          console.warn(`[BG Tabs] DEBOUNCED: Error automatically re-applying volume on page load for tab ${tabId}:`, error);
                      });

             }, ONUPDATED_RESTART_DEBOUNCE_MS); // Debounce time
        }
    } // --- End of shouldBeCapturing block ---
});


// --- Extension Lifecycle Listeners ---
chrome.runtime.onInstalled.addListener((details) => {
    console.log(`[BG Lifecycle] Extension ${details.reason}. Version: ${chrome.runtime.getManifest().version}`);
    if (details.reason === 'install') {
        // Perform initial setup, like setting default options if you add an options page later
    } else if (details.reason === 'update') {
        // Perform migrations if storage format changes, etc.
        loadInitialVolumes(); // Reload volumes on update in case of storage changes
    }
});

chrome.runtime.onStartup.addListener(() => {
    console.log("[BG Lifecycle] Browser startup detected.");
    // Re-load volumes on browser startup in case the service worker was terminated for a long time
    loadInitialVolumes();
});


console.log('[BG] Service Worker initialization complete. Listeners added.');