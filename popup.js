// --- popup.js (Refactored with Presets, List, Feedback, Errors) ---

// --- DOM Elements ---
const slider = document.getElementById('volumeSlider');
const percentageDisplay = document.getElementById('volumePercentage');
const statusDisplay = document.getElementById('status');
const resetButton = document.getElementById('resetButton');
const presetButtonContainer = document.querySelector('.preset-buttons');
const activeTabsListContainer = document.getElementById('activeTabsList');


// --- Constants ---
const MSG_TYPE_GET_VOLUME = 'GET_VOLUME';
const MSG_TYPE_SET_VOLUME = 'SET_VOLUME';
const MSG_TYPE_GET_ACTIVE_TABS = 'GET_ACTIVE_TABS'; // New
const DEFAULT_VOLUME = 100;
const SET_VOLUME_DEBOUNCE_MS = 150;
const VISUAL_FEEDBACK_DURATION_MS = 750; // How long success feedback lasts

// --- State ---
let currentTabId = null;
let debounceTimer;
let isLoading = true; // Flag to prevent sending SET while initially loading
let feedbackTimeout; // Timer for visual feedback


// --- Non-Linear Slider Mapping ---
const SliderMapping = {
    // Adjust powerFactor to change the curve.
    // > 1.0 : More slider range dedicated to lower volumes (e.g., 2.0 is good for 0-600%)
    // = 1.0 : Linear mapping
    // < 1.0 : More slider range dedicated to higher volumes
    powerFactor: 0.5, // Makes slider movement more granular at higher volumes (since slider max >> 100)
                    // A value like 2.0 would give more granularity below 100%

    maxRawValue: parseFloat(slider.max), // Get from slider attribute
    maxActualVolume: parseFloat(slider.max), // Assuming max volume matches slider max

    /** Maps slider's raw linear value to actual volume using a power curve. */
    mapRawToActual(rawValue) {
        if (rawValue <= 0) return 0;
        const normalizedValue = rawValue / this.maxRawValue; // Normalize 0-1
        // Inverse power mapping: raise to 1/powerFactor
        // e.g. powerFactor = 0.5 => square the normalized value (more range at high end)
        // e.g. powerFactor = 2.0 => square root the normalized value (more range at low end)
        const mappedNormalized = Math.pow(normalizedValue, 1 / this.powerFactor);
        const actualVolume = mappedNormalized * this.maxActualVolume;
        return Math.round(actualVolume);
    },

    /** Maps actual volume back to the raw slider value. */
    mapActualToRaw(actualVolume) {
        if (actualVolume <= 0) return 0;
        const cappedVolume = Math.min(actualVolume, this.maxActualVolume);
        const normalizedVolume = cappedVolume / this.maxActualVolume; // Normalize 0-1
        // Forward power mapping: raise to powerFactor
        const mappedNormalized = Math.pow(normalizedVolume, this.powerFactor);
        const rawValue = mappedNormalized * this.maxRawValue;
        return Math.round(rawValue);
    }
};

// --- Error Message Mapping ---
function mapErrorMessage(originalError) {
    if (!originalError) return "An unknown error occurred.";
    const lowerError = originalError.toLowerCase();

    if (lowerError.includes("cannot capture tab audio") || lowerError.includes("is it audible?")) {
        return "Tab audio not capturable (is it playing?)";
    }
    if (lowerError.includes("operation busy") || lowerError.includes("in progress")) {
        return "Busy, please wait a moment.";
    }
    if (lowerError.includes("internal audio processor error") || lowerError.includes("offscreen document failed")) {
        return "Internal audio error.";
    }
    if (lowerError.includes("no active tab")) {
        return "No active tab found.";
    }
    if (lowerError.includes("cannot control chrome pages") || lowerError.includes("cannot control this page type")) {
        return "Cannot control this type of page.";
    }
     if (lowerError.includes("invalid request parameters")) {
        return "Invalid request sent.";
    }
     if (lowerError.includes("runtime error") || lowerError.includes("native host has exited")) {
        // This often means the background script crashed or was terminated
        return "Extension context error. Try reloading.";
     }

    // Default fallback for other errors
    // Truncate long generic messages
    return originalError.length > 50 ? originalError.substring(0, 47) + "..." : originalError;
}


