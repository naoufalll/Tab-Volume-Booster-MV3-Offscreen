// --- popup.js (Refactored) ---
console.log("[Popup] Initializing...");

// --- DOM Elements ---
const slider = document.getElementById('volumeSlider');
const percentageDisplay = document.getElementById('volumePercentage');
const statusDisplay = document.getElementById('status');
const resetButton = document.getElementById('resetButton');
const presetButtonContainer = document.querySelector('.preset-buttons');
const activeTabsListContainer = document.getElementById('activeTabsList');
const boostedTabsHeading = document.querySelector('.list-heading'); // Reference heading

// --- Constants ---
const MSG_TYPE_GET_VOLUME = 'GET_VOLUME';
const MSG_TYPE_SET_VOLUME = 'SET_VOLUME';
const MSG_TYPE_GET_ACTIVE_TABS = 'GET_ACTIVE_TABS';
const DEFAULT_VOLUME = 100;
const MAX_VOLUME = 600; // Defined from slider max
const SET_VOLUME_DEBOUNCE_MS = 150;
const VISUAL_FEEDBACK_DURATION_MS = 750;
const DEFAULT_FAVICON_PATH = 'icons/icon16.png'; // Path to your default icon

// Logging Prefixes
const LOG_PREFIX = '[Popup]';

// --- State ---
let currentTabId = null;
let currentTabUrl = null; // Store URL for checks
let debounceTimer;
let isLoading = true; // Flag to prevent interactions during load/init error
let feedbackTimeout; // Timer for visual feedback

// --- Non-Linear Slider Mapping ---
const SliderMapping = {
    powerFactor: 0.5, // More granularity at higher volumes (0-1 less sensitive, 100-600 more sensitive)
    maxRawValue: parseFloat(slider.max),
    maxActualVolume: MAX_VOLUME,

    mapRawToActual(rawValue) {
        if (rawValue <= 0) return 0;
        const normalizedValue = Math.min(1, rawValue / this.maxRawValue); // Clamp to 1 max
        const mappedNormalized = Math.pow(normalizedValue, 1 / this.powerFactor);
        const actualVolume = Math.min(this.maxActualVolume, mappedNormalized * this.maxActualVolume);
        return Math.round(actualVolume);
    },

    mapActualToRaw(actualVolume) {
        if (actualVolume <= 0) return 0;
        const cappedVolume = Math.min(actualVolume, this.maxActualVolume);
        const normalizedVolume = cappedVolume / this.maxActualVolume;
        const mappedNormalized = Math.pow(normalizedVolume, this.powerFactor);
        const rawValue = mappedNormalized * this.maxRawValue;
        return Math.round(rawValue);
    }
};

// --- Error Message Mapping ---
function mapErrorMessage(originalError) {
    if (!originalError) return "An unknown error occurred.";
    const lowerError = String(originalError).toLowerCase(); // Ensure it's a string

    // Specific Background/Offscreen Errors
    if (lowerError.includes("cannot capture tab audio") || lowerError.includes("is it audible?") || lowerError.includes("getmediastreamid failed") || lowerError.includes("timed out")) {
        return "Cannot capture audio (is tab audible/playing?)";
    }
    if (lowerError.includes("operation busy") || lowerError.includes("in progress")) {
        return "Busy, please wait a moment.";
    }
    if (lowerError.includes("internal audio processor error") || lowerError.includes("offscreen document failed") || lowerError.includes("audio setup failed")) {
        return "Internal audio processor error.";
    }
    if (lowerError.includes("internal audio processor unavailable")) {
        return "Audio processor unavailable. Try reloading.";
    }
     if (lowerError.includes("invalid stream id")) {
         return "Internal error (Invalid Stream ID).";
     }

    // Popup / Tab Errors
    if (lowerError.includes("no active tab")) {
        return "No active tab found.";
    }
    if (lowerError.includes("cannot control") && (lowerError.includes("chrome pages") || lowerError.includes("this page type") || lowerError.includes("url scheme"))) {
        return "Cannot control this type of page.";
    }

    // Communication / Runtime Errors
     if (lowerError.includes("invalid request parameters")) {
        return "Invalid request sent.";
    }
    if (lowerError.includes("runtime error") || lowerError.includes("native host has exited") || lowerError.includes("receiving end does not exist") || lowerError.includes("could not establish connection")) {
        // Often means the background script crashed, was terminated, or is starting up
        return "Extension context error. Try again shortly or reload.";
     }
     if (lowerError.includes("invalid tabid")) {
         return "Internal error (Invalid Tab ID)."
     }

    // Default fallback - truncate long generic messages
    const maxLength = 60;
    const cleanMsg = String(originalError).replace(/^Error: /, ''); // Remove leading "Error: "
    return cleanMsg.length > maxLength ? cleanMsg.substring(0, maxLength - 3) + "..." : cleanMsg;
}


