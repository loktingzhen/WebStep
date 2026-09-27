let isRecording = false;
let pendingInteraction = null;
let pendingInput = null;
let inputPollingTimerId = null;
let frameGeometry = {
  x: 0,
  y: 0,
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
  ready: window === window.top
};
const frameGeometryRequests = new Map();
const observedInputLengths = new WeakMap();
const IGNORED_CONTAINER_TAGS = new Set(["HTML", "BODY", "MAIN", "IFRAME", "FRAME"]);
const VISUAL_INNER_TAGS = new Set(["SVG", "PATH", "USE", "I"]);
const GENERIC_TAGS = new Set(["DIV", "SPAN", "LI", "SECTION", "ARTICLE", "HEADER", "NAV"]);
const SEMANTIC_TAGS = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "OPTION", "LABEL"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "option", "menuitem", "tab", "checkbox", "radio"]);
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "password", "tel", "url", "number"]);
const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset"]);
const CLASS_HINT_PATTERN = /(btn|button|item|option|menu|tab|link|select|dropdown|filter|city|comment|action)/i;
const TITLE_HINT_PATTERN = /(title|name|headline)/i;
const SENSITIVE_FIELD_PATTERN =
  /(password|passwd|pwd|passcode|支付密码|密码|验证码|verification|verify|captcha|code|身份证|id.?card|identity|银行卡|bank.?card|信用卡|credit.?card|cvv|cvc|pin|安全码)/i;
const ACTION_TYPES = {
  CLICK_LINK: "CLICK_LINK",
  CLICK_BUTTON: "CLICK_BUTTON",
  CLICK_ICON: "CLICK_ICON",
  CLICK_GENERIC: "CLICK_GENERIC",
  INPUT_TEXT: "INPUT_TEXT",
  SELECT_OPTION: "SELECT_OPTION"
};
const ELEMENT_TYPES = {
  LINK: "LINK",
  BUTTON: "BUTTON",
  INPUT: "INPUT",
  TEXTAREA: "TEXTAREA",
  SELECT: "SELECT",
  OPTION: "OPTION",
  ICON: "ICON",
  GENERIC: "GENERIC"
};
const TEXT_LIMIT = 50;
const MAX_GENERIC_AREA_RATIO = 0.2;
const MAX_GENERIC_WIDTH_RATIO = 0.6;
const MAX_GENERIC_HEIGHT_RATIO = 0.3;
const MIN_TARGET_SCORE = 45;
const INPUT_DEBOUNCE_DELAY = 900;
const INPUT_SCREENSHOT_REFRESH_DELAY = 420;
const INPUT_POLL_INTERVAL = 300;
const EXPLICIT_FIELD_LABEL_PATTERN = /(用户名|账号|账户|手机号|手机号码|邮箱|邮件|email|密码|验证码|身份证|银行卡|信用卡|安全码|PIN)/i;

console.log("WebStep content script ready", {
  href: window.location.href,
  isTopFrame: window === window.top
});

