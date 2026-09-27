const DB_NAME = "webstep";
const DB_VERSION = 1;
const SCREENSHOT_STORE = "screenshots";
const MARKER_PADDING_X = 9;
const MARKER_PADDING_Y = 5;
const MAX_IMAGE_SIZE = 15 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const HANDLE_DIRECTIONS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const summary = document.getElementById("summary");
const stepsContainer = document.getElementById("steps");
const sourceInfo = document.getElementById("sourceInfo");
const addStepBtn = document.getElementById("addStepBtn");
const saveStatus = document.getElementById("saveStatus");
const exportPdfBtn = document.getElementById("exportPdfBtn");
const imageInput = document.getElementById("imageInput");
const toast = document.getElementById("toast");
const editorModal = document.getElementById("editorModal");
const editorCanvas = document.getElementById("editorCanvas");
const addMarkerBtn = document.getElementById("addMarkerBtn");
const addBlurBtn = document.getElementById("addBlurBtn");
const restoreMarkerBtn = document.getElementById("restoreMarkerBtn");
const deleteSelectedBtn = document.getElementById("deleteSelectedBtn");
const cancelEditorBtn = document.getElementById("cancelEditorBtn");
const saveEditorBtn = document.getElementById("saveEditorBtn");
const closeEditorBtn = document.getElementById("closeEditorBtn");

let steps = [];
let draggedStepId = "";
let pendingImageAction = null;
let toastTimer = null;
let editorState = null;

function getScrollSnapshot(stepId = "") {
  const targetId = stepId || document.elementFromPoint(window.innerWidth / 2, 120)?.closest?.(".step-card")?.dataset?.stepId || "";
  const target = targetId ? document.querySelector(`[data-step-id="${CSS.escape(targetId)}"]`) : null;

  return {
    stepId: targetId,
    offset: target ? target.getBoundingClientRect().top : 0,
    scrollY: window.scrollY
  };
}

function restoreScrollSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  window.requestAnimationFrame(() => {
    const target = snapshot.stepId
      ? document.querySelector(`[data-step-id="${CSS.escape(snapshot.stepId)}"]`)
      : null;

    if (!target) {
      window.scrollTo({ top: snapshot.scrollY });
      return;
    }

    const nextTop = target.getBoundingClientRect().top;
    window.scrollBy({ top: nextTop - snapshot.offset });
  });
}