// --- Initialization ---
async function initializePopup() {
    console.log(`${LOG_PREFIX} Starting initialization...`);
    setLoadingState(true, 'Loading...');

    try {
        // 1. Get Active Tab Info
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0 || !tabs[0].id) {
            throw new Error("No active tab found.");
        }
        currentTabId = tabs[0].id;
        currentTabUrl = tabs[0].url;
        console.log(`${LOG_PREFIX} Active Tab ID: ${currentTabId}, URL: ${currentTabUrl}`);

        // 2. Check if URL is controllable
        if (!currentTabUrl || !/^(https?|file):/.test(currentTabUrl)) {
            const reason = (currentTabUrl && currentTabUrl.startsWith('chrome://'))
                ? "Cannot control chrome pages."
                : "Cannot control this page type.";
            throw new Error(reason);
        }

        // 3. Get Current Volume for Active Tab
        console.log(`${LOG_PREFIX} Requesting initial volume for tab ${currentTabId}`);
        const volumeResponse = await chrome.runtime.sendMessage({ type: MSG_TYPE_GET_VOLUME, tabId: currentTabId });

        // Check for runtime errors after the call
        if (chrome.runtime.lastError) {
            throw new Error(`Runtime error: ${chrome.runtime.lastError.message}`);
        }
        if (volumeResponse?.error) {
             throw new Error(`Error getting volume: ${volumeResponse.error}`);
        }
        if (volumeResponse && typeof volumeResponse.volume === 'number') {
            console.log(`${LOG_PREFIX} Received initial volume: ${volumeResponse.volume}%`);
            updateUI(volumeResponse.volume);
            setStatus('', false); // Clear loading message
        } else {
            console.warn(`${LOG_PREFIX} Invalid response for GET_VOLUME:`, volumeResponse);
            updateUI(DEFAULT_VOLUME); // Fallback to default UI
            setStatus('Could not get current volume.', false); // Informative but not error state
        }

        // 4. Fetch and Render Boosted Tabs List (happens concurrently with UI enable)
        fetchAndRenderActiveTabs(); // Don't await here, let it run in background

        // 5. Enable Controls
        setLoadingState(false); // Success!

    } catch (error) {
        console.error(`${LOG_PREFIX} Initialization error:`, error);
        const friendlyError = mapErrorMessage(error.message);
        setStatus(`Error: ${friendlyError}`, true);
        updateUI(DEFAULT_VOLUME); // Show default state
        setLoadingState(true); // Keep controls disabled on init error
        renderActiveTabsList([], `Failed: ${friendlyError}`); // Show error in list too
    }
}

// --- UI State Management ---

/** Sets the loading state for the main controls and status message. */
function setLoadingState(loading, message = '') {
    isLoading = loading;
    slider.disabled = loading;
    resetButton.disabled = loading;
    presetButtonContainer.querySelectorAll('button').forEach(button => button.disabled = loading);

    if (loading) {
        setStatus(message, false); // Show loading message, not as error
    }
    // Keep existing status message if finishing loading (isLoading = false)
}

/** Sets the status message text and optional error styling. */
function setStatus(message, isError = false) {
     statusDisplay.textContent = message || ''; // Use empty string if message is null/undefined/empty
     statusDisplay.classList.toggle('error', isError && !!message); // Add error class only if it's an error *and* there's a message
}

/** Updates the main slider/percentage display based on an ACTUAL volume value. */
function updateUI(actualVolume) {
    const clampedVolume = Math.max(0, Math.min(MAX_VOLUME, actualVolume)); // Ensure within 0-MAX bounds
    const rawValue = SliderMapping.mapActualToRaw(clampedVolume);
    slider.value = rawValue;
    percentageDisplay.textContent = `${clampedVolume}%`;
}

/** Shows temporary visual feedback on the percentage display. */
function showVisualFeedback() {
    clearTimeout(feedbackTimeout);
    percentageDisplay.classList.add('success-feedback');
    feedbackTimeout = setTimeout(() => {
        percentageDisplay.classList.remove('success-feedback');
    }, VISUAL_FEEDBACK_DURATION_MS);
}

// --- Fetch and Render Active Tabs List ---