function createInteractionId() {
  return `step_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createRequestId() {
  return `request_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeSendMessage(message, context) {
  return chrome.runtime.sendMessage(message).catch((error) => {
    console.warn(`WebStep ${context} message failed`, error);
    return { ok: false, reason: "message_failed" };
  });
}

function cleanText(text) {
  return text.trim().replace(/\s+/g, " ").slice(0, TEXT_LIMIT);
}

function getVisibleText(element) {
  return cleanText(element.innerText || element.textContent || "");
}

function getOwnVisibleText(element) {
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join(" ");

  return cleanText(text);
}

function isLowQualityLabel(text) {
  const value = cleanText(text);

  if (!value) {
    return true;
  }

  if (/播放器$/.test(value) || /哔哩哔哩播放器|bilibili player|正在缓冲|缓冲中|加载中|loading/i.test(value)) {
    return true;
  }

  const tokens = value.split(/\s+/);
  const allAuxiliary = tokens.every((token) => {
    return (
      /^\d{1,2}:\d{2}(:\d{2})?$/.test(token) ||
      /^[\d.]+万?$/.test(token) ||
      /^\d+$/.test(token) ||
      /^(播放|弹幕|点赞|收藏|评论|分享)$/.test(token)
    );
  });

  return allAuxiliary;
}

function getPreferredDescendantText(element) {
  const titleNode = Array.from(element.querySelectorAll("[title], [aria-label], [class*='title'], [class*='name'], [class*='headline']"))
    .find((node) => {
      const text = cleanText(node.getAttribute("title") || node.getAttribute("aria-label") || node.innerText || node.textContent || "");
      return text && !isLowQualityLabel(text);
    });

  if (titleNode) {
    return cleanText(titleNode.getAttribute("title") || titleNode.getAttribute("aria-label") || titleNode.innerText || titleNode.textContent || "");
  }

  const text = getShortDescendantText(element);
  return isLowQualityLabel(text) ? "" : text;
}

function getInputType(element) {
  if (element.tagName !== "INPUT") {
    return "";
  }

  return (element.getAttribute("type") || "text").toLowerCase();
}

function isBilibiliVideoHref(href) {
  return /bilibili\.com\/video\/|\/video\/|\/BV[a-zA-Z0-9]+|BV[a-zA-Z0-9]+/.test(href || "");
}

function getTargetLabel(element) {
  const tagName = element.tagName;
  const ariaLabel = getAttributeText(element, "aria-label");
  const title = getAttributeText(element, "title");
  const placeholder = getAttributeText(element, "placeholder");
  const role = getAttributeText(element, "role").toLowerCase();
  const inputType = getInputType(element);

  if (ariaLabel && !isLowQualityLabel(ariaLabel)) {
    return ariaLabel;
  }

  if (tagName === "INPUT") {
    if (BUTTON_INPUT_TYPES.has(inputType)) {
      return cleanText(element.value || "") || title;
    }

    if (TEXT_INPUT_TYPES.has(inputType)) {
      return getFieldLabel(element);
    }

    return placeholder || title || getAttributeText(element, "name") || inputType;
  }

  if (tagName === "TEXTAREA") {
    return getFieldLabel(element);
  }

  if (title && !isLowQualityLabel(title)) {
    return title;
  }

  if (tagName === "A" || role === "link") {
    if (isBilibiliVideoHref(getElementHref(element))) {
      return "";
    }

    const descendantText = getPreferredDescendantText(element);
    const ownText = getOwnVisibleText(element);
    return descendantText || (isLowQualityLabel(ownText) ? "" : ownText);
  }

  if (tagName === "BUTTON" || tagName === "A" || INTERACTIVE_ROLES.has(role)) {
    const ownText = getOwnVisibleText(element);
    return getPreferredDescendantText(element) || (isLowQualityLabel(ownText) ? "" : ownText);
  }

  if (tagName === "SELECT") {
    return title || getAttributeText(element, "name") || "下拉选择";
  }

  if (tagName === "OPTION") {
    return getVisibleText(element) || title;
  }

  if (tagName === "LABEL") {
    const ownText = getOwnVisibleText(element);
    return getPreferredDescendantText(element) || (isLowQualityLabel(ownText) ? "" : ownText);
  }

  const ownText = getOwnVisibleText(element);
  return (isLowQualityLabel(ownText) ? "" : ownText) || getPreferredDescendantText(element);
}

function getAttributeText(element, name) {
  return cleanText(element.getAttribute(name) || "");
}

function getClassName(element) {
  if (typeof element.className === "string") {
    return element.className;
  }

  if (element.className && typeof element.className.baseVal === "string") {
    return element.className.baseVal;
  }

  return "";
}

function getElementHref(element) {
  if (typeof element.href === "string") {
    return element.href;
  }

  return getAttributeText(element, "href");
}

function getShortDescendantText(element) {
  if (element.children.length > 4) {
    return "";
  }

  const text = getVisibleText(element);

  if (!text || text.length > TEXT_LIMIT) {
    return "";
  }

  return text;
}

function getElementType(element) {
  const tagName = element.tagName;
  const role = getAttributeText(element, "role").toLowerCase();
  const inputType = getInputType(element);

  if (tagName === "BUTTON" || role === "button" || (tagName === "INPUT" && BUTTON_INPUT_TYPES.has(inputType))) {
    return ELEMENT_TYPES.BUTTON;
  }

  if (tagName === "INPUT") {
    return ELEMENT_TYPES.INPUT;
  }

  if (tagName === "TEXTAREA" || element.isContentEditable) {
    return ELEMENT_TYPES.TEXTAREA;
  }

  if (tagName === "SELECT") {
    return ELEMENT_TYPES.SELECT;
  }

  if (tagName === "OPTION" || role === "option" || role === "menuitem") {
    return ELEMENT_TYPES.OPTION;
  }

  if (isGenericElement(element) && !isLargeGenericElement(element) && /(option|menuitem|dropdown|select)/i.test(getClassName(element))) {
    return ELEMENT_TYPES.OPTION;
  }

  if ((tagName === "A" && element.hasAttribute("href")) || role === "link") {
    return ELEMENT_TYPES.LINK;
  }

  if (VISUAL_INNER_TAGS.has(tagName) || /icon|comment|collect|share|service|客服|评论|收藏|分享|弹幕/i.test(getClassName(element))) {
    return ELEMENT_TYPES.ICON;
  }

  return ELEMENT_TYPES.GENERIC;
}

function getAssociatedLabel(element) {
  if (element.id) {
    const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);

    if (label) {
      return cleanText(label.innerText || label.textContent || "");
    }
  }

  const wrappingLabel = element.closest("label");

  if (wrappingLabel) {
    return cleanText(wrappingLabel.innerText || wrappingLabel.textContent || "");
  }

  return "";
}

function normalizeFieldLabel(label, inputType) {
  const cleanLabel = cleanText(label)
    .replace(/^请输入/, "")
    .replace(/[:：*]+$/g, "");

  if (!cleanLabel) {
    return "输入框";
  }

  if (inputType === "search" || /搜索|search/i.test(cleanLabel)) {
    return "输入框";
  }

  if (EXPLICIT_FIELD_LABEL_PATTERN.test(cleanLabel)) {
    return cleanLabel;
  }

  return "输入框";
}

function getFieldLabel(element) {
  const inputType = getInputType(element);
  const label =
    getAttributeText(element, "aria-label") ||
    getAttributeText(element, "placeholder") ||
    getAttributeText(element, "title") ||
    getAssociatedLabel(element) ||
    getAttributeText(element, "name");

  return normalizeFieldLabel(label, inputType);
}

function getSensitiveKind(element) {
  const inputType = getInputType(element);
  const fieldLabel = getFieldLabel(element);
  const haystack = [
    inputType,
    element.id || "",
    getAttributeText(element, "name"),
    getAttributeText(element, "placeholder"),
    getAttributeText(element, "aria-label"),
    getAttributeText(element, "title"),
    fieldLabel,
    getAssociatedLabel(element)
  ].join(" ");

  if (inputType === "password" || /密码|password|passwd|pwd|pin/i.test(haystack)) {
    return "密码";
  }

  if (/验证码|verification|verify|captcha|code/i.test(haystack)) {
    return "验证码";
  }

  if (/身份证|id.?card|identity/i.test(haystack)) {
    return "身份证号";
  }

  if (/银行卡|bank.?card/i.test(haystack)) {
    return "银行卡号";
  }

  if (/信用卡|credit.?card/i.test(haystack)) {
    return "信用卡号";
  }

  if (/cvv|cvc|安全码/i.test(haystack)) {
    return "安全码";
  }

  return SENSITIVE_FIELD_PATTERN.test(haystack) ? "敏感信息" : "";
}

