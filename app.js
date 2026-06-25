(function () {
  "use strict";

  const STORAGE_KEY = "script-editor-project-v1";
  const UI_STORAGE_KEY = "script-editor-ui-v1";
  const SPEAKER_DRAG_TYPE = "application/x-script-speaker-name";
  const TYPE_LABELS = {
    dialogue: "会話",
    direction: "ト書き",
    sfx: "効果音",
    bgm: "BGM",
  };
  const PALETTE = [
    "#7c3aed",
    "#2563eb",
    "#16a34a",
    "#f97316",
    "#dc2626",
    "#0891b2",
    "#be185d",
    "#4f46e5",
    "#65a30d",
    "#d97706",
  ];
  const SPECIAL_SPEAKERS = new Map([
    ["ナレーション", { color: "#9b5de5", type: "direction" }],
    ["ト書き", { color: "#64748b", type: "direction" }],
    ["効果音", { color: "#f97316", type: "sfx" }],
    ["SE", { color: "#f97316", type: "sfx" }],
    ["SFX", { color: "#f97316", type: "sfx" }],
    ["BGM", { color: "#8b5cf6", type: "bgm" }],
  ]);

  const els = {};
  let project = createDefaultProject();
  let activeSectionId = project.sections[0].id;
  let selectedScope = "all";
  let matches = [];
  let currentMatchIndex = -1;
  let speakerPicker = null;
  let selectedLineIds = new Set();
  let lineSelectionAnchorId = "";
  let lineClipboard = [];
  let focusedLineId = "";
  let bodySelection = null;
  let bodySelectionRange = null;
  let suppressBodyFocusScroll = false;
  let hasPendingSave = false;
  let saveTimer = 0;
  let renderTimer = 0;
  let compactSidebarQuery = null;
  let narrowSidebarQuery = null;
  let speakerDrawerOpen = false;
  let settingsDrawerOpen = false;
  let uiState = {
    speakerPaneVisible: true,
    settingsPaneVisible: true,
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    project = loadProject();
    uiState = loadUiState();
    activeSectionId = project.activeSectionId || project.sections[0].id;
    bindEvents();
    applySidebarVisibility();
    normalizeProject();
    renderAll();
    updateBodyColorButton();
    setSaveState("LocalStorageに自動保存済み");
  }

  function cacheElements() {
    els.projectTitle = document.getElementById("projectTitle");
    els.saveState = document.getElementById("saveState");
    els.sectionTabs = document.getElementById("sectionTabs");
    els.addSectionButton = document.getElementById("addSectionButton");
    els.scriptRows = document.getElementById("scriptRows");
    els.settingsPane = document.querySelector(".settings-pane");
    els.addLineButton = document.getElementById("addLineButton");
    els.bodyBoldButton = document.getElementById("bodyBoldButton");
    els.bodyColorApplyButton = document.getElementById("bodyColorApplyButton");
    els.bodyColorInput = document.getElementById("bodyColorInput");
    els.bodyColorClearButton = document.getElementById("bodyColorClearButton");
    els.formatStatus = document.getElementById("formatStatus");
    els.selectedLineStatus = document.getElementById("selectedLineStatus");
    els.clearSelectedLinesButton = document.getElementById("clearSelectedLinesButton");
    els.copyLinesButton = document.getElementById("copyLinesButton");
    els.cutLinesButton = document.getElementById("cutLinesButton");
    els.pasteLinesButton = document.getElementById("pasteLinesButton");
    els.toggleSpeakerPaneButton = document.getElementById("toggleSpeakerPaneButton");
    els.toggleSettingsPaneButton = document.getElementById("toggleSettingsPaneButton");
    els.newProjectButton = document.getElementById("newProjectButton");
    els.saveJsonButton = document.getElementById("saveJsonButton");
    els.loadJsonInput = document.getElementById("loadJsonInput");
    els.exportTxtButton = document.getElementById("exportTxtButton");
    els.exportDocxButton = document.getElementById("exportDocxButton");
    els.searchInput = document.getElementById("searchInput");
    els.replaceInput = document.getElementById("replaceInput");
    els.prevMatchButton = document.getElementById("prevMatchButton");
    els.nextMatchButton = document.getElementById("nextMatchButton");
    els.replaceOneButton = document.getElementById("replaceOneButton");
    els.replaceAllButton = document.getElementById("replaceAllButton");
    els.matchStatus = document.getElementById("matchStatus");
    els.totalBodyChars = document.getElementById("totalBodyChars");
    els.sectionBodyChars = document.getElementById("sectionBodyChars");
    els.speakerForm = document.getElementById("speakerForm");
    els.speakerNameInput = document.getElementById("speakerNameInput");
    els.speakerColorInput = document.getElementById("speakerColorInput");
    els.speakerBodyColorInput = document.getElementById("speakerBodyColorInput");
    els.speakerList = document.getElementById("speakerList");
    els.exportBlankLineInput = document.getElementById("exportBlankLineInput");
    els.copyGoogleDocsButton = document.getElementById("copyGoogleDocsButton");
    els.copySelectedGoogleDocsButton = document.getElementById("copySelectedGoogleDocsButton");
    els.googleDocsCopyStatus = document.getElementById("googleDocsCopyStatus");
    els.googleDocsPreview = document.getElementById("googleDocsPreview");
  }

  function bindEvents() {
    compactSidebarQuery = window.matchMedia("(max-width: 1440px)");
    narrowSidebarQuery = window.matchMedia("(max-width: 900px)");
    compactSidebarQuery.addEventListener("change", handleCompactSidebarChange);
    narrowSidebarQuery.addEventListener("change", handleCompactSidebarChange);
    document.addEventListener("click", (event) => {
      if (
        speakerDrawerOpen &&
        isNarrowSpeakerDrawerMode() &&
        !document.querySelector(".speaker-pane").contains(event.target) &&
        !els.toggleSpeakerPaneButton.contains(event.target)
      ) {
        speakerDrawerOpen = false;
        applySidebarVisibility();
      }
      if (
        settingsDrawerOpen &&
        isCompactSidebarMode() &&
        !els.settingsPane.contains(event.target) &&
        !els.toggleSettingsPaneButton.contains(event.target)
      ) {
        settingsDrawerOpen = false;
        applySidebarVisibility();
      }
      if (!speakerPicker) return;
      if (speakerPicker.element.contains(event.target) || speakerPicker.input === event.target) return;
      hideSpeakerPicker();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideSpeakerPicker();
      if (event.key === "Escape" && speakerDrawerOpen && isNarrowSpeakerDrawerMode()) {
        speakerDrawerOpen = false;
        applySidebarVisibility();
      }
      if (event.key === "Escape" && settingsDrawerOpen && isCompactSidebarMode()) {
        settingsDrawerOpen = false;
        applySidebarVisibility();
      }
    });
    document.addEventListener("selectionchange", updateBodySelectionFromDocument);
    window.addEventListener("resize", hideSpeakerPicker);
    window.addEventListener("scroll", hideSpeakerPicker, true);
    window.addEventListener("beforeunload", flushPendingSave);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushPendingSave();
    });

    els.projectTitle.addEventListener("focus", flushPendingSave);
    els.projectTitle.addEventListener("input", () => {
      project.title = cleanProjectTitle(els.projectTitle.value);
      markSavePending();
    });
    els.projectTitle.addEventListener("blur", flushPendingSave);

    els.addSectionButton.addEventListener("click", addSection);
    els.addLineButton.addEventListener("click", () => {
      addLineAfter(getActiveSection().lines.length - 1);
    });
    els.clearSelectedLinesButton.addEventListener("click", clearLineSelection);
    els.copyLinesButton.addEventListener("click", copySelectedLines);
    els.cutLinesButton.addEventListener("click", cutSelectedLines);
    els.pasteLinesButton.addEventListener("click", pasteCopiedLines);
    els.toggleSpeakerPaneButton.addEventListener("click", () => {
      if (isNarrowSpeakerDrawerMode()) {
        speakerDrawerOpen = !speakerDrawerOpen;
        hideSpeakerPicker();
        applySidebarVisibility();
        return;
      }
      setSidebarVisibility("speaker", !uiState.speakerPaneVisible);
    });
    els.toggleSettingsPaneButton.addEventListener("click", () => {
      if (isCompactSidebarMode()) {
        settingsDrawerOpen = !settingsDrawerOpen;
        hideSpeakerPicker();
        applySidebarVisibility();
        return;
      }
      setSidebarVisibility("settings", !uiState.settingsPaneVisible);
    });
    els.speakerList.addEventListener("dragover", handleSpeakerListDragOver);
    els.speakerList.addEventListener("drop", handleSpeakerListDrop);
    els.speakerList.addEventListener("dragleave", (event) => {
      if (event.target === els.speakerList) clearAllSpeakerDropClasses();
    });
    window.scriptEditorApplyBodyBold = applyBodyBoldFromPointer;
    els.bodyColorApplyButton.addEventListener("mousedown", applyBodyColorFromPointer);
    els.bodyColorClearButton.addEventListener("mousedown", preserveBodySelectionForToolbar);
    els.bodyBoldButton.addEventListener("mousedown", applyBodyBoldFromPointer);
    els.bodyBoldButton.addEventListener("click", (event) => event.preventDefault());
    els.bodyColorApplyButton.addEventListener("click", (event) => event.preventDefault());
    els.bodyColorInput.addEventListener("mousedown", preserveBodySelectionForToolbar);
    els.bodyColorInput.addEventListener("input", () => {
      updateBodyColorButton();
      applyBodyMark({ color: els.bodyColorInput.value });
    });
    els.bodyColorInput.addEventListener("change", flushPendingSave);
    els.bodyColorClearButton.addEventListener("click", () => {
      applyBodyMark({ color: "" });
      flushPendingSave();
    });
    els.newProjectButton.addEventListener("click", () => {
      if (!confirm("現在の内容を破棄して新規作成しますか？")) return;
      project = createDefaultProject();
      activeSectionId = project.sections[0].id;
      selectedLineIds.clear();
      lineSelectionAnchorId = "";
      focusedLineId = "";
      renderAll();
      scheduleSave();
    });
    els.saveJsonButton.addEventListener("click", saveJson);
    els.loadJsonInput.addEventListener("change", loadJsonFile);
    els.exportTxtButton.addEventListener("click", exportTxt);
    els.exportDocxButton.addEventListener("click", exportDocx);
    els.exportBlankLineInput.addEventListener("change", () => {
      project.settings.exportBlankLineBetweenLines = els.exportBlankLineInput.checked;
      renderGoogleDocsPreview();
      scheduleSave();
    });
    els.copyGoogleDocsButton.addEventListener("click", copyGoogleDocsRichText);
    els.copySelectedGoogleDocsButton.addEventListener("click", copySelectedGoogleDocsRichText);

    els.searchInput.addEventListener("input", updateMatches);
    document.querySelectorAll(".scope-button").forEach((button) => {
      button.addEventListener("click", () => {
        selectedScope = button.dataset.scope;
        document.querySelectorAll(".scope-button").forEach((item) => {
          item.classList.toggle("active", item === button);
        });
        updateMatches();
      });
    });
    els.prevMatchButton.addEventListener("click", () => moveMatch(-1));
    els.nextMatchButton.addEventListener("click", () => moveMatch(1));
    els.replaceOneButton.addEventListener("click", replaceOne);
    els.replaceAllButton.addEventListener("click", replaceAll);

    els.speakerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = cleanSpeakerName(els.speakerNameInput.value);
      if (!name) return;
      ensureSpeaker(name, els.speakerColorInput.value, false, els.speakerBodyColorInput.value);
      els.speakerNameInput.value = "";
      renderAll();
      scheduleSave();
    });
  }

  function createDefaultProject() {
    const sectionId = makeId("section");
    return {
      title: "無題の台本",
      activeSectionId: sectionId,
      sections: [
        {
          id: sectionId,
          title: "01 オープニング",
          lines: [createLine()],
        },
      ],
      speakers: {},
      speakerOrder: [],
      settings: {
        exportBlankLineBetweenLines: false,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  function loadProject() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultProject();
      const parsed = JSON.parse(raw);
      return hydrateProject(parsed);
    } catch (error) {
      console.warn(error);
      return createDefaultProject();
    }
  }

  function loadUiState() {
    try {
      const raw = localStorage.getItem(UI_STORAGE_KEY);
      if (!raw) return { speakerPaneVisible: true, settingsPaneVisible: true };
      const parsed = JSON.parse(raw);
      return {
        speakerPaneVisible: parsed.speakerPaneVisible !== false,
        settingsPaneVisible: parsed.settingsPaneVisible !== false,
      };
    } catch (error) {
      console.warn(error);
      return { speakerPaneVisible: true, settingsPaneVisible: true };
    }
  }

  function saveUiState() {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(uiState));
  }

  function setSidebarVisibility(side, visible) {
    if (side === "speaker") uiState.speakerPaneVisible = Boolean(visible);
    if (side === "settings") uiState.settingsPaneVisible = Boolean(visible);
    hideSpeakerPicker();
    applySidebarVisibility();
    saveUiState();
  }

  function isCompactSidebarMode() {
    return compactSidebarQuery ? compactSidebarQuery.matches : window.innerWidth <= 1440;
  }

  function isNarrowSpeakerDrawerMode() {
    return narrowSidebarQuery ? narrowSidebarQuery.matches : window.innerWidth <= 900;
  }

  function handleCompactSidebarChange() {
    settingsDrawerOpen = false;
    speakerDrawerOpen = false;
    applySidebarVisibility();
  }

  function applySidebarVisibility() {
    const compactMode = isCompactSidebarMode();
    const speakerDrawerMode = isNarrowSpeakerDrawerMode();
    document.body.classList.toggle("sidebar-left-hidden", !speakerDrawerMode && !uiState.speakerPaneVisible);
    document.body.classList.toggle("sidebar-right-hidden", !compactMode && !uiState.settingsPaneVisible);
    document.body.classList.toggle("responsive-speaker-drawer", speakerDrawerMode);
    document.body.classList.toggle("speaker-drawer-open", speakerDrawerMode && speakerDrawerOpen);
    document.body.classList.toggle("responsive-settings-drawer", compactMode);
    document.body.classList.toggle("settings-drawer-open", compactMode && settingsDrawerOpen);
    updateSidebarToggleButton(els.toggleSpeakerPaneButton, speakerDrawerMode ? speakerDrawerOpen : uiState.speakerPaneVisible, "話者");
    updateSidebarToggleButton(els.toggleSettingsPaneButton, compactMode ? settingsDrawerOpen : uiState.settingsPaneVisible, "設定");
  }

  function updateSidebarToggleButton(button, visible, label) {
    if (!button) return;
    button.setAttribute("aria-pressed", String(visible));
    const action = visible ? "隠す" : "表示";
    button.title = `${label}サイドバーを${action}`;
    button.setAttribute("aria-label", `${label}サイドバーを${action}`);
  }

  function hydrateProject(raw) {
    const fallback = createDefaultProject();
    if (!raw || !Array.isArray(raw.sections)) return fallback;
    return {
      title: typeof raw.title === "string" ? raw.title : fallback.title,
      activeSectionId: typeof raw.activeSectionId === "string" ? raw.activeSectionId : raw.sections[0]?.id,
      sections: raw.sections.length
        ? raw.sections.map((section, sectionIndex) => ({
            id: section.id || makeId("section"),
            title: section.title || `${String(sectionIndex + 1).padStart(2, "0")} セクション`,
            lines: Array.isArray(section.lines) && section.lines.length
              ? section.lines.map(hydrateLine)
              : [createLine()],
          }))
        : fallback.sections,
      speakers: raw.speakers && typeof raw.speakers === "object" ? raw.speakers : {},
      speakerOrder: Array.isArray(raw.speakerOrder) ? raw.speakerOrder.filter((name) => typeof name === "string") : [],
      settings: {
        ...fallback.settings,
        ...(raw.settings && typeof raw.settings === "object" ? raw.settings : {}),
        exportBlankLineBetweenLines: Boolean(raw.settings?.exportBlankLineBetweenLines),
      },
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  }

  function hydrateLine(line) {
    if (typeof line === "string") return parseRawLine(line);
    const speaker = cleanSpeakerName(line.speaker || "");
    const body = typeof line.body === "string" ? line.body : "";
    return {
      id: line.id || makeId("line"),
      speaker,
      body,
      bodyMarks: normalizeBodyMarks(line.bodyMarks, body.length),
      type: TYPE_LABELS[line.type] ? line.type : inferType(line.speaker || "", line.body || ""),
      speakerCommitted: typeof line.speakerCommitted === "boolean" ? line.speakerCommitted : Boolean(speaker && body.trim()),
    };
  }

  function normalizeProject() {
    if (!project.sections.length) project.sections.push(createDefaultProject().sections[0]);
    if (!project.sections.some((section) => section.id === activeSectionId)) {
      activeSectionId = project.sections[0].id;
    }
    if (!project.settings || typeof project.settings !== "object") project.settings = {};
    project.settings.exportBlankLineBetweenLines = Boolean(project.settings.exportBlankLineBetweenLines);
    project.activeSectionId = activeSectionId;
    project.sections.forEach((section) => {
      if (!section.lines.length) section.lines.push(createLine());
      section.lines.forEach((line) => {
        line.speaker = cleanSpeakerName(line.speaker);
        line.body = String(line.body || "");
        line.bodyMarks = normalizeBodyMarks(line.bodyMarks, line.body.length);
        line.type = TYPE_LABELS[line.type] ? line.type : inferType(line.speaker, line.body);
        line.speakerCommitted = Boolean(line.speakerCommitted);
        if (shouldAutoRegisterSpeaker(line)) ensureSpeaker(line.speaker, undefined, true);
      });
    });
    pruneUnusedAutoSpeakers();
    syncSpeakerOrder();
  }

  function renderAll() {
    els.projectTitle.value = project.title;
    renderTabs();
    renderRows();
    renderSpeakers();
    renderStats();
    renderExportSettings();
    renderGoogleDocsPreview();
    updateMatches();
  }

  function renderExportSettings() {
    els.exportBlankLineInput.checked = Boolean(project.settings?.exportBlankLineBetweenLines);
  }

  function renderGoogleDocsPreview() {
    els.googleDocsPreview.innerHTML = buildGoogleDocsPasteHtmlBody();
  }

  function renderTabs() {
    els.sectionTabs.innerHTML = "";
    project.sections.forEach((section) => {
      const tab = document.createElement("button");
      tab.className = `tab${section.id === activeSectionId ? " active" : ""}`;
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.innerHTML = `<span>${escapeHtml(section.title)}</span><span class="tab-dot"></span>`;
      tab.addEventListener("click", () => {
        activeSectionId = section.id;
        project.activeSectionId = section.id;
        selectedLineIds.clear();
        lineSelectionAnchorId = "";
        focusedLineId = "";
        renderAll();
        scheduleSave();
      });
      tab.addEventListener("dblclick", () => renameSection(section.id));
      els.sectionTabs.appendChild(tab);
    });
  }

  function renderRows() {
    hideSpeakerPicker();
    const section = getActiveSection();
    els.scriptRows.innerHTML = "";
    section.lines.forEach((line, index) => {
      const speaker = project.speakers[line.speaker];
      const color = speaker?.color || autoColor(line.speaker);
      const bodyColor = getSpeakerBodyColor(speaker);
      const row = document.createElement("div");
      row.className = `script-row${selectedLineIds.has(line.id) ? " selected" : ""}`;
      row.dataset.lineId = line.id;
      row.addEventListener("click", () => {
        focusedLineId = line.id;
      });
      row.addEventListener("dragover", (event) => handleLineDragOver(event, row));
      row.addEventListener("dragleave", () => clearLineDropClasses(row));
      row.addEventListener("drop", (event) => handleLineDrop(event, line.id, row));
      row.style.setProperty("--speaker-bg", tintColor(color, 0.84));
      row.style.setProperty("--speaker-text", darkenColor(color));
      setOptionalCssVar(row, "--body-text", bodyColor);

      const number = document.createElement("div");
      number.className = "line-number";
      number.textContent = String(index + 1).padStart(3, "0");
      number.draggable = true;
      number.title = "クリックで選択 / ドラッグで行移動";
      number.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleLineSelection(line.id, event.shiftKey);
      });
      number.addEventListener("dragstart", (event) => {
        const dragIds = selectedLineIds.has(line.id) ? Array.from(selectedLineIds) : [line.id];
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-script-line-ids", JSON.stringify(dragIds));
        row.classList.add("dragging");
      });
      number.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        clearAllLineDropClasses();
      });

      const speakerCell = document.createElement("div");
      speakerCell.className = "speaker-cell";
      const speakerInput = document.createElement("input");
      speakerInput.className = "speaker-input";
      speakerInput.type = "text";
      speakerInput.value = line.speaker;
      speakerInput.placeholder = line.type === "dialogue" ? "話者名" : TYPE_LABELS[line.type];
      speakerInput.addEventListener("input", () => {
        line.speaker = cleanSpeakerName(speakerInput.value);
        line.speakerCommitted = false;
        line.type = inferType(line.speaker, line.body, line.type);
        if (line.speaker) {
          hideSpeakerPicker();
        } else {
          showSpeakerPicker(speakerInput, line, syncRowVisual);
        }
        syncRowVisual();
        renderStats();
        renderGoogleDocsPreview();
        updateMatches();
        markSavePending();
      });
      speakerInput.addEventListener("focus", () => {
        flushPendingSave();
        focusedLineId = line.id;
        if (!cleanSpeakerName(speakerInput.value)) showSpeakerPicker(speakerInput, line, syncRowVisual);
      });
      speakerInput.addEventListener("click", () => {
        focusedLineId = line.id;
        if (!cleanSpeakerName(speakerInput.value)) showSpeakerPicker(speakerInput, line, syncRowVisual);
      });
      speakerInput.addEventListener("change", () => {
        commitLineSpeaker(line);
        flushPendingSave();
      });
      speakerInput.addEventListener("blur", () => {
        commitLineSpeaker(line);
        flushPendingSave();
      });
      speakerInput.addEventListener("paste", (event) => handlePaste(event, index));
      speakerInput.addEventListener("keydown", (event) => handleRowKey(event, index, "speaker"));

      speakerCell.append(speakerInput);

      const bodyCell = document.createElement("div");
      bodyCell.className = "body-cell";
      const colon = document.createElement("div");
      colon.className = "colon";
      colon.textContent = line.speaker ? "：" : "";
      const bodyInput = document.createElement("div");
      bodyInput.className = `body-input ${line.type}`;
      bodyInput.contentEditable = "true";
      bodyInput.setAttribute("role", "textbox");
      bodyInput.setAttribute("aria-label", "本文");
      bodyInput.dataset.placeholder = "本文";
      bodyInput.innerHTML = bodyEditorHtml(line);
      bodyInput.addEventListener("input", () => {
        syncBodyEditorToLine(bodyInput, line);
        line.type = inferType(line.speaker, line.body, line.type);
        if (shouldAutoRegisterSpeaker(line)) ensureSpeaker(line.speaker, undefined, true);
        pruneUnusedAutoSpeakers();
        syncRowVisual();
        resizeBodyInput(bodyInput);
        renderSpeakers();
        renderStats();
        renderGoogleDocsPreview();
        updateMatches();
        markSavePending();
      });
      bodyInput.addEventListener("focus", () => {
        flushPendingSave();
        focusedLineId = line.id;
        captureBodySelection(line.id, bodyInput);
        resizeBodyInput(bodyInput);
        if (!suppressBodyFocusScroll) centerRowForEditing(row);
      });
      bodyInput.addEventListener("beforeinput", () => captureBodySelection(line.id, bodyInput));
      bodyInput.addEventListener("blur", flushPendingSave);
      bodyInput.addEventListener("mouseup", () => captureBodySelection(line.id, bodyInput));
      bodyInput.addEventListener("keyup", () => {
        captureBodySelection(line.id, bodyInput);
        resizeBodyInput(bodyInput);
      });
      bodyInput.addEventListener("paste", (event) => handleBodyPaste(event, index));
      bodyInput.addEventListener("keydown", (event) => handleRowKey(event, index, "body"));
      bodyCell.append(colon, bodyInput);
      requestAnimationFrame(() => resizeBodyInput(bodyInput));

      const tools = document.createElement("div");
      tools.className = "row-tools";
      const deleteButton = document.createElement("button");
      deleteButton.className = "delete-row";
      deleteButton.type = "button";
      deleteButton.title = "行を削除";
      deleteButton.textContent = "×";
      deleteButton.addEventListener("click", () => deleteLine(index));
      tools.appendChild(deleteButton);

      row.append(number, speakerCell, bodyCell, tools);
      els.scriptRows.appendChild(row);

      function syncRowVisual() {
        const nextSpeaker = project.speakers[line.speaker];
        const nextColor = nextSpeaker?.color || autoColor(line.speaker);
        const nextBodyColor = getSpeakerBodyColor(nextSpeaker);
        row.style.setProperty("--speaker-bg", tintColor(nextColor, 0.84));
        row.style.setProperty("--speaker-text", darkenColor(nextColor));
        setOptionalCssVar(row, "--body-text", nextBodyColor);
        colon.textContent = line.speaker ? "：" : "";
        bodyInput.className = `body-input ${line.type}`;
        if (document.activeElement !== bodyInput) bodyInput.innerHTML = bodyEditorHtml(line);
      }
    });
    updateSelectedLineStatus();
  }

  function resizeBodyInput(input) {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  function centerRowForEditing(row) {
    requestAnimationFrame(() => {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function bodyEditorHtml(line) {
    const runs = styledTextRuns(line.body, line.bodyMarks);
    if (!runs.length) return "";
    return runs.map((run) => {
      const styles = [];
      if (run.bold) styles.push("font-weight:900");
      if (run.color) styles.push(`color:${run.color}`);
      const text = escapeHtml(run.text).replace(/\n/g, "<br>");
      return styles.length ? `<span style="${styles.join(";")}">${text}</span>` : text;
    }).join("");
  }

  function styledTextRuns(text, marks) {
    const source = String(text || "");
    if (!source) return [];
    const normalized = normalizeBodyMarks(marks, source.length);
    const points = new Set([0, source.length]);
    normalized.forEach((mark) => {
      points.add(mark.start);
      points.add(mark.end);
    });
    const ordered = Array.from(points).sort((a, b) => a - b);
    const runs = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index];
      const end = ordered[index + 1];
      if (start === end) continue;
      const active = normalized.filter((mark) => mark.start < end && mark.end > start);
      const bold = active.some((mark) => mark.bold);
      const colorMark = active.findLast ? active.findLast((mark) => mark.color) : active.slice().reverse().find((mark) => mark.color);
      runs.push({
        text: source.slice(start, end),
        bold,
        color: colorMark?.color || "",
      });
    }
    return mergeStyledRuns(runs);
  }

  function mergeStyledRuns(runs) {
    const merged = [];
    runs.forEach((run) => {
      const previous = merged[merged.length - 1];
      if (previous && previous.bold === run.bold && previous.color === run.color) {
        previous.text += run.text;
      } else {
        merged.push({ ...run });
      }
    });
    return merged;
  }

  function normalizeBodyMarks(marks, textLength) {
    if (!Array.isArray(marks)) return [];
    return marks
      .map((mark) => ({
        start: clampNumber(mark.start, 0, textLength),
        end: clampNumber(mark.end, 0, textLength),
        bold: Boolean(mark.bold),
        color: normalizeCssColor(mark.color),
      }))
      .filter((mark) => mark.end > mark.start && (mark.bold || mark.color))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function syncBodyEditorToLine(editor, line) {
    line.body = editorPlainText(editor);
    line.bodyMarks = extractBodyMarks(editor, line.body.length);
  }

  function editorPlainText(root) {
    let text = "";
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "BR") {
        text += "\n";
        return;
      }
      Array.from(node.childNodes).forEach(walk);
    };
    Array.from(root.childNodes).forEach(walk);
    return text;
  }

  function extractBodyMarks(root, textLength) {
    const marks = [];
    let offset = 0;
    const walk = (node, inherited) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue || "";
        const start = offset;
        offset += text.length;
        if (text.length && (inherited.bold || inherited.color)) {
          marks.push({ start, end: offset, ...inherited });
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const next = { ...inherited };
      const element = node;
      const weight = element.style?.fontWeight || "";
      if (element.tagName === "B" || element.tagName === "STRONG" || Number.parseInt(weight, 10) >= 600 || weight === "bold") {
        next.bold = true;
      }
      const color = normalizeCssColor(element.style?.color);
      if (color) next.color = color;
      if (element.tagName === "BR") {
        offset += 1;
        return;
      }
      Array.from(element.childNodes).forEach((child) => walk(child, next));
    };
    Array.from(root.childNodes).forEach((child) => walk(child, { bold: false, color: "" }));
    return normalizeBodyMarks(marks, textLength);
  }

  function captureBodySelection(lineId, editor) {
    const offsets = selectionOffsetsForEditor(editor);
    if (!offsets && (typeof editor.selectionStart !== "number" || typeof editor.selectionEnd !== "number")) return;
    const start = offsets?.start ?? editor.selectionStart;
    const end = offsets?.end ?? editor.selectionEnd;
    bodySelection = {
      lineId,
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
    bodySelectionRange = null;
  }

  function updateBodySelectionFromDocument() {
    const selection = captureActiveBodySelection();
    if (selection) bodySelection = selection;
  }

  function preserveBodySelectionForToolbar(event) {
    updateBodySelectionFromDocument();
    if (event.currentTarget !== els.bodyColorInput) event.preventDefault();
  }

  function applyBodyBoldFromPointer(event) {
    if (event.__scriptEditorBodyBoldHandled) return;
    event.__scriptEditorBodyBoldHandled = true;
    updateBodySelectionFromDocument();
    event.preventDefault();
    const result = toggleBodyBoldSelection();
    if (!result) {
      setFormatStatus("本文を選択してください");
      return;
    }
    setFormatStatus(result === "removed" ? "太字を解除しました" : "太字を適用しました");
    flushPendingSave();
  }

  function applyBodyColorFromPointer(event) {
    event.preventDefault();
    updateBodySelectionFromDocument();
    const applied = applyBodyMark({ color: els.bodyColorInput.value });
    if (!applied) {
      setFormatStatus("本文を選択してください");
      return;
    }
    setFormatStatus("色を適用しました");
    flushPendingSave();
  }

  function captureActiveBodySelection() {
    const selection = document.getSelection?.();
    const selectionEditor = selection?.rangeCount
      ? closestBodyEditor(selection.anchorNode) || closestBodyEditor(selection.focusNode)
      : null;
    const activeEditor = document.activeElement?.classList?.contains("body-input") ? document.activeElement : null;
    const editor = selectionEditor || activeEditor;
    if (!editor) return null;
    const row = editor.closest(".script-row");
    const lineId = row?.dataset.lineId;
    if (!lineId) return null;
    const offsets = selectionOffsetsForEditor(editor);
    if (!offsets && (typeof editor.selectionStart !== "number" || typeof editor.selectionEnd !== "number")) return null;
    const start = offsets?.start ?? editor.selectionStart;
    const end = offsets?.end ?? editor.selectionEnd;
    return {
      lineId,
      start: Math.min(start, end),
      end: Math.max(start, end),
    };
  }

  function closestBodyEditor(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return element?.closest?.(".body-input") || null;
  }

  function selectionOffsetsForEditor(editor) {
    const selection = document.getSelection?.();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!nodeBelongsToEditor(editor, range.startContainer) || !nodeBelongsToEditor(editor, range.endContainer)) return null;
    const textLength = editorPlainText(editor).length;
    return {
      start: clampNumber(offsetForEditorPosition(editor, range.startContainer, range.startOffset), 0, textLength),
      end: clampNumber(offsetForEditorPosition(editor, range.endContainer, range.endOffset), 0, textLength),
    };
  }

  function nodeBelongsToEditor(editor, node) {
    return node === editor || Boolean(editor.contains?.(node));
  }

  function offsetForEditorPosition(root, targetNode, targetOffset) {
    let offset = 0;
    let found = false;
    const lengthOf = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || "").length;
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") return 1;
      return Array.from(node.childNodes || []).reduce((total, child) => total + lengthOf(child), 0);
    };
    const walk = (node) => {
      if (found) return;
      if (node === targetNode) {
        if (node.nodeType === Node.TEXT_NODE) {
          offset += targetOffset;
        } else {
          Array.from(node.childNodes || []).slice(0, targetOffset).forEach((child) => {
            offset += lengthOf(child);
          });
        }
        found = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        offset += (node.nodeValue || "").length;
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
        offset += 1;
        return;
      }
      Array.from(node.childNodes || []).forEach(walk);
    };
    walk(root);
    return offset;
  }

  function applyBodyMark(style) {
    updateBodySelectionFromDocument();
    if (!bodySelection || bodySelection.start === bodySelection.end) return false;
    const line = findLine(bodySelection.lineId);
    if (!line) return false;
    const selectionToRestore = { ...bodySelection };
    line.bodyMarks = applyMarkToRange(line.bodyMarks, line.body.length, bodySelection.start, bodySelection.end, style);
    renderAll();
    restoreBodySelectionAfterRender(selectionToRestore);
    markSavePending();
    return true;
  }

  function toggleBodyBoldSelection() {
    updateBodySelectionFromDocument();
    if (!bodySelection || bodySelection.start === bodySelection.end) return "";
    const line = findLine(bodySelection.lineId);
    if (!line) return "";
    const removeBold = rangeIsFullyBold(line.bodyMarks, line.body.length, bodySelection.start, bodySelection.end);
    return applyBodyMark({ bold: !removeBold }) ? (removeBold ? "removed" : "applied") : "";
  }

  function rangeIsFullyBold(marks, textLength, start, end) {
    const normalized = normalizeBodyMarks(marks, textLength);
    const clippedStart = clampNumber(start, 0, textLength);
    const clippedEnd = clampNumber(end, 0, textLength);
    if (clippedEnd <= clippedStart) return false;
    const points = new Set([clippedStart, clippedEnd]);
    normalized.forEach((mark) => {
      if (mark.end > clippedStart && mark.start < clippedEnd) {
        points.add(clampNumber(mark.start, clippedStart, clippedEnd));
        points.add(clampNumber(mark.end, clippedStart, clippedEnd));
      }
    });
    const ordered = Array.from(points).sort((a, b) => a - b);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const segmentStart = ordered[index];
      const segmentEnd = ordered[index + 1];
      if (segmentStart === segmentEnd) continue;
      const isBold = normalized.some((mark) => mark.bold && mark.start < segmentEnd && mark.end > segmentStart);
      if (!isBold) return false;
    }
    return true;
  }

  function restoreBodySelectionAfterRender(selection) {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const rowsScrollTop = els.scriptRows.scrollTop;
    const restore = () => {
      const row = Array.from(els.scriptRows.querySelectorAll(".script-row")).find((item) => item.dataset.lineId === selection.lineId);
      const editor = row?.querySelector(".body-input");
      if (!editor) return false;
      try {
        suppressBodyFocusScroll = true;
        editor.focus({ preventScroll: true });
        setEditorSelection(editor, selection.start, selection.end);
        captureBodySelection(selection.lineId, editor);
      } finally {
        suppressBodyFocusScroll = false;
      }
      els.scriptRows.scrollTop = rowsScrollTop;
      window.scrollTo(scrollX, scrollY);
      return true;
    };
    if (restore()) {
      requestAnimationFrame(restore);
    } else {
      requestAnimationFrame(restore);
    }
  }

  function setEditorSelection(editor, start, end) {
    const selection = document.getSelection?.();
    if (!selection) return;
    const range = document.createRange();
    const startPosition = editorPositionForOffset(editor, start);
    const endPosition = editorPositionForOffset(editor, end);
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function editorPositionForOffset(root, targetOffset) {
    let offset = 0;
    const target = Math.max(0, targetOffset);
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = (node.nodeValue || "").length;
        if (target <= offset + length) return { node, offset: target - offset };
        offset += length;
        return null;
      }
      const children = Array.from(node.childNodes || []);
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "BR") {
          if (target <= offset + 1) return { node, offset: index + 1 };
          offset += 1;
          continue;
        }
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(root) || { node: root, offset: root.childNodes.length };
  }

  function setFormatStatus(text) {
    if (!els.formatStatus) return;
    els.formatStatus.textContent = text;
  }

  function updateBodyColorButton() {
    if (!els.bodyColorApplyButton || !els.bodyColorInput) return;
    els.bodyColorApplyButton.style.setProperty("--active-body-color", els.bodyColorInput.value);
  }

  function applyMarkToRange(marks, textLength, start, end, style) {
    const normalized = normalizeBodyMarks(marks, textLength);
    const clippedStart = clampNumber(start, 0, textLength);
    const clippedEnd = clampNumber(end, 0, textLength);
    if (clippedEnd <= clippedStart) return normalized;
    const points = new Set([0, textLength, clippedStart, clippedEnd]);
    normalized.forEach((mark) => {
      points.add(mark.start);
      points.add(mark.end);
    });
    const ordered = Array.from(points).sort((a, b) => a - b);
    const nextMarks = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const segmentStart = ordered[index];
      const segmentEnd = ordered[index + 1];
      if (segmentStart === segmentEnd) continue;
      const active = normalized.filter((mark) => mark.start < segmentEnd && mark.end > segmentStart);
      const current = {
        bold: active.some((mark) => mark.bold),
        color: (active.findLast ? active.findLast((mark) => mark.color) : active.slice().reverse().find((mark) => mark.color))?.color || "",
      };
      if (segmentStart >= clippedStart && segmentEnd <= clippedEnd) {
        if (Object.prototype.hasOwnProperty.call(style, "bold")) current.bold = Boolean(style.bold);
        if (Object.prototype.hasOwnProperty.call(style, "color")) current.color = normalizeCssColor(style.color);
      }
      if (current.bold || current.color) {
        nextMarks.push({ start: segmentStart, end: segmentEnd, ...current });
      }
    }
    return mergeBodyMarks(nextMarks);
  }

  function mergeBodyMarks(marks) {
    const merged = [];
    marks.forEach((mark) => {
      const previous = merged[merged.length - 1];
      if (previous && previous.end === mark.start && previous.bold === mark.bold && previous.color === mark.color) {
        previous.end = mark.end;
      } else {
        merged.push({ ...mark });
      }
    });
    return merged;
  }

  function clampNumber(value, min, max) {
    const number = Number.isFinite(Number(value)) ? Number(value) : min;
    return Math.min(max, Math.max(min, number));
  }

  function renderSpeakers() {
    const counts = speakerCounts();
    syncSpeakerOrder();
    const names = orderedSpeakerNames();
    els.speakerList.innerHTML = "";
    if (!names.length) {
      const empty = document.createElement("div");
      empty.className = "status-line";
      empty.textContent = "話者名を入力すると自動登録されます。";
      els.speakerList.appendChild(empty);
      return;
    }

    const topDropZone = document.createElement("div");
    topDropZone.className = "speaker-drop-zone-top";
    topDropZone.addEventListener("dragover", handleSpeakerTopDragOver);
    topDropZone.addEventListener("drop", handleSpeakerTopDrop);
    topDropZone.addEventListener("dragleave", () => topDropZone.classList.remove("drop-active"));
    els.speakerList.appendChild(topDropZone);

    names.forEach((name) => {
      const speaker = project.speakers[name];
      const item = document.createElement("div");
      item.className = "speaker-item";
      item.dataset.speakerName = name;
      item.addEventListener("dragover", (event) => handleSpeakerDragOver(event, item));
      item.addEventListener("dragleave", () => clearSpeakerDropClasses(item));
      item.addEventListener("drop", (event) => handleSpeakerDrop(event, name, item));

      const handle = document.createElement("button");
      handle.className = "speaker-drag-handle";
      handle.type = "button";
      handle.draggable = true;
      handle.title = "ドラッグして並び替え";
      handle.setAttribute("aria-label", `${name}を並び替え`);
      handle.textContent = "⋮⋮";
      handle.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(SPEAKER_DRAG_TYPE, name);
        event.dataTransfer.setData("text/plain", name);
        els.speakerList.classList.add("speaker-dragging-active");
        item.classList.add("dragging");
      });
      handle.addEventListener("dragend", () => {
        els.speakerList.classList.remove("speaker-dragging-active");
        item.classList.remove("dragging");
        clearAllSpeakerDropClasses();
      });

      const meta = document.createElement("div");
      meta.className = "speaker-meta";
      const speakerName = document.createElement("div");
      speakerName.className = "speaker-name";
      speakerName.textContent = name;
      const count = document.createElement("div");
      count.className = "speaker-count";
      count.textContent = `${counts[name] || 0}行`;
      meta.append(speakerName, count);

      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = speaker.color;
      colorInput.setAttribute("aria-label", `${name}の背景色`);
      colorInput.title = "背景色";
      colorInput.addEventListener("input", () => {
        speaker.color = colorInput.value;
        renderRows();
        renderGoogleDocsPreview();
        markSavePending();
      });
      colorInput.addEventListener("change", flushPendingSave);

      const bodyColorInput = document.createElement("input");
      bodyColorInput.type = "color";
      bodyColorInput.value = getSpeakerBodyColor(speaker) || "#1f2937";
      bodyColorInput.setAttribute("aria-label", `${name}の本文色`);
      bodyColorInput.title = "本文色";
      bodyColorInput.addEventListener("input", () => {
        speaker.bodyColor = bodyColorInput.value;
        renderRows();
        markSavePending();
      });
      bodyColorInput.addEventListener("change", flushPendingSave);

      const deleteButton = document.createElement("button");
      deleteButton.className = "speaker-delete-button";
      deleteButton.type = "button";
      deleteButton.title = "話者を削除";
      deleteButton.setAttribute("aria-label", `${name}を削除`);
      deleteButton.textContent = "×";
      deleteButton.addEventListener("click", () => deleteSpeaker(name));

      item.append(handle, meta, colorInput, bodyColorInput, deleteButton);
      els.speakerList.appendChild(item);
    });
  }

  function renderStats() {
    const total = project.sections.reduce((sum, section) => {
      return sum + countBodyChars(section.lines);
    }, 0);
    const active = countBodyChars(getActiveSection().lines);
    els.totalBodyChars.textContent = total.toLocaleString("ja-JP");
    els.sectionBodyChars.textContent = active.toLocaleString("ja-JP");
  }

  function countBodyChars(lines) {
    return lines.reduce((sum, line) => sum + Array.from(line.body || "").length, 0);
  }

  function toggleLineSelection(lineId, extendRange = false) {
    if (extendRange && selectLineRange(lineId)) {
      renderRows();
      return;
    }

    if (selectedLineIds.has(lineId)) {
      selectedLineIds.delete(lineId);
    } else {
      selectedLineIds.add(lineId);
      focusedLineId = lineId;
    }
    lineSelectionAnchorId = lineId;
    renderRows();
  }

  function selectLineRange(targetLineId) {
    const lines = getActiveSection().lines;
    const anchorId = lineSelectionAnchorId || focusedLineId || selectedLinesInOrder()[0]?.id || targetLineId;
    const anchorIndex = lines.findIndex((line) => line.id === anchorId);
    const targetIndex = lines.findIndex((line) => line.id === targetLineId);
    if (anchorIndex < 0 || targetIndex < 0) return false;

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    selectedLineIds = new Set(lines.slice(start, end + 1).map((line) => line.id));
    focusedLineId = targetLineId;
    lineSelectionAnchorId = anchorId;
    return true;
  }

  function clearLineSelection() {
    selectedLineIds.clear();
    lineSelectionAnchorId = "";
    focusedLineId = "";
    renderRows();
  }

  function updateSelectedLineStatus() {
    if (!els.selectedLineStatus) return;
    const count = selectedLineIds.size;
    els.selectedLineStatus.textContent = count ? `${count}件の行を選択中` : "";
    if (els.clearSelectedLinesButton) els.clearSelectedLinesButton.hidden = count === 0;
    if (els.copySelectedGoogleDocsButton) els.copySelectedGoogleDocsButton.disabled = count === 0;
  }

  function handleLineDragOver(event, row) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  }

  function handleLineDrop(event, targetLineId, row) {
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/x-script-line-ids");
    clearAllLineDropClasses();
    if (!raw) return;
    const draggedIds = JSON.parse(raw);
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    moveLines(draggedIds, targetLineId, after);
  }

  function clearLineDropClasses(row) {
    row.classList.remove("drop-before", "drop-after");
  }

  function clearAllLineDropClasses() {
    els.scriptRows.querySelectorAll(".script-row").forEach(clearLineDropClasses);
  }

  function moveLines(lineIds, targetLineId, after) {
    const section = getActiveSection();
    const moveSet = new Set(lineIds);
    if (moveSet.has(targetLineId)) return;
    const moving = section.lines.filter((line) => moveSet.has(line.id));
    if (!moving.length) return;
    const remaining = section.lines.filter((line) => !moveSet.has(line.id));
    const targetIndex = remaining.findIndex((line) => line.id === targetLineId);
    if (targetIndex < 0) return;
    remaining.splice(targetIndex + (after ? 1 : 0), 0, ...moving);
    section.lines = remaining;
    focusedLineId = moving[moving.length - 1].id;
    renderAll();
    scheduleSave();
  }

  function selectedLinesInOrder() {
    const section = getActiveSection();
    return section.lines.filter((line) => selectedLineIds.has(line.id));
  }

  function copySelectedLines() {
    const selected = selectedLinesInOrder();
    if (!selected.length) return;
    lineClipboard = selected.map(cloneLineForClipboard);
  }

  function cutSelectedLines() {
    const section = getActiveSection();
    const selected = selectedLinesInOrder();
    if (!selected.length) return;
    lineClipboard = selected.map(cloneLineForClipboard);
    const cutSet = new Set(selected.map((line) => line.id));
    section.lines = section.lines.filter((line) => !cutSet.has(line.id));
    if (!section.lines.length) section.lines.push(createLine());
    selectedLineIds.clear();
    lineSelectionAnchorId = "";
    focusedLineId = "";
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function pasteCopiedLines() {
    if (!lineClipboard.length) return;
    const section = getActiveSection();
    const pasted = lineClipboard.map(cloneLineForPaste);
    if (section.lines.length === 1 && isBlankLine(section.lines[0]) && !focusedLineId && !selectedLineIds.size) {
      section.lines.splice(0, 1, ...pasted);
      selectedLineIds = new Set(pasted.map((line) => line.id));
      lineSelectionAnchorId = pasted[0]?.id || "";
      focusedLineId = pasted[pasted.length - 1].id;
      normalizeProject();
      renderAll();
      scheduleSave();
      requestAnimationFrame(() => focusLine(0, "speaker"));
      return;
    }

    let insertIndex = section.lines.length - 1;
    const selectedIndexes = section.lines
      .map((line, index) => (selectedLineIds.has(line.id) ? index : -1))
      .filter((index) => index >= 0);
    const focusedIndex = focusedLineId ? section.lines.findIndex((line) => line.id === focusedLineId) : -1;
    if (focusedIndex >= 0) {
      insertIndex = focusedIndex;
    } else if (selectedIndexes.length) {
      insertIndex = Math.max(...selectedIndexes);
    }

    section.lines.splice(insertIndex + 1, 0, ...pasted);
    selectedLineIds = new Set(pasted.map((line) => line.id));
    lineSelectionAnchorId = pasted[0]?.id || "";
    focusedLineId = pasted[pasted.length - 1].id;
    normalizeProject();
    renderAll();
    scheduleSave();
    requestAnimationFrame(() => focusLine(insertIndex + 1, "speaker"));
  }

  function cloneLineForClipboard(line) {
    return {
      speaker: line.speaker,
      body: line.body,
      bodyMarks: normalizeBodyMarks(line.bodyMarks, line.body.length).map((mark) => ({ ...mark })),
      type: line.type,
      speakerCommitted: Boolean(line.speakerCommitted),
    };
  }

  function cloneLineForPaste(line) {
    return {
      ...cloneLineForClipboard(line),
      id: makeId("line"),
    };
  }

  function isBlankLine(line) {
    return !line.speaker && !String(line.body || "").trim();
  }

  function showSpeakerPicker(input, line, syncRowVisual) {
    const names = orderedSpeakerNames();
    if (!names.length) {
      hideSpeakerPicker();
      return;
    }

    hideSpeakerPicker();
    const picker = document.createElement("div");
    picker.className = "speaker-picker";
    picker.setAttribute("role", "listbox");

    names.forEach((name) => {
      const speaker = project.speakers[name];
      const option = document.createElement("button");
      option.type = "button";
      option.className = "speaker-picker-option";
      option.setAttribute("role", "option");
      option.style.setProperty("--picker-speaker-bg", tintColor(speaker?.color || autoColor(name), 0.84));
      option.style.setProperty("--picker-speaker-text", darkenColor(speaker?.color || autoColor(name)));
      option.textContent = name;
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => {
        line.speaker = name;
        line.speakerCommitted = true;
        input.value = name;
        line.type = inferType(line.speaker, line.body, line.type);
        if (shouldAutoRegisterSpeaker(line)) ensureSpeaker(line.speaker, undefined, true);
        syncRowVisual();
        renderSpeakers();
        renderStats();
        updateMatches();
        scheduleSave();
        hideSpeakerPicker();
        input.focus();
      });
      picker.appendChild(option);
    });

    document.body.appendChild(picker);
    positionSpeakerPicker(picker, input);
    speakerPicker = { element: picker, input };
  }

  function positionSpeakerPicker(picker, input) {
    const rect = input.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const desiredHeight = Math.min(picker.scrollHeight, 260);
    const openAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
    const maxHeight = Math.max(96, Math.min(260, openAbove ? spaceAbove - gap : spaceBelow - gap));
    const actualHeight = Math.min(desiredHeight, maxHeight);

    picker.style.left = `${rect.left}px`;
    picker.style.maxHeight = `${maxHeight}px`;
    picker.style.top = openAbove
      ? `${Math.max(margin, rect.top - actualHeight - gap)}px`
      : `${rect.bottom + gap}px`;
    picker.style.minWidth = `${rect.width}px`;
  }

  function hideSpeakerPicker() {
    if (!speakerPicker) return;
    speakerPicker.element.remove();
    speakerPicker = null;
  }

  function handleSpeakerDragOver(event, item) {
    if (!hasSpeakerDragData(event)) return;
    event.stopPropagation();
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const after = isAfterSpeakerDropPoint(event, item);
    item.classList.toggle("drop-before", !after);
    item.classList.toggle("drop-after", after);
  }

  function handleSpeakerDrop(event, targetName, item) {
    if (!hasSpeakerDragData(event)) return;
    event.stopPropagation();
    event.preventDefault();
    const draggedName = getDraggedSpeakerName(event);
    const after = isAfterSpeakerDropPoint(event, item);
    els.speakerList.classList.remove("speaker-dragging-active");
    clearAllSpeakerDropClasses();
    moveSpeaker(draggedName, targetName, after);
  }

  function handleSpeakerListDragOver(event) {
    if (!hasSpeakerDragData(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const placement = getSpeakerListDropPlacement(event.clientY);
    clearAllSpeakerDropClasses();
    if (!placement) return;
    placement.item.classList.toggle("drop-before", !placement.after);
    placement.item.classList.toggle("drop-after", placement.after);
  }

  function handleSpeakerListDrop(event) {
    if (!hasSpeakerDragData(event)) return;
    event.preventDefault();
    const placement = getSpeakerListDropPlacement(event.clientY);
    const draggedName = getDraggedSpeakerName(event);
    els.speakerList.classList.remove("speaker-dragging-active");
    clearAllSpeakerDropClasses();
    if (!placement) return;
    moveSpeaker(draggedName, placement.targetName, placement.after);
  }

  function handleSpeakerTopDragOver(event) {
    if (!hasSpeakerDragData(event)) return;
    event.stopPropagation();
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearAllSpeakerDropClasses();
    event.currentTarget.classList.add("drop-active");
  }

  function handleSpeakerTopDrop(event) {
    if (!hasSpeakerDragData(event)) return;
    event.stopPropagation();
    event.preventDefault();
    const draggedName = getDraggedSpeakerName(event);
    els.speakerList.classList.remove("speaker-dragging-active");
    clearAllSpeakerDropClasses();
    moveSpeakerToIndex(draggedName, 0);
  }

  function hasSpeakerDragData(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    return types.includes(SPEAKER_DRAG_TYPE) || types.includes("text/plain");
  }

  function getDraggedSpeakerName(event) {
    return event.dataTransfer.getData(SPEAKER_DRAG_TYPE) || event.dataTransfer.getData("text/plain");
  }

  function isAfterSpeakerDropPoint(event, item) {
    const rect = item.getBoundingClientRect();
    const firstItem = els.speakerList.querySelector(".speaker-item");
    const beforeLimit = item === firstItem ? rect.top + rect.height * 0.72 : rect.top + rect.height / 2;
    return event.clientY > beforeLimit;
  }

  function getSpeakerListDropPlacement(clientY) {
    const items = Array.from(els.speakerList.querySelectorAll(".speaker-item"));
    if (!items.length) return null;

    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const beforeLimit = item === items[0] ? rect.top + rect.height * 0.72 : rect.top + rect.height / 2;
      if (clientY <= beforeLimit) {
        return {
          item,
          targetName: item.dataset.speakerName,
          after: false,
        };
      }
    }

    const lastItem = items[items.length - 1];
    return {
      item: lastItem,
      targetName: lastItem.dataset.speakerName,
      after: true,
    };
  }

  function clearSpeakerDropClasses(item) {
    item.classList.remove("drop-before", "drop-after");
  }

  function clearAllSpeakerDropClasses() {
    els.speakerList.querySelectorAll(".speaker-item").forEach(clearSpeakerDropClasses);
    els.speakerList.querySelectorAll(".speaker-drop-zone-top").forEach((zone) => {
      zone.classList.remove("drop-active");
    });
  }

  function moveSpeaker(draggedName, targetName, after) {
    if (!draggedName || !targetName || draggedName === targetName) return;
    syncSpeakerOrder();
    const withoutDragged = project.speakerOrder.filter((name) => name !== draggedName);
    const targetIndex = withoutDragged.indexOf(targetName);
    if (targetIndex < 0) return;
    withoutDragged.splice(targetIndex + (after ? 1 : 0), 0, draggedName);
    project.speakerOrder = withoutDragged;
    renderSpeakers();
    scheduleSave();
  }

  function moveSpeakerToIndex(draggedName, index) {
    if (!draggedName) return;
    syncSpeakerOrder();
    if (!project.speakerOrder.includes(draggedName)) return;
    const withoutDragged = project.speakerOrder.filter((name) => name !== draggedName);
    const insertionIndex = clampNumber(index, 0, withoutDragged.length);
    withoutDragged.splice(insertionIndex, 0, draggedName);
    project.speakerOrder = withoutDragged;
    renderSpeakers();
    scheduleSave();
  }

  function deleteSpeaker(name) {
    if (!project.speakers[name]) return;
    if (!confirm(`${name} を削除しますか？\n本文は残し、該当行の話者欄だけ空にします。`)) return;

    project.sections.forEach((section) => {
      section.lines.forEach((line) => {
        if (line.speaker !== name) return;
        line.speaker = "";
        line.speakerCommitted = false;
        line.type = inferType("", line.body, line.type);
      });
    });

    delete project.speakers[name];
    project.speakerOrder = Array.isArray(project.speakerOrder)
      ? project.speakerOrder.filter((speakerName) => speakerName !== name)
      : [];
    syncSpeakerOrder();
    renderAll();
    scheduleSave();
  }

  function getActiveSection() {
    return project.sections.find((section) => section.id === activeSectionId) || project.sections[0];
  }

  function addSection() {
    const next = project.sections.length + 1;
    const title = `${String(next).padStart(2, "0")} 新規セクション`;
    const section = {
      id: makeId("section"),
      title,
      lines: [createLine()],
    };
    project.sections.push(section);
    activeSectionId = section.id;
    project.activeSectionId = section.id;
    renderAll();
    scheduleSave();
  }

  function renameSection(sectionId) {
    const section = project.sections.find((item) => item.id === sectionId);
    if (!section) return;
    const nextTitle = prompt("セクション名", section.title);
    if (!nextTitle || !nextTitle.trim()) return;
    section.title = nextTitle.trim();
    renderTabs();
    scheduleSave();
  }

  function addLineAfter(index, parsedLines) {
    const section = getActiveSection();
    const lines = parsedLines && parsedLines.length ? parsedLines : [createLine()];
    section.lines.splice(index + 1, 0, ...lines);
    normalizeProject();
    renderAll();
    scheduleSave();
    requestAnimationFrame(() => focusLine(index + 1, "speaker"));
  }

  function deleteLine(index) {
    const section = getActiveSection();
    const removedLine = section.lines[index];
    if (section.lines.length === 1) {
      section.lines[0] = createLine();
    } else {
      section.lines.splice(index, 1);
    }
    if (removedLine) selectedLineIds.delete(removedLine.id);
    if (lineSelectionAnchorId === removedLine?.id) lineSelectionAnchorId = "";
    if (focusedLineId === removedLine?.id) focusedLineId = "";
    renderAll();
    scheduleSave();
  }

  function handlePaste(event, index) {
    const text = event.clipboardData?.getData("text");
    if (!text || !text.includes("\n")) return;
    event.preventDefault();
    const pasted = text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map(parseRawLine);
    if (!pasted.length) return;
    const section = getActiveSection();
    section.lines.splice(index, 1, ...pasted);
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function handleBodyPaste(event, index) {
    const text = event.clipboardData?.getData("text/plain") || event.clipboardData?.getData("text") || "";
    if (!text) return;
    if (text.includes("\n")) {
      handlePaste(event, index);
      return;
    }
    event.preventDefault();
    document.execCommand("insertText", false, text);
  }

  function handleRowKey(event, index, field) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (field === "speaker") {
      const line = getActiveSection().lines[index];
      if (line) commitLineSpeaker(line);
    }
    addLineAfter(index);
    requestAnimationFrame(() => focusLine(index + 1, field));
  }

  function commitLineSpeaker(line) {
    if (!line) return;
    line.speaker = cleanSpeakerName(line.speaker);
    line.speakerCommitted = Boolean(line.speaker);
    if (shouldAutoRegisterSpeaker(line)) {
      ensureSpeaker(line.speaker, undefined, true);
    }
    pruneUnusedAutoSpeakers();
    renderSpeakers();
    scheduleSave();
  }

  function shouldAutoRegisterSpeaker(line) {
    return Boolean(line.speaker && line.speakerCommitted && String(line.body || "").trim());
  }

  function focusLine(index, field) {
    const rows = Array.from(els.scriptRows.querySelectorAll(".script-row"));
    const target = rows[index];
    if (!target) return;
    const input = target.querySelector(field === "speaker" ? ".speaker-input" : ".body-input");
    input?.focus();
  }

  function createLine() {
    return {
      id: makeId("line"),
      speaker: "",
      body: "",
      bodyMarks: [],
      type: "dialogue",
      speakerCommitted: false,
    };
  }

  function parseRawLine(raw) {
    const line = String(raw || "").trim();
    const colonIndex = findColonIndex(line);
    if (colonIndex >= 0) {
      const speaker = cleanSpeakerName(line.slice(0, colonIndex));
      const body = line.slice(colonIndex + 1).trimStart();
      return {
        id: makeId("line"),
        speaker,
        body,
        bodyMarks: [],
        type: inferType(speaker, body),
        speakerCommitted: Boolean(speaker),
      };
    }
    return {
      id: makeId("line"),
      speaker: "",
      body: line,
      bodyMarks: [],
      type: inferType("", line),
      speakerCommitted: false,
    };
  }

  function findColonIndex(text) {
    const full = text.indexOf("：");
    const half = text.indexOf(":");
    if (full === -1) return half;
    if (half === -1) return full;
    return Math.min(full, half);
  }

  function inferType(speaker, body, fallback) {
    const name = cleanSpeakerName(speaker).toUpperCase();
    const source = `${speaker} ${body}`.trim();
    if (name === "BGM" || /^BGM[:：\s]/i.test(source)) return "bgm";
    if (["SE", "SFX", "効果音"].includes(name) || /効果音|SE[:：\s]|SFX[:：\s]/i.test(source)) return "sfx";
    if (!speaker && /^[（(【\[]/.test(body.trim())) return "direction";
    if (["ト書き", "ナレーション"].includes(cleanSpeakerName(speaker))) return "direction";
    return fallback && fallback !== "dialogue" ? fallback : "dialogue";
  }

  function ensureSpeaker(name, preferredColor, auto, preferredBodyColor) {
    const clean = cleanSpeakerName(name);
    if (!clean) return;
    if (!project.speakers) project.speakers = {};
    if (!project.speakers[clean]) {
      const special = SPECIAL_SPEAKERS.get(clean);
      const color = preferredColor || special?.color || autoColor(clean);
      project.speakers[clean] = {
        name: clean,
        color,
        bodyColor: preferredBodyColor || special?.bodyColor || "",
        auto: Boolean(auto),
        createdAt: new Date().toISOString(),
      };
      if (!Array.isArray(project.speakerOrder)) project.speakerOrder = [];
      project.speakerOrder.push(clean);
    } else if (preferredColor) {
      project.speakers[clean].color = preferredColor;
      if (preferredBodyColor) project.speakers[clean].bodyColor = preferredBodyColor;
      project.speakers[clean].auto = Boolean(auto);
    }
  }

  function speakerCounts() {
    const counts = {};
    project.sections.forEach((section) => {
      section.lines.forEach((line) => {
        if (!shouldAutoRegisterSpeaker(line)) return;
        counts[line.speaker] = (counts[line.speaker] || 0) + 1;
      });
    });
    return counts;
  }

  function pruneUnusedAutoSpeakers() {
    syncSpeakerOrder();
  }

  function orderedSpeakerNames() {
    syncSpeakerOrder();
    return project.speakerOrder.slice();
  }

  function syncSpeakerOrder() {
    if (!project.speakers || typeof project.speakers !== "object") project.speakers = {};
    if (!Array.isArray(project.speakerOrder)) project.speakerOrder = [];
    const existingNames = Object.keys(project.speakers);
    const existingSet = new Set(existingNames);
    project.speakerOrder = project.speakerOrder.filter((name, index, array) => {
      return existingSet.has(name) && array.indexOf(name) === index;
    });
    const orderedSet = new Set(project.speakerOrder);
    existingNames
      .filter((name) => !orderedSet.has(name))
      .sort((a, b) => a.localeCompare(b, "ja"))
      .forEach((name) => project.speakerOrder.push(name));
  }

  function cleanSpeakerName(name) {
    return String(name || "")
      .replace(/[：:]+$/g, "")
      .trim();
  }

  function updateMatches() {
    const query = els.searchInput.value;
    matches = [];
    currentMatchIndex = -1;
    if (query) {
      project.sections.forEach((section) => {
        section.lines.forEach((line) => {
          const fields = fieldsForScope(line, selectedScope);
          fields.forEach((field) => {
            if (field.value.includes(query)) {
              matches.push({ sectionId: section.id, lineId: line.id, field: field.key });
            }
          });
        });
      });
    }
    updateMatchClasses();
    updateMatchStatus();
  }

  function fieldsForScope(line, scope) {
    if (scope === "speaker") return [{ key: "speaker", value: line.speaker }];
    if (scope === "body") return [{ key: "body", value: line.body }];
    return [
      { key: "speaker", value: line.speaker },
      { key: "body", value: line.body },
    ];
  }

  function moveMatch(delta) {
    if (!matches.length) return;
    currentMatchIndex = (currentMatchIndex + delta + matches.length) % matches.length;
    const match = matches[currentMatchIndex];
    if (match.sectionId !== activeSectionId) {
      activeSectionId = match.sectionId;
      project.activeSectionId = match.sectionId;
      renderAll();
      currentMatchIndex = matches.findIndex((item) => item.lineId === match.lineId && item.field === match.field);
    }
    updateMatchClasses();
    updateMatchStatus();
    focusMatch(match);
  }

  function focusMatch(match) {
    const row = els.scriptRows.querySelector(`[data-line-id="${cssEscape(match.lineId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    const input = row.querySelector(match.field === "speaker" ? ".speaker-input" : ".body-input");
    input?.focus();
    if (typeof input?.select === "function") {
      input.select();
    } else if (input) {
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function updateMatchClasses() {
    const activeIds = new Set(matches.filter((match) => match.sectionId === activeSectionId).map((match) => match.lineId));
    els.scriptRows.querySelectorAll(".script-row").forEach((row) => {
      const isMatch = activeIds.has(row.dataset.lineId);
      const current = matches[currentMatchIndex];
      row.classList.toggle("match", isMatch);
      row.classList.toggle("current-match", Boolean(current && current.lineId === row.dataset.lineId));
    });
  }

  function updateMatchStatus() {
    if (!els.searchInput.value) {
      els.matchStatus.textContent = "0件";
      return;
    }
    const current = matches.length && currentMatchIndex >= 0 ? `${currentMatchIndex + 1} / ` : "";
    els.matchStatus.textContent = `${current}${matches.length}件`;
  }

  function replaceOne() {
    const query = els.searchInput.value;
    if (!query) return;
    if (!matches.length) updateMatches();
    if (!matches.length) return;
    if (currentMatchIndex < 0) currentMatchIndex = 0;
    const match = matches[currentMatchIndex];
    const line = findLine(match.lineId);
    if (!line) return;
    line[match.field] = line[match.field].replace(query, els.replaceInput.value);
    if (match.field === "body") line.bodyMarks = [];
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function replaceAll() {
    const query = els.searchInput.value;
    if (!query) return;
    let count = 0;
    project.sections.forEach((section) => {
      section.lines.forEach((line) => {
        const keys = selectedScope === "all" ? ["speaker", "body"] : [selectedScope];
        keys.forEach((key) => {
          const before = line[key];
          line[key] = before.split(query).join(els.replaceInput.value);
          if (before !== line[key]) {
            if (key === "body") line.bodyMarks = [];
            count += before.split(query).length - 1;
          }
        });
      });
    });
    normalizeProject();
    renderAll();
    els.matchStatus.textContent = `${count}件置換`;
    scheduleSave();
  }

  function findLine(lineId) {
    for (const section of project.sections) {
      const line = section.lines.find((item) => item.id === lineId);
      if (line) return line;
    }
    return null;
  }

  function saveJson() {
    syncProjectTitleFromInput();
    normalizeProject();
    const data = JSON.stringify(project, null, 2);
    downloadBlob(data, `${safeFileName(project.title)}.json`, "application/json");
  }

  function loadJsonFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        project = hydrateProject(JSON.parse(String(reader.result)));
        activeSectionId = project.activeSectionId || project.sections[0].id;
        selectedLineIds.clear();
        lineSelectionAnchorId = "";
        focusedLineId = "";
        normalizeProject();
        renderAll();
        scheduleSave();
      } catch (error) {
        alert("JSONを読み込めませんでした。");
        console.error(error);
      } finally {
        els.loadJsonInput.value = "";
      }
    };
    reader.readAsText(file, "utf-8");
  }

  function exportTxt() {
    syncProjectTitleFromInput();
    downloadBlob(buildPlainTextExport(), `${safeFileName(project.title)}.txt`, "text/plain");
  }

  function buildPlainTextExport() {
    const lineSeparator = project.settings.exportBlankLineBetweenLines ? "\n\n" : "\n";
    const blocks = project.sections.map((section) => {
      const body = section.lines
        .map((line) => (line.speaker ? `${line.speaker}：${line.body}` : line.body))
        .join(lineSeparator);
      return `# ${section.title}\n${body}`;
    });
    return blocks.join("\n\n");
  }

  async function copyGoogleDocsRichText() {
    await copyGoogleDocsRichTextPayload(
      buildGoogleDocsPasteHtmlDocument(),
      buildGoogleDocsPastePlainText(),
      "リッチ形式でコピーしました。Googleドキュメントに貼り付けできます。"
    );
  }

  async function copySelectedGoogleDocsRichText() {
    const selected = selectedLinesInOrder();
    if (!selected.length) return;
    await copyGoogleDocsRichTextPayload(
      buildGoogleDocsPasteHtmlDocument(selected),
      buildGoogleDocsPastePlainText(selected),
      `${selected.length}件の選択行をリッチコピーしました。`
    );
  }

  async function copyGoogleDocsRichTextPayload(html, plainText, successMessage) {
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plainText], { type: "text/plain" }),
          }),
        ]);
        setGoogleDocsCopyStatus(successMessage);
        return;
      }
      throw new Error("Rich clipboard is not available.");
    } catch (error) {
      selectGoogleDocsPreview();
      const copied = document.execCommand && document.execCommand("copy");
      setGoogleDocsCopyStatus(
        copied
          ? "プレビューからコピーしました。Googleドキュメントに貼り付けできます。"
          : "自動コピーできませんでした。プレビューを選択してコピーしてください。"
      );
    }
  }

  function buildGoogleDocsPasteHtmlDocument(lines = null) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
  </head>
  <body>
    ${buildGoogleDocsPasteHtmlBody(lines)}
  </body>