async function fetchAndRenderActiveTabs() {
    console.log(`${LOG_PREFIX} Fetching active tabs list...`);
    renderActiveTabsList(null); // Show loading state in list

    try {
        const response = await chrome.runtime.sendMessage({ type: MSG_TYPE_GET_ACTIVE_TABS });
        if (chrome.runtime.lastError) {
             throw new Error(`Runtime error fetching list: ${chrome.runtime.lastError.message}`);
        }
        if (response?.error) {
            throw new Error(`Error fetching list: ${response.error}`);
        }
        if (response && Array.isArray(response.activeTabs)) {
            console.log(`${LOG_PREFIX} Received ${response.activeTabs.length} active tabs.`);
            renderActiveTabsList(response.activeTabs);
        } else {
             throw new Error("Invalid response when fetching active tabs.");
        }
    } catch (error) {
         console.error(`${LOG_PREFIX} Error fetching or rendering active tabs:`, error);
         renderActiveTabsList([], mapErrorMessage(error.message)); // Show error in the list area
    }
}

function renderActiveTabsList(tabsData, errorMessage = null) {
    activeTabsListContainer.innerHTML = ''; // Clear previous content

    if (errorMessage) {
        const errorElement = document.createElement('span');
        errorElement.className = 'no-active-tabs error'; // Use existing class + error style
        errorElement.textContent = `List error: ${errorMessage}`;
        activeTabsListContainer.appendChild(errorElement);
        boostedTabsHeading.style.display = 'block'; // Ensure heading is visible
        return;
    }

     if (tabsData === null) { // Loading state
        const loadingElement = document.createElement('span');
        loadingElement.className = 'no-active-tabs';
        loadingElement.textContent = `Loading list...`;
        activeTabsListContainer.appendChild(loadingElement);
        boostedTabsHeading.style.display = 'block'; // Ensure heading is visible
        return;
    }

    // Filter out the current tab from the list
    const otherBoostedTabs = tabsData.filter(tab => tab.tabId !== currentTabId);

    if (otherBoostedTabs.length === 0) {
        const noTabsElement = document.createElement('span');
        noTabsElement.className = 'no-active-tabs';
        noTabsElement.textContent = 'No other tabs currently boosted.';
        activeTabsListContainer.appendChild(noTabsElement);
        boostedTabsHeading.style.display = 'block'; // Show heading even if list is empty now
        return;
    }

    boostedTabsHeading.style.display = 'block'; // Make sure heading is visible

    const ul = document.createElement('ul');
    ul.className = 'active-tabs-list';

    // Sort alphabetically by title for consistent order
    otherBoostedTabs.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    otherBoostedTabs.forEach(tab => {
        const li = document.createElement('li');
        li.dataset.tabId = tab.tabId; // Add tabId to li for potential future use

        const img = document.createElement('img');
        img.className = 'active-tab-favicon';
        img.src = tab.favIconUrl || DEFAULT_FAVICON_PATH; // Use default if null/empty
        img.alt = ''; // Decorative
        // Handle favicon loading error (optional, sets to default)
        img.onerror = () => { if (img.src !== DEFAULT_FAVICON_PATH) img.src = DEFAULT_FAVICON_PATH; };

        const titleSpan = document.createElement('span');
        titleSpan.className = 'active-tab-title';
        titleSpan.textContent = tab.title || `Tab ID: ${tab.tabId}`;
        titleSpan.title = tab.title || `Tab ID: ${tab.tabId}`; // Tooltip for overflow

        const volumeSpan = document.createElement('span');
        volumeSpan.className = 'active-tab-volume';
        volumeSpan.textContent = `${tab.volume}%`;

        const listResetButton = document.createElement('button');
        listResetButton.className = 'active-tab-reset';
        listResetButton.textContent = 'Reset';
        listResetButton.dataset.tabid = tab.tabId; // Store tabId for the click handler
        listResetButton.disabled = isLoading; // Disable if main controls are disabled

        li.appendChild(img);
        li.appendChild(titleSpan);
        li.appendChild(volumeSpan);
        li.appendChild(listResetButton);
        ul.appendChild(li);
    });

    activeTabsListContainer.appendChild(ul);
}


// --- Event Listeners ---

// Slider Input: Update display and debounce sending update
slider.addEventListener('input', () => {
    if (isLoading) return;

    const rawValue = parseInt(slider.value, 10);
    const actualVolume = SliderMapping.mapRawToActual(rawValue);

    // Update only the percentage display immediately
    percentageDisplay.textContent = `${actualVolume}%`;
    setStatus(""); // Clear status/error when user interacts

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        // Send the *actual* calculated volume, not the raw slider value
        handleVolumeChangeRequest(actualVolume, currentTabId);
    }, SET_VOLUME_DEBOUNCE_MS);
});

// Reset Button for Current Tab
resetButton.addEventListener('click', () => {
    if (isLoading) return;
    console.log(`${LOG_PREFIX} Resetting current tab (${currentTabId}) volume to 100%`);
    handleVolumeChangeRequest(DEFAULT_VOLUME, currentTabId);
});