function classifyAction(element, eventContext) {
  const elementType = getElementType(element);

  if (eventContext === "input") {
    return {
      actionType: ACTION_TYPES.INPUT_TEXT,
      elementType,
      reason: "real input event on editable target"
    };
  }

  if (eventContext === "select" || elementType === ELEMENT_TYPES.OPTION) {
    return {
      actionType: ACTION_TYPES.SELECT_OPTION,
      elementType,
      reason: "select or option interaction"
    };
  }

  if (elementType === ELEMENT_TYPES.BUTTON) {
    return {
      actionType: ACTION_TYPES.CLICK_BUTTON,
      elementType,
      reason: "button element type"
    };
  }

  if (elementType === ELEMENT_TYPES.LINK) {
    return {
      actionType: ACTION_TYPES.CLICK_LINK,
      elementType,
      reason: "link element type"
    };
  }

  if (elementType === ELEMENT_TYPES.ICON) {
    return {
      actionType: ACTION_TYPES.CLICK_ICON,
      elementType,
      reason: "icon-like element type"
    };
  }

  return {
    actionType: ACTION_TYPES.CLICK_GENERIC,
    elementType,
    reason: "generic interaction target"
  };
}

function getAreaRatio(rect) {
  const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
  const elementArea = Math.max(rect.width * rect.height, 0);

  return elementArea / viewportArea;
}

function findChildFrame(sourceWindow) {
  return Array.from(document.querySelectorAll("iframe, frame")).find((frame) => {
    try {
      return frame.contentWindow === sourceWindow;
    } catch (error) {
      return false;
    }
  });
}

function getLocalFrameGeometry() {
  return {
    x: frameGeometry.x,
    y: frameGeometry.y,
    viewportWidth: frameGeometry.viewportWidth,
    viewportHeight: frameGeometry.viewportHeight
  };
}

function handleFrameGeometryMessage(event) {
  const message = event.data;

  if (!message || !message.webstep || !message.type) {
    return;
  }

  if (message.type === "WEBSTEP_FRAME_GEOMETRY_REQUEST") {
    const childFrame = findChildFrame(event.source);

    if (!childFrame) {
      return;
    }

    const frameRect = childFrame.getBoundingClientRect();
    const parentGeometry = getLocalFrameGeometry();

    event.source.postMessage(
      {
        webstep: true,
        type: "WEBSTEP_FRAME_GEOMETRY_RESPONSE",
        requestId: message.requestId,
        geometry: {
          x: parentGeometry.x + frameRect.x,
          y: parentGeometry.y + frameRect.y,
          viewportWidth: parentGeometry.viewportWidth,
          viewportHeight: parentGeometry.viewportHeight
        }
      },
      "*"
    );
    return;
  }

  if (message.type === "WEBSTEP_FRAME_GEOMETRY_RESPONSE") {
    const pending = frameGeometryRequests.get(message.requestId);

    if (!pending) {
      return;
    }

    frameGeometryRequests.delete(message.requestId);
    pending.resolve(message.geometry);
  }
}

function requestFrameGeometry() {
  if (window === window.top) {
    frameGeometry = {
      x: 0,
      y: 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      ready: true
    };
    return Promise.resolve(frameGeometry);
  }

  const requestId = createRequestId();

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      frameGeometryRequests.delete(requestId);
      resolve(frameGeometry);
    }, 300);

    frameGeometryRequests.set(requestId, {
      resolve: (geometry) => {
        clearTimeout(timeoutId);
        frameGeometry = {
          ...geometry,
          ready: true
        };
        resolve(frameGeometry);
      }
    });

    window.parent.postMessage(
      {
        webstep: true,
        type: "WEBSTEP_FRAME_GEOMETRY_REQUEST",
        requestId
      },
      "*"
    );
  });
}

function getFrameOffset() {
  return { x: frameGeometry.x, y: frameGeometry.y };
}

function getTopViewportSize() {
  return {
    width: frameGeometry.viewportWidth,
    height: frameGeometry.viewportHeight
  };
}

function getViewportRect(element) {
  const rect = element.getBoundingClientRect();
  const frameOffset = getFrameOffset();
  const topViewport = getTopViewportSize();

  return {
    x: rect.x + frameOffset.x,
    y: rect.y + frameOffset.y,
    width: rect.width,
    height: rect.height,
    viewportWidth: topViewport.width,
    viewportHeight: topViewport.height
  };
}

function isElementVisibleEnough(element) {
  const rect = element.getBoundingClientRect();

  return rect.width >= 2 && rect.height >= 2;
}

function isGenericElement(element) {
  return GENERIC_TAGS.has(element.tagName);
}

function isLargeGenericElement(element) {
  const rect = element.getBoundingClientRect();
  const widthRatio = rect.width / Math.max(window.innerWidth, 1);
  const heightRatio = rect.height / Math.max(window.innerHeight, 1);

  if (IGNORED_CONTAINER_TAGS.has(element.tagName)) {
    return true;
  }

  if (
    isGenericElement(element) &&
    (widthRatio > MAX_GENERIC_WIDTH_RATIO ||
      heightRatio > MAX_GENERIC_HEIGHT_RATIO ||
      getAreaRatio(rect) > MAX_GENERIC_AREA_RATIO)
  ) {
    return true;
  }

  return false;
}