</html>`;
  }

  function buildGoogleDocsPasteHtmlBody(lines = null) {
    if (Array.isArray(lines)) return buildGoogleDocsLinesHtml(lines);
    const includeSectionTitles = project.sections.length > 1;
    const blocks = [];
    project.sections.forEach((section, sectionIndex) => {
      if (includeSectionTitles) {
        if (sectionIndex > 0) blocks.push(blankPasteParagraphHtml());
        blocks.push(sectionTitlePasteHtml(section.title));
      }
      section.lines.forEach((line, lineIndex) => {
        blocks.push(linePasteHtml(line));
        if (project.settings.exportBlankLineBetweenLines && lineIndex < section.lines.length - 1) {
          blocks.push(blankPasteParagraphHtml());
        }
      });
    });
    return blocks.length ? blocks.join("\n") : blankPasteParagraphHtml();
  }

  function buildGoogleDocsLinesHtml(lines) {
    const blocks = [];
    lines.forEach((line, lineIndex) => {
      blocks.push(linePasteHtml(line));
      if (project.settings.exportBlankLineBetweenLines && lineIndex < lines.length - 1) {
        blocks.push(blankPasteParagraphHtml());
      }
    });
    return blocks.length ? blocks.join("\n") : blankPasteParagraphHtml();
  }

  function buildGoogleDocsPastePlainText(lines = null) {
    if (Array.isArray(lines)) {
      const lineSeparator = project.settings.exportBlankLineBetweenLines ? "\n\n" : "\n";
      return lines.map((line) => (line.speaker ? `${line.speaker}：${line.body}` : line.body)).join(lineSeparator);
    }
    const includeSectionTitles = project.sections.length > 1;
    const lineSeparator = project.settings.exportBlankLineBetweenLines ? "\n\n" : "\n";
    const sectionTexts = project.sections.map((section) => {
      const lines = section.lines.map((line) => (line.speaker ? `${line.speaker}：${line.body}` : line.body));
      const body = lines.join(lineSeparator);
      return includeSectionTitles ? `${section.title}\n${body}` : body;
    });
    return sectionTexts.join("\n\n");
  }

  function sectionTitlePasteHtml(title) {
    return `<p style="${pasteParagraphStyle()} margin-top:10px; margin-bottom:6px;"><strong>${escapeHtml(title)}</strong></p>`;
  }

  function linePasteHtml(line) {
    const parts = [];
    if (line.speaker) {
      const color = `#${normalizeDocxColor(project.speakers[line.speaker]?.color || autoColor(line.speaker))}`;
      parts.push(`<strong style="color:${color}; font-weight:700;">${escapeHtml(line.speaker)}</strong>`);
      parts.push('<span style="font-weight:400;">：</span>');
    }
    parts.push(bodyPasteHtml(line));
    return `<p style="${pasteParagraphStyle()}">${parts.join("") || "<br>"}</p>`;
  }

  function bodyPasteHtml(line) {
    const runs = styledTextRuns(line.body, line.bodyMarks);
    if (!runs.length) return "";
    return runs.map((run) => {
      const styles = [`font-weight:${run.bold ? "700" : "400"}`];
      if (run.color) styles.push(`color:${run.color}`);
      const text = escapeHtml(run.text).replace(/\n/g, "<br>");
      return `<span style="${styles.join(";")}">${text}</span>`;
    }).join("");
  }

  function blankPasteParagraphHtml() {
    return `<p data-export-blank-line="true" style="${pasteParagraphStyle()} min-height:18pt;">&nbsp;</p>`;
  }

  function pasteParagraphStyle() {
    return 'margin:0; color:#111827; font-family:Arial, "Yu Gothic", "Yu Gothic UI", Meiryo, sans-serif; font-size:11pt; font-weight:400; line-height:1.65; background:transparent;';
  }

  function selectGoogleDocsPreview() {
    const range = document.createRange();
    range.selectNodeContents(els.googleDocsPreview);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function setGoogleDocsCopyStatus(text) {
    els.googleDocsCopyStatus.textContent = text;
  }

  function exportDocx() {
    syncProjectTitleFromInput();
    normalizeProject();
    const docx = buildGoogleDocsDocx();
    downloadBytes(
      docx,
      `${safeFileName(project.title)}.docx`,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  }

  function buildGoogleDocsDocx() {
    const documentXml = buildDocumentXml();
    const files = [
      ["[Content_Types].xml", contentTypesXml()],
      ["_rels/.rels", packageRelationshipsXml()],
      ["docProps/app.xml", appPropertiesXml()],
      ["docProps/core.xml", corePropertiesXml()],
      ["word/document.xml", documentXml],
      ["word/styles.xml", stylesXml()],
      ["word/_rels/document.xml.rels", documentRelationshipsXml()],
    ];
    return createZip(files);
  }

  function buildDocumentXml() {
    const paragraphs = [
      paragraphXml([{ text: project.title || "台本", bold: false }], "AppTitle"),
    ];

    project.sections.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) paragraphs.push(paragraphXml([], "Spacer"));
      paragraphs.push(paragraphXml([{ text: section.title, bold: true }], "SectionHeading"));
      section.lines.forEach((line, lineIndex) => {
        const runs = [];
        if (line.speaker) {
          runs.push({
            text: line.speaker,
            bold: true,
            color: normalizeDocxColor(project.speakers[line.speaker]?.color || autoColor(line.speaker)),
          });
          runs.push({ text: "：", bold: false });
        }
        if (line.body) {
          styledTextRuns(line.body, line.bodyMarks).forEach((run) => {
            runs.push({
              text: run.text,
              bold: run.bold,
              color: run.color ? normalizeDocxColor(run.color) : "",
            });
          });
        }
        paragraphs.push(paragraphXml(runs, "ScriptLine"));
        if (project.settings.exportBlankLineBetweenLines && lineIndex < section.lines.length - 1) {
          paragraphs.push(paragraphXml([], "ExportBlankLine"));
        }
      });
    });

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join("\n    ")}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  }

  function paragraphXml(runs, styleId) {
    const body = runs.length ? runs.map(runXml).join("") : runXml({ text: "" });
    return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>${body}</w:p>`;
  }

  function runXml(run) {
    const properties = [];
    properties.push('<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Yu Gothic"/>');
    if (run.bold) properties.push("<w:b/>");
    if (run.color) properties.push(`<w:color w:val="${run.color}"/>`);
    const preserveSpace = /^\s|\s$/.test(run.text) ? ' xml:space="preserve"' : "";
    return `<w:r><w:rPr>${properties.join("")}</w:rPr><w:t${preserveSpace}>${escapeXml(run.text)}</w:t></w:r>`;
  }

  function stylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Yu Gothic"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:color w:val="111827"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="80" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:rPr>
      <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Yu Gothic"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="111827"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="AppTitle">
    <w:name w:val="Script Export Title"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="0" w:after="180"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Yu Gothic"/>
      <w:sz w:val="40"/>
      <w:szCs w:val="40"/>
      <w:color w:val="111827"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="SectionHeading">
    <w:name w:val="Script Section Heading"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="160" w:after="90"/>
      <w:keepNext/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Yu Gothic"/>
      <w:b/>
      <w:sz w:val="28"/>
      <w:szCs w:val="28"/>
      <w:color w:val="111827"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ScriptLine">
    <w:name w:val="Script Line"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:after="70" w:line="276" w:lineRule="auto"/>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ExportBlankLine">
    <w:name w:val="Export Blank Line"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:spacing w:before="0" w:after="0" w:line="276" w:lineRule="auto"/>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Spacer">
    <w:name w:val="Section Spacer"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:spacing w:before="80" w:after="80"/>
    </w:pPr>
  </w:style>
</w:styles>`;
  }

  function contentTypesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
  }

  function packageRelationshipsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  }

  function documentRelationshipsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  }

  function appPropertiesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>台本制作エディタ</Application>
