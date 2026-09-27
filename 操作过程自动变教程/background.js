const DB_NAME = "webstep";
const DB_VERSION = 1;
const SCREENSHOT_STORE = "screenshots";
const ORPHAN_SCREENSHOT_TTL = 10000;
const PENDING_CAPTURE_WAIT_TIMEOUT = 1500;
const PENDING_CAPTURE_WAIT_INTERVAL = 25;
const CAPTURE_RETRY_DELAY = 250;
const MIN_CAPTURE_INTERVAL = 650;
const FALLBACK_CAPTURE_RETRY_DELAY = 450;

const pendingCaptures = new Map();
const captureVersions = new Map();
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(SCREENSHOT_STORE)) {
        database.createObjectStore(SCREENSHOT_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runScreenshotTransaction(mode, callback) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SCREENSHOT_STORE, mode);
    const store = transaction.objectStore(SCREENSHOT_STORE);
    const request = callback(store);

    transaction.oncomplete = () => {
      database.close();
      resolve(request ? request.result : undefined);
    };

    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

function getScreenshotId(interactionId) {
  return `screenshot_${interactionId}`;
}

function isRestrictedUrl(url) {
  return /^(chrome|chrome-extension|edge|about):\/\//.test(url || "");
}

async function getRecordingState() {
  const result = await chrome.storage.local.get({ recording: false });
  return result.recording;
}

async function saveScreenshot(record) {
  await runScreenshotTransaction("readwrite", (store) => store.put(record));
}

async function getScreenshot(id) {
  return runScreenshotTransaction("readonly", (store) => store.get(id));
}

async function deleteScreenshot(id) {
  await runScreenshotTransaction("readwrite", (store) => store.delete(id));
}

async function clearScreenshots() {
  await runScreenshotTransaction("readwrite", (store) => store.clear());
  pendingCaptures.clear();
  captureVersions.clear();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueCapture(task) {
  const runTask = captureQueue
    .catch(() => {})
    .then(async () => {
      const elapsed = Date.now() - lastCaptureAt;

      if (elapsed < MIN_CAPTURE_INTERVAL) {
        await wait(MIN_CAPTURE_INTERVAL - elapsed);
      }

      lastCaptureAt = Date.now();
      return task();
    });

  captureQueue = runTask.catch(() => {});
  return runTask;
}

function getErrorMessage(error) {
  if (!error) {
    return "";
  }

  return error.message || String(error);
}

async function captureVisibleTabWithRetry(tab, options = {}) {
  const task = async () => {
    try {
      return await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png"
      });
    } catch (error) {
      await wait(CAPTURE_RETRY_DELAY);
      try {
        return await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png"
        });
      } catch (retryError) {
        if (options.immediate) {
          return enqueueCapture(() => chrome.tabs.captureVisibleTab(tab.windowId, {
            format: "png"
          }));
        }

        throw retryError;
      }
    }
  };

  if (options.immediate) {
    return task();
  }

  return enqueueCapture(task);
}

async function captureAndStoreScreenshot(interactionId, tab, options = {}) {
  const screenshotId = getScreenshotId(interactionId);
  const dataUrl = await captureVisibleTabWithRetry(tab, {
    immediate: Boolean(options.immediate)
  });
  const currentTab = tab.id ? await chrome.tabs.get(tab.id).catch(() => null) : null;
  const currentUrl = currentTab ? currentTab.url || "" : tab.url || "";
  const pageChangedBeforeStore = Boolean(options.requireSameUrl && options.expectedUrl && currentUrl !== options.expectedUrl);

  if (pageChangedBeforeStore) {
    const existing = await getScreenshot(screenshotId).catch(() => null);

    if (existing?.dataUrl && !existing.pageChangedBeforeStore) {
      return screenshotId;
    }
  }

  await saveScreenshot({
    id: screenshotId,
    dataUrl,
    createdAt: Date.now(),
    url: currentUrl,
    expectedUrl: options.expectedUrl || "",
    pageChangedBeforeStore
  });

  return screenshotId;
}

async function rejectChangedScreenshotIfNeeded(screenshotId, options = {}) {
  if (!options.rejectChangedUrl || !screenshotId) {
    return null;
  }

  const screenshot = await getScreenshot(screenshotId);

  if (!screenshot || !screenshot.pageChangedBeforeStore) {
    return null;
  }

  try {
    await deleteScreenshot(screenshotId);
  } catch (error) {
    console.warn("WebStep failed to delete changed-page screenshot", error);
  }

  return {
    screenshotId: "",
    screenshotError: "page_changed_before_screenshot"
  };
}

function scheduleOrphanCleanup(interactionId) {
  return setTimeout(async () => {
    const pending = pendingCaptures.get(interactionId);

    if (!pending || pending.used) {
      return;
    }

    pendingCaptures.delete(interactionId);

    try {
      await deleteScreenshot(getScreenshotId(interactionId));
    } catch (error) {
      console.warn("WebStep failed to delete orphan screenshot", error);
    }
  }, ORPHAN_SCREENSHOT_TTL);
}

function waitForPendingCapture(interactionId) {
  if (pendingCaptures.has(interactionId)) {
    return Promise.resolve(pendingCaptures.get(interactionId));
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      const pending = pendingCaptures.get(interactionId);

      if (pending) {
        clearInterval(intervalId);
        resolve(pending);
        return;
      }

      if (Date.now() - startedAt >= PENDING_CAPTURE_WAIT_TIMEOUT) {
        clearInterval(intervalId);
        resolve(null);
      }
    }, PENDING_CAPTURE_WAIT_INTERVAL);
  });
}