function getElementMetrics(element) {
  const rect = element.getBoundingClientRect();

  return {
    rect,
    widthRatio: rect.width / Math.max(window.innerWidth, 1),
    heightRatio: rect.height / Math.max(window.innerHeight, 1),
    areaRatio: getAreaRatio(rect)
  };
}

function getComposedElementPath(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const elements = path.filter((item) => item instanceof Element);

  if (elements.length > 0) {
    return elements;
  }

  return event.target instanceof Element ? [event.target] : [];
}

function isPrimarySemanticElement(element) {
  if (!SEMANTIC_TAGS.has(element.tagName)) {
    return false;
  }

  if (element.tagName === "A") {
    return element.hasAttribute("href");
  }

  return true;
}

function getTabIndex(element) {
  const tabIndex = Number(element.getAttribute("tabindex"));

  return Number.isNaN(tabIndex) ? null : tabIndex;
}

function getCandidateScore(element, depth) {
  const tagName = element.tagName;
  const role = getAttributeText(element, "role").toLowerCase();
  const className = getClassName(element);
  const label = getTargetLabel(element);
  const style = window.getComputedStyle(element);
  const tabIndex = getTabIndex(element);
  const metrics = getElementMetrics(element);
  const reasons = [];
  let score = 0;
  let ignoredReason = "";

  if (IGNORED_CONTAINER_TAGS.has(tagName)) {
    return { element, score: -Infinity, label, role, className, cursor: style.cursor, metrics, reasons, ignoredReason: "page container" };
  }

  if (!isElementVisibleEnough(element)) {
    return { element, score: -Infinity, label, role, className, cursor: style.cursor, metrics, reasons, ignoredReason: "too small or hidden" };
  }

  if (isPrimarySemanticElement(element)) {
    score += 100;
    reasons.push("primary semantic");
  }

  if (INTERACTIVE_ROLES.has(role)) {
    score += 85;
    reasons.push(`role=${role}`);
  }

  if (style.cursor === "pointer") {
    score += 35;
    reasons.push("cursor pointer");
  }

  if (tabIndex !== null && tabIndex >= 0) {
    score += 25;
    reasons.push("tabindex");
  }

  if (getAttributeText(element, "aria-label")) {
    score += 25;
    reasons.push("aria-label");
  }

  if (getAttributeText(element, "title")) {
    score += 18;
    reasons.push("title");
  }

  if (label) {
    score += label.length <= 20 ? 24 : 12;
    reasons.push("label");
  }

  if (CLASS_HINT_PATTERN.test(className)) {
    score += 14;
    reasons.push("class hint");
  }

  if (element.hasAttribute("onclick")) {
    score += 18;
    reasons.push("onclick");
  }

  if (VISUAL_INNER_TAGS.has(tagName) && !INTERACTIVE_ROLES.has(role)) {
    score -= 35;
    reasons.push("visual inner penalty");
  }

  score -= depth * 3;

  if (isGenericElement(element)) {
    if (
      metrics.widthRatio > MAX_GENERIC_WIDTH_RATIO ||
      metrics.heightRatio > MAX_GENERIC_HEIGHT_RATIO ||
      metrics.areaRatio > MAX_GENERIC_AREA_RATIO
    ) {
      score -= 120;
      ignoredReason = "large generic element";
      reasons.push("large generic penalty");
    }

    const hasStrongGenericSignal =
      style.cursor === "pointer" ||
      (tabIndex !== null && tabIndex >= 0) ||
      getAttributeText(element, "aria-label") ||
      getAttributeText(element, "title") ||
      INTERACTIVE_ROLES.has(role);

    if (!hasStrongGenericSignal && !label) {
      score -= 60;
      ignoredReason = "generic without interaction signal";
      reasons.push("weak generic");
    }
  }

  return { element, score, label, role, className, cursor: style.cursor, metrics, reasons, ignoredReason };
}

function shouldPreferCandidate(candidate, selected) {
  if (!selected) {
    return true;
  }

  if (candidate.score !== selected.score) {
    return candidate.score > selected.score;
  }

  const candidateArea = candidate.metrics.areaRatio;
  const selectedArea = selected.metrics.areaRatio;

  return candidateArea < selectedArea;
}

function preferLinkForLowQualityTarget(selected, candidates) {
  if (!selected || !isLowQualityLabel(selected.label)) {
    return selected;
  }

  const linkCandidate = candidates.find((candidate) => {
    const element = candidate.element;
    return element instanceof HTMLElement && element.tagName === "A" && element.hasAttribute("href");
  });

  return linkCandidate || selected;
}

function debugTargetSelection(rawTarget, candidates, selected, classification) {
  const summarizeElement = (element) => {
    if (!(element instanceof Element)) {
      return "";
    }

    return {
      tag: element.tagName,
      id: element.id || "",
      className: getClassName(element),
      role: getAttributeText(element, "role"),
      inputType: getInputType(element)
    };
  };

  console.groupCollapsed("WebStep target debug");
  console.log("rawTarget:", summarizeElement(rawTarget));
  console.table(
    candidates.map((candidate, index) => ({
      index,
      tag: candidate.element.tagName,
      text: candidate.label,
      class: candidate.className,
      role: candidate.role,
      cursor: candidate.cursor,
      width: Math.round(candidate.metrics.rect.width),
      height: Math.round(candidate.metrics.rect.height),
      score: candidate.score,
      ignoredReason: candidate.ignoredReason,
      reasons: candidate.reasons.join(", ")
    }))
  );
  console.log("selectedTarget:", selected ? summarizeElement(selected.element) : null);
  console.log("elementType:", classification ? classification.elementType : "");
  console.log("eventType:", classification ? classification.eventContext : "");
  console.log("actionType:", classification ? classification.actionType : "");
  console.log("classificationReason:", classification ? classification.reason : "");
  console.groupEnd();
}