</Properties>`;
  }

  function corePropertiesXml() {
    const now = new Date().toISOString();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(project.title || "台本")}</dc:title>
  <dc:creator>台本制作エディタ</dc:creator>
  <cp:lastModifiedBy>台本制作エディタ</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
  }

  function createZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    files.forEach(([path, content]) => {
      const name = encoder.encode(path);
      const data = content instanceof Uint8Array ? content : encoder.encode(content);
      const crc = crc32(data);
      const localHeader = zipLocalHeader(name, data, crc);
      localParts.push(localHeader, name, data);
      centralParts.push(zipCentralHeader(name, data, crc, offset), name);
      offset += localHeader.length + name.length + data.length;
    });

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = zipEndRecord(files.length, centralSize, offset);
    return concatUint8Arrays([...localParts, ...centralParts, end]);
  }

  function zipLocalHeader(name, data, crc) {
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    return header;
  }

  function zipCentralHeader(name, data, crc, offset) {
    const header = new Uint8Array(46);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, data.length, true);
    view.setUint32(24, data.length, true);
    view.setUint16(28, name.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    return header;
  }

  function zipEndRecord(fileCount, centralSize, centralOffset) {
    const record = new Uint8Array(22);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, fileCount, true);
    view.setUint16(10, fileCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
    return record;
  }

  function concatUint8Arrays(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      output.set(part, offset);
      offset += part.length;
    });
    return output;
  }

  function crc32(data) {
    let crc = 0xffffffff;
    for (let index = 0; index < data.length; index += 1) {
      crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  function downloadBlob(content, fileName, type) {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadBytes(bytes, fileName, type) {
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function scheduleSave() {
    setSaveState("保存中...");
    hasPendingSave = false;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveProjectNow();
    }, 250);
  }

  function markSavePending() {
    clearTimeout(saveTimer);
    hasPendingSave = true;
    setSaveState("未保存の入力があります");
  }

  function flushPendingSave() {
    if (!hasPendingSave) return;
    clearTimeout(saveTimer);
    saveProjectNow();
  }

  function saveProjectNow() {
    project.updatedAt = new Date().toISOString();
    project.activeSectionId = activeSectionId;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    hasPendingSave = false;
    setSaveState(`LocalStorageに自動保存済み ${new Date().toLocaleTimeString("ja-JP")}`);
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      normalizeProject();
      renderSpeakers();
      updateMatches();
    }, 120);
  }

  function setSaveState(text) {
    if (!els.saveState) return;
    els.saveState.textContent = text;
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function autoColor(name) {
    if (!name) return "#94a3b8";
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) {
      hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
    }
    return PALETTE[hash % PALETTE.length];
  }

  function tintColor(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb) return "#edf2f7";
    return `rgb(${Math.round(rgb.r + (255 - rgb.r) * amount)}, ${Math.round(rgb.g + (255 - rgb.g) * amount)}, ${Math.round(rgb.b + (255 - rgb.b) * amount)})`;
  }

  function darkenColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return "#1f2937";
    return `rgb(${Math.round(rgb.r * 0.55)}, ${Math.round(rgb.g * 0.55)}, ${Math.round(rgb.b * 0.55)})`;
  }

  function getSpeakerBodyColor(speaker) {
    return speaker?.bodyColor || speaker?.textColor || "";
  }

  function setOptionalCssVar(element, name, value) {
    if (value) {
      element.style.setProperty(name, value);
    } else {
      element.style.removeProperty(name);
    }
  }

  function hexToRgb(hex) {
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!match) return null;
    return {
      r: parseInt(match[1], 16),
      g: parseInt(match[2], 16),
      b: parseInt(match[3], 16),
    };
  }

  function normalizeDocxColor(hex) {
    const match = /^#?([a-f\d]{6})$/i.exec(String(hex || ""));
    return match ? match[1].toUpperCase() : "111827";
  }

  function normalizeCssColor(value) {
    const source = String(value || "").trim();
    if (!source) return "";
    const hex = /^#?([a-f\d]{6})$/i.exec(source);
    if (hex) return `#${hex[1].toUpperCase()}`;
    const shortHex = /^#?([a-f\d]{3})$/i.exec(source);
    if (shortHex) {
      return `#${shortHex[1].split("").map((char) => char + char).join("").toUpperCase()}`;
    }
    const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(source);
    if (rgb) {
      const channels = rgb.slice(1, 4).map((part) => clampNumber(Number(part), 0, 255));
      return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    }
    return "";
  }

  function safeFileName(name) {
    const cleaned = String(name || "")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 80);
    return cleaned || "無題の台本";
  }

  function cleanProjectTitle(title) {
    return String(title || "").trim();
  }

  function syncProjectTitleFromInput() {
    project.title = cleanProjectTitle(els.projectTitle.value) || "無題の台本";
    els.projectTitle.value = project.title;
  }

  function escapeXml(text) {
    return String(text).replace(/[<>&"']/g, (char) => {
      return {
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      }[char];
    });
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[char];
    });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