// --- Initialization ---
async function initializePopup() {
    isLoading = true; // Set loading flag
    statusDisplay.textContent = 'Loading...';
    statusDisplay.classList.remove('error'); // Clear error class
    disableControls(true); // Disable while loading
    renderActiveTabsList(null); // Show loading state for list

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0 || !tabs[0].id) {
            throw new Error("No active tab found.");
        }

        currentTabId = tabs[0].id;
        const tabUrl = tabs[0].url;

        // Check if the URL is controllable
        if (!tabUrl || !/^(https?|file):/.test(tabUrl)) {
            if (tabUrl && tabUrl.startsWith('chrome://')) {
                throw new Error("Cannot control Chrome pages.");
            } else {
                throw new Error("Cannot control this page type.");
            }
        }

        // Get current volume for the active tab
        const volumeResponse = await chrome.runtime.sendMessage({ type: MSG_TYPE_GET_VOLUME, tabId: currentTabId });

        if (chrome.runtime.lastError) {
            throw new Error(`Runtime error: ${chrome.runtime.lastError.message}`);
        }
        if (volumeResponse && typeof volumeResponse.volume === 'number') {
            console.log(`[Popup] Received initial volume: ${volumeResponse.volume}%`);
            updateUI(volumeResponse.volume);
            statusDisplay.textContent = ''; // Clear loading message
        } else {
            console.warn("[Popup] Invalid response received for GET_VOLUME:", volumeResponse);
            updateUI(DEFAULT_VOLUME);
            statusDisplay.textContent = 'Using default (100%).';
        }

        // Fetch and render the list of active tabs
        await fetchAndRenderActiveTabs();

        disableControls(false); // Enable controls after successful load

    } catch (error) {
        console.error("[Popup] Initialization error:", error);
        const friendlyError = mapErrorMessage(error.message);
        statusDisplay.textContent = `Error: ${friendlyError}`;
        statusDisplay.classList.add('error');
        updateUI(DEFAULT_VOLUME); // Show default state
        disableControls(true); // Keep controls disabled on error
        renderActiveTabsList([]); // Show empty list on error
    } finally {
        isLoading = false; // Clear loading flag
    }
}

// --- Fetch and Render Active Tabs ---
async function fetchAndRenderActiveTabs() {
    try {
        const response = await chrome.runtime.sendMessage({ type: MSG_TYPE_GET_ACTIVE_TABS });
        if (chrome.runtime.lastError) {
             throw new Error(`Runtime error fetching list: ${chrome.runtime.lastError.message}`);
        }
        if (response && Array.isArray(response.activeTabs)) {
            renderActiveTabsList(response.activeTabs);
        } else {
             throw new Error("Invalid response when fetching active tabs.");
        }
    } catch (error) {
         console.error("[Popup] Error fetching or rendering active tabs:", error);
         renderActiveTabsList(null, mapErrorMessage(error.message)); // Show error in the list area
    }
}


// --- Render Active Tabs List ---
function renderActiveTabsList(tabsData, errorMessage = null) {
    activeTabsListContainer.innerHTML = ''; // Clear previous content

    if (errorMessage) {
        const errorElement = document.createElement('span');
        errorElement.className = 'no-active-tabs error'; // Use error class
        errorElement.textContent = `Error loading list: ${errorMessage}`;
        activeTabsListContainer.appendChild(errorElement);
        return;
    }

     if (tabsData === null) { // Loading state
        const loadingElement = document.createElement('span');
        loadingElement.className = 'no-active-tabs';
        loadingElement.textContent = `Loading list...`;
        activeTabsListContainer.appendChild(loadingElement);
        return;
    }


    if (!tabsData || tabsData.length === 0) {
        const noTabsElement = document.createElement('span');
        noTabsElement.className = 'no-active-tabs';
        noTabsElement.textContent = 'No other tabs are boosted.';
        activeTabsListContainer.appendChild(noTabsElement);
        return;
    }

    const ul = document.createElement('ul');
    ul.className = 'active-tabs-list';

    tabsData.sort((a, b) => (a.title || "").localeCompare(b.title || "")); // Sort alphabetically by title

    tabsData.forEach(tab => {
        const li = document.createElement('li');

        const img = document.createElement('img');
        img.className = 'active-tab-favicon';
        img.src = tab.favIconUrl || 'icons/icon16.png'; // Provide a default icon path
        img.alt = ''; // Decorative

        const titleSpan = document.createElement('span');
        titleSpan.className = 'active-tab-title';
        titleSpan.textContent = tab.title || `Tab ID: ${tab.tabId}`;
        titleSpan.title = tab.title || `Tab ID: ${tab.tabId}`; // Tooltip for long titles

        const volumeSpan = document.createElement('span');
        volumeSpan.className = 'active-tab-volume';
        volumeSpan.textContent = `${tab.volume}%`;

        const resetButton = document.createElement('button');
        resetButton.className = 'active-tab-reset';
        resetButton.textContent = 'Reset';
        resetButton.dataset.tabid = tab.tabId; // Store tabId for the click handler

        li.appendChild(img);
        li.appendChild(titleSpan);
        li.appendChild(volumeSpan);
        li.appendChild(resetButton);
        ul.appendChild(li);
    });

    activeTabsListContainer.appendChild(ul);
}


// --- Event Listeners ---
slider.addEventListener('input', () => {
    if (isLoading) return;

    const rawValue = parseInt(slider.value, 10);
    const actualVolume = SliderMapping.mapRawToActual(rawValue);

    percentageDisplay.textContent = `${actualVolume}%`;
    statusDisplay.textContent = "";
    statusDisplay.classList.remove('error'); // Clear error state

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        sendVolumeUpdate(actualVolume, currentTabId); // Send for current tab
    }, SET_VOLUME_DEBOUNCE_MS);
});

resetButton.addEventListener('click', () => { // Resets the CURRENT tab
    if (isLoading || slider.disabled) return;
    console.log("[Popup] Resetting current tab volume to 100%");
    handleVolumeChangeRequest(DEFAULT_VOLUME, currentTabId);
});