function debugAction(interaction, eventType) {
  console.groupCollapsed("WebStep action debug");
  console.log("resolvedTarget:", {
    tag: interaction.tagName,
    id: interaction.id,
    className: interaction.className,
    role: interaction.role,
    inputType: interaction.inputType
  });
  console.log("elementType:", interaction.elementType);
  console.log("eventType:", eventType);
  console.log("actionType:", interaction.actionType);
  console.log("classificationReason:", interaction.classificationReason);
  console.groupEnd();
}

function resolveTarget(event) {
  const path = getComposedElementPath(event);
  const candidates = path
    .filter((element) => element instanceof HTMLElement || element instanceof SVGElement)
    .map((element, index) => getCandidateScore(element, index));
  const validCandidates = candidates.filter((candidate) => candidate.score >= MIN_TARGET_SCORE);
  const scoredSelected = validCandidates.reduce((best, candidate) => {
    return shouldPreferCandidate(candidate, best) ? candidate : best;
  }, null);
  const selected = preferLinkForLowQualityTarget(scoredSelected, candidates);

  return {
    rawTarget: event.target,
    target: selected ? selected.element : null,
    candidates,
    selected
  };
}

function createElementSnapshot(element, interactionId, eventContext = "click") {
  const rect = getViewportRect(element);
  const classification = classifyAction(element, eventContext);
  const label = getTargetLabel(element);
  const isInputLike = element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
  const fieldLabel = isInputLike ? getFieldLabel(element) : "";
  const sensitiveKind = isInputLike ? getSensitiveKind(element) : "";

  return {
    actionType: classification.actionType,
    elementType: classification.elementType,
    classificationReason: classification.reason,
    tagName: element.tagName,
    label,
    fieldLabel,
    sensitiveKind,
    text: label,
    id: element.id || "",
    className: getClassName(element),
    role: getAttributeText(element, "role"),
    inputType: getInputType(element),
    href: getElementHref(element),
    placeholder: getAttributeText(element, "placeholder"),
    ariaLabel: getAttributeText(element, "aria-label"),
    title: getAttributeText(element, "title"),
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    viewportWidth: rect.viewportWidth,
    viewportHeight: rect.viewportHeight,
    interactionId
  };
}

function createStep(interaction) {
  return {
    url: interaction.url || window.location.href,
    pageTitle: interaction.pageTitle || document.title,
    actionType: interaction.actionType,
    elementType: interaction.elementType,
    classificationReason: interaction.classificationReason,
    tagName: interaction.tagName,
    label: interaction.label,
    fieldLabel: interaction.fieldLabel,
    sensitiveKind: interaction.sensitiveKind,
    text: interaction.text,
    id: interaction.id,
    className: interaction.className,
    role: interaction.role,
    inputType: interaction.inputType,
    href: interaction.href,
    placeholder: interaction.placeholder,
    ariaLabel: interaction.ariaLabel,
    title: interaction.title,
    x: interaction.x,
    y: interaction.y,
    width: interaction.width,
    height: interaction.height,
    viewportWidth: interaction.viewportWidth,
    viewportHeight: interaction.viewportHeight,
    rectSource: interaction.rectSource,
    timestamp: interaction.timestamp || Date.now(),
    screenshot: "",
    screenshotId: "",
    interactionId: interaction.interactionId
  };
}

async function sendSaveStep(interaction) {
  const step = createStep(interaction);

  await safeSendMessage({
    type: "WEBSTEP_SAVE_STEP",
    interactionId: interaction.interactionId,
    step
  }, "save step");
}

function isTextInputElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.tagName === "TEXTAREA") {
    return true;
  }

  if (element.tagName === "INPUT") {
    return TEXT_INPUT_TYPES.has(getInputType(element));
  }

  if (!element.isContentEditable) {
    return false;
  }

  const role = getAttributeText(element, "role").toLowerCase();
  const tagName = element.tagName;
  const rect = element.getBoundingClientRect();
  const isLargeEditable =
    rect.width / Math.max(window.innerWidth, 1) > 0.55 ||
    rect.height / Math.max(window.innerHeight, 1) > 0.25 ||
    (rect.width * rect.height) / Math.max(window.innerWidth * window.innerHeight, 1) > 0.16;

  if (tagName === "A" || tagName === "BUTTON" || INTERACTIVE_ROLES.has(role)) {
    return false;
  }

  if (isLargeEditable) {
    return false;
  }

  return role === "textbox" || role === "searchbox" || element.getAttribute("contenteditable") === "plaintext-only";
}

function getActiveTextInputElement() {
  let activeElement = document.activeElement;

  while (activeElement && activeElement.shadowRoot && activeElement.shadowRoot.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }

  return isTextInputElement(activeElement) ? activeElement : null;
}

function collectTextInputElements(root, elements = []) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return elements;
  }

  root.querySelectorAll("input, textarea, [contenteditable]").forEach((element) => {
    if (isTextInputElement(element)) {
      elements.push(element);
    }
  });

  root.querySelectorAll("*").forEach((element) => {
    if (element.shadowRoot) {
      collectTextInputElements(element.shadowRoot, elements);
    }
  });

  return elements;
}

function getTextInputElements() {
  return collectTextInputElements(document)
    .filter((element) => isElementVisibleEnough(element));
}

function isSameInputElement(target, inputElement) {
  return target === inputElement || (target instanceof Node && inputElement && inputElement.contains(target));
}