async function renderAndKeepPosition(stepId = "") {
  const snapshot = getScrollSnapshot(stepId);
  await renderTutorial();
  restoreScrollSnapshot(snapshot);
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

function cleanText(text) {
  return (text || "").trim().replace(/\s+/g, " ");
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function setSaveStatus(text, state = "") {
  saveStatus.textContent = text;
  saveStatus.className = `save-status ${state}`.trim();
}

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

function getScreenshot(screenshotId) {
  if (!screenshotId) {
    return Promise.resolve(null);
  }

  return runScreenshotTransaction("readonly", (store) => store.get(screenshotId))
    .then((record) => record || null);
}

function isImageDataUrl(value) {
  return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

async function resolveScreenshotDataUrl(screenshotItem) {
  if (!screenshotItem) {
    return "";
  }

  if (isImageDataUrl(screenshotItem.dataUrl)) {
    return screenshotItem.dataUrl;
  }

  if (isImageDataUrl(screenshotItem.screenshotId)) {
    return screenshotItem.screenshotId;
  }

  if (isImageDataUrl(screenshotItem.screenshot)) {
    return screenshotItem.screenshot;
  }

  const screenshot = await getScreenshot(screenshotItem.screenshotId);
  return screenshot?.dataUrl || "";
}

function putScreenshot(record) {
  return runScreenshotTransaction("readwrite", (store) => store.put(record));
}

function deleteScreenshotRecord(screenshotId) {
  return runScreenshotTransaction("readwrite", (store) => store.delete(screenshotId));
}

function isLowQualityLabel(text) {
  const value = cleanText(text);

  if (!value) {
    return true;
  }

  if (/播放器$/.test(value) || /哔哩哔哩播放器|bilibili player|正在缓冲|缓冲中|加载中|loading/i.test(value)) {
    return true;
  }

  return value.split(/\s+/).every((token) => {
    return (
      /^\d{1,2}:\d{2}(:\d{2})?$/.test(token) ||
      /^[\d.]+万?$/.test(token) ||
      /^\d+$/.test(token) ||
      /^(播放|弹幕|点赞|收藏|评论|分享)$/.test(token)
    );
  });
}

function getDisplayLabel(step) {
  if (step.actionType === "CLICK_LINK" && /bilibili\.com\/video\/|\/video\/|\/BV[a-zA-Z0-9]+|BV[a-zA-Z0-9]+/.test(step.href || step.url || "")) {
    return "";
  }

  const label = step.label || step.text || step.ariaLabel || step.title || step.placeholder || "";
  return isLowQualityLabel(label) ? "" : label;
}

function generateStepDescription(step) {
  const label = getDisplayLabel(step);
  const fieldLabel = step.fieldLabel || "输入框";

  if (step.actionType === "INPUT_TEXT") {
    return step.sensitiveKind ? `输入${step.sensitiveKind}` : "输入内容";
  }

  if (step.actionType === "SELECT_OPTION") {
    return label ? `选择“${label}”` : "选择选项";
  }

  if (step.actionType === "CLICK_BUTTON") {
    return label ? `点击“${label}”按钮` : "点击按钮";
  }

  if (step.actionType === "CLICK_ICON") {
    return label ? `点击“${label}”图标` : "点击页面控件";
  }

  if (step.actionType === "CLICK_LINK") {
    return label ? `点击“${label}”` : "点击链接";
  }

  if (fieldLabel && step.tagName === "INPUT" && fieldLabel !== "输入框") {
    return `点击“${fieldLabel}”输入框`;
  }

  if (step.tagName === "INPUT" || step.tagName === "TEXTAREA") {
    return "点击输入框";
  }

  return label ? `点击“${label}”` : "点击页面控件";
}

function getAutoMarker(step) {
  const viewportWidth = step.viewportWidth || 1;
  const viewportHeight = step.viewportHeight || 1;
  const left = clamp((step.x - MARKER_PADDING_X) / viewportWidth);
  const top = clamp((step.y - MARKER_PADDING_Y) / viewportHeight);
  const right = clamp((step.x + step.width + MARKER_PADDING_X) / viewportWidth);
  const bottom = clamp((step.y + step.height + MARKER_PADDING_Y) / viewportHeight);

  return {
    x: left,
    y: top,
    width: Math.max(right - left, 0.01),
    height: Math.max(bottom - top, 0.01)
  };
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== "object") {
    return null;
  }

  const x = clamp(rect.x);
  const y = clamp(rect.y);
  const width = clamp(rect.width, 0.01, 1 - x);
  const height = clamp(rect.height, 0.01, 1 - y);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
}

function createScreenshotItem(step, screenshotId) {
  return {
    id: createId("shot"),
    screenshotId,
    marker: screenshotId ? getAutoMarker(step) : null,
    blurRegions: []
  };
}

function createManualStep() {
  const now = Date.now();

  return {
    id: createId("manual_step"),
    interactionId: createId("manual_interaction"),
    actionType: "MANUAL",
    elementType: "MANUAL",
    description: "点击编辑操作说明",
    note: "",
    screenshots: [],
    screenshot: "",
    screenshotId: "",
    screenshotError: "",
    url: getSourceUrl(),
    pageTitle: "",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    viewportWidth: 1,
    viewportHeight: 1,
    timestamp: now,
    editOrder: steps.length
  };
}

function migrateStep(step, index) {
  const id = step.id || step.interactionId || createId("step");
  const description = typeof step.description === "string" ? step.description : generateStepDescription(step);
  const note = typeof step.note === "string" ? step.note : "";
  let screenshots = Array.isArray(step.screenshots)
    ? step.screenshots
    : [];

  screenshots = screenshots
    .map((item) => {
      const screenshotId = item.screenshotId || item.screenshot || "";
      return {
        id: item.id || createId("shot"),
        screenshotId,
        marker: normalizeRect(item.marker) || (screenshotId ? getAutoMarker(step) : null),
        blurRegions: Array.isArray(item.blurRegions)
          ? item.blurRegions.map((region) => {
              const rect = normalizeRect(region);
              return rect ? { id: region.id || createId("blur"), ...rect } : null;
            }).filter(Boolean)
          : []
      };
    });

  if (screenshots.length === 0 && (step.screenshotId || step.screenshot)) {
    screenshots = [createScreenshotItem(step, step.screenshotId || step.screenshot)];
  }

  return {
    ...step,
    id,
    description,
    note,
    screenshots,
    editOrder: Number.isFinite(step.editOrder) ? step.editOrder : index
  };
}

async function addManualStep() {
  const step = createManualStep();
  steps = [...steps, step].map((item, index) => ({ ...item, editOrder: index }));
  await saveSteps("已添加步骤");
  await renderTutorial();

  window.requestAnimationFrame(() => {
    const card = document.querySelector(`[data-step-id="${CSS.escape(step.id)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    const input = card?.querySelector(".description-input");
    input?.focus();
    input?.select();
  });
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function getMissingScreenshotText(step) {
  return step.screenshotError ? `截图不可用：${step.screenshotError}` : "截图不可用";
}

function getSourceUrl() {
  return steps.find((step) => step.url)?.url || "";
}

function renderSourceInfo() {
  const url = getSourceUrl();

  if (!url) {
    sourceInfo.hidden = true;
    sourceInfo.textContent = "";
    return;
  }

  sourceInfo.hidden = false;
  sourceInfo.innerHTML = "";

  const label = createElement("span", "source-label", "网页链接");
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = url;

  sourceInfo.append(label, link);
}

async function saveSteps(message = "已自动保存") {
  setSaveStatus("保存中", "saving");

  try {
    await chrome.storage.local.set({ steps });
    setSaveStatus(message);
  } catch (error) {
    console.error("WebStep failed to save steps", error);
    setSaveStatus("保存失败", "error");
    showToast("保存失败，请稍后重试");
  }
}

function updateStep(stepId, updater) {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index === -1) {
    return null;
  }

  const next = typeof updater === "function" ? updater(steps[index]) : { ...steps[index], ...updater };
  steps[index] = next;
  return next;
}

function collectScreenshotReferences(exceptStepId = "", exceptScreenshotItemId = "") {
  const refs = new Map();

  for (const step of steps) {
    for (const screenshot of step.screenshots || []) {
      if (step.id === exceptStepId && screenshot.id === exceptScreenshotItemId) {
        continue;
      }

      if (!screenshot.screenshotId) {
        continue;
      }

      refs.set(screenshot.screenshotId, (refs.get(screenshot.screenshotId) || 0) + 1);
    }
  }

  return refs;
}

async function deleteIfUnreferenced(screenshotId) {
  if (!screenshotId) {
    return;
  }

  const refs = collectScreenshotReferences();
  if (!refs.has(screenshotId)) {
    await deleteScreenshotRecord(screenshotId).catch((error) => {
      console.warn("WebStep failed to delete unreferenced screenshot", error);
    });
  }
}

async function deleteStep(stepId) {
  const step = steps.find((item) => item.id === stepId);
  if (!step) {
    return;
  }

  const screenshotIds = (step.screenshots || []).map((item) => item.screenshotId).filter(Boolean);
  steps = steps
    .filter((item) => item.id !== stepId)
    .map((item, index) => ({ ...item, editOrder: index }));

  await saveSteps();

  for (const screenshotId of screenshotIds) {
    await deleteIfUnreferenced(screenshotId);
  }
}

function applyRectStyle(element, rect) {
  if (!rect) {
    element.hidden = true;
    return;
  }

  element.hidden = false;
  element.style.left = `${rect.x * 100}%`;
  element.style.top = `${rect.y * 100}%`;
  element.style.width = `${rect.width * 100}%`;
  element.style.height = `${rect.height * 100}%`;
}

function renderMarker(frame, screenshotItem) {
  const marker = screenshotItem.marker ? createElement("div", "click-marker") : null;
  if (!marker) {
    return;
  }

  applyRectStyle(marker, screenshotItem.marker);
  frame.append(marker);
}

function renderBlurRegions(frame, screenshotItem, dataUrl) {
  for (const region of screenshotItem.blurRegions || []) {
    const rect = normalizeRect(region);
    if (!rect) {
      continue;
    }

    const blur = createElement("div", "blur-region");
    applyRectStyle(blur, rect);

    if (dataUrl) {
      const blurImage = document.createElement("img");
      blurImage.className = "blur-region-image";
      blurImage.src = dataUrl;
      blurImage.alt = "";
      blurImage.style.left = `${(-rect.x / rect.width) * 100}%`;
      blurImage.style.top = `${(-rect.y / rect.height) * 100}%`;
      blurImage.style.width = `${(1 / rect.width) * 100}%`;
      blurImage.style.height = `${(1 / rect.height) * 100}%`;
      blur.append(blurImage);
    }

    frame.append(blur);
  }
}

async function renderScreenshot(step, screenshotItem, index) {
  const block = createElement("section", "screenshot-block");
  const head = createElement("div", "screenshot-head");
  const label = createElement("span", "screenshot-label", "");
  const actions = createElement("div", "screenshot-actions");

  const editBtn = createElement("button", "secondary-button", "编辑截图");
  const replaceBtn = createElement("button", "secondary-button", "替换");
  const deleteBtn = createElement("button", "secondary-button danger", "删除");

  editBtn.type = "button";
  replaceBtn.type = "button";
  deleteBtn.type = "button";
  actions.append(editBtn, replaceBtn, deleteBtn);
  head.append(label, actions);
  block.append(head);

  try {
    const dataUrl = await resolveScreenshotDataUrl(screenshotItem);

    if (!dataUrl) {
      const missing = createElement("div", "missing-screenshot", getMissingScreenshotText(step));
      block.append(missing);
    } else {
      const frame = createElement("div", "screenshot-frame");
      const image = document.createElement("img");
      image.src = dataUrl;
      image.alt = `步骤截图 ${index + 1}`;
      frame.append(image);
      renderBlurRegions(frame, screenshotItem, dataUrl);
      renderMarker(frame, screenshotItem);
      block.append(frame);
    }
  } catch (error) {
    console.warn("WebStep failed to render screenshot", error);
    block.append(createElement("div", "missing-screenshot", "截图读取失败"));
  }

  editBtn.addEventListener("click", () => openScreenshotEditor(step.id, screenshotItem.id, screenshotItem));
  replaceBtn.addEventListener("click", () => triggerImageUpload({ type: "replace", stepId: step.id, screenshotItemId: screenshotItem.id }));
  deleteBtn.addEventListener("click", async () => {
    if (!window.confirm("删除这张截图？")) {
      return;
    }

    const deletedScreenshotId = screenshotItem.screenshotId;
    updateStep(step.id, (current) => ({
      ...current,
      screenshots: (current.screenshots || []).filter((item) => item.id !== screenshotItem.id)
    }));
    await saveSteps();
    await deleteIfUnreferenced(deletedScreenshotId);
    renderAndKeepPosition(step.id);
  });

  return block;
}

async function renderStep(step, index) {
  const card = createElement("article", "step-card");
  card.draggable = true;
  card.dataset.stepId = step.id;

  const header = createElement("div", "step-header");
  const numberBadge = createElement("div", "step-number", String(index + 1));
  const descGroup = createFieldGroup("", "textarea", "description-input", step.description || generateStepDescription(step));
  descGroup.group.classList.add("description-field");
  const stepActions = createElement("div", "step-actions");
  const moveTopBtn = createElement("button", "icon-action-button", "⇧");
  const moveUpBtn = createElement("button", "icon-action-button", "↑");
  const moveDownBtn = createElement("button", "icon-action-button", "↓");
  const deleteStepBtn = createElement("button", "icon-action-button danger", "×");
  const dragHandle = createElement("button", "drag-handle", "⋮⋮");

  moveTopBtn.type = "button";
  moveTopBtn.title = "移到最前";
  moveTopBtn.disabled = index === 0;
  moveUpBtn.type = "button";
  moveUpBtn.title = "上移步骤";
  moveUpBtn.disabled = index === 0;
  moveDownBtn.type = "button";
  moveDownBtn.title = "下移步骤";
  moveDownBtn.disabled = index === steps.length - 1;
  deleteStepBtn.type = "button";
  deleteStepBtn.title = "删除步骤";
  dragHandle.type = "button";
  dragHandle.title = "拖拽排序";

  moveTopBtn.addEventListener("click", async () => {
    moveStepToTop(step.id);
    await saveSteps();
    renderAndKeepPosition(step.id);
  });
  moveUpBtn.addEventListener("click", async () => {
    moveStep(step.id, -1);
    await saveSteps();
    renderAndKeepPosition(step.id);
  });
  moveDownBtn.addEventListener("click", async () => {
    moveStep(step.id, 1);
    await saveSteps();
    renderAndKeepPosition(step.id);
  });
  deleteStepBtn.addEventListener("click", async () => {
    if (!window.confirm(`删除步骤 ${index + 1}？`)) {
      return;
    }

    const snapshot = getScrollSnapshot(step.id);
    await deleteStep(step.id);
    await renderTutorial();
    restoreScrollSnapshot(snapshot);
  });

  stepActions.append(moveTopBtn, moveUpBtn, moveDownBtn, deleteStepBtn, dragHandle);
  header.append(numberBadge, descGroup.group, stepActions);
  descGroup.input.rows = 1;
  descGroup.input.title = "点击编辑操作说明";
  descGroup.input.setAttribute("aria-label", "操作说明，可编辑");
  descGroup.input.addEventListener("blur", async () => {
    const next = descGroup.input.value.trim() || generateStepDescription(step);
    if (next === step.description) {
      return;
    }

    updateStep(step.id, (current) => ({ ...current, description: next }));
    await saveSteps();
  });

  const noteGroup = step.note
    ? createFieldGroup("备注", "textarea", "note-input", step.note)
    : null;

  if (noteGroup) {
    noteGroup.group.classList.add("note-field");
    noteGroup.input.addEventListener("blur", async () => {
      const next = noteGroup.input.value.trim();
      if (next === (step.note || "")) {
        return;
      }

      updateStep(step.id, (current) => ({ ...current, note: next }));
      await saveSteps();
      renderAndKeepPosition(step.id);
    });
  }

  const screenshotsWrap = createElement("div", "screenshots");
  const screenshots = step.screenshots || [];

  if (screenshots.length === 0) {
    screenshotsWrap.append(createElement("div", "missing-screenshot", getMissingScreenshotText(step)));
  } else {
    for (const [screenshotIndex, screenshot] of screenshots.entries()) {
      screenshotsWrap.append(await renderScreenshot(step, screenshot, screenshotIndex));
    }
  }

  const footer = createElement("div", "step-footer");
  const addScreenshotBtn = createElement("button", "secondary-button quiet-button", screenshots.length ? "添加截图" : "上传截图");
  addScreenshotBtn.type = "button";
  addScreenshotBtn.addEventListener("click", () => triggerImageUpload({ type: "add", stepId: step.id }));
  footer.append(addScreenshotBtn);

  if (!step.note) {
    const addNoteBtn = createElement("button", "secondary-button quiet-button", "添加备注");
    addNoteBtn.type = "button";
    addNoteBtn.addEventListener("click", async () => {
      updateStep(step.id, (current) => ({ ...current, note: " " }));
      await saveSteps();
      renderAndKeepPosition(step.id);
    });
    footer.append(addNoteBtn);
  }

  stepActions.append(footer);
  card.append(header);
  if (noteGroup) {
    card.append(noteGroup.group);
  }
  card.append(screenshotsWrap);
  wireStepDrag(card);
  return card;
}

function createFieldGroup(labelText, tagName, className, value) {
  const group = createElement("label", "field-group");
  const input = document.createElement(tagName);
  input.className = className;
  input.value = value || "";
  if (labelText) {
    const label = createElement("span", "field-label", labelText);
    group.append(label);
  }
  group.append(input);
  return { group, input };
}

function wireStepDrag(card) {
  card.addEventListener("dragstart", (event) => {
    draggedStepId = card.dataset.stepId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedStepId);
    card.classList.add("dragging");
  });

  card.addEventListener("dragend", () => {
    draggedStepId = "";
    card.classList.remove("dragging");
    stepsContainer.querySelectorAll(".drag-over").forEach((element) => element.classList.remove("drag-over"));
  });

  card.addEventListener("dragover", (event) => {
    if (!draggedStepId || draggedStepId === card.dataset.stepId) {
      return;
    }

    event.preventDefault();
    card.classList.add("drag-over");
  });

  card.addEventListener("dragleave", () => {
    card.classList.remove("drag-over");
  });

  card.addEventListener("drop", async (event) => {
    event.preventDefault();
    card.classList.remove("drag-over");
    const targetStepId = card.dataset.stepId;

    if (!draggedStepId || draggedStepId === targetStepId) {
      return;
    }

    reorderSteps(draggedStepId, targetStepId);
    await saveSteps();
    renderAndKeepPosition(draggedStepId);
  });
}

function reorderSteps(sourceId, targetId) {
  const sourceIndex = steps.findIndex((step) => step.id === sourceId);
  const targetIndex = steps.findIndex((step) => step.id === targetId);

  if (sourceIndex === -1 || targetIndex === -1) {
    return;
  }

  const [source] = steps.splice(sourceIndex, 1);
  const insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  steps.splice(insertIndex, 0, source);
  steps = steps.map((step, index) => ({ ...step, editOrder: index }));
}

function moveStep(stepId, direction) {
  const index = steps.findIndex((step) => step.id === stepId);
  const nextIndex = index + direction;

  if (index < 0 || nextIndex < 0 || nextIndex >= steps.length) {
    return;
  }

  const [step] = steps.splice(index, 1);
  steps.splice(nextIndex, 0, step);
  steps = steps.map((item, itemIndex) => ({ ...item, editOrder: itemIndex }));
}

function moveStepToTop(stepId) {
  const index = steps.findIndex((step) => step.id === stepId);

  if (index <= 0) {
    return;
  }

  const [step] = steps.splice(index, 1);
  steps.unshift(step);
  steps = steps.map((item, itemIndex) => ({ ...item, editOrder: itemIndex }));
}

function triggerImageUpload(action) {
  pendingImageAction = action;
  imageInput.value = "";
  imageInput.click();
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function saveUploadedImage(file) {
  if (!file) {
    throw new Error("没有选择图片");
  }

  if (!IMAGE_TYPES.has(file.type)) {
    throw new Error("请选择 PNG、JPG、JPEG 或 WEBP 图片");
  }

  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error("图片过大，请选择小于 15MB 的图片");
  }

  const dataUrl = await readImageFile(file);
  const id = createId("uploaded_screenshot");
  await putScreenshot({
    id,
    dataUrl,
    createdAt: Date.now(),
    source: "upload",
    name: file.name
  });
  return id;
}

imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  const action = pendingImageAction;
  pendingImageAction = null;

  if (!file || !action) {
    return;
  }

  try {
    const screenshotId = await saveUploadedImage(file);

    if (action.type === "add") {
      updateStep(action.stepId, (step) => ({
        ...step,
        screenshots: [
          ...(step.screenshots || []),
          {
            id: createId("shot"),
            screenshotId,
            marker: null,
            blurRegions: []
          }
        ]
      }));
      showToast("截图已添加");
    }

    if (action.type === "replace") {
      let oldScreenshotId = "";
      updateStep(action.stepId, (step) => ({
        ...step,
        screenshots: (step.screenshots || []).map((item) => {
          if (item.id !== action.screenshotItemId) {
            return item;
          }

          oldScreenshotId = item.screenshotId;
          return {
            ...item,
            screenshotId,
            marker: null,
            blurRegions: []
          };
        })
      }));
      await deleteIfUnreferenced(oldScreenshotId);
      showToast("截图已替换，请重新设置标注位置。");
    }

    await saveSteps();
    renderAndKeepPosition(action.stepId);
  } catch (error) {
    showToast(error.message || "图片上传失败");
  }
});

function findStepByScreenshotItem(stepId, screenshotItem) {
  const directStep = steps.find((item) => item.id === stepId);

  if (directStep) {
    return directStep;
  }

  if (!screenshotItem?.screenshotId) {
    return null;
  }

  return steps.find((step) => (
    (step.screenshots || []).some((item) => item.screenshotId === screenshotItem.screenshotId)
  )) || null;
}

function findScreenshotItem(step, screenshotItemId, fallbackScreenshotItem = null) {
  if (!step) {
    return null;
  }

  const screenshots = step.screenshots || [];
  const byId = screenshots.find((item) => item.id === screenshotItemId);

  if (byId) {
    return byId;
  }

  if (fallbackScreenshotItem?.screenshotId) {
    const byScreenshotId = screenshots.find((item) => item.screenshotId === fallbackScreenshotItem.screenshotId);

    if (byScreenshotId) {
      return byScreenshotId;
    }
  }

  return fallbackScreenshotItem || null;
}

function isSameScreenshotItem(item, editor) {
  if (!item || !editor) {
    return false;
  }

  if (item.id && editor.screenshotItemId && item.id === editor.screenshotItemId) {
    return true;
  }

  return Boolean(editor.screenshotId && item.screenshotId === editor.screenshotId);
}

async function openScreenshotEditor(stepId, screenshotItemId, fallbackScreenshotItem = null) {
  try {
    const step = findStepByScreenshotItem(stepId, fallbackScreenshotItem);
    const screenshotItem = findScreenshotItem(step, screenshotItemId, fallbackScreenshotItem);

    if (!step || !screenshotItem) {
      showToast("没有找到这张截图");
      return;
    }

    const dataUrl = await resolveScreenshotDataUrl(screenshotItem);
    if (!dataUrl) {
      showToast("截图不可用，请先替换或上传截图");
      return;
    }

    editorState = {
      stepId: step.id,
      screenshotItemId: screenshotItem.id || screenshotItemId || "",
      screenshotId: screenshotItem.screenshotId || fallbackScreenshotItem?.screenshotId || "",
      marker: screenshotItem.marker ? { ...screenshotItem.marker } : null,
      blurRegions: (screenshotItem.blurRegions || []).map((region) => ({ ...region })),
      selectedType: screenshotItem.marker ? "marker" : "",
      selectedBlurId: "",
      dataUrl,
      activePointer: null
    };

    renderEditorCanvas();
    editorModal.hidden = false;
  } catch (error) {
    console.warn("WebStep failed to open screenshot editor", error);
    showToast("截图读取失败，请先替换或重新上传");
  }
}

function closeEditor() {
  editorState = null;
  editorCanvas.textContent = "";
  editorModal.hidden = true;
}

function renderEditorCanvas() {
  if (!editorState) {
    return;
  }

  editorCanvas.textContent = "";

  const image = document.createElement("img");
  image.src = editorState.dataUrl;
  image.alt = "正在编辑的截图";
  editorCanvas.append(image);

  if (editorState.marker) {
    const marker = createEditableRect(
      `editor-marker${editorState.selectedType === "marker" ? " selected" : ""}`,
      editorState.marker,
      "marker"
    );
    editorCanvas.append(marker);
  }

  for (const region of editorState.blurRegions) {
    const blur = createEditableRect(
      `editor-blur${region.id === editorState.selectedBlurId ? " selected" : ""}`,
      region,
      "blur",
      region.id
    );
    editorCanvas.append(blur);
  }
}

function createEditableRect(className, rect, type, id = "") {
  const element = createElement("div", className);
  element.dataset.rectType = type;
  element.dataset.rectId = id;
  applyRectStyle(element, rect);

  element.addEventListener("pointerdown", (event) => {
    if (!editorState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (type === "marker") {
      editorState.selectedType = "marker";
      editorState.selectedBlurId = "";
      renderEditorCanvas();
    }

    if (type === "blur") {
      editorState.selectedType = "blur";
      editorState.selectedBlurId = id;
      renderEditorCanvas();
    }

    startRectInteraction(event, type, id, "move");
  });

  for (const direction of HANDLE_DIRECTIONS) {
    const handle = createElement("span", `resize-handle ${direction}`);
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (type === "marker") {
        editorState.selectedType = "marker";
        editorState.selectedBlurId = "";
        renderEditorCanvas();
      }

      if (type === "blur") {
        editorState.selectedType = "blur";
        editorState.selectedBlurId = id;
        renderEditorCanvas();
      }

      startRectInteraction(event, type, id, direction);
    });
    element.append(handle);
  }

  return element;
}

function getEditorRect(type, id) {
  if (!editorState) {
    return null;
  }

  if (type === "marker") {
    return editorState.marker;
  }

  return editorState.blurRegions.find((region) => region.id === id) || null;
}

function setEditorRect(type, id, rect) {
  const nextRect = normalizeRect(rect);
  if (!nextRect || !editorState) {
    return;
  }

  if (type === "marker") {
    editorState.marker = nextRect;
    return;
  }

  editorState.blurRegions = editorState.blurRegions.map((region) => (
    region.id === id ? { ...region, ...nextRect } : region
  ));
}

function startRectInteraction(event, type, id, mode) {
  const rect = getEditorRect(type, id);
  if (!rect) {
    return;
  }

  const canvasRect = editorCanvas.getBoundingClientRect();
  editorState.activePointer = {
    pointerId: event.pointerId,
    type,
    id,
    mode,
    startX: event.clientX,
    startY: event.clientY,
    startRect: { ...rect },
    canvasWidth: canvasRect.width,
    canvasHeight: canvasRect.height
  };

  editorCanvas.setPointerCapture?.(event.pointerId);
}

function handleEditorPointerMove(event) {
  const active = editorState?.activePointer;
  if (!active || active.pointerId !== event.pointerId) {
    return;
  }

  const dx = (event.clientX - active.startX) / active.canvasWidth;
  const dy = (event.clientY - active.startY) / active.canvasHeight;
  const rect = { ...active.startRect };

  if (active.mode === "move") {
    rect.x = clamp(active.startRect.x + dx, 0, 1 - active.startRect.width);
    rect.y = clamp(active.startRect.y + dy, 0, 1 - active.startRect.height);
  } else {
    resizeRect(rect, dx, dy, active.mode, active.startRect);
  }

  setEditorRect(active.type, active.id, rect);
  renderEditorCanvas();
}

function resizeRect(rect, dx, dy, mode, startRect) {
  if (mode.includes("e")) {
    rect.width = clamp(startRect.width + dx, 0.01, 1 - startRect.x);
  }

  if (mode.includes("s")) {
    rect.height = clamp(startRect.height + dy, 0.01, 1 - startRect.y);
  }

  if (mode.includes("w")) {
    const right = startRect.x + startRect.width;
    rect.x = clamp(startRect.x + dx, 0, right - 0.01);
    rect.width = clamp(right - rect.x, 0.01, 1 - rect.x);
  }

  if (mode.includes("n")) {
    const bottom = startRect.y + startRect.height;
    rect.y = clamp(startRect.y + dy, 0, bottom - 0.01);
    rect.height = clamp(bottom - rect.y, 0.01, 1 - rect.y);
  }
}

function handleEditorPointerUp(event) {
  if (editorState?.activePointer?.pointerId === event.pointerId) {
    editorState.activePointer = null;
  }
}

editorCanvas.addEventListener("pointermove", handleEditorPointerMove);
editorCanvas.addEventListener("pointerup", handleEditorPointerUp);
editorCanvas.addEventListener("pointercancel", handleEditorPointerUp);

addMarkerBtn.addEventListener("click", () => {
  if (!editorState) {
    return;
  }

  if (!editorState.marker) {
    const step = steps.find((item) => item.id === editorState.stepId);
    editorState.marker = step ? getAutoMarker(step) : {
      x: 0.38,
      y: 0.38,
      width: 0.24,
      height: 0.12
    };
  }

  editorState.selectedType = "marker";
  editorState.selectedBlurId = "";
  renderEditorCanvas();
});

addBlurBtn.addEventListener("click", () => {
  if (!editorState) {
    return;
  }

  const id = createId("blur");
  editorState.blurRegions.push({
    id,
    x: 0.32,
    y: 0.32,
    width: 0.22,
    height: 0.1
  });
  editorState.selectedType = "blur";
  editorState.selectedBlurId = id;
  renderEditorCanvas();
});

restoreMarkerBtn.addEventListener("click", () => {
  if (!editorState) {
    return;
  }

  const step = steps.find((item) => item.id === editorState.stepId);
  if (!step) {
    return;
  }

  editorState.marker = getAutoMarker(step);
  editorState.selectedType = "marker";
  editorState.selectedBlurId = "";
  renderEditorCanvas();
});

deleteSelectedBtn.addEventListener("click", () => {
  if (!editorState) {
    return;
  }

  if (editorState.selectedType === "marker" && editorState.marker) {
    editorState.marker = null;
    editorState.selectedType = "";
    renderEditorCanvas();
    return;
  }

  if (editorState.selectedType === "blur" && editorState.selectedBlurId) {
    editorState.blurRegions = editorState.blurRegions.filter((region) => region.id !== editorState.selectedBlurId);
    editorState.selectedBlurId = "";
    editorState.selectedType = "";
    renderEditorCanvas();
    return;
  }

  showToast("请先选择一个红框或模糊区域");
});

saveEditorBtn.addEventListener("click", async () => {
  if (!editorState) {
    return;
  }

  updateStep(editorState.stepId, (step) => ({
    ...step,
    screenshots: (step.screenshots || []).map((item) => (
      isSameScreenshotItem(item, editorState)
        ? {
            ...item,
            id: item.id || editorState.screenshotItemId || createId("shot"),
            marker: editorState.marker ? normalizeRect(editorState.marker) : null,
            blurRegions: editorState.blurRegions.map((region) => {
              const rect = normalizeRect(region);
              return rect ? { id: region.id, ...rect } : null;
            }).filter(Boolean)
          }
        : item
    ))
  }));

  const editedStepId = editorState.stepId;
  await saveSteps();
  closeEditor();
  renderAndKeepPosition(editedStepId);
});

cancelEditorBtn.addEventListener("click", closeEditor);
closeEditorBtn.addEventListener("click", closeEditor);
editorModal.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-editor]")) {
    closeEditor();
  }
});

exportPdfBtn.addEventListener("click", () => {
  showToast("导出时请在打印设置中关闭“页眉和页脚”，即可去掉时间和标题。");
  document.body.classList.add("printing-export");
  const previousTitle = document.title;
  document.title = " ";
  window.setTimeout(() => {
    window.print();
    document.title = previousTitle;
    document.body.classList.remove("printing-export");
  }, 80);
});

addStepBtn.addEventListener("click", addManualStep);

window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing-export");
});

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
    document.body.classList.add("printing-export");
  }
});

window.addEventListener("beforeprint", () => {
  document.body.classList.add("printing-export");
});

async function loadSteps() {
  const result = await chrome.storage.local.get({ steps: [] });
  const rawSteps = [...result.steps];
  const hasEditOrder = rawSteps.some((step) => Number.isFinite(step.editOrder));
  const loaded = rawSteps.map(migrateStep);

  steps = hasEditOrder
    ? loaded.sort((a, b) => (a.editOrder || 0) - (b.editOrder || 0))
    : loaded.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  steps = steps.map((step, index) => ({ ...step, editOrder: index }));
  await saveSteps("已加载");
}

async function renderTutorial() {
  stepsContainer.textContent = "";
  summary.textContent = `共 ${steps.length} 个步骤`;
  renderSourceInfo();

  if (steps.length === 0) {
    stepsContainer.append(createElement("div", "empty-state", "暂无录制步骤"));
    return;
  }

  for (const [index, step] of steps.entries()) {
    stepsContainer.append(await renderStep(step, index));
  }
}

loadSteps()
  .then(renderTutorial)
  .catch((error) => {
    console.error("WebStep failed to load tutorial", error);
    summary.textContent = "读取失败";
    stepsContainer.append(createElement("div", "empty-state", "教程读取失败，请刷新重试。"));
  });