// Preset Buttons (Event Delegation)
presetButtonContainer.addEventListener('click', (event) => {
    if (isLoading || !event.target.classList.contains('preset-button')) return;

    const button = event.target;
    const volume = parseInt(button.dataset.volume, 10);
    if (!isNaN(volume)) {
         console.log(`${LOG_PREFIX} Preset button clicked: ${volume}% for tab ${currentTabId}`);
         button.disabled = true; // Briefly disable clicked button
         handleVolumeChangeRequest(volume, currentTabId);
         // Re-enable button after a short delay or on completion? Let sendVolumeUpdate handle state.
         setTimeout(() => { if (!isLoading) button.disabled = false; }, 500); // Re-enable after delay
    }
});

// Reset Buttons in Active Tabs List (Event Delegation)
activeTabsListContainer.addEventListener('click', (event) => {
     if (isLoading || !event.target.classList.contains('active-tab-reset')) return;

     const button = event.target;
     const tabIdToReset = parseInt(button.dataset.tabid, 10);
     if (!isNaN(tabIdToReset)) {
         console.log(`${LOG_PREFIX} Resetting volume for tab ${tabIdToReset} from list`);
         button.disabled = true; // Disable button being clicked
         button.textContent = '...'; // Provide visual feedback
         // The list will refresh via sendVolumeUpdate callback, removing/updating this item
         handleVolumeChangeRequest(DEFAULT_VOLUME, tabIdToReset);
     }
});


// --- Core Logic ---

/** Central handler for initiating volume changes from the UI. */
function handleVolumeChangeRequest(actualVolume, targetTabId) {
    if (isLoading) {
        console.warn(`${LOG_PREFIX} Ignoring volume change request while loading.`);
        return;
    }
    if (targetTabId === null) {
        console.error(`${LOG_PREFIX} Cannot set volume, targetTabId is null.`);
        setStatus(mapErrorMessage("No active tab found."), true);
        return;
    }

     // Clamp volume just in case
     const clampedVolume = Math.max(0, Math.min(MAX_VOLUME, actualVolume));

     // Update main UI immediately ONLY if the change is for the currently viewed tab
     if (targetTabId === currentTabId) {
         updateUI(clampedVolume);
     }

     setStatus("Setting...", false); // Indicate activity

     clearTimeout(debounceTimer); // Clear slider debounce if button/reset triggered change
     sendVolumeUpdate(clampedVolume, targetTabId);
}

/** Sends the volume update message to the background script. */
function sendVolumeUpdate(actualVolume, targetTabId) {
    console.log(`${LOG_PREFIX} Sending SET_VOLUME: Tab ${targetTabId}, Volume ${actualVolume}%`);

    chrome.runtime.sendMessage({ type: MSG_TYPE_SET_VOLUME, tabId: targetTabId, volume: actualVolume }, (response) => {
        // If popup closed or re-initialized while waiting, response might be irrelevant
        if (isLoading && currentTabId === null) { // Check if popup state was reset
             console.log(`${LOG_PREFIX} Ignoring SET_VOLUME response as popup seems closed/reset.`);
             return;
         }

        // ALWAYS try to refresh the list after ANY set attempt, success or fail,
        // as the background state might have changed partially or needs re-syncing.
        fetchAndRenderActiveTabs();

        if (chrome.runtime.lastError) {
            console.error(`${LOG_PREFIX} Error setting volume for tab ${targetTabId} (runtime):`, chrome.runtime.lastError);
            const friendlyError = mapErrorMessage(chrome.runtime.lastError.message);
            setStatus(`Error: ${friendlyError}`, true);
            // Re-enable controls even on error, allowing user to retry
            setLoadingState(false);
        } else if (response && response.status === "success") {
            console.log(`${LOG_PREFIX} Volume set successfully for tab ${targetTabId}. Message: ${response.message || '(No message)'}`);
            setStatus("", false); // Clear "Setting..."
            // Apply visual feedback ONLY if the update was for the currently displayed tab
            if (targetTabId === currentTabId) {
                showVisualFeedback();
                 // Ensure UI matches the confirmed volume (in case of clamping/rounding differences)
                 updateUI(actualVolume);
            }
             setLoadingState(false); // Re-enable controls on success
        } else {
            // Handle specific errors from background response
            console.error(`${LOG_PREFIX} Error setting volume for tab ${targetTabId} (response):`, response?.error || "Unknown background error");
            const friendlyError = mapErrorMessage(response?.error);
            setStatus(`Error: ${friendlyError}`, true);
             // If the error was 'busy', maybe keep controls disabled briefly?
             // For now, re-enable to allow retry.
             setLoadingState(false);
        }
    });
}

// --- Start Initialization ---
document.addEventListener('DOMContentLoaded', initializePopup);