// Listener for Preset Buttons (using event delegation)
presetButtonContainer.addEventListener('click', (event) => {
    if (isLoading || slider.disabled) return;
    if (event.target.classList.contains('preset-button')) {
        const volume = parseInt(event.target.dataset.volume, 10);
        if (!isNaN(volume)) {
             console.log(`[Popup] Preset button clicked: ${volume}%`);
             handleVolumeChangeRequest(volume, currentTabId);
        }
    }
});

// Listener for Reset buttons within the Active Tabs list (using event delegation)
activeTabsListContainer.addEventListener('click', (event) => {
     if (isLoading) return;
     if (event.target.classList.contains('active-tab-reset')) {
        const tabIdToReset = parseInt(event.target.dataset.tabid, 10);
        if (!isNaN(tabIdToReset)) {
            console.log(`[Popup] Resetting volume for tab ${tabIdToReset} from list`);
            // Visually disable the button temporarily?
            event.target.disabled = true;
            event.target.textContent = '...';
            handleVolumeChangeRequest(DEFAULT_VOLUME, tabIdToReset);
            // Note: The list will refresh automatically on success via sendVolumeUpdate's callback
        }
     }
});


// --- Helper for handling volume changes from UI interactions ---
function handleVolumeChangeRequest(actualVolume, targetTabId) {
    if (targetTabId === null) {
        console.error("[Popup] Cannot set volume, targetTabId is null.");
        statusDisplay.textContent = mapErrorMessage("No active tab found.");
        statusDisplay.classList.add('error');
        return;
    }

     // Update main UI only if the change is for the currently active tab
     if (targetTabId === currentTabId) {
         updateUI(actualVolume);
     }

     statusDisplay.textContent = ""; // Clear status
     statusDisplay.classList.remove('error');

     clearTimeout(debounceTimer); // Clear slider debounce if a button is clicked
     sendVolumeUpdate(actualVolume, targetTabId);
}


// --- Communication with Background ---
// Modified to accept targetTabId and update list on success
function sendVolumeUpdate(actualVolume, targetTabId) {
    if (targetTabId === null) {
        console.error("[Popup] Cannot set volume, targetTabId is null.");
        statusDisplay.textContent = mapErrorMessage("Tab ID missing.");
        statusDisplay.classList.add('error');
        return;
    }

    console.log(`[Popup] Sending SET_VOLUME: Tab ${targetTabId}, Volume ${actualVolume}%`);
    // Only show "Setting..." if it's for the current tab? Or always? Let's show always for now.
    statusDisplay.textContent = "Setting...";
    statusDisplay.classList.remove('error');


    chrome.runtime.sendMessage({ type: MSG_TYPE_SET_VOLUME, tabId: targetTabId, volume: actualVolume }, (response) => {
        if (isLoading) return; // Ignore responses if popup re-initialized

        // Always try to refresh the list, even on error, as state might have changed partially
        fetchAndRenderActiveTabs();

        if (chrome.runtime.lastError) {
            console.error(`[Popup] Error setting volume for tab ${targetTabId} (runtime):`, chrome.runtime.lastError.message);
            const friendlyError = mapErrorMessage(chrome.runtime.lastError.message);
            statusDisplay.textContent = `Error: ${friendlyError}`;
            statusDisplay.classList.add('error');
        } else if (response && response.status === "success") {
            console.log(`[Popup] Volume set successfully for tab ${targetTabId}`);
            statusDisplay.textContent = ""; // Clear "Setting..."
            // Apply visual feedback only if the update was for the currently displayed tab
            if (targetTabId === currentTabId) {
                showVisualFeedback();
            }
        } else {
            // Handle specific errors like "busy" or other failures from background
            console.error(`[Popup] Error setting volume for tab ${targetTabId} (response):`, response?.error || "Unknown background error");
            const friendlyError = mapErrorMessage(response?.error);
            statusDisplay.textContent = `Error: ${friendlyError}`;
            statusDisplay.classList.add('error');
        }
    });
}


// --- UI Helper Functions ---

/** Updates the main slider/percentage display based on an ACTUAL volume value. */
function updateUI(actualVolume) {
    const rawValue = SliderMapping.mapActualToRaw(actualVolume);
    slider.value = rawValue;
    percentageDisplay.textContent = `${actualVolume}%`;
}

/** Enables or disables the main controls. */
function disableControls(disabled) {
    slider.disabled = disabled;
    resetButton.disabled = disabled;
    // Also disable preset buttons
    presetButtonContainer.querySelectorAll('button').forEach(button => button.disabled = disabled);
    // We don't disable list reset buttons here, they depend on the list rendering
}

/** Shows temporary visual feedback on the percentage display. */
function showVisualFeedback() {
    clearTimeout(feedbackTimeout); // Clear previous timeout if any
    percentageDisplay.classList.add('success-feedback');
    feedbackTimeout = setTimeout(() => {
        percentageDisplay.classList.remove('success-feedback');
    }, VISUAL_FEEDBACK_DURATION_MS);
}

// --- Start Initialization ---
initializePopup();