async function handleCaptureScreenshot(message, sender) {
  if (!sender.tab || isRestrictedUrl(sender.tab.url)) {
    return { ok: false, reason: "restricted_url" };
  }

  const previousPending = pendingCaptures.get(message.interactionId);
  if (previousPending && !previousPending.used) {
    clearTimeout(previousPending.timeoutId);
  }

  const captureVersion = (captureVersions.get(message.interactionId) || 0) + 1;
  captureVersions.set(message.interactionId, captureVersion);

  const capturePromise = captureAndStoreScreenshot(message.interactionId, sender.tab, {
    requireSameUrl: Boolean(message.requireSameUrl),
    expectedUrl: message.expectedUrl || sender.tab.url || "",
    immediate: Boolean(message.requireSameUrl),
    captureVersion
  });

  pendingCaptures.set(message.interactionId, {
    promise: capturePromise,
    timeoutId: scheduleOrphanCleanup(message.interactionId),
    used: false
  });

  capturePromise.catch((error) => {
    console.warn("WebStep screenshot capture failed", error);
  });

  const recording = await getRecordingState();

  if (!recording && !message.allowAfterStop) {
    return { ok: false, reason: "not_recording" };
  }

  return { ok: true };
}

async function captureFallbackScreenshot(interactionId, tab, options = {}) {
  if (!tab || isRestrictedUrl(tab.url)) {
    return { screenshotId: "", screenshotError: "fallback_unavailable" };
  }

  try {
    await wait(FALLBACK_CAPTURE_RETRY_DELAY);
    const screenshotId = await captureAndStoreScreenshot(interactionId, tab, {
      requireSameUrl: Boolean(options.requireSameUrl),
      expectedUrl: options.expectedUrl || ""
    });
    const rejected = await rejectChangedScreenshotIfNeeded(screenshotId, options);

    if (rejected) {
      return rejected;
    }

    return { screenshotId, screenshotError: "" };
  } catch (error) {
    console.warn("WebStep fallback screenshot capture failed", error);
    return {
      screenshotId: "",
      screenshotError: getErrorMessage(error) || "fallback_capture_failed"
    };
  }
}

async function getScreenshotIdForStep(interactionId, tab, options = {}) {
  const pending = await waitForPendingCapture(interactionId);

  if (pending) {
    pending.used = true;
    clearTimeout(pending.timeoutId);

    try {
      const screenshotId = await pending.promise;
      pendingCaptures.delete(interactionId);
      captureVersions.delete(interactionId);
      const rejected = await rejectChangedScreenshotIfNeeded(screenshotId, options);

      if (rejected) {
        return rejected;
      }

      return { screenshotId, screenshotError: "" };
    } catch (error) {
      pendingCaptures.delete(interactionId);
      captureVersions.delete(interactionId);
      if (!options.allowFallback) {
        return {
          screenshotId: "",
          screenshotError: getErrorMessage(error) || "pre_click_capture_failed"
        };
      }

      return captureFallbackScreenshot(interactionId, tab, options);
    }
  }

  const screenshotId = getScreenshotId(interactionId);
  const screenshot = await getScreenshot(screenshotId);
  if (screenshot) {
    const rejected = await rejectChangedScreenshotIfNeeded(screenshotId, options);

    if (rejected) {
      return rejected;
    }

    return { screenshotId, screenshotError: "" };
  }

  if (!options.allowFallback) {
    return { screenshotId: "", screenshotError: "pre_click_screenshot_missing" };
  }

  return captureFallbackScreenshot(interactionId, tab, options);
}

async function saveStep(step, interactionId, tab) {
  const isClickStep = String(step.actionType || "").startsWith("CLICK_");
  const needsSameUrlScreenshot = isClickStep || step.actionType === "INPUT_TEXT";
  const { screenshotId, screenshotError } = await getScreenshotIdForStep(interactionId, tab, {
    allowFallback: true,
    requireSameUrl: needsSameUrlScreenshot,
    expectedUrl: step.url || "",
    rejectChangedUrl: step.actionType === "INPUT_TEXT"
  });
  const result = await chrome.storage.local.get({ steps: [] });
  const nextStep = {
    ...step,
    screenshot: screenshotId,
    screenshotId,
    screenshotError
  };

  await chrome.storage.local.set({
    steps: [...result.steps, nextStep]
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "WEBSTEP_CAPTURE_SCREENSHOT") {
    handleCaptureScreenshot(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.warn("WebStep capture message failed", error);
        sendResponse({ ok: false, reason: "capture_failed" });
      });
    return true;
  }

  if (message.type === "WEBSTEP_SAVE_STEP") {
    saveStep(message.step, message.interactionId, sender.tab)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.warn("WebStep save step message failed", error);
        sendResponse({ ok: false, reason: "save_failed" });
      });
    return true;
  }

  if (message.type === "WEBSTEP_CLEAR_SCREENSHOTS") {
    clearScreenshots()
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.warn("WebStep clear screenshots message failed", error);
        sendResponse({ ok: false, reason: "clear_failed" });
      });
    return true;
  }

  return false;
});