function getEditableValueLength(element) {
  if (!(element instanceof HTMLElement)) {
    return 0;
  }

  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    return typeof element.value === "string" ? element.value.length : 0;
  }

  if (element.isContentEditable) {
    return (element.innerText || element.textContent || "").length;
  }

  return 0;
}

function shouldPreCaptureShortCodeInput(element, interaction, valueLength) {
  if (!(element instanceof HTMLInputElement)) {
    return false;
  }

  const maxLength = Number(element.maxLength || 0);

  if (maxLength <= 0 || maxLength > 8 || valueLength < maxLength) {
    return false;
  }

  const inputHints = [
    interaction.fieldLabel,
    getAttributeText(element, "placeholder"),
    getAttributeText(element, "aria-label"),
    getAttributeText(element, "name"),
    getAttributeText(element, "id"),
    getAttributeText(element, "autocomplete"),
    getAttributeText(element, "inputmode")
  ].join(" ").toLowerCase();

  return /验证码|校验码|短信|动态码|code|captcha|otp|one-time-code/.test(inputHints);
}

function createInputInteraction(element) {
  const interactionId = createInteractionId();
  const snapshot = createElementSnapshot(element, interactionId, "input");

  return {
    ...snapshot,
    label: "",
    text: "",
    fieldLabel: getFieldLabel(element),
    sensitiveKind: getSensitiveKind(element),
    initialValueLength: getEditableValueLength(element),
    lastValueLength: getEditableValueLength(element),
    hasUserInput: false,
    url: window.location.href,
    pageTitle: document.title,
    createdAt: Date.now(),
    timestamp: Date.now()
  };
}

function updateInteractionRectFromElement(interaction, element) {
  if (!(element instanceof Element) || !document.contains(element)) {
    interaction.rectSource = "fallback";
    return;
  }

  const rect = getViewportRect(element);

  interaction.x = Math.round(rect.x);
  interaction.y = Math.round(rect.y);
  interaction.width = Math.round(rect.width);
  interaction.height = Math.round(rect.height);
  interaction.viewportWidth = rect.viewportWidth;
  interaction.viewportHeight = rect.viewportHeight;
  interaction.rectSource = "flush";
}

function debugInputRect(interaction, element) {
  console.groupCollapsed("WebStep input rect debug");
  console.log("input element:", element instanceof Element ? {
    tagName: element.tagName,
    id: element.id || "",
    className: getClassName(element),
    placeholder: getAttributeText(element, "placeholder")
  } : null);
  console.log("input rect:", {
    x: interaction.x,
    y: interaction.y,
    width: interaction.width,
    height: interaction.height,
    source: interaction.rectSource || "initial"
  });
  console.log("viewport:", {
    width: interaction.viewportWidth,
    height: interaction.viewportHeight
  });
  console.log("screenshot moment:", Date.now());
  console.log("step saved rect:", {
    x: interaction.x,
    y: interaction.y,
    width: interaction.width,
    height: interaction.height
  });
  console.groupEnd();
}

function createSelectInteraction(element) {
  const interactionId = createInteractionId();
  const snapshot = createElementSnapshot(element, interactionId, "select");
  const selectedOption = element.options ? element.options[element.selectedIndex] : null;
  const label = selectedOption ? cleanText(selectedOption.textContent || "") : snapshot.label;

  return {
    ...snapshot,
    actionType: ACTION_TYPES.SELECT_OPTION,
    label,
    text: label,
    fieldLabel: getFieldLabel(element),
    createdAt: Date.now(),
    timestamp: Date.now()
  };
}

function scheduleInputSave(interaction) {
  clearTimeout(interaction.timerId);
  interaction.timerId = setTimeout(() => {
    if (pendingInput === interaction) {
      interaction.isIdle = true;
    }
  }, INPUT_DEBOUNCE_DELAY);
}

function requestInputScreenshot(interaction, options = {}) {
  if (interaction.captureReady && !options.refresh) {
    return interaction.captureReady;
  }

  interaction.url = interaction.url || window.location.href;
  interaction.pageTitle = interaction.pageTitle || document.title;
  interaction.captureExpectedUrl = interaction.url;
  interaction.captureReady = safeSendMessage({
    type: "WEBSTEP_CAPTURE_SCREENSHOT",
    interactionId: interaction.interactionId,
    allowAfterStop: true,
    requireSameUrl: true,
    expectedUrl: interaction.captureExpectedUrl
  }, "input screenshot capture");

  return interaction.captureReady;
}

function scheduleInputScreenshotRefresh(interaction) {
  clearTimeout(interaction.captureTimerId);

  interaction.captureTimerId = window.setTimeout(() => {
    if (interaction.isSaved || pendingInput !== interaction) {
      return;
    }

    updateInteractionRectFromElement(interaction, interaction.sourceElement);
    requestInputScreenshot(interaction, { refresh: true });
  }, INPUT_SCREENSHOT_REFRESH_DELAY);
}

function hasInputValueAlreadyChanged(reason) {
  return reason === "input" || reason === "keyup-value-change" || reason === "compositionend";
}

async function finalizeInputStep(interaction) {
  if (interaction.isSaved) {
    return;
  }

  if (!interaction.hasUserInput && interaction.lastValueLength === interaction.initialValueLength) {
    clearTimeout(interaction.timerId);
    interaction.isSaved = true;
    return;
  }

  interaction.isSaved = true;
  clearTimeout(interaction.captureTimerId);
  await requestFrameGeometry();
  updateInteractionRectFromElement(interaction, interaction.sourceElement);
  debugInputRect(interaction, interaction.sourceElement);
  debugAction(interaction, "input");
  await requestInputScreenshot(interaction);
  await sendSaveStep(interaction);
  console.log("WebStep input step saved", {
    interactionId: interaction.interactionId,
    actionType: interaction.actionType,
    fieldLabel: interaction.fieldLabel,
    rectSource: interaction.rectSource
  });
}

