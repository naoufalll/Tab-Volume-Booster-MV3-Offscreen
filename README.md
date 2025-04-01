# Tab Volume Booster (MV3 Offscreen)

A Chrome extension built with Manifest V3 that allows you to control and boost the audio volume for individual browser tabs, even beyond the standard 100% limit. It uses the Offscreen API for efficient background audio processing and includes numerous internal improvements for stability.

## Features

*   **Per-Tab Volume Control:** Adjust the volume independently for each tab.
*   **Volume Boosting:** Increase volume up to **600%**.
*   **Non-Linear Slider:** Provides finer control, especially at higher volume levels (curve configurable in `popup.js`).
*   **Preset Volume Levels:** Quickly set volume to common levels (50%, 100%, 200%, 400%, MAX) with dedicated buttons.
*   **Visual Feedback:** The volume percentage display briefly changes color upon successful setting.
*   **Active Tab List:** View a list of all tabs currently being boosted (volume ≠ 100%) directly in the popup, including their favicons and current volume.
*   **Quick Reset:**
    *   Reset the *current* tab's volume back to 100%.
    *   Reset any boosted tab's volume directly from the active list.
*   **Reliable Navigation Persistence:** Volume settings for a tab are more reliably reapplied when navigating within that same tab (e.g., clicking through videos on YouTube), thanks to improved detection logic.
*   **Clipping Prevention:** Includes a built-in Web Audio Dynamics Compressor (limiter) to help prevent harsh audio clipping when boosting volume significantly.
*   **Efficient Resource Usage:** Leverages Chrome's Offscreen API to run audio processing only when needed, closing the offscreen document automatically when no tabs require volume adjustment, with improved closing logic.
*   **Improved Status & Error Feedback:** Provides clearer, more user-friendly status messages and error feedback in the popup UI, helping diagnose issues like non-audible tabs.
*   **Enhanced Stability:** Includes numerous internal improvements for more robust handling of edge cases, tab closures, and potential errors during audio capture.
*   **Manifest V3 Compliant:** Built using the modern Chrome extension platform.


## How to Use

1.  **Install** the extension.
2.  Navigate to a tab playing audio (e.g., a YouTube video, Spotify Web Player).
3.  **Click the extension icon** in your Chrome toolbar.
4.  The popup will show the current volume for that tab.
5.  **Adjust the Volume:**
    *   Use the **slider** for precise control.
    *   Click one of the **preset buttons** (50%, 100%, 200%, etc.) for quick changes.
6.  **View Boosted Tabs:** Scroll down in the popup to see a list of other tabs currently having their volume modified.
7.  **Reset Volume:**
    *   Click the **"Reset Current Tab"** button to set the active tab back to 100%.
    *   Click the **"Reset"** button next to a tab in the "Boosted Tabs" list to reset that specific tab's volume.

The volume setting for a tab will persist as long as the volume is not 100%. It will automatically attempt to re-apply after navigating within the same tab if audio is playing.

## Permissions Explained

This extension requires the following permissions (as defined in `manifest.json`):

*   **`tabs`**: Needed to query active tabs, get tab details (ID, URL, title, audible state, muted state) for the popup UI, list functionality, and applying changes. Also used to detect navigation for persistence.
*   **`tabCapture`**: Required to capture the audio stream from a specific tab using `chrome.tabCapture.getMediaStreamId`. This is essential for processing the audio. Capturing might require the tab to be audible.
*   **`offscreen`**: Required to create and manage an Offscreen Document. This document runs the Web Audio API graph to process the captured tab audio without needing a persistent background script or visible page.
*   **`storage`**: Used to store the volume settings for each tab (`chrome.storage.local`) so they persist between browser sessions and popup openings.
*   **`favicon`**: Used by the background script via `chrome.tabs.get` to retrieve favicon URLs for display in the "Boosted Tabs" list in the popup. *(`Note: While listed, ensure this matches your manifest if you excluded it`)*
*   **`scripting`**: (Currently included but minimally used) Might be used for future features. Its primary current use might be implicitly through other APIs depending on Chrome version, but direct scripting injection is not a core feature.

We strive to use the minimum permissions necessary for the extension's functionality.

## Installation

**Manual Installation:**

1.  Download or clone this repository.
2.  Open Chrome and navigate to `chrome://extensions/`.
3.  Enable **"Developer mode"** using the toggle switch in the top-right corner.
4.  Click the **"Load unpacked"** button.
5.  Select the directory containing `manifest.json` (e.g., `naoufalll-tab-volume-booster-mv3-offscreen/`).
6.  The extension should now be loaded and visible in your toolbar.

## Known Limitations

*   **Cannot Control `chrome://` or `chrome-extension://` Pages:** Chrome extensions cannot interact with internal browser pages or other extension pages for security reasons. Some other special page types might also be restricted.
*   **Tab Audibility:** Boosting might initially fail or stop working if the target tab is not actively playing or making sound when the volume is first changed or after navigation. The extension needs an active audio stream to capture.
*   **Initial Capture Delay:** There might still be a very brief moment when starting playback or navigating on a boosted tab where the audio starts before the boost is fully applied, although the restart logic is faster.
*   **Resource Usage:** While the Offscreen API is efficient, having a very large number of tabs actively boosted simultaneously *might* still consume noticeable system resources (CPU/Memory). The limiter helps prevent extreme audio issues, but quality depends on the source audio and boost level.

## Contributing

Contributions are welcome! If you find a bug or have a feature request, please open an issue on the GitHub repository. If you'd like to contribute code, please fork the repository and submit a pull request.
