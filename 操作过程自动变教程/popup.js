const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const tutorialButton = document.getElementById("tutorialButton");
const statusText = document.getElementById("statusText");

function updateView(recording) {
  statusText.textContent = recording ? "当前状态：录制中" : "当前状态：未录制";
  startButton.disabled = recording;
  stopButton.disabled = !recording;
}

async function getRecordingState() {
  const result = await chrome.storage.local.get({ recording: false });
  return result.recording;
}

async function setRecordingState(recording) {
  if (recording) {
    try {
      await chrome.runtime.sendMessage({ type: "WEBSTEP_CLEAR_SCREENSHOTS" });
    } catch (error) {
      console.warn("WebStep failed to clear screenshots", error);
    }
  }

  const state = recording ? { recording, steps: [] } : { recording };
  await chrome.storage.local.set(state);
  updateView(recording);
}

startButton.addEventListener("click", () => {
  setRecordingState(true);
});

stopButton.addEventListener("click", () => {
  setRecordingState(false);
});

tutorialButton.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("tutorial/tutorial.html")
  });
});

getRecordingState().then(updateView);