function flushInputStep() {
  if (!pendingInput) {
    return Promise.resolve();
  }

  clearTimeout(pendingInput.timerId);
  clearTimeout(pendingInput.captureTimerId);
  const interaction = pendingInput;
  pendingInput = null;
  return finalizeInputStep(interaction);
}

function ensureInputSession(element) {
  if (!observedInputLengths.has(element)) {
    observedInputLengths.set(element, getEditableValueLength(element));
  }

  if (!pendingInput || pendingInput.sourceElement !== element) {
    flushInputStep();

    const interaction = createInputInteraction(element);
    interaction.sourceElement = element;
    interaction.isIdle = false;
    interaction.isSaved = false;
    pendingInput = interaction;
  } else {
    pendingInput.isIdle = false;
  }

  return pendingInput;
}

function markInputActivity(element, reason) {
  if (!isRecording || !isTextInputElement(element)) {
    return;
  }

  const interaction = ensureInputSession(element);
  const valueLength = getEditableValueLength(element);

  interaction.lastValueLength = valueLength;
  observedInputLengths.set(element, valueLength);
  interaction.hasUserInput = interaction.hasUserInput || reason !== "focus" || valueLength !== interaction.initialValueLength;
  interaction.timestamp = Date.now();
  scheduleInputSave(interaction);

  if (interaction.hasUserInput && hasInputValueAlreadyChanged(reason)) {
    if (!interaction.captureReady) {
      updateInteractionRectFromElement(interaction, element);
      requestInputScreenshot(interaction);
    }

    scheduleInputScreenshotRefresh(interaction);
  }

  if (interaction.hasUserInput && shouldPreCaptureShortCodeInput(element, interaction, valueLength)) {
    updateInteractionRectFromElement(interaction, element);
    requestInputScreenshot(interaction, { refresh: true });
  }

  console.log("WebStep input activity debug", {
    reason,
    tagName: element.tagName,
    id: element.id || "",
    className: getClassName(element),
    placeholder: getAttributeText(element, "placeholder"),
    hasUserInput: interaction.hasUserInput,
    initialValueLength: interaction.initialValueLength,
    lastValueLength: interaction.lastValueLength
  });
}

function pollInputValueChanges() {
  if (!isRecording) {
    return;
  }

  getTextInputElements().forEach((element) => {
    const valueLength = getEditableValueLength(element);

    if (!observedInputLengths.has(element)) {
      observedInputLengths.set(element, valueLength);
      return;
    }

    if (observedInputLengths.get(element) !== valueLength) {
      observedInputLengths.set(element, valueLength);
    }
  });
}

function startInputPolling() {
  if (inputPollingTimerId !== null) {
    return;
  }

  console.log("WebStep input polling started", {
    inputCount: getTextInputElements().length
  });
  pollInputValueChanges();
  inputPollingTimerId = window.setInterval(pollInputValueChanges, INPUT_POLL_INTERVAL);
}

function stopInputPolling() {
  if (inputPollingTimerId === null) {
    return;
  }

  window.clearInterval(inputPollingTimerId);
  inputPollingTimerId = null;
}

function handleInputFocus(event) {
  if (!isRecording || !isTextInputElement(event.target)) {
    return;
  }

  ensureInputSession(event.target);
}

function syncActiveInputSession(reason) {
  if (!isRecording) {
    return;
  }

  const activeInput = getActiveTextInputElement();

  if (!activeInput) {
    return;
  }

  const interaction = ensureInputSession(activeInput);
  const valueLength = getEditableValueLength(activeInput);

  interaction.lastValueLength = valueLength;
  interaction.timestamp = Date.now();

  console.log("WebStep active input sync debug", {
    reason,
    tagName: activeInput.tagName,
    id: activeInput.id || "",
    className: getClassName(activeInput),
    placeholder: getAttributeText(activeInput, "placeholder"),
    hasUserInput: interaction.hasUserInput,
    initialValueLength: interaction.initialValueLength,
    lastValueLength: interaction.lastValueLength
  });
}

function handleBeforeInput(event) {
  if (!event.isTrusted) {
    return;
  }

  markInputActivity(event.target, "beforeinput");
}

function handleInput(event) {
  if (!event.isTrusted) {
    return;
  }

  markInputActivity(event.target, "input");
}

function handleKeyUp(event) {
  if (!event.isTrusted) {
    return;
  }

  const target = isTextInputElement(event.target) ? event.target : getActiveTextInputElement();

  if (!target) {
    return;
  }

  const currentLength = getEditableValueLength(target);

  if (pendingInput && pendingInput.sourceElement === target && currentLength !== pendingInput.lastValueLength) {
    markInputActivity(target, "keyup-value-change");
  }
}

function handleInputDone(event) {
  if (pendingInput && pendingInput.sourceElement === event.target) {
    pendingInput.lastValueLength = getEditableValueLength(event.target);
    flushInputStep();
  }
}

function handleKeyDown(event) {
  if (!event.isTrusted) {
    return;
  }

  if (event.key === "Enter" && pendingInput && pendingInput.sourceElement === event.target) {
    pendingInput.lastValueLength = getEditableValueLength(event.target);
    pendingInput.hasUserInput = true;
    updateInteractionRectFromElement(pendingInput, pendingInput.sourceElement);
    requestInputScreenshot(pendingInput, { refresh: true });
    flushInputStep();
    return;
  }

  const target = isTextInputElement(event.target) ? event.target : getActiveTextInputElement();

  if (!isRecording || !target) {
    return;
  }

  if (
    event.key.length === 1 ||
    event.key === "Backspace" ||
    event.key === "Delete" ||
    event.key === "Paste"
  ) {
    const interaction = ensureInputSession(target);
    interaction.hasUserInput = true;
    interaction.timestamp = Date.now();
    scheduleInputSave(interaction);
  }
}

function handleCompositionEnd(event) {
  if (!event.isTrusted) {
    return;
  }

  markInputActivity(event.target, "compositionend");
}

function handlePaste(event) {
  if (!event.isTrusted) {
    return;
  }

  markInputActivity(event.target, "paste");
}

function handleInputDoneFromChange(event) {
  if (!event.isTrusted) {
    return false;
  }

  if (!isTextInputElement(event.target)) {
    return false;
  }

  handleInputDone(event);
  return true;
}

function handleInputFallbackBeforeClick(event) {
  if (pendingInput && !isSameInputElement(event.target, pendingInput.sourceElement)) {
    pendingInput.lastValueLength = getEditableValueLength(pendingInput.sourceElement);
    updateInteractionRectFromElement(pendingInput, pendingInput.sourceElement);
    requestInputScreenshot(pendingInput, { refresh: true });
    flushInputStep();
  }
}

function refreshPendingInputBeforeStop() {
  syncActiveInputSession("before-stop");

  if (!pendingInput) {
    return;
  }

  pendingInput.lastValueLength = getEditableValueLength(pendingInput.sourceElement);
  updateInteractionRectFromElement(pendingInput, pendingInput.sourceElement);
  requestInputScreenshot(pendingInput, { refresh: true });
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    if (pendingInput) {
      pendingInput.lastValueLength = getEditableValueLength(pendingInput.sourceElement);
      updateInteractionRectFromElement(pendingInput, pendingInput.sourceElement);
      requestInputScreenshot(pendingInput, { refresh: true });
    }
    flushInputStep();
  }
}

async function handleChange(event) {
  if (!isRecording) {
    return;
  }

  if (handleInputDoneFromChange(event)) {
    return;
  }

  if (event.target instanceof HTMLSelectElement) {
    const interaction = createSelectInteraction(event.target);

    await safeSendMessage({
      type: "WEBSTEP_CAPTURE_SCREENSHOT",
      interactionId: interaction.interactionId
    }, "select screenshot capture");
    await sendSaveStep(interaction);
  }
}

async function handlePointerDown(event) {
  if (!isRecording) {
    return;
  }

  if (event.button !== 0) {
    return;
  }

  handleInputFallbackBeforeClick(event);
  window.setTimeout(() => syncActiveInputSession("post-pointerdown"), 0);
  window.setTimeout(() => syncActiveInputSession("post-pointerdown-delayed"), 120);

  const resolved = resolveTarget(event);
  const target = resolved.target;

  if (!target) {
    debugTargetSelection(event.target, resolved.candidates, resolved.selected, null);
    pendingInteraction = null;
    return;
  }

  await requestFrameGeometry();

  if (!isRecording) {
    return;
  }

  const interactionId = createInteractionId();
  const snapshot = createElementSnapshot(target, interactionId, "click");
  debugTargetSelection(event.target, resolved.candidates, resolved.selected, {
    actionType: snapshot.actionType,
    elementType: snapshot.elementType,
    eventContext: "click",
    reason: snapshot.classificationReason
  });
  pendingInteraction = {
    ...snapshot,
    createdAt: Date.now(),
    timestamp: Date.now(),
    pointerId: event.pointerId,
    button: event.button,
    captureReady: safeSendMessage({
      type: "WEBSTEP_CAPTURE_SCREENSHOT",
      interactionId,
      requireSameUrl: true,
      expectedUrl: window.location.href
    }, "click screenshot capture")
  };
}

async function handlePageClick(event) {
  if (!isRecording) {
    return;
  }

  const interaction = pendingInteraction;
  pendingInteraction = null;

  if (!interaction || Date.now() - interaction.createdAt > 3000) {
    return;
  }

  await interaction.captureReady;
  await sendSaveStep(interaction);
}

function clearPendingInteraction() {
  pendingInteraction = null;
}

chrome.storage.local.get({ recording: false }).then((result) => {
  isRecording = result.recording;
  if (isRecording) {
    startInputPolling();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.recording) {
    return;
  }

  const nextRecording = changes.recording.newValue;

  if (nextRecording) {
    isRecording = true;
    startInputPolling();
    return;
  }

  pendingInteraction = null;
  refreshPendingInputBeforeStop();
  flushInputStep();
  stopInputPolling();
  isRecording = false;
});

document.addEventListener("pointerdown", handlePointerDown, true);
document.addEventListener("pointercancel", clearPendingInteraction, true);
document.addEventListener("click", handlePageClick, true);
document.addEventListener("focusin", handleInputFocus, true);
document.addEventListener("beforeinput", handleBeforeInput, true);
document.addEventListener("input", handleInput, true);
document.addEventListener("change", handleChange, true);
document.addEventListener("blur", handleInputDone, true);
document.addEventListener("keydown", handleKeyDown, true);
document.addEventListener("keyup", handleKeyUp, true);
document.addEventListener("paste", handlePaste, true);
document.addEventListener("compositionend", handleCompositionEnd, true);
document.addEventListener("visibilitychange", handleVisibilityChange);
window.addEventListener("message", handleFrameGeometryMessage);
window.addEventListener("resize", requestFrameGeometry);
window.addEventListener("beforeunload", flushInputStep);
window.addEventListener("pagehide", flushInputStep);
requestFrameGeometry();
