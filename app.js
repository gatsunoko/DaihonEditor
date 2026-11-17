(function () {
  "use strict";

  const STORAGE_KEY = "script-editor-project-v1";
  const UI_STORAGE_KEY = "script-editor-ui-v1";
  const JSON_SAVE_DIRECTORY_PICKER_ID = "script-json-save-dir";
  const FILE_HANDLE_DB_NAME = "script-editor-file-handles-v1";
  const FILE_HANDLE_STORE_NAME = "handles";
  const JSON_SAVE_HANDLE_KEY = "last-json-save-file";
  const BACKUP_DIRECTORY_HANDLE_KEY = "json-backup-directory";
  const JSON_AUTO_SAVE_DELAY = 2000;
  const STATUS_NOTICE_DURATION = 6000;
  const BACKUP_INTERVAL = 10 * 60 * 1000;
  const BACKUP_MAX_FILES = 30;
  const BACKUP_LAST_SAVED_KEY_PREFIX = "script-editor-last-backup-v1:";
  const SPEAKER_DRAG_TYPE = "application/x-script-speaker-name";
  const NOTE_END_DRAG_TYPE = "application/x-script-note-end";
  const MAX_LINE_DELETE_UNDO = 30;
  const BODY_EDIT_UNDO_GROUP_DELAY = 1000;
  const DEFAULT_NOTE_KIND = "note";
  const DEFAULT_NOTE_COLOR = "#dbeafe";
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
  const statusNoticeTimers = new WeakMap();
  let project = createDefaultProject();
  let activeSectionId = project.sections[0].id;
  let allSectionsVisible = false;
  let selectedScope = "all";
  let activeSpeakerFilter = "";
  let matches = [];
  let currentMatchIndex = -1;
  let speakerPicker = null;
  let selectedLineIds = new Set();
  let lineSelectionAnchorId = "";
  let lineClipboard = [];
  let lineDeleteUndoStack = [];
  let bodyEditUndoGroup = null;
  const editedSpeakerInputs = new WeakSet();
  let focusedLineId = "";
  let noteEndDrag = null;
  let bodySelection = null;
  let bodySelectionRange = null;
  let suppressBodyFocusScroll = false;
  let hasPendingSave = false;
  let saveTimer = 0;
  let jsonAutoSaveTimer = 0;
  let jsonAutoSaveRunning = false;
  let jsonAutoSaveQueued = false;
  let jsonAutoSavePromise = null;
  let jsonAutoSaveTargetVersion = 0;
  let renderTimer = 0;
  let compactSidebarQuery = null;
  let narrowSidebarQuery = null;
  let topbarResizeObserver = null;
  let speakerDrawerOpen = false;
  let settingsDrawerOpen = false;
  let lastJsonSaveHandle = null;
  let lastJsonSaveHandleLoaded = false;
  let lastJsonSaveHandleLoadPromise = null;
  let backupDirectoryHandle = null;
  let backupDirectoryHandleLoaded = false;
  let backupDirectoryHandleLoadPromise = null;
  let backupTimer = 0;
  let backupWriteChain = Promise.resolve();
  let loadedJsonSourceFingerprint = "";
  let loadedJsonSourceFileIdentity = null;
  let mcpCompositionActive = false;
  let mcpRevisionCounter = 0;
  let mcpLastFingerprint = "";
  const mcpRevisionPrefix = makeId("revision");
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
    setSaveState("LocalStorageに自動保存済み", { notify: false });
    showRememberedJsonAutoSaveState();
    showRememberedBackupState();
    initializeMcpEditing();
  }

  function initializeMcpEditing() {
    document.addEventListener("compositionstart", () => { mcpCompositionActive = true; }, true);
    document.addEventListener("compositionend", () => { mcpCompositionActive = false; }, true);
    window.scriptEditorMcp = Object.freeze({
      getSnapshot: getMcpSnapshot,
      applyEdits: applyMcpEdits,
    });
  }

  function mcpError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function getMcpSnapshot() {
    if (mcpCompositionActive) throw mcpError("BUSY", "文字入力の変換中です。確定してから再実行してください。");
    const snapshot = JSON.parse(JSON.stringify(projectForSave()));
    // Saving timestamps and the selected tab do not change the script content.
    const fingerprint = JSON.stringify(snapshot, (key, value) =>
      key === "updatedAt" || key === "activeSectionId" ? undefined : value);
    if (fingerprint !== mcpLastFingerprint) {
      mcpLastFingerprint = fingerprint;
      mcpRevisionCounter += 1;
    }
    return { project: snapshot, revision: `${mcpRevisionPrefix}:${mcpRevisionCounter}` };
  }

  function applyMcpEdits(args) {
    const current = getMcpSnapshot();
    if (args?.projectId !== current.project.projectId) {
      throw mcpError("PROJECT_CHANGED", "別の台本に切り替わっています。台本を再取得してください。");
    }
    if (args.expectedRevision !== current.revision) {
      throw mcpError("REVISION_CONFLICT", "台本が編集されています。最新版を読み直して変更を見直してください。");
    }
    if (!window.ScriptEditorProjectEdits) throw mcpError("EDITOR_ERROR", "AI編集機能を読み込めませんでした。画面を再読み込みしてください。");
    // Validate the entire batch on a copy before committing any browser state.
    const candidate = window.ScriptEditorProjectEdits.applyProjectEdits(projectForSave(), args.operations);
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(activeElement.tagName))) {
      activeElement.blur();
    }
    // Speaker and note blur handlers can commit additional local changes.
    if (getMcpSnapshot().revision !== args.expectedRevision) {
      throw mcpError("REVISION_CONFLICT", "入力が確定され台本が更新されました。最新版を再取得してください。");
    }
    const before = cloneProjectForUndo();
    const previousProject = project;
    const previousActiveSectionId = activeSectionId;
    project = candidate;
    try {
      normalizeProject();
      const after = getMcpSnapshot();
      if (after.revision === current.revision) {
        project = previousProject;
        activeSectionId = previousActiveSectionId;
        return { ...getMcpSnapshot(), changed: false };
      }
      // Persist before acknowledging success. JSON autosave retains its ID checks.
      saveProjectNow();
    } catch (error) {
      project = previousProject;
      activeSectionId = previousActiveSectionId;
      normalizeProject();
      renderAll();
      const code = typeof error.code === "string" ? error.code : "SAVE_FAILED";
      throw mcpError(code, code === "SAVE_FAILED" ? "変更を保存できなかったため反映を中止しました。保存領域を確認してください。" : error.message);
    }
    pushUndoEntry({ type: "mcp-edit", project: before, activeSectionId: previousActiveSectionId, allSectionsVisible, activeSpeakerFilter });
    clearLineSelectionState();
    bodySelection = null;
    bodySelectionRange = null;
    hideSpeakerPicker();
    renderAll();
    setSaveState("AIの変更を保存しました（Undoで取り消せます）", { preserveWarning: true });
    return { ...getMcpSnapshot(), changed: true, savedTo: "localStorage", jsonAutoSave: "scheduled" };
  }

  function cacheElements() {
    els.topbar = document.querySelector(".topbar");
    els.projectTitle = document.getElementById("projectTitle");
    els.sectionSearch = document.getElementById("sectionSearch");
    els.saveState = document.getElementById("saveState");
    els.sectionTabs = document.getElementById("sectionTabs");
    els.addSectionButton = document.getElementById("addSectionButton");
    els.scriptRows = document.getElementById("scriptRows");
    els.settingsPane = document.querySelector(".settings-pane");
    els.addLineButton = document.getElementById("addLineButton");
    els.undoDeleteLineButton = document.getElementById("undoDeleteLineButton");
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
    els.saveJsonAsButton = document.getElementById("saveJsonAsButton");
    els.backupSettingsButton = document.getElementById("backupSettingsButton");
    els.backupState = document.getElementById("backupState");
    els.loadJsonButton = document.getElementById("loadJsonButton");
    els.loadJsonInput = document.getElementById("loadJsonInput");
    els.exportTxtButton = document.getElementById("exportTxtButton");
    els.exportDocxButton = document.getElementById("exportDocxButton");
    els.searchInput = document.getElementById("searchInput");
    els.replaceInput = document.getElementById("replaceInput");
    els.prevMatchButton = document.getElementById("prevMatchButton");
    els.nextMatchButton = document.getElementById("nextMatchButton");
    els.replaceOneButton = document.getElementById("replaceOneButton");
    els.replaceAllButton = document.getElementById("replaceAllButton");
    els.replaceCurrentSectionOnlyInput = document.getElementById("replaceCurrentSectionOnlyInput");
    els.matchStatus = document.getElementById("matchStatus");
    els.totalBodyChars = document.getElementById("totalBodyChars");
    els.sectionBodyChars = document.getElementById("sectionBodyChars");
    els.speakerForm = document.getElementById("speakerForm");
    els.speakerNameInput = document.getElementById("speakerNameInput");
    els.speakerColorInput = document.getElementById("speakerColorInput");
    els.speakerBodyColorInput = document.getElementById("speakerBodyColorInput");
    els.speakerFilterSelect = document.getElementById("speakerFilterSelect");
    els.speakerList = document.getElementById("speakerList");
    els.furiganaVisibleInput = document.getElementById("furiganaVisibleInput");
    els.furiganaForm = document.getElementById("furiganaForm");
    els.furiganaWordInput = document.getElementById("furiganaWordInput");
    els.furiganaReadingInput = document.getElementById("furiganaReadingInput");
    els.furiganaList = document.getElementById("furiganaList");
    els.furiganaStatus = document.getElementById("furiganaStatus");
    els.exportBlankLineInput = document.getElementById("exportBlankLineInput");
    els.exportNotesInput = document.getElementById("exportNotesInput");
    els.exportNoteSeparatorInput = document.getElementById("exportNoteSeparatorInput");
    els.copyGoogleDocsButton = document.getElementById("copyGoogleDocsButton");
    els.copySpeakersOnlyGoogleDocsButton = document.getElementById("copySpeakersOnlyGoogleDocsButton");
    els.copyCurrentSectionGoogleDocsButton = document.getElementById("copyCurrentSectionGoogleDocsButton");
    els.copyFilteredGoogleDocsButton = document.getElementById("copyFilteredGoogleDocsButton");
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
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        isUndoShortcut(event) &&
        lineDeleteUndoStack.length &&
        (!isEditableTarget(event.target) || canUndoFromScriptEditor(event.target)) &&
        canUndoLastAction()
      ) {
        event.preventDefault();
        undoLastAction();
      }
    });
    document.addEventListener("selectionchange", updateBodySelectionFromDocument);
    window.addEventListener("resize", () => {
      hideSpeakerPicker();
      syncStickySidebarTop();
    });
    if (window.ResizeObserver && els.topbar) {
      topbarResizeObserver = new ResizeObserver(syncStickySidebarTop);
      topbarResizeObserver.observe(els.topbar);
    }
    window.addEventListener("scroll", handleSpeakerPickerScroll, true);
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
    els.sectionSearch.addEventListener("input", () => {
      renderTabs();
      els.sectionTabs.scrollLeft = 0;
      renderRows();
      renderSpeakers();
      renderStats();
      updateMatches();
    });

    els.addSectionButton.addEventListener("mousedown", (event) => event.preventDefault());
    els.addSectionButton.addEventListener("click", addSection);
    els.addLineButton.addEventListener("click", () => {
      addLineAfter(getActiveSection().lines.length - 1);
    });
    els.undoDeleteLineButton.addEventListener("click", undoLastAction);
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
    els.newProjectButton.addEventListener("click", async () => {
      if (!confirm("現在の台本を閉じて新規作成しますか？")) return;
      if (!(await saveCurrentProjectBeforeSwitch())) return;
      clearTimeout(backupTimer);
      backupTimer = 0;
      forgetRememberedJsonSaveHandle();
      project = createDefaultProject();
      loadedJsonSourceFingerprint = "";
      loadedJsonSourceFileIdentity = null;
      activeSectionId = project.sections[0].id;
      allSectionsVisible = false;
      activeSpeakerFilter = "";
      selectedLineIds.clear();
      lineSelectionAnchorId = "";
      lineDeleteUndoStack = [];
      focusedLineId = "";
      renderAll();
      scheduleSave();
    });
    els.saveJsonButton.addEventListener("click", () => {
      saveJson().catch((error) => {
        if (error?.name === "AbortError") return;
        console.error(error);
        alert(`JSONを保存できませんでした。\n\n${fileOperationErrorDetail(error)}`);
      });
    });
    els.saveJsonAsButton.addEventListener("click", () => {
      saveJsonAs().catch((error) => {
        if (error?.name === "AbortError") return;
        console.error(error);
        alert(`JSONを別名保存できませんでした。\n\n${fileOperationErrorDetail(error)}`);
      });
    });
    els.backupSettingsButton.addEventListener("click", () => {
      chooseBackupDirectory().catch((error) => {
        if (error?.name === "AbortError") return;
        console.error(error);
        alert("バックアップフォルダを設定できませんでした。");
      });
    });
    els.loadJsonButton.addEventListener("click", () => {
      chooseJsonFileToLoad().catch((error) => {
        if (error?.name === "AbortError") return;
        console.error(error);
        alert("JSONを読み込めませんでした。");
      });
    });
    els.loadJsonInput.addEventListener("change", loadJsonFile);
    els.exportTxtButton.addEventListener("click", exportTxt);
    els.exportDocxButton.addEventListener("click", exportDocx);
    els.exportBlankLineInput.addEventListener("change", () => {
      project.settings.exportBlankLineBetweenLines = els.exportBlankLineInput.checked;
      renderGoogleDocsPreview();
      scheduleSave();
    });
    els.exportNotesInput.addEventListener("change", () => {
      project.settings.exportNotes = els.exportNotesInput.checked;
      renderGoogleDocsPreview();
      scheduleSave();
    });
    els.exportNoteSeparatorInput.addEventListener("change", () => {
      project.settings.exportNoteSeparators = els.exportNoteSeparatorInput.checked;
      renderGoogleDocsPreview();
      scheduleSave();
    });
    els.furiganaVisibleInput.addEventListener("change", () => {
      project.settings.showFurigana = els.furiganaVisibleInput.checked;
      renderRows();
      renderGoogleDocsPreview();
      setFuriganaStatus(project.settings.showFurigana ? "ふりがなを表示します。" : "ふりがなを非表示にしました。");
      scheduleSave();
    });
    els.furiganaForm.addEventListener("submit", (event) => {
      event.preventDefault();
      registerFuriganaEntry();
    });
    els.copyGoogleDocsButton.addEventListener("click", copyGoogleDocsRichText);
    els.copySpeakersOnlyGoogleDocsButton.addEventListener("click", copySpeakersOnlyGoogleDocsRichText);
    els.copyCurrentSectionGoogleDocsButton.addEventListener("click", copyCurrentSectionGoogleDocsRichText);
    els.copyFilteredGoogleDocsButton.addEventListener("click", copyFilteredSpeakerGoogleDocsRichText);
    els.copySelectedGoogleDocsButton.addEventListener("click", copySelectedGoogleDocsRichText);

    els.searchInput.addEventListener("input", updateMatches);
    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      moveMatch(1, false);
    });
    els.replaceCurrentSectionOnlyInput.addEventListener("change", updateMatches);
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
    els.speakerFilterSelect.addEventListener("change", () => {
      activeSpeakerFilter = els.speakerFilterSelect.value;
      clearLineSelectionState();
      hideSpeakerPicker();
      renderRows();
      renderStats();
      updateFilteredGoogleDocsButton();
      updateMatches();
    });
  }

  function createDefaultProject() {
    const sectionId = makeId("section");
    return {
      projectId: createProjectId(),
      title: "無題の台本",
      activeSectionId: sectionId,
      sections: [
        {
          id: sectionId,
          title: "01 オープニング",
          lines: [createLine()],
          notes: [],
        },
      ],
      speakers: {},
      speakerOrder: [],
      furigana: [],
      settings: {
        exportBlankLineBetweenLines: false,
        exportNotes: false,
        exportNoteSeparators: false,
        showFurigana: true,
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
    speakerDrawerOpen = false;
    applySidebarVisibility();
  }

  function applySidebarVisibility() {
    syncStickySidebarTop();
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

  function syncStickySidebarTop() {
    if (!els.topbar) return;
    const rootStyles = getComputedStyle(document.documentElement);
    const pagePadding = Number.parseFloat(rootStyles.getPropertyValue("--page-padding")) || 0;
    const topbarBottom = els.topbar.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty("--sticky-sidebar-top", `${Math.ceil(topbarBottom + pagePadding)}px`);
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
      projectId: typeof raw.projectId === "string" && raw.projectId.trim() ? raw.projectId : fallback.projectId,
      title: typeof raw.title === "string" ? raw.title : fallback.title,
      activeSectionId: typeof raw.activeSectionId === "string" ? raw.activeSectionId : raw.sections[0]?.id,
      sections: raw.sections.length
        ? raw.sections.map(hydrateSection)
        : fallback.sections,
      speakers: raw.speakers && typeof raw.speakers === "object" ? raw.speakers : {},
      speakerOrder: Array.isArray(raw.speakerOrder) ? raw.speakerOrder.filter((name) => typeof name === "string") : [],
      furigana: normalizeFuriganaEntries(raw.furigana),
      settings: {
        ...fallback.settings,
        ...(raw.settings && typeof raw.settings === "object" ? raw.settings : {}),
        exportBlankLineBetweenLines: Boolean(raw.settings?.exportBlankLineBetweenLines),
        exportNotes: Boolean(raw.settings?.exportNotes),
        exportNoteSeparators: Boolean(raw.settings?.exportNoteSeparators),
        showFurigana: raw.settings?.showFurigana !== false,
      },
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  }

  function hydrateSection(section, sectionIndex) {
    const lines = Array.isArray(section.lines) && section.lines.length
      ? section.lines.map(hydrateLine)
      : [createLine()];
    return {
      id: section.id || makeId("section"),
      title: section.title || `${String(sectionIndex + 1).padStart(2, "0")} セクション`,
      lines,
      notes: Array.isArray(section.notes) ? section.notes.map(hydrateNote) : [],
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

  function hydrateNote(note) {
    const startLineId = typeof note?.startLineId === "string" ? note.startLineId : "";
    const endLineId = typeof note?.endLineId === "string" ? note.endLineId : startLineId;
    return {
      id: note?.id || makeId("note"),
      kind: typeof note?.kind === "string" && note.kind ? note.kind : DEFAULT_NOTE_KIND,
      text: typeof note?.text === "string" ? note.text : "",
      color: normalizeNoteColor(note?.color),
      startLineId,
      endLineId,
    };
  }

  function normalizeProject() {
    if (!project.sections.length) project.sections.push(createDefaultProject().sections[0]);
    if (!project.sections.some((section) => section.id === activeSectionId)) {
      activeSectionId = project.sections[0].id;
    }
    if (!project.settings || typeof project.settings !== "object") project.settings = {};
    project.settings.exportBlankLineBetweenLines = Boolean(project.settings.exportBlankLineBetweenLines);
    project.settings.exportNotes = Boolean(project.settings.exportNotes);
    project.settings.exportNoteSeparators = Boolean(project.settings.exportNoteSeparators);
    project.settings.showFurigana = project.settings.showFurigana !== false;
    project.furigana = normalizeFuriganaEntries(project.furigana);
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
      section.notes = normalizeSectionNotes(section);
    });
    pruneUnusedAutoSpeakers();
    syncSpeakerOrder();
  }

  function normalizeSectionNotes(section) {
    const lineIds = new Set(section.lines.map((line) => line.id));
    const notes = Array.isArray(section.notes) ? section.notes.map(hydrateNote) : [];
    return notes
      .map((note) => {
        const hasStart = lineIds.has(note.startLineId);
        const hasEnd = lineIds.has(note.endLineId);
        if (!hasStart && !hasEnd) return null;
        const startLineId = hasStart ? note.startLineId : note.endLineId;
        const endLineId = hasEnd ? note.endLineId : startLineId;
        const normalized = { ...note, startLineId, endLineId };
        return orderNoteEndpoints(section, normalized);
      })
      .filter(Boolean);
  }

  function orderNoteEndpoints(section, note) {
    const startIndex = section.lines.findIndex((line) => line.id === note.startLineId);
    const endIndex = section.lines.findIndex((line) => line.id === note.endLineId);
    if (startIndex < 0 || endIndex < 0 || startIndex <= endIndex) return note;
    return {
      ...note,
      startLineId: note.endLineId,
      endLineId: note.startLineId,
    };
  }

  function renderAll() {
    els.projectTitle.value = project.title;
    renderTabs();
    renderRows();
    renderSpeakers();
    renderFuriganaSettings();
    renderStats();
    renderExportSettings();
    renderGoogleDocsPreview();
    updateCurrentSectionGoogleDocsButton();
    updateFilteredGoogleDocsButton();
    updateFooterActionAvailability();
    updateMatches();
  }

  function renderExportSettings() {
    els.exportBlankLineInput.checked = Boolean(project.settings?.exportBlankLineBetweenLines);
    els.exportNotesInput.checked = Boolean(project.settings?.exportNotes);
    els.exportNoteSeparatorInput.checked = Boolean(project.settings?.exportNoteSeparators);
  }

  function renderFuriganaSettings() {
    els.furiganaVisibleInput.checked = isFuriganaVisible();
    renderFuriganaList();
  }

  function updateFooterActionAvailability() {
    if (els.addLineButton) {
      els.addLineButton.disabled = allSectionsVisible;
      els.addLineButton.title = allSectionsVisible ? "全表示中は個別セクションを選んでから行を追加してください" : "";
    }
    [els.copyLinesButton, els.cutLinesButton, els.pasteLinesButton].forEach((button) => {
      if (!button) return;
      button.disabled = allSectionsVisible;
      button.title = allSectionsVisible ? "全表示中は行の選択操作はできません" : "";
    });
  }

  function renderGoogleDocsPreview() {
    if (!els.googleDocsPreview) return;
    els.googleDocsPreview.innerHTML = buildGoogleDocsPasteHtmlBody();
  }

  function normalizeSectionSearch(value) {
    return String(value || "").normalize("NFKC").toLowerCase().trim();
  }

  function sectionMatchesSearch(section) {
    return normalizeSectionSearch(section.title).includes(normalizeSectionSearch(els.sectionSearch.value));
  }

  function getDisplayedSections() {
    const sections = allSectionsVisible ? project.sections : [getActiveSection()];
    return sections.filter(sectionMatchesSearch);
  }

  function renderTabs() {
    els.sectionTabs.innerHTML = "";
    const allItem = document.createElement("div");
    allItem.className = `tab-item all-sections-tab${allSectionsVisible ? " active" : ""}`;
    const allTab = document.createElement("button");
    allTab.className = "tab";
    allTab.type = "button";
    allTab.setAttribute("role", "tab");
    allTab.setAttribute("aria-selected", String(allSectionsVisible));
    const allTitle = document.createElement("span");
    allTitle.className = "tab-title";
    allTitle.textContent = "全て表示";
    allTab.appendChild(allTitle);
    allTab.addEventListener("mousedown", (event) => activateSectionTabFromPointer(event, activateAllSections));
    allTab.addEventListener("click", activateAllSections);
    allItem.appendChild(allTab);
    els.sectionTabs.appendChild(allItem);

    project.sections.forEach((section, index) => {
      if (!sectionMatchesSearch(section)) return;
      const isActive = !allSectionsVisible && section.id === activeSectionId;
      const item = document.createElement("div");
      item.className = `tab-item${isActive ? " active" : ""}`;

      const tab = document.createElement("button");
      tab.className = "tab";
      tab.type = "button";
      tab.title = section.title;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(isActive));

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = section.title;
      const dot = document.createElement("span");
      dot.className = "tab-dot";
      tab.append(title, dot);

      tab.addEventListener("mousedown", (event) => {
        activateSectionTabFromPointer(event, () => activateSection(section.id));
      });
      tab.addEventListener("click", () => activateSection(section.id));
      tab.addEventListener("dblclick", () => renameSection(section.id));

      const actions = document.createElement("div");
      actions.className = "tab-actions";

      const movePrevious = createSectionActionButton("前へ移動", "‹", () => moveSection(section.id, -1));
      movePrevious.disabled = index === 0;
      const moveNext = createSectionActionButton("後へ移動", "›", () => moveSection(section.id, 1));
      moveNext.disabled = index === project.sections.length - 1;
      const remove = createSectionActionButton("削除", "×", () => deleteSection(section.id), "delete");
      remove.disabled = project.sections.length <= 1;

      actions.append(movePrevious, moveNext, remove);
      item.append(tab, actions);
      els.sectionTabs.appendChild(item);
    });
  }

  function activateSectionTabFromPointer(event, activate) {
    if (event.button !== 0) return;
    event.preventDefault();

    const windowX = window.scrollX;
    const windowY = window.scrollY;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== event.currentTarget) {
      focused.blur();
    }

    activate();

    const restoreWindowPosition = () => window.scrollTo(windowX, windowY);
    restoreWindowPosition();
    requestAnimationFrame(restoreWindowPosition);
  }

  function renderRows() {
    bodyEditUndoGroup = null;
    hideSpeakerPicker();
    const sectionsToRender = getDisplayedSections();
    const speakerFilter = getActiveSpeakerFilter();
    let visibleCount = 0;
    els.scriptRows.innerHTML = "";
    sectionsToRender.forEach((section) => {
      const heading = allSectionsVisible ? createAllSectionHeading(section) : null;
      let sectionVisibleCount = 0;
      if (heading) els.scriptRows.appendChild(heading);

      section.lines.forEach((line, index) => {
      if (!lineMatchesSpeakerFilter(line, speakerFilter)) return;
      visibleCount += 1;
      sectionVisibleCount += 1;
      const speaker = project.speakers[line.speaker];
      const color = speaker?.color || autoColor(line.speaker);
      const bodyColor = getSpeakerBodyColor(speaker);
      const row = document.createElement("div");
      row.className = `script-row${selectedLineIds.has(line.id) ? " selected" : ""}`;
      row.dataset.sectionId = section.id;
      row.dataset.lineId = line.id;
      row.addEventListener("click", () => {
        focusedLineId = line.id;
      });
      if (!allSectionsVisible) {
        row.addEventListener("dragover", (event) => handleLineDragOver(event, row));
        row.addEventListener("dragleave", () => clearLineDropClasses(row));
        row.addEventListener("drop", (event) => handleLineDrop(event, line.id, row));
      }
      row.style.setProperty("--speaker-bg", tintColor(color, 0.84));
      row.style.setProperty("--speaker-text", darkenColor(color));
      setOptionalCssVar(row, "--body-text", bodyColor);

      const number = document.createElement("div");
      number.className = "line-number";
      const displayLineNumber = allSectionsVisible
        ? visibleCount
        : speakerFilter
          ? sectionVisibleCount
          : index + 1;
      number.textContent = String(displayLineNumber).padStart(3, "0");
      if (allSectionsVisible) {
        number.draggable = false;
        number.title = "全表示中は行移動と複数選択はできません";
      } else {
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
      }

      const noteState = noteStateForLine(section, index);
      const noteCell = createNoteCell(section, line, index, noteState);

      const speakerCell = document.createElement("div");
      speakerCell.className = "speaker-cell";
      const speakerHighlight = document.createElement("div");
      speakerHighlight.className = "speaker-highlight-layer";
      speakerHighlight.setAttribute("aria-hidden", "true");
      const speakerInput = document.createElement("input");
      speakerInput.className = "speaker-input";
      speakerInput.type = "text";
      speakerInput.value = line.speaker;
      speakerInput.placeholder = line.type === "dialogue" ? "話者名" : TYPE_LABELS[line.type];
      speakerInput.addEventListener("input", () => preserveEditorScroll(() => {
        editedSpeakerInputs.add(speakerInput);
        bodyEditUndoGroup = null;
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
      }));
      speakerInput.addEventListener("focus", () => {
        editedSpeakerInputs.delete(speakerInput);
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
      if (!allSectionsVisible) {
        speakerInput.addEventListener("paste", (event) => handlePaste(event, index));
        speakerInput.addEventListener("keydown", (event) => handleRowKey(event, index, "speaker"));
      }

      speakerCell.append(speakerHighlight, speakerInput);

      const bodyCell = document.createElement("div");
      bodyCell.className = "body-cell";
      const colon = document.createElement("div");
      colon.className = "colon";
      colon.textContent = line.speaker ? "：" : "";
      const bodyInput = document.createElement("div");
      bodyInput.className = `body-input ${line.type}`;
      bodyInput.classList.toggle("speakerless-direction", line.type === "direction" && !line.speaker);
      bodyInput.contentEditable = "true";
      bodyInput.setAttribute("role", "textbox");
      bodyInput.setAttribute("aria-label", "本文");
      bodyInput.dataset.placeholder = "本文";
      bodyInput.innerHTML = bodyEditorHtml(line);
      let beforeInputSelection = null;
      let bodyComposing = false;
      let bodyCompositionEnding = false;
      bodyInput.addEventListener("compositionstart", () => {
        bodyComposing = true;
        bodyEditUndoGroup = null;
      });
      bodyInput.addEventListener("compositionend", () => {
        bodyComposing = false;
        bodyCompositionEnding = true;
        const compositionEntry = bodyEditUndoGroup?.entry;
        // 確定入力が compositionend の後に発火しても、同じ履歴にまとめる。
        setTimeout(() => {
          bodyCompositionEnding = false;
          if (bodyEditUndoGroup?.entry === compositionEntry) bodyEditUndoGroup = null;
        }, 0);
      });
      bodyInput.addEventListener("input", (event) => preserveEditorScroll(() => {
        const previousBody = bodyStateForUndo(line);
        syncBodyEditorToLine(bodyInput, line);
        line.type = inferType(line.speaker, line.body, line.type);
        recordBodyEditUndo(section.id, line, previousBody, beforeInputSelection, {
          inputType: event.inputType,
          composing: bodyComposing || event.isComposing,
          compositionCommit: bodyCompositionEnding,
          selection: selectionOffsetsForEditor(bodyInput),
        });
        beforeInputSelection = null;
        if (shouldAutoRegisterSpeaker(line)) ensureSpeaker(line.speaker, undefined, true);
        pruneUnusedAutoSpeakers();
        syncRowVisual();
        resizeBodyInput(bodyInput);
        renderSpeakers();
        renderStats();
        renderGoogleDocsPreview();
        updateMatches();
        markSavePending();
      }));
      bodyInput.addEventListener("focus", () => {
        bodyEditUndoGroup = null;
        bodyInput.querySelectorAll(".furigana-annotation").forEach((annotation) => annotation.remove());
        flushPendingSave();
        focusedLineId = line.id;
        captureBodySelection(line.id, bodyInput);
        resizeBodyInput(bodyInput);
        if (!suppressBodyFocusScroll) centerRowForEditing(row);
      });
      bodyInput.addEventListener("beforeinput", (event) => {
        if (event.inputType === "historyUndo" && !bodyComposing && !event.isComposing &&
          canUndoFromScriptEditor(bodyInput) && canUndoLastAction()) {
          event.preventDefault();
          undoLastAction();
          return;
        }
        captureBodySelection(line.id, bodyInput);
        beforeInputSelection = selectionOffsetsForEditor(bodyInput);
      });
      bodyInput.addEventListener("blur", () => {
        bodyEditUndoGroup = null;
        bodyInput.innerHTML = bodyEditorHtml(line);
        resizeBodyInput(bodyInput);
        flushPendingSave();
      });
      bodyInput.addEventListener("mouseup", () => captureBodySelection(line.id, bodyInput));
      bodyInput.addEventListener("keyup", () => preserveEditorScroll(() => {
        captureBodySelection(line.id, bodyInput);
        resizeBodyInput(bodyInput);
      }));
      if (!allSectionsVisible) {
        bodyInput.addEventListener("paste", (event) => handleBodyPaste(event, index));
        bodyInput.addEventListener("keydown", (event) => handleRowKey(event, index, "body"));
      }
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
      if (!allSectionsVisible) tools.appendChild(deleteButton);

      row.append(number, noteCell, speakerCell, bodyCell, tools);
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
        bodyInput.classList.toggle("speakerless-direction", line.type === "direction" && !line.speaker);
        syncSpeakerSearchHighlight(speakerCell, speakerHighlight, line);
        if (document.activeElement !== bodyInput) bodyInput.innerHTML = bodyEditorHtml(line);
      }
      syncSpeakerSearchHighlight(speakerCell, speakerHighlight, line);
      });
      if (heading && speakerFilter && sectionVisibleCount === 0) heading.remove();
    });
    if (sectionsToRender.length === 0 || (speakerFilter && visibleCount === 0)) {
      const empty = document.createElement("div");
      empty.className = "speaker-filter-empty";
      empty.textContent = sectionsToRender.length === 0
        ? project.sections.some(sectionMatchesSearch)
          ? "選択中のセクションは検索条件に一致しません。一覧からセクションを選ぶか、「全て表示」を選んでください。"
          : "検索条件に一致するセクションはありません。"
        : "表示対象の行はありません。";
      els.scriptRows.appendChild(empty);
    }
    updateSelectedLineStatus();
    updateLineDeleteUndoButton();
    updateFilteredGoogleDocsButton();
  }

  function createAllSectionHeading(section) {
    const heading = document.createElement("div");
    heading.className = "all-section-heading";
    const title = document.createElement("span");
    title.className = "all-section-title";
    title.textContent = section.title;
    title.title = section.title;
    const count = document.createElement("span");
    count.className = "all-section-count";
    count.textContent = `${section.lines.length}行`;
    heading.append(title, count);
    return heading;
  }

  function createNoteCell(section, line, lineIndex, noteState) {
    const cell = document.createElement("div");
    cell.className = "note-cell";
    const readOnly = allSectionsVisible;
    if (!readOnly) {
      cell.addEventListener("click", (event) => {
        if (event.target.closest("button") || event.target.closest(".note-text")) return;
        event.stopPropagation();
        if (noteState) {
          focusNoteEditor(noteState.note.id);
          return;
        }
        addNoteFromCellClick(section, lineIndex);
      });
    }

    if (!noteState) return cell;

    const { note, bounds, extraCount } = noteState;
    const isStart = lineIndex === bounds.startIndex;
    const isEnd = lineIndex === bounds.endIndex;
    cell.classList.add("has-note");
    if (isStart) cell.classList.add("note-start");
    if (isEnd) cell.classList.add("note-end");
    if (!isStart && !isEnd) cell.classList.add("note-middle");
    if (noteEndDrag?.noteId === note.id) {
      cell.classList.add("note-active");
    }
    cell.style.setProperty("--note-bg", note.color || DEFAULT_NOTE_COLOR);

    const rail = document.createElement("div");
    rail.className = "note-rail";
    cell.appendChild(rail);

    if (isStart) {
      const content = document.createElement("div");
      content.className = "note-card";

      const text = document.createElement("div");
      text.className = "note-text";
      text.contentEditable = !readOnly;
      text.setAttribute("role", "textbox");
      text.setAttribute("aria-label", "備考");
      text.dataset.noteId = note.id;
      text.dataset.placeholder = "備考を入力";
      text.textContent = note.text || "";
      if (!readOnly) {
        text.addEventListener("input", () => preserveEditorScroll(() => {
          note.text = editablePlainText(text);
          renderGoogleDocsPreview();
          markSavePending();
        }));
        text.addEventListener("focus", () => {
          focusedLineId = line.id;
        });
        text.addEventListener("keydown", (event) => handleNoteKey(event, section, lineIndex, note, text));
        text.addEventListener("blur", () => handleNoteTextBlur(section.id, note.id, text));
        text.addEventListener("paste", pastePlainTextIntoEditable);
      }
      content.append(text);
      if (extraCount > 0) {
        const overlap = document.createElement("div");
        overlap.className = "note-overlap-count";
        overlap.textContent = `+${extraCount}`;
        content.appendChild(overlap);
      }
      cell.appendChild(content);
    }

    if (isEnd && !readOnly) {
      const handle = document.createElement("button");
      handle.className = "note-end-handle";
      handle.type = "button";
      handle.title = "ドラッグして備考の終点を変更";
      handle.textContent = "↕";
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) => {
        noteEndDrag = { sectionId: section.id, noteId: note.id };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(NOTE_END_DRAG_TYPE, JSON.stringify(noteEndDrag));
      });
      handle.addEventListener("dragend", () => {
        noteEndDrag = null;
        clearAllLineDropClasses();
        renderRows();
      });
      cell.appendChild(handle);
    }

    return cell;
  }

  function editablePlainText(editor) {
    return String(editor.innerText || "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  }

  function noteStateForLine(section, lineIndex) {
    const hits = (section.notes || [])
      .map((note) => {
        const bounds = noteRangeBounds(section, note);
        if (!bounds || lineIndex < bounds.startIndex || lineIndex > bounds.endIndex) return null;
        return { note, bounds };
      })
      .filter(Boolean)
      .sort((a, b) => a.bounds.startIndex - b.bounds.startIndex || a.bounds.endIndex - b.bounds.endIndex);
    if (!hits.length) return null;
    return { ...hits[0], extraCount: hits.length - 1 };
  }

  function noteRangeBounds(section, note) {
    const startIndex = section.lines.findIndex((line) => line.id === note.startLineId);
    const endIndex = section.lines.findIndex((line) => line.id === note.endLineId);
    if (startIndex < 0 || endIndex < 0) return null;
    return {
      startIndex: Math.min(startIndex, endIndex),
      endIndex: Math.max(startIndex, endIndex),
    };
  }

  function notesStartingAtLine(section, lineIndex) {
    return (section.notes || [])
      .filter((note) => String(note.text || "").trim())
      .map((note) => ({ note, bounds: noteRangeBounds(section, note) }))
      .filter((item) => item.bounds && item.bounds.startIndex === lineIndex);
  }

  function formatNoteRange(bounds) {
    const start = bounds.startIndex + 1;
    const end = bounds.endIndex + 1;
    return start === end ? String(start).padStart(3, "0") : `${String(start).padStart(3, "0")}-${String(end).padStart(3, "0")}`;
  }

  function addNoteFromCellClick(section, lineIndex) {
    if (allSectionsVisible) {
      alert("備考はセクションを1つ選んだ状態で追加してください。");
      return;
    }
    const bounds = noteBoundsForCellClick(section, lineIndex);
    createNoteForBounds(section, bounds);
  }

  function noteBoundsForCellClick(section, lineIndex) {
    const clickedLine = section.lines[lineIndex];
    if (!clickedLine || !selectedLineIds.has(clickedLine.id)) {
      return { startIndex: lineIndex, endIndex: lineIndex };
    }
    return currentNoteSelectionBounds(section) || { startIndex: lineIndex, endIndex: lineIndex };
  }

  function createNoteForBounds(section, bounds) {
    if (!bounds) return;
    if (hasNoteOverlap(section, bounds.startIndex, bounds.endIndex)) {
      alert("既存の備考と重なる範囲には追加できません。先に範囲を調整してください。");
      return;
    }
    if (!Array.isArray(section.notes)) section.notes = [];
    const note = {
      id: makeId("note"),
      kind: DEFAULT_NOTE_KIND,
      text: "",
      color: DEFAULT_NOTE_COLOR,
      startLineId: section.lines[bounds.startIndex].id,
      endLineId: section.lines[bounds.endIndex].id,
    };
    section.notes.push(note);
    normalizeProject();
    renderAll();
    requestAnimationFrame(() => focusNoteEditor(note.id));
  }

  function currentNoteSelectionBounds(section) {
    const selectedIndexes = section.lines
      .map((line, index) => (selectedLineIds.has(line.id) ? index : -1))
      .filter((index) => index >= 0);
    if (selectedIndexes.length) {
      return {
        startIndex: Math.min(...selectedIndexes),
        endIndex: Math.max(...selectedIndexes),
      };
    }
    const focusedIndex = focusedLineId ? section.lines.findIndex((line) => line.id === focusedLineId) : -1;
    if (focusedIndex < 0) return null;
    return { startIndex: focusedIndex, endIndex: focusedIndex };
  }

  function hasNoteOverlap(section, startIndex, endIndex, ignoreNoteId = "") {
    return (section.notes || []).some((note) => {
      if (note.id === ignoreNoteId) return false;
      const bounds = noteRangeBounds(section, note);
      if (!bounds) return false;
      return startIndex <= bounds.endIndex && endIndex >= bounds.startIndex;
    });
  }

  function handleNoteTextBlur(sectionId, noteId, editor) {
    const note = findSectionNote(sectionId, noteId);
    if (!note) return;
    note.text = editablePlainText(editor);
    if (!note.text.trim()) {
      removeNote(sectionId, noteId);
      return;
    }
    flushPendingSave();
  }

  function handleNoteKey(event, section, lineIndex, note, editor) {
    if (event.key !== "Tab" || event.shiftKey) return;
    const nextLineIndex = lineIndex + 1;
    if (!section.lines[nextLineIndex]) return;

    event.preventDefault();
    note.text = editablePlainText(editor);
    if (!note.text.trim()) {
      section.notes = section.notes.filter((item) => item.id !== note.id);
    }

    let nextNoteState = noteStateForLine(section, nextLineIndex);
    if (!nextNoteState) {
      const nextLine = section.lines[nextLineIndex];
      const nextNote = {
        id: makeId("note"),
        kind: DEFAULT_NOTE_KIND,
        text: "",
        color: DEFAULT_NOTE_COLOR,
        startLineId: nextLine.id,
        endLineId: nextLine.id,
      };
      section.notes.push(nextNote);
      nextNoteState = { note: nextNote };
    }

    normalizeProject();
    renderAll();
    scheduleSave();
    requestAnimationFrame(() => focusNoteEditor(nextNoteState.note.id));
  }

  function focusNoteEditor(noteId) {
    const editor = els.scriptRows.querySelector(`.note-text[data-note-id="${cssEscape(noteId)}"]`);
    if (!editor) return;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function removeNote(sectionId, noteId) {
    const section = project.sections.find((item) => item.id === sectionId);
    if (!section || !Array.isArray(section.notes)) return;
    section.notes = section.notes.filter((item) => item.id !== noteId);
    if (noteEndDrag?.noteId === noteId) noteEndDrag = null;
    renderAll();
    scheduleSave();
  }

  function canSetNoteEndToLine(sectionId, noteId, lineId) {
    const section = project.sections.find((item) => item.id === sectionId);
    const note = findSectionNote(sectionId, noteId);
    if (!section || !note) return false;
    const startIndex = section.lines.findIndex((line) => line.id === note.startLineId);
    const targetIndex = section.lines.findIndex((line) => line.id === lineId);
    return startIndex >= 0 && targetIndex >= startIndex;
  }

  function setNoteEndToLine(sectionId, noteId, lineId) {
    const section = project.sections.find((item) => item.id === sectionId);
    const note = findSectionNote(sectionId, noteId);
    if (!section || !note) return;
    if (!canSetNoteEndToLine(sectionId, noteId, lineId)) {
      alert("終点は開始行より下の行にしてください。");
      return;
    }
    const targetIndex = section.lines.findIndex((line) => line.id === lineId);
    if (hasNoteOverlap(section, section.lines.findIndex((line) => line.id === note.startLineId), targetIndex, noteId)) {
      alert("既存の備考と重なる範囲には変更できません。");
      return;
    }
    note.endLineId = lineId;
    noteEndDrag = null;
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function findSectionNote(sectionId, noteId) {
    const section = project.sections.find((item) => item.id === sectionId);
    if (!section || !Array.isArray(section.notes)) return null;
    return section.notes.find((note) => note.id === noteId) || null;
  }

  function resizeBodyInput(input) {
    // contenteditable の div は内容と幅に合わせて自動で伸縮する。
    // 固定高を残すと、サイドバー開閉後に折り返しが減っても行だけ縮まない。
    input.style.removeProperty("height");
  }

  function preserveEditorScroll(callback) {
    const position = captureEditorScrollPosition();
    const result = callback();
    restoreEditorScrollPosition(position);
    requestAnimationFrame(() => restoreEditorScrollPosition(position));
    return result;
  }

  function captureEditorScrollPosition() {
    return {
      rowsScrollTop: els.scriptRows ? els.scriptRows.scrollTop : 0,
      windowX: window.scrollX,
      windowY: window.scrollY,
    };
  }

  function restoreEditorScrollPosition(position) {
    if (!position) return;
    if (els.scriptRows) els.scriptRows.scrollTop = position.rowsScrollTop;
    if (window.scrollX !== position.windowX || window.scrollY !== position.windowY) {
      window.scrollTo(position.windowX, position.windowY);
    }
  }

  function getActiveSpeakerFilter() {
    if (activeSpeakerFilter && !project.speakers?.[activeSpeakerFilter]) {
      activeSpeakerFilter = "";
    }
    return activeSpeakerFilter;
  }

  function lineMatchesSpeakerFilter(line, speakerFilter = getActiveSpeakerFilter()) {
    return !speakerFilter || line.speaker === speakerFilter;
  }

  function centerRowForEditing(row) {
    requestAnimationFrame(() => {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function bodyEditorHtml(line) {
    const runs = styledTextRuns(line.body, line.bodyMarks);
    if (!runs.length) return "";
    const query = searchQueryForField("body");
    const current = currentMatchForLineField(line.id, "body");
    const furiganaByEnd = new Map(furiganaMatches(line.body).map((match) => [match.end, match.reading]));
    let offset = 0;
    return runs.map((run) => {
      const styles = [];
      if (run.bold) styles.push("font-weight:900");
      if (run.color) styles.push(`color:${run.color}`);
      const runStart = offset;
      const runEnd = runStart + run.text.length;
      const boundaries = Array.from(furiganaByEnd.keys())
        .filter((end) => end > runStart && end < runEnd)
        .sort((a, b) => a - b);
      const pieces = [];
      let pieceStart = runStart;
      [...boundaries, runEnd].forEach((pieceEnd) => {
        if (pieceEnd > pieceStart) {
          const text = highlightSearchText(
            line.body.slice(pieceStart, pieceEnd),
            query,
            pieceStart,
            current?.start ?? -1,
          ).replace(/\n/g, "<br>");
          pieces.push(styles.length ? `<span style="${styles.join(";")}">${text}</span>` : text);
        }
        const reading = furiganaByEnd.get(pieceEnd);
        if (reading) {
          pieces.push(`<span class="furigana-annotation" contenteditable="false" data-furigana="${escapeHtml(reading)}" aria-label="ふりがな ${escapeHtml(reading)}"></span>`);
        }
        pieceStart = pieceEnd;
      });
      offset = runEnd;
      return pieces.join("");
    }).join("");
  }

  function searchQueryForField(field) {
    const query = String(els.searchInput?.value || "");
    if (!query) return "";
    if (selectedScope !== "all" && selectedScope !== field) return "";
    return query;
  }

  function currentMatchForLineField(lineId, field) {
    const current = matches[currentMatchIndex];
    if (!current || current.lineId !== lineId || current.field !== field) return null;
    return current;
  }

  function highlightSearchText(text, query, baseOffset = 0, currentStart = -1) {
    const source = String(text || "");
    if (!query) return escapeHtml(source);
    let html = "";
    let cursor = 0;
    let index = source.indexOf(query, cursor);
    while (index >= 0) {
      html += escapeHtml(source.slice(cursor, index));
      const absoluteStart = baseOffset + index;
      const className = absoluteStart === currentStart ? "search-hit current-search-hit" : "search-hit";
      html += `<mark class="${className}">${escapeHtml(source.slice(index, index + query.length))}</mark>`;
      cursor = index + query.length;
      index = source.indexOf(query, cursor);
    }
    html += escapeHtml(source.slice(cursor));
    return html;
  }

  function syncSpeakerSearchHighlight(cell, layer, line) {
    const query = searchQueryForField("speaker");
    const hasHighlight = Boolean(query && line.speaker.includes(query));
    cell.classList.toggle("search-highlight-visible", hasHighlight);
    if (!hasHighlight) {
      layer.textContent = "";
      return;
    }
    const current = currentMatchForLineField(line.id, "speaker");
    layer.innerHTML = highlightSearchText(line.speaker, query, 0, current?.start ?? -1);
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

  function styledTextRunsWithFurigana(text, marks) {
    const source = String(text || "");
    const runs = styledTextRuns(source, marks);
    const matches = furiganaMatches(source);
    if (!matches.length) return runs;
    const readingByEnd = new Map(matches.map((match) => [match.end, match.reading]));
    const result = [];
    let offset = 0;
    runs.forEach((run) => {
      const runStart = offset;
      const runEnd = runStart + run.text.length;
      const boundaries = Array.from(readingByEnd.keys())
        .filter((end) => end > runStart && end <= runEnd)
        .sort((a, b) => a - b);
      let pieceStart = runStart;
      [...boundaries, runEnd].forEach((pieceEnd) => {
        if (pieceEnd > pieceStart) {
          result.push({
            text: source.slice(pieceStart, pieceEnd),
            bold: run.bold,
            color: run.color,
          });
        }
        const reading = readingByEnd.get(pieceEnd);
        if (reading) {
          result.push({
            text: `（${reading}）`,
            bold: run.bold,
            color: run.color,
          });
        }
        pieceStart = pieceEnd;
      });
      offset = runEnd;
    });
    return mergeStyledRuns(result);
  }

  function normalizeFuriganaEntries(entries) {
    if (!Array.isArray(entries)) return [];
    const normalized = [];
    const indexByWord = new Map();
    entries.forEach((entry) => {
      const word = cleanFuriganaValue(entry?.word);
      const reading = cleanFuriganaValue(entry?.reading);
      if (!word || !reading) return;
      if (indexByWord.has(word)) {
        normalized[indexByWord.get(word)].reading = reading;
        return;
      }
      indexByWord.set(word, normalized.length);
      normalized.push({ word, reading });
    });
    return normalized;
  }

  function cleanFuriganaValue(value) {
    return String(value || "").replace(/[\r\n]+/g, " ").trim();
  }

  function isFuriganaVisible() {
    return project.settings?.showFurigana !== false;
  }

  function activeFuriganaEntries() {
    if (!isFuriganaVisible()) return [];
    return project.furigana
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => b.word.length - a.word.length || a.index - b.index);
  }

  function furiganaMatches(text) {
    const source = String(text || "");
    const entries = activeFuriganaEntries();
    if (!source || !entries.length) return [];
    const matches = [];
    let cursor = 0;
    while (cursor < source.length) {
      const entry = entries.find((candidate) => source.startsWith(candidate.word, cursor));
      if (!entry) {
        cursor += source.codePointAt(cursor) > 0xFFFF ? 2 : 1;
        continue;
      }
      const end = cursor + entry.word.length;
      const annotation = `（${entry.reading}）`;
      if (source.startsWith(annotation, end)) {
        cursor = end + annotation.length;
        continue;
      }
      matches.push({ start: cursor, end, word: entry.word, reading: entry.reading });
      cursor = end;
    }
    return matches;
  }

  function textWithFurigana(text) {
    const source = String(text || "");
    const matches = furiganaMatches(source);
    if (!matches.length) return source;
    let result = "";
    let cursor = 0;
    matches.forEach((match) => {
      result += source.slice(cursor, match.end);
      result += `（${match.reading}）`;
      cursor = match.end;
    });
    return result + source.slice(cursor);
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

  function isUndoShortcut(event) {
    return (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z";
  }

  function isEditableTarget(target) {
    const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
    if (!element) return false;
    if (element.closest?.("[contenteditable='true']")) return true;
    const tagName = element.tagName;
    return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
  }

  function canUndoFromScriptEditor(target) {
    const latest = lineDeleteUndoStack[lineDeleteUndoStack.length - 1];
    if (closestBodyEditor(target)) return latest?.type !== "line-add";
    const speakerInput = target?.closest?.(".speaker-input");
    return Boolean(speakerInput && !editedSpeakerInputs.has(speakerInput) &&
      (latest?.type === "body-edit" || latest?.type === "paste"));
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
    const previousBody = bodyStateForUndo(line);
    line.bodyMarks = applyMarkToRange(line.bodyMarks, line.body.length, bodySelection.start, bodySelection.end, style);
    const section = project.sections.find((item) => item.lines.some((itemLine) => itemLine.id === line.id));
    recordBodyEditUndo(section.id, line, previousBody, selectionToRestore);
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
    const selectedCounts = speakerCounts(getDisplayedSections());
    syncSpeakerOrder();
    const names = orderedSpeakerNames();
    renderSpeakerFilterOptions(names);
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
      const speakerName = document.createElement("button");
      speakerName.className = "speaker-name";
      speakerName.type = "button";
      speakerName.title = "話者名を変更（全セクションに反映）";
      speakerName.setAttribute("aria-label", `${name}の話者名を変更`);
      const nameText = document.createElement("span");
      nameText.className = "speaker-name-text";
      nameText.textContent = name;
      const editIcon = document.createElement("span");
      editIcon.className = "speaker-name-icon";
      editIcon.setAttribute("aria-hidden", "true");
      editIcon.textContent = "✎";
      speakerName.append(nameText, editIcon);
      speakerName.addEventListener("click", (event) => {
        event.stopPropagation();
        renameSpeaker(name);
      });
      const count = document.createElement("div");
      count.className = "speaker-count";
      count.textContent = `全体 ${counts[name] || 0}行 / 選択 ${selectedCounts[name] || 0}行`;
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
        renderGoogleDocsPreview();
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

  function registerFuriganaEntry() {
    const word = cleanFuriganaValue(els.furiganaWordInput.value);
    const reading = cleanFuriganaValue(els.furiganaReadingInput.value);
    if (!word || !reading) {
      setFuriganaStatus("単語とふりがなの両方を入力してください。");
      (!word ? els.furiganaWordInput : els.furiganaReadingInput).focus();
      return;
    }
    const existing = project.furigana.find((entry) => entry.word === word);
    if (existing) {
      existing.reading = reading;
    } else {
      project.furigana.push({ word, reading });
    }
    els.furiganaWordInput.value = "";
    els.furiganaReadingInput.value = "";
    renderFuriganaList();
    renderRows();
    renderGoogleDocsPreview();
    setFuriganaStatus(existing ? `「${word}」のふりがなを更新しました。` : `「${word}」を登録しました。`);
    scheduleSave();
    els.furiganaWordInput.focus();
  }

  function renderFuriganaList() {
    els.furiganaList.innerHTML = "";
    if (!project.furigana.length) {
      const empty = document.createElement("div");
      empty.className = "furigana-empty";
      empty.textContent = "登録した単語が本文にあると、自動で（ふりがな）を表示します。";
      els.furiganaList.appendChild(empty);
      return;
    }
    project.furigana.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "furigana-item";

      const pair = document.createElement("div");
      pair.className = "furigana-pair";
      const word = document.createElement("strong");
      word.textContent = entry.word;
      const reading = document.createElement("span");
      reading.textContent = `（${entry.reading}）`;
      pair.append(word, reading);

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "furigana-edit-button";
      editButton.textContent = "編集";
      editButton.setAttribute("aria-label", `${entry.word}のふりがなを編集`);
      editButton.addEventListener("click", () => {
        els.furiganaWordInput.value = entry.word;
        els.furiganaReadingInput.value = entry.reading;
        els.furiganaReadingInput.focus();
        els.furiganaReadingInput.select();
        setFuriganaStatus(`「${entry.word}」を編集中です。登録すると上書きします。`);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "furigana-delete-button";
      deleteButton.textContent = "×";
      deleteButton.title = "削除";
      deleteButton.setAttribute("aria-label", `${entry.word}のふりがなを削除`);
      deleteButton.addEventListener("click", () => {
        project.furigana = project.furigana.filter((item) => item.word !== entry.word);
        renderFuriganaList();
        renderRows();
        renderGoogleDocsPreview();
        setFuriganaStatus(`「${entry.word}」を削除しました。`);
        scheduleSave();
      });

      item.append(pair, editButton, deleteButton);
      els.furiganaList.appendChild(item);
    });
  }

  function setFuriganaStatus(text) {
    if (els.furiganaStatus) els.furiganaStatus.textContent = text;
  }

  function renderSpeakerFilterOptions(names) {
    if (!els.speakerFilterSelect) return;
    const speakerFilter = getActiveSpeakerFilter();
    els.speakerFilterSelect.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "すべての話者";
    els.speakerFilterSelect.appendChild(allOption);
    names.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      els.speakerFilterSelect.appendChild(option);
    });
    els.speakerFilterSelect.value = speakerFilter;
    els.speakerFilterSelect.disabled = names.length === 0;
  }

  function renderStats() {
    const total = project.sections.reduce((sum, section) => {
      return sum + countBodyChars(section.lines);
    }, 0);
    const speakerFilter = getActiveSpeakerFilter();
    const visibleLines = getDisplayedSections().flatMap((section) => section.lines);
    const activeLines = visibleLines.filter((line) => lineMatchesSpeakerFilter(line, speakerFilter));
    const active = countBodyChars(activeLines);
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
    clearLineSelectionState();
    renderRows();
  }

  function updateSelectedLineStatus() {
    if (!els.selectedLineStatus) return;
    const count = selectedLineIds.size;
    els.selectedLineStatus.textContent = count ? `${count}件の行を選択中` : "";
    if (els.clearSelectedLinesButton) els.clearSelectedLinesButton.hidden = count === 0;
    if (els.copySelectedGoogleDocsButton) els.copySelectedGoogleDocsButton.disabled = count === 0;
  }

  function updateLineDeleteUndoButton() {
    if (!els.undoDeleteLineButton) return;
    els.undoDeleteLineButton.disabled = lineDeleteUndoStack.length === 0;
    const latest = lineDeleteUndoStack[lineDeleteUndoStack.length - 1];
    els.undoDeleteLineButton.textContent = "Undo";
    els.undoDeleteLineButton.title = latest ? undoTitleForEntry(latest) : "元に戻す";
  }

  function undoTitleForEntry(entry) {
    if (entry?.type === "mcp-edit") return "AIの変更を元に戻す";
    if (entry?.type === "body-edit") return "直前の本文編集を元に戻す";
    if (entry?.type === "speaker-rename") return "直前の話者名変更を元に戻す";
    if (entry?.type === "replace") return "直前の置換を元に戻す";
    if (entry?.type === "paste") return "直前の貼り付けを元に戻す";
    if (entry?.type === "line-add") {
      const count = entry.lineIds?.length || 0;
      return count > 1 ? `${count}行の追加を元に戻す` : "直前の行追加を元に戻す";
    }
    const count = entry?.lines?.length || 0;
    return count > 1 ? `${count}行の削除を元に戻す` : "直前の削除を元に戻す";
  }

  function pushLineDeleteUndo(entry) {
    if (!entry?.lines?.length) return;
    pushUndoEntry({ ...entry, type: "line-delete" });
  }

  function pushReplaceUndo(projectSnapshot) {
    if (!projectSnapshot) return;
    pushUndoEntry({
      type: "replace",
      project: projectSnapshot,
      activeSectionId,
      allSectionsVisible,
      activeSpeakerFilter,
    });
  }

  function pushPasteUndo(entry) {
    if (!entry?.project) return;
    pushUndoEntry({
      ...entry,
      type: "paste",
      afterFingerprint: projectUndoFingerprint(project),
    });
  }

  function pushUndoEntry(entry) {
    bodyEditUndoGroup = null;
    lineDeleteUndoStack.push(entry);
    if (lineDeleteUndoStack.length > MAX_LINE_DELETE_UNDO) lineDeleteUndoStack.shift();
    updateLineDeleteUndoButton();
  }

  function undoLastAction() {
    if (!canUndoLastAction()) return false;
    bodyEditUndoGroup = null;
    const entry = lineDeleteUndoStack.pop();
    if (!entry) {
      updateLineDeleteUndoButton();
      return false;
    }
    if (entry.type === "body-edit") {
      undoBodyEdit(entry);
      return true;
    }
    if (entry.type === "replace" || entry.type === "speaker-rename" || entry.type === "mcp-edit") {
      undoReplace(entry);
      return true;
    }
    if (entry.type === "paste") {
      undoPaste(entry);
      return true;
    }
    if (entry.type === "line-add") {
      undoAddedLines(entry);
      return true;
    }
    undoDeletedLines(entry);
    return true;
  }

  function canUndoLastAction() {
    const entry = lineDeleteUndoStack[lineDeleteUndoStack.length - 1];
    if (!entry) return false;
    if (entry.type !== "paste") return true;
    return entry.afterFingerprint === projectUndoFingerprint(project);
  }

  function projectUndoFingerprint(value) {
    return JSON.stringify(value, (key, item) => (key === "updatedAt" ? undefined : item));
  }

  function bodyStateForUndo(line) {
    return {
      body: line.body,
      bodyMarks: normalizeBodyMarks(line.bodyMarks, line.body.length),
      type: line.type,
    };
  }

  function recordBodyEditUndo(sectionId, line, before, selection, input = {}) {
    const after = bodyStateForUndo(line);
    const beforeFingerprint = JSON.stringify(before);
    const afterFingerprint = JSON.stringify(after);
    if (beforeFingerprint === afterFingerprint || input.inputType === "historyUndo" || input.inputType === "historyRedo") return;

    const now = Date.now();
    const group = bodyEditUndoGroup;
    const latest = lineDeleteUndoStack[lineDeleteUndoStack.length - 1];
    const groupable = input.composing || input.compositionCommit ||
      ["insertText", "insertCompositionText", "deleteContentBackward", "deleteContentForward"].includes(input.inputType);
    const continuingComposition = group?.composing && (input.composing || input.compositionCommit);
    const adjacentSelection = selection && group?.selection &&
      selection.start === selection.end &&
      selection.start === group.selection.start && selection.end === group.selection.end;
    const merge = group && group.entry === latest && group.entry.lineId === line.id &&
      group.afterFingerprint === beforeFingerprint && groupable &&
      (continuingComposition || (group.inputType === input.inputType &&
        !group.composing && adjacentSelection && now - group.time <= BODY_EDIT_UNDO_GROUP_DELAY));

    if (!merge) {
      pushUndoEntry({
        type: "body-edit",
        sectionId,
        lineId: line.id,
        before,
        selection: selection ? { start: selection.start, end: selection.end } : null,
      });
    }
    bodyEditUndoGroup = groupable ? {
      entry: lineDeleteUndoStack[lineDeleteUndoStack.length - 1],
      inputType: input.inputType,
      composing: Boolean(input.composing),
      afterFingerprint,
      selection: input.selection,
      time: now,
    } : null;
  }

  function undoBodyEdit(entry) {
    const section = project.sections.find((item) => item.id === entry.sectionId);
    const line = section?.lines.find((item) => item.id === entry.lineId);
    if (!line) {
      updateLineDeleteUndoButton();
      return;
    }
    line.body = entry.before.body;
    line.bodyMarks = normalizeBodyMarks(entry.before.bodyMarks, line.body.length);
    line.type = inferType(line.speaker, line.body, entry.before.type);
    if (!allSectionsVisible) {
      activeSectionId = section.id;
      project.activeSectionId = section.id;
    }
    if (!lineMatchesSpeakerFilter(line)) activeSpeakerFilter = "";
    focusedLineId = line.id;
    normalizeProject();
    renderAll();
    scheduleSave();
    const selection = entry.selection || { start: line.body.length, end: line.body.length };
    restoreBodySelectionAfterRender({ lineId: line.id, ...selection });
  }

  function undoReplace(entry) {
    project = hydrateProject(entry.project);
    activeSectionId = entry.activeSectionId || project.activeSectionId || project.sections[0].id;
    allSectionsVisible = Boolean(entry.allSectionsVisible);
    activeSpeakerFilter = entry.activeSpeakerFilter || "";
    clearLineSelectionState();
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function undoPaste(entry) {
    project = hydrateProject(entry.project);
    activeSectionId = entry.activeSectionId || project.activeSectionId || project.sections[0].id;
    allSectionsVisible = Boolean(entry.allSectionsVisible);
    activeSpeakerFilter = entry.activeSpeakerFilter || "";
    selectedLineIds = new Set(entry.selectedLineIds || []);
    lineSelectionAnchorId = entry.lineSelectionAnchorId || "";
    focusedLineId = entry.focusedLineId || entry.focus?.lineId || "";
    normalizeProject();
    renderAll();
    scheduleSave();
    restorePasteFocus(entry.focus);
  }

  function restorePasteFocus(focus) {
    if (!focus?.lineId) return;
    const line = findLine(focus.lineId);
    if (!line) return;
    if (focus.field === "body") {
      const start = clampNumber(focus.start, 0, line.body.length);
      const end = clampNumber(focus.end, 0, line.body.length);
      bodySelection = { lineId: focus.lineId, start, end };
      restoreBodySelectionAfterRender(bodySelection);
      return;
    }
    requestAnimationFrame(() => {
      const row = Array.from(els.scriptRows.querySelectorAll(".script-row"))
        .find((item) => item.dataset.lineId === focus.lineId);
      const input = row?.querySelector(".speaker-input");
      if (!input) return;
      input.focus();
      input.setSelectionRange(
        clampNumber(focus.start, 0, input.value.length),
        clampNumber(focus.end, 0, input.value.length),
      );
    });
  }

  function undoAddedLines(entry) {
    const section = project.sections.find((item) => item.id === entry.sectionId);
    if (!section) {
      updateLineDeleteUndoButton();
      return;
    }
    const addedIds = new Set(entry.lineIds || []);
    if (!addedIds.size) {
      updateLineDeleteUndoButton();
      return;
    }
    section.lines = section.lines.filter((line) => !addedIds.has(line.id));
    if (!section.lines.length) section.lines.push(createLine());
    selectedLineIds = new Set(Array.from(selectedLineIds).filter((lineId) => !addedIds.has(lineId)));
    if (addedIds.has(lineSelectionAnchorId)) lineSelectionAnchorId = "";
    activeSectionId = section.id;
    allSectionsVisible = false;
    project.activeSectionId = section.id;
    const focusIndex = section.lines.findIndex((line) => line.id === entry.focusLineId);
    focusedLineId = focusIndex >= 0 ? entry.focusLineId : section.lines[Math.max(0, entry.index - 1)]?.id || "";
    normalizeProject();
    renderAll();
    scheduleSave();
    requestAnimationFrame(() => {
      const restoredFocusIndex = section.lines.findIndex((line) => line.id === focusedLineId);
      if (restoredFocusIndex >= 0) focusLine(restoredFocusIndex, entry.focusField || "speaker");
    });
  }

  function undoDeletedLines(entry) {
    const section = project.sections.find((item) => item.id === entry.sectionId);
    if (!section) {
      updateLineDeleteUndoButton();
      return;
    }
    const items = (entry.items || entry.lines.map((line, index) => ({ index: entry.index + index, line })))
      .slice()
      .sort((a, b) => a.index - b.index);
    const restored = [];
    if (entry.mode === "replace-blank") {
      const restoredLines = items.map((item) => cloneLineForUndo(item.line, section));
      restored.push(...restoredLines);
      const placeholderIndex = section.lines.findIndex((line) => line.id === entry.placeholderLineId);
      if (placeholderIndex >= 0 && isBlankLine(section.lines[placeholderIndex])) {
        section.lines.splice(placeholderIndex, 1, ...restoredLines);
      } else {
        section.lines.splice(Math.min(entry.index, section.lines.length), 0, ...restoredLines);
      }
    } else {
      items.forEach((item) => {
        const restoredLine = cloneLineForUndo(item.line, section);
        section.lines.splice(Math.min(item.index, section.lines.length), 0, restoredLine);
        restored.push(restoredLine);
      });
    }
    if (Array.isArray(entry.notes)) section.notes = entry.notes.map(hydrateNote);
    activeSectionId = section.id;
    allSectionsVisible = false;
    project.activeSectionId = section.id;
    selectedLineIds = new Set(restored.map((line) => line.id));
    lineSelectionAnchorId = restored[0]?.id || "";
    focusedLineId = restored[restored.length - 1]?.id || "";
    normalizeProject();
    renderAll();
    scheduleSave();
    requestAnimationFrame(() => {
      const restoredIndex = section.lines.findIndex((line) => line.id === focusedLineId);
      if (restoredIndex >= 0) focusLine(restoredIndex, "speaker");
    });
  }

  function handleLineDragOver(event, row) {
    if (isNoteEndDrag(event)) {
      handleNoteEndDragOver(event, row);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  }

  function handleLineDrop(event, targetLineId, row) {
    event.preventDefault();
    if (isNoteEndDrag(event)) {
      handleNoteEndDrop(event, targetLineId);
      clearAllLineDropClasses();
      return;
    }
    const raw = event.dataTransfer.getData("application/x-script-line-ids");
    clearAllLineDropClasses();
    if (!raw) return;
    const draggedIds = JSON.parse(raw);
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    moveLines(draggedIds, targetLineId, after);
  }

  function clearLineDropClasses(row) {
    row.classList.remove("drop-before", "drop-after", "note-end-target", "note-end-invalid");
  }

  function clearAllLineDropClasses() {
    els.scriptRows.querySelectorAll(".script-row").forEach(clearLineDropClasses);
  }

  function isNoteEndDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes(NOTE_END_DRAG_TYPE) || Boolean(noteEndDrag);
  }

  function handleNoteEndDragOver(event, row) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const targetLineId = row.dataset.lineId;
    const canDrop = noteEndDrag && canSetNoteEndToLine(noteEndDrag.sectionId, noteEndDrag.noteId, targetLineId);
    row.classList.toggle("note-end-target", canDrop);
    row.classList.toggle("note-end-invalid", !canDrop);
  }

  function handleNoteEndDrop(event, targetLineId) {
    const raw = event.dataTransfer.getData(NOTE_END_DRAG_TYPE);
    const payload = raw ? JSON.parse(raw) : noteEndDrag;
    if (!payload) return;
    setNoteEndToLine(payload.sectionId, payload.noteId, targetLineId);
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
    const firstIndex = section.lines.findIndex((line) => line.id === selected[0].id);
    lineClipboard = selected.map(cloneLineForClipboard);
    const undoEntry = {
      sectionId: section.id,
      index: Math.max(0, firstIndex),
      mode: selected.length === section.lines.length ? "replace-blank" : "insert",
      notes: cloneSectionNotes(section),
      lines: selected.map(cloneLineForDeleteUndo),
      items: selected.map((line) => ({
        index: section.lines.findIndex((item) => item.id === line.id),
        line: cloneLineForDeleteUndo(line),
      })),
    };
    const cutSet = new Set(selected.map((line) => line.id));
    section.lines = section.lines.filter((line) => !cutSet.has(line.id));
    if (!section.lines.length) {
      const blankLine = createLine();
      section.lines.push(blankLine);
      undoEntry.placeholderLineId = blankLine.id;
    }
    pushLineDeleteUndo(undoEntry);
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

  function cloneProjectForUndo() {
    return JSON.parse(JSON.stringify(project));
  }

  function cloneSectionNotes(section) {
    return Array.isArray(section.notes) ? section.notes.map((note) => ({ ...note })) : [];
  }

  function cloneLineForDeleteUndo(line) {
    return {
      ...cloneLineForClipboard(line),
      id: line.id,
    };
  }

  function cloneLineForPaste(line) {
    return {
      ...cloneLineForClipboard(line),
      id: makeId("line"),
    };
  }

  function cloneLineForUndo(line, section) {
    const existingIds = new Set(section.lines.map((item) => item.id));
    return {
      ...cloneLineForClipboard(line),
      id: line.id && !existingIds.has(line.id) ? line.id : makeId("line"),
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

  function handleSpeakerPickerScroll(event) {
    if (speakerPicker && event.target instanceof Node && speakerPicker.element.contains(event.target)) return;
    hideSpeakerPicker();
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

  function renameSpeaker(name) {
    const speaker = project.speakers[name];
    if (!speaker) return;
    const enteredName = prompt("新しい話者名\n全セクションの同じ話者名もまとめて変更します。", name);
    if (enteredName === null) return;
    const nextName = cleanSpeakerName(enteredName.trim());
    if (!nextName) {
      alert("話者名を入力してください。");
      return;
    }
    if (nextName === name) return;
    if (Object.prototype.hasOwnProperty.call(project.speakers, nextName)) {
      alert(`「${nextName}」は既に登録されています。別の話者名を入力してください。`);
      return;
    }

    pushUndoEntry({
      type: "speaker-rename",
      project: cloneProjectForUndo(),
      activeSectionId,
      allSectionsVisible,
      activeSpeakerFilter,
    });
    project.speakers = {
      ...project.speakers,
      [nextName]: { ...speaker, name: nextName },
    };
    delete project.speakers[name];
    project.speakerOrder = project.speakerOrder.map((speakerName) => speakerName === name ? nextName : speakerName);
    project.sections.forEach((section) => {
      section.lines.forEach((line) => {
        if (line.speaker === name) line.speaker = nextName;
      });
    });
    if (activeSpeakerFilter === name) activeSpeakerFilter = nextName;
    preserveEditorScroll(renderAll);
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

  function activateAllSections() {
    if (allSectionsVisible) return;
    allSectionsVisible = true;
    clearLineSelectionState();
    renderAll();
  }

  function activateSection(sectionId) {
    if (!allSectionsVisible && sectionId === activeSectionId) return;
    allSectionsVisible = false;
    activeSectionId = sectionId;
    project.activeSectionId = sectionId;
    clearLineSelectionState();
    renderAll();
    scheduleSave();
  }

  function clearLineSelectionState() {
    selectedLineIds.clear();
    lineSelectionAnchorId = "";
    focusedLineId = "";
    noteEndDrag = null;
  }

  function createSectionActionButton(title, label, onClick, modifier = "") {
    const button = document.createElement("button");
    button.className = `tab-action${modifier ? ` ${modifier}` : ""}`;
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function moveSection(sectionId, direction) {
    const index = project.sections.findIndex((section) => section.id === sectionId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= project.sections.length) return;
    const [section] = project.sections.splice(index, 1);
    project.sections.splice(nextIndex, 0, section);
    activeSectionId = section.id;
    allSectionsVisible = false;
    project.activeSectionId = section.id;
    clearLineSelectionState();
    renderAll();
    scheduleSave();
  }

  function deleteSection(sectionId) {
    if (project.sections.length <= 1) return;
    const index = project.sections.findIndex((section) => section.id === sectionId);
    if (index < 0) return;
    const section = project.sections[index];
    if (!confirm(`「${section.title}」を削除しますか？\nこのセクション内の行も削除されます。`)) return;
    project.sections.splice(index, 1);
    if (activeSectionId === sectionId) {
      const nextSection = project.sections[Math.min(index, project.sections.length - 1)];
      activeSectionId = nextSection.id;
      project.activeSectionId = nextSection.id;
    }
    clearLineSelectionState();
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function addSection(event) {
    event?.preventDefault();
    const buttonTop = els.addSectionButton.getBoundingClientRect().top;
    const next = project.sections.length + 1;
    const title = `${String(next).padStart(2, "0")} 新規セクション`;
    const section = {
      id: makeId("section"),
      title,
      lines: [createLine()],
      notes: [],
    };
    const activeIndex = allSectionsVisible
      ? -1
      : project.sections.findIndex((item) => item.id === activeSectionId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : project.sections.length;
    project.sections.splice(insertIndex, 0, section);
    activeSectionId = section.id;
    allSectionsVisible = false;
    project.activeSectionId = section.id;
    clearLineSelectionState();
    bodySelection = null;
    bodySelectionRange = null;
    normalizeProject();
    renderAll();
    restoreSectionAddViewport(buttonTop);
    revealActiveSectionTab();
    scheduleSave();
  }

  function restoreSectionAddViewport(buttonTop) {
    if (!Number.isFinite(buttonTop)) return;
    const restore = () => {
      const nextButtonTop = els.addSectionButton.getBoundingClientRect().top;
      if (Number.isFinite(nextButtonTop)) window.scrollBy(0, nextButtonTop - buttonTop);
    };
    restore();
    requestAnimationFrame(restore);
  }

  function revealActiveSectionTab() {
    const reveal = () => {
      const activeItem = els.sectionTabs.querySelector(".tab-item.active");
      if (!activeItem) return;
      const tabsRect = els.sectionTabs.getBoundingClientRect();
      const itemRect = activeItem.getBoundingClientRect();
      if (itemRect.right > tabsRect.right) {
        els.sectionTabs.scrollLeft += itemRect.right - tabsRect.right;
      } else if (itemRect.left < tabsRect.left) {
        els.sectionTabs.scrollLeft -= tabsRect.left - itemRect.left;
      }
    };
    reveal();
    requestAnimationFrame(reveal);
  }

  function renameSection(sectionId) {
    const section = project.sections.find((item) => item.id === sectionId);
    if (!section) return;
    const nextTitle = prompt("セクション名", section.title);
    if (!nextTitle || !nextTitle.trim()) return;
    section.title = nextTitle.trim();
    renderTabs();
    updateCurrentSectionGoogleDocsButton();
    scheduleSave();
  }

  function addLineAfter(index, parsedLines, focusField = "speaker") {
    const section = getActiveSection();
    const lines = parsedLines && parsedLines.length ? parsedLines : [createLine()];
    const focusLineId = section.lines[index]?.id || "";
    section.lines.splice(index + 1, 0, ...lines);
    pushUndoEntry({
      type: "line-add",
      sectionId: section.id,
      index: index + 1,
      lineIds: lines.map((line) => line.id),
      focusLineId,
      focusField,
    });
    normalizeProject();
    renderAll();
    scheduleSave();
    requestAnimationFrame(() => focusLine(index + 1, focusField));
  }

  function deleteLine(index) {
    const section = getActiveSection();
    const removedLine = section.lines[index];
    if (!removedLine) return;
    const undoEntry = {
      sectionId: section.id,
      index,
      mode: section.lines.length === 1 ? "replace-blank" : "insert",
      notes: cloneSectionNotes(section),
      lines: [cloneLineForDeleteUndo(removedLine)],
      items: [{ index, line: cloneLineForDeleteUndo(removedLine) }],
    };
    if (section.lines.length === 1) {
      const blankLine = createLine();
      section.lines[0] = blankLine;
      undoEntry.placeholderLineId = blankLine.id;
    } else {
      section.lines.splice(index, 1);
    }
    pushLineDeleteUndo(undoEntry);
    selectedLineIds.delete(removedLine.id);
    if (lineSelectionAnchorId === removedLine?.id) lineSelectionAnchorId = "";
    if (focusedLineId === removedLine?.id) focusedLineId = "";
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function pastePlainTextIntoEditable(event) {
    const text = event.clipboardData?.getData("text/plain") || event.clipboardData?.getData("text") || "";
    if (!text) return;
    event.preventDefault();
    document.execCommand("insertText", false, text);
  }

  function capturePasteUndo(target, index) {
    const section = getActiveSection();
    const line = section.lines[index];
    if (!line) return null;
    const isBody = target?.classList?.contains("body-input");
    const storedBodySelection = bodySelection?.lineId === line.id ? bodySelection : null;
    const bodyOffsets = isBody ? selectionOffsetsForEditor(target) || storedBodySelection : null;
    const start = isBody ? bodyOffsets?.start : target?.selectionStart;
    const end = isBody ? bodyOffsets?.end : target?.selectionEnd;
    return {
      project: cloneProjectForUndo(),
      activeSectionId,
      allSectionsVisible,
      activeSpeakerFilter,
      selectedLineIds: Array.from(selectedLineIds),
      lineSelectionAnchorId,
      focusedLineId,
      focus: {
        lineId: line.id,
        field: isBody ? "body" : "speaker",
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : Number.isFinite(start) ? start : 0,
      },
    };
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
    const undoEntry = capturePasteUndo(event.currentTarget, index);
    const section = getActiveSection();
    section.lines.splice(index, 1, ...pasted);
    normalizeProject();
    renderAll();
    scheduleSave();
    pushPasteUndo(undoEntry);
  }

  function handleBodyPaste(event, index) {
    const text = event.clipboardData?.getData("text/plain") || event.clipboardData?.getData("text") || "";
    if (!text) return;
    if (text.includes("\n")) {
      handlePaste(event, index);
      return;
    }
    const undoEntry = capturePasteUndo(event.currentTarget, index);
    const richHtml = event.clipboardData?.getData("text/html") || "";
    if (richHtml) {
      const bodyHtml = sanitizeBodyClipboardHtml(richHtml);
      if (bodyHtml) {
        const clipboardBody = document.createElement("div");
        clipboardBody.innerHTML = bodyHtml;
        const clipboardText = editorPlainText(clipboardBody);
        const clipboardMarks = extractBodyMarks(clipboardBody, clipboardText.length);
        const alignedClipboard = alignStyledBodyClipboard(clipboardText, clipboardMarks, text);
        if (
          alignedClipboard?.marks.length &&
          insertStyledBodyPaste(event.currentTarget, index, alignedClipboard.text, alignedClipboard.marks)
        ) {
          event.preventDefault();
          pushPasteUndo(undoEntry);
          return;
        }
      }
    }
    if (insertStyledBodyPaste(event.currentTarget, index, text, [])) {
      event.preventDefault();
      pushPasteUndo(undoEntry);
      return;
    }
    event.preventDefault();
    document.execCommand("insertText", false, text);
  }

  function alignStyledBodyClipboard(richText, richMarks, plainText) {
    const source = String(richText || "");
    const expected = String(plainText || "");
    if (!expected) return null;
    const matchStart = source.indexOf(expected);
    if (matchStart < 0) return null;
    const matchEnd = matchStart + expected.length;
    const marks = normalizeBodyMarks(richMarks, source.length)
      .filter((mark) => mark.start < matchEnd && mark.end > matchStart)
      .map((mark) => ({
        ...mark,
        start: Math.max(mark.start, matchStart) - matchStart,
        end: Math.min(mark.end, matchEnd) - matchStart,
      }));
    return {
      text: expected,
      marks: mergeBodyMarks(normalizeBodyMarks(marks, expected.length)),
    };
  }

  function insertStyledBodyPaste(editor, index, pastedText, pastedMarks) {
    if (!editor?.classList?.contains("body-input")) return false;
    const section = getActiveSection();
    const line = section.lines[index];
    if (!line) return false;
    const offsets = selectionOffsetsForEditor(editor);
    if (!offsets) return false;

    const start = Math.min(offsets.start, offsets.end);
    const end = Math.max(offsets.start, offsets.end);
    const previousText = line.body;
    const nextText = `${previousText.slice(0, start)}${pastedText}${previousText.slice(end)}`;
    const delta = pastedText.length - (end - start);
    const nextMarks = [];

    normalizeBodyMarks(line.bodyMarks, previousText.length).forEach((mark) => {
      if (mark.start < start) {
        nextMarks.push({ ...mark, end: Math.min(mark.end, start) });
      }
      if (mark.end > end) {
        nextMarks.push({
          ...mark,
          start: Math.max(mark.start, end) + delta,
          end: mark.end + delta,
        });
      }
    });
    normalizeBodyMarks(pastedMarks, pastedText.length).forEach((mark) => {
      nextMarks.push({
        ...mark,
        start: start + mark.start,
        end: start + mark.end,
      });
    });

    line.body = nextText;
    line.bodyMarks = mergeBodyMarks(normalizeBodyMarks(nextMarks, nextText.length));
    line.type = inferType(line.speaker, line.body, line.type);
    if (shouldAutoRegisterSpeaker(line)) ensureSpeaker(line.speaker, undefined, true);
    pruneUnusedAutoSpeakers();
    const caret = start + pastedText.length;
    bodySelection = { lineId: line.id, start: caret, end: caret };
    renderAll();
    restoreBodySelectionAfterRender(bodySelection);
    markSavePending();
    return true;
  }

  function sanitizeBodyClipboardHtml(html) {
    const container = document.createElement("div");
    container.innerHTML = String(html || "");
    const parts = [];
    const ignoredTags = new Set(["HEAD", "META", "LINK", "SCRIPT", "STYLE", "TITLE"]);

    const appendText = (text, style) => {
      if (!text) return;
      const styles = [];
      if (style.bold) styles.push("font-weight:900");
      if (style.color) styles.push(`color:${style.color}`);
      const escaped = escapeHtml(text).replace(/\r\n?|\n/g, "<br>");
      parts.push(styles.length ? `<span style="${styles.join(";")}">${escaped}</span>` : escaped);
    };

    const walk = (node, inherited) => {
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.nodeValue || "", inherited);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node;
      if (ignoredTags.has(element.tagName)) return;
      if (element.tagName === "BR") {
        parts.push("<br>");
        return;
      }

      const next = { ...inherited };
      const weight = String(element.style?.fontWeight || "").toLowerCase();
      if (
        element.tagName === "B" ||
        element.tagName === "STRONG" ||
        weight === "bold" ||
        Number.parseInt(weight, 10) >= 600
      ) {
        next.bold = true;
      }
      const color = normalizeCssColor(element.style?.color || (element.tagName === "FONT" ? element.getAttribute("color") : ""));
      if (color) next.color = color;
      Array.from(element.childNodes).forEach((child) => walk(child, next));
    };

    Array.from(container.childNodes).forEach((child) => walk(child, { bold: false, color: "" }));
    return parts.join("");
  }

  function handleRowKey(event, index, field) {
    if (event.isComposing || event.keyCode === 229) return;
    if (undoPasteFromEditor(event)) return;
    if (undoBlankAddedLineFromEditor(event)) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (field === "speaker") {
      const line = getActiveSection().lines[index];
      if (line) commitLineSpeaker(line);
    }
    addLineAfter(index, undefined, field);
  }

  function undoPasteFromEditor(event) {
    if (!isUndoShortcut(event)) return false;
    const latest = lineDeleteUndoStack[lineDeleteUndoStack.length - 1];
    if (latest?.type !== "paste" || !canUndoLastAction()) return false;
    event.preventDefault();
    undoLastAction();
    return true;
  }

  function undoBlankAddedLineFromEditor(event) {
    if (!isUndoShortcut(event)) return false;
    const latest = lineDeleteUndoStack[lineDeleteUndoStack.length - 1];
    if (latest?.type !== "line-add") return false;
    const lineId = event.currentTarget.closest(".script-row")?.dataset.lineId;
    if (!lineId || !latest.lineIds?.includes(lineId)) return false;
    const line = findLine(lineId);
    if (!line || !isBlankLine(line)) return false;
    event.preventDefault();
    undoLastAction();
    return true;
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
    if (getActiveSpeakerFilter()) {
      renderRows();
      renderStats();
    }
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
    return fallback && !["dialogue", "direction"].includes(fallback) ? fallback : "dialogue";
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

  function speakerCounts(sections = project.sections) {
    const counts = {};
    sections.forEach((section) => {
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
      sectionsForSearchReplace().forEach((section) => {
        section.lines.forEach((line) => {
          if (!lineMatchesSearchReplaceFilters(line)) return;
          const fields = fieldsForScope(line, selectedScope);
          fields.forEach((field) => {
            let start = 0;
            let index = String(field.value || "").indexOf(query, start);
            while (index >= 0) {
              matches.push({ sectionId: section.id, lineId: line.id, field: field.key, start: index });
              start = index + query.length;
              index = String(field.value || "").indexOf(query, start);
            }
          });
        });
      });
    }
    updateMatchClasses();
    refreshSearchHighlights();
    updateMatchStatus();
  }

  function sectionsForSearchReplace() {
    if (els.replaceCurrentSectionOnlyInput?.checked) return [getActiveSection()];
    return project.sections;
  }

  function lineMatchesSearchReplaceFilters(line) {
    return lineMatchesSpeakerFilter(line, getActiveSpeakerFilter());
  }

  function searchReplaceScopeSuffix() {
    const parts = [];
    const speakerFilter = getActiveSpeakerFilter();
    if (els.replaceCurrentSectionOnlyInput?.checked) parts.push("このセクション");
    if (speakerFilter) parts.push(speakerFilter);
    return parts.length ? `（${parts.join(" / ")}）` : "";
  }

  function fieldsForScope(line, scope) {
    if (scope === "speaker") return [{ key: "speaker", value: line.speaker }];
    if (scope === "body") return [{ key: "body", value: line.body }];
    return [
      { key: "speaker", value: line.speaker },
      { key: "body", value: line.body },
    ];
  }

  function moveMatch(delta, focusInput = true) {
    if (!matches.length) return;
    currentMatchIndex = (currentMatchIndex + delta + matches.length) % matches.length;
    const match = matches[currentMatchIndex];
    if (match.sectionId !== activeSectionId) {
      activeSectionId = match.sectionId;
      project.activeSectionId = match.sectionId;
      renderAll();
      currentMatchIndex = matches.findIndex((item) => {
        return item.lineId === match.lineId && item.field === match.field && item.start === match.start;
      });
    }
    updateMatchClasses();
    refreshSearchHighlights(true);
    updateMatchStatus();
    focusMatch(match, focusInput);
  }

  function focusMatch(match, focusInput = true) {
    const row = els.scriptRows.querySelector(`[data-line-id="${cssEscape(match.lineId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    if (!focusInput) return;
    const input = row.querySelector(match.field === "speaker" ? ".speaker-input" : ".body-input");
    input?.focus();
    const queryLength = String(els.searchInput.value || "").length;
    if (typeof input?.setSelectionRange === "function") {
      input.setSelectionRange(match.start, match.start + queryLength);
    } else if (input) {
      setEditorSelection(input, match.start, match.start + queryLength);
    }
  }

  function updateMatchClasses() {
    const visibleMatches = allSectionsVisible ? matches : matches.filter((match) => match.sectionId === activeSectionId);
    const activeIds = new Set(visibleMatches.map((match) => match.lineId));
    els.scriptRows.querySelectorAll(".script-row").forEach((row) => {
      const isMatch = activeIds.has(row.dataset.lineId);
      const current = matches[currentMatchIndex];
      row.classList.toggle("match", isMatch);
      row.classList.toggle("current-match", Boolean(current && current.lineId === row.dataset.lineId));
    });
  }

  function refreshSearchHighlights(force = false) {
    els.scriptRows.querySelectorAll(".script-row").forEach((row) => {
      const line = findLine(row.dataset.lineId);
      if (!line) return;
      const speakerCell = row.querySelector(".speaker-cell");
      const speakerLayer = row.querySelector(".speaker-highlight-layer");
      if (speakerCell && speakerLayer) syncSpeakerSearchHighlight(speakerCell, speakerLayer, line);
      const bodyInput = row.querySelector(".body-input");
      if (bodyInput && (force || document.activeElement !== bodyInput)) {
        bodyInput.innerHTML = bodyEditorHtml(line);
        resizeBodyInput(bodyInput);
      }
    });
  }

  function updateMatchStatus() {
    if (!els.searchInput.value) {
      els.matchStatus.textContent = "0件";
      return;
    }
    const current = matches.length && currentMatchIndex >= 0 ? `${currentMatchIndex + 1} / ` : "";
    els.matchStatus.textContent = `${current}${matches.length}件${searchReplaceScopeSuffix()}`;
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
    const value = String(line[match.field] || "");
    const start = value.slice(match.start, match.start + query.length) === query ? match.start : value.indexOf(query);
    if (start < 0) {
      updateMatches();
      return;
    }
    const nextValue = value.slice(0, start) + els.replaceInput.value + value.slice(start + query.length);
    if (nextValue === value) return;
    const undoSnapshot = cloneProjectForUndo();
    line[match.field] = nextValue;
    if (match.field === "body") line.bodyMarks = [];
    pushReplaceUndo(undoSnapshot);
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function replaceAll() {
    const query = els.searchInput.value;
    if (!query) return;
    let count = 0;
    const undoSnapshot = cloneProjectForUndo();
    sectionsForSearchReplace().forEach((section) => {
      section.lines.forEach((line) => {
        if (!lineMatchesSearchReplaceFilters(line)) return;
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
    if (!count) {
      els.matchStatus.textContent = `0件置換${searchReplaceScopeSuffix()}`;
      return;
    }
    pushReplaceUndo(undoSnapshot);
    normalizeProject();
    renderAll();
    els.matchStatus.textContent = `${count}件置換${searchReplaceScopeSuffix()}`;
    scheduleSave();
  }

  function findLine(lineId) {
    for (const section of project.sections) {
      const line = section.lines.find((item) => item.id === lineId);
      if (line) return line;
    }
    return null;
  }

  async function saveJson() {
    syncProjectTitleFromInput();
    normalizeProject();
    const currentHandle = await getRememberedJsonSaveHandle();
    if (!currentHandle) {
      await saveJsonAs();
      return;
    }
    if (!(await requestHandleWritePermission(currentHandle))) return;
    await saveJsonToHandle(currentHandle, currentHandle, false);
  }

  async function saveJsonAs() {
    syncProjectTitleFromInput();
    normalizeProject();
    const previousHandle = await getRememberedJsonSaveHandle();
    const fileName = `${safeFileName(project.title)}.json`;

    if (!window.showDirectoryPicker) {
      const copy = projectForSave();
      if (previousHandle) copy.projectId = createProjectId();
      downloadBlob(JSON.stringify(copy, null, 2), fileName, "application/json");
      setSaveState("JSONをダウンロードしました（自動保存先は変更されません）");
      return;
    }

    const handle = await createNewJsonFileHandle(fileName, previousHandle);
    if (!handle) return;
    await saveJsonToHandle(handle, previousHandle, Boolean(previousHandle));
  }

  async function saveJsonToHandle(handle, previousHandle, isSaveAsNewProject) {
    clearTimeout(jsonAutoSaveTimer);
    jsonAutoSaveTimer = 0;
    jsonAutoSaveQueued = false;
    if (jsonAutoSavePromise) await jsonAutoSavePromise;

    const targetCheck = await inspectJsonSaveTarget(handle);
    const sameAsPreviousHandle = await areSameFileHandles(handle, previousHandle);
    if (!(await approveManualJsonTarget(targetCheck, handle.name, previousHandle, sameAsPreviousHandle))) return;
    if (!(await createManualBackupBeforeWrite(targetCheck, handle, previousHandle))) return;

    if (isSaveAsNewProject) project.projectId = createProjectId();
    const data = JSON.stringify(projectForSave(), null, 2);
    await writeJsonToFileHandle(handle, data);
    await rememberJsonSaveHandle(handle);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projectForSave()));
    loadedJsonSourceFingerprint = jsonDataFingerprint(projectForSave());
    const savedFile = await handle.getFile();
    loadedJsonSourceFileIdentity = fileIdentityFromFile(savedFile);
    hasPendingSave = false;
    scheduleProjectBackup();
    setSaveState(
      `${isSaveAsNewProject ? "別台本として保存・" : ""}JSON自動保存先を設定済み: ${handle.name}`,
    );
  }

  async function requestHandleWritePermission(handle) {
    const currentPermission = await queryHandleWritePermission(handle);
    if (currentPermission === "granted") return true;
    if (typeof handle?.requestPermission === "function") {
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission === "granted") return true;
    }
    setSaveState(`JSON自動保存の再設定が必要: ${handle?.name || "保存先"}`, { warning: "permission" });
    alert("現在のJSONへ書き込む権限がありません。［別名保存］で新しいファイルを作成してください。");
    return false;
  }

  async function createNewJsonFileHandle(suggestedName, previousHandle) {
    const options = { id: JSON_SAVE_DIRECTORY_PICKER_ID, mode: "readwrite" };
    if (previousHandle) options.startIn = previousHandle;

    let directoryHandle;
    try {
      directoryHandle = await window.showDirectoryPicker(options);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // ブラウザが id や startIn を受け付けない場合は、最小構成で再試行します。
      directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    }

    const enteredName = prompt(
      "新しく作成するJSONファイル名を入力してください。\n既存ファイルと同じ名前は使用できません。",
      suggestedName,
    );
    if (enteredName === null) return null;
    const fileName = normalizeJsonFileName(enteredName);
    if (!fileName) {
      alert("ファイル名を入力してください。");
      return null;
    }

    try {
      await directoryHandle.getFileHandle(fileName);
      setSaveState("上書きを防止しました（同名ファイルが既にあります）", { warning: "overwrite-blocked" });
      alert(`「${fileName}」は既に存在します。既存ファイルは上書きできません。別の名前を指定してください。`);
      return null;
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
    return directoryHandle.getFileHandle(fileName, { create: true });
  }

  function normalizeJsonFileName(value) {
    const entered = String(value || "").trim();
    if (!entered) return "";
    const withoutExtension = entered.replace(/\.json$/i, "");
    return `${safeFileName(withoutExtension)}.json`;
  }

  async function inspectJsonSaveTarget(handle) {
    const file = await handle.getFile();
    const fileIdentity = { name: file.name, size: file.size, lastModified: file.lastModified };
    if (!file.size) return { status: "empty", data: null, fileIdentity };

    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch (_error) {
      return { status: "invalid", data: null, fileIdentity };
    }
    if (!raw || !Array.isArray(raw.sections)) return { status: "invalid", data: raw, fileIdentity };

    const targetProjectId = typeof raw.projectId === "string" ? raw.projectId.trim() : "";
    if (!targetProjectId) {
      return {
        status: "legacy",
        data: raw,
        title: cleanProjectTitle(raw.title) || "無題の台本",
        fingerprint: jsonDataFingerprint(raw),
        fileIdentity,
      };
    }
    if (targetProjectId !== project.projectId) {
      return {
        status: "different-project",
        data: raw,
        title: cleanProjectTitle(raw.title) || "無題の台本",
        projectId: targetProjectId,
        fingerprint: jsonDataFingerprint(raw),
        fileIdentity,
      };
    }
    return {
      status: "same-project",
      data: raw,
      title: cleanProjectTitle(raw.title) || "無題の台本",
      fingerprint: jsonDataFingerprint(raw),
      fileIdentity,
    };
  }

  async function approveManualJsonTarget(targetCheck, fileName, previousHandle, sameAsPreviousHandle) {
    if (targetCheck.status === "empty") return true;
    if (previousHandle && !sameAsPreviousHandle) {
      setSaveState("上書きを防止しました（現在の保存先とは別の既存ファイルです）", { warning: "overwrite-blocked" });
      alert(
        `「${fileName}」は現在の自動保存先とは別の既存ファイルです。\n\n` +
          "台本IDが同じでも上書きは中止しました。別のファイル名で保存してください。",
      );
      return false;
    }
    if (targetCheck.status === "different-project") {
      setSaveState("上書きを防止しました（別の台本ファイルです）", { warning: "overwrite-blocked" });
      alert(
        `「${fileName}」は別の台本「${targetCheck.title}」の保存ファイルです。\n\n` +
          "上書きは中止しました。現在の台本は別名で保存してください。",
      );
      return false;
    }
    if (targetCheck.status === "invalid") {
      setSaveState("上書きを防止しました（台本JSONではありません）", { warning: "overwrite-blocked" });
      alert(`「${fileName}」は台本エディタのJSONとして確認できないため、上書きを中止しました。`);
      return false;
    }

    const isLoadedSource =
      Boolean(loadedJsonSourceFingerprint) &&
      targetCheck.fingerprint === loadedJsonSourceFingerprint &&
      sameFileIdentity(targetCheck.fileIdentity, loadedJsonSourceFileIdentity);
    if (targetCheck.status === "same-project") {
      if (sameAsPreviousHandle || (!previousHandle && isLoadedSource)) return true;
      setSaveState("上書きを防止しました（読み込んだ元ファイルとして確認できません）", { warning: "overwrite-blocked" });
      alert(
        `「${fileName}」は現在の保存先または読み込んだ元ファイルとして確認できないため、上書きを中止しました。`,
      );
      return false;
    }

    if (!sameAsPreviousHandle && !isLoadedSource) {
      setSaveState("上書きを防止しました（旧形式の別ファイルです）", { warning: "overwrite-blocked" });
      alert(
        `「${fileName}」は識別IDがない既存ファイルで、読み込んだ元ファイルとも一致しません。\n\n` +
          "上書きは中止しました。別のファイル名で保存してください。",
      );
      return false;
    }

    const approved = confirm(
      `「${fileName}」は識別IDがない旧形式の台本「${targetCheck.title}」です。\n\n` +
        `現在の台本「${project.title}」の保存先として登録し、上書きしますか？\n` +
        "別の台本かもしれない場合は［キャンセル］してください。",
    );
    if (!approved) setSaveState("旧形式JSONへの上書きを中止しました");
    return approved;
  }

  async function writeJsonToFileHandle(handle, data) {
    const writable = await handle.createWritable();
    await writable.write(new Blob([data], { type: "application/json;charset=utf-8" }));
    await writable.close();
  }

  async function getRememberedJsonSaveHandle() {
    if (lastJsonSaveHandleLoaded) return lastJsonSaveHandle;
    if (!lastJsonSaveHandleLoadPromise) {
      lastJsonSaveHandleLoadPromise = readFileHandle(JSON_SAVE_HANDLE_KEY)
        .then((handle) => {
          if (!lastJsonSaveHandleLoaded) {
            lastJsonSaveHandle = handle;
            lastJsonSaveHandleLoaded = true;
          }
          return lastJsonSaveHandle;
        })
        .catch((error) => {
          console.warn("前回のJSON保存先を読み込めませんでした。", error);
          if (!lastJsonSaveHandleLoaded) {
            lastJsonSaveHandle = null;
            lastJsonSaveHandleLoaded = true;
          }
          return lastJsonSaveHandle;
        })
        .finally(() => {
          lastJsonSaveHandleLoadPromise = null;
        });
    }
    return lastJsonSaveHandleLoadPromise;
  }

  async function rememberJsonSaveHandle(handle) {
    jsonAutoSaveTargetVersion += 1;
    lastJsonSaveHandle = handle;
    lastJsonSaveHandleLoaded = true;
    try {
      await writeFileHandle(JSON_SAVE_HANDLE_KEY, handle);
    } catch (error) {
      console.warn("JSON保存先を永続化できませんでした。", error);
    }
  }

  async function forgetRememberedJsonSaveHandle() {
    jsonAutoSaveTargetVersion += 1;
    clearTimeout(jsonAutoSaveTimer);
    jsonAutoSaveTimer = 0;
    jsonAutoSaveQueued = false;
    lastJsonSaveHandle = null;
    lastJsonSaveHandleLoaded = true;
    setSaveState("JSON自動保存先は未設定です", { notify: false });
    try {
      await deleteFileHandle(JSON_SAVE_HANDLE_KEY);
    } catch (error) {
      console.warn("古いJSON保存先を削除できませんでした。", error);
    }
  }

  async function getRememberedBackupDirectoryHandle() {
    if (backupDirectoryHandleLoaded) return backupDirectoryHandle;
    if (!backupDirectoryHandleLoadPromise) {
      backupDirectoryHandleLoadPromise = readFileHandle(BACKUP_DIRECTORY_HANDLE_KEY)
        .then((handle) => {
          if (!backupDirectoryHandleLoaded) {
            backupDirectoryHandle = handle;
            backupDirectoryHandleLoaded = true;
          }
          return backupDirectoryHandle;
        })
        .catch((error) => {
          console.warn("バックアップフォルダを読み込めませんでした。", error);
          if (!backupDirectoryHandleLoaded) {
            backupDirectoryHandle = null;
            backupDirectoryHandleLoaded = true;
          }
          return backupDirectoryHandle;
        })
        .finally(() => {
          backupDirectoryHandleLoadPromise = null;
        });
    }
    return backupDirectoryHandleLoadPromise;
  }

  async function rememberBackupDirectoryHandle(handle) {
    backupDirectoryHandle = handle;
    backupDirectoryHandleLoaded = true;
    try {
      await writeFileHandle(BACKUP_DIRECTORY_HANDLE_KEY, handle);
    } catch (error) {
      console.warn("バックアップフォルダを永続化できませんでした。", error);
    }
  }

  async function chooseBackupDirectory() {
    if (!window.showDirectoryPicker) {
      alert("このブラウザはフォルダへの自動バックアップに対応していません。ChromeまたはEdgeで開いてください。");
      return;
    }

    const rememberedHandle = await getRememberedBackupDirectoryHandle();
    if (rememberedHandle && typeof rememberedHandle.requestPermission === "function") {
      const currentPermission = await queryHandleWritePermission(rememberedHandle);
      if (currentPermission !== "granted") {
        const permission = await rememberedHandle.requestPermission({ mode: "readwrite" });
        if (permission === "granted") {
          setBackupState(`バックアップ先: ${rememberedHandle.name}（10分ごと・最大30世代）`, { notify: true });
          const result = await createProjectBackup({ force: true, reason: "再設定時" });
          if (result.status !== "saved") throw new Error("再設定後のバックアップを作成できませんでした。");
          return;
        }
      }
    }

    const handle = await window.showDirectoryPicker({ id: "script-editor-json-backups", mode: "readwrite" });
    await rememberBackupDirectoryHandle(handle);
    setBackupState(`バックアップ先: ${handle.name}（10分ごと・最大30世代）`, { notify: true });
    const result = await createProjectBackup({ force: true, reason: "設定時" });
    if (result.status !== "saved") throw new Error("初回バックアップを作成できませんでした。");
  }

  async function showRememberedBackupState() {
    try {
      const handle = await getRememberedBackupDirectoryHandle();
      if (!handle) {
        setBackupState("バックアップ未設定");
        return;
      }
      const permission = await queryHandleWritePermission(handle);
      if (permission !== "granted") {
        setBackupState(`バックアップの再設定が必要: ${handle.name}`, { warning: "permission", notify: true });
        return;
      }
      setBackupState(`バックアップ先: ${handle.name}（10分ごと・最大30世代）`);
    } catch (error) {
      console.warn("バックアップ先の状態を確認できませんでした。", error);
      setBackupState("バックアップ先を確認できませんでした", { warning: "unavailable", notify: true });
    }
  }

  async function queryHandleWritePermission(handle) {
    if (typeof handle?.queryPermission !== "function") return "granted";
    return handle.queryPermission({ mode: "readwrite" });
  }

  async function createManualBackupBeforeWrite(targetCheck, handle, previousHandle) {
    const directoryHandle = await getRememberedBackupDirectoryHandle();
    if (!directoryHandle) {
      setBackupState("バックアップ未設定（必要なら先に設定してください）");
      return true;
    }

    const backupRequests = [];
    if (targetCheck.data) {
      backupRequests.push({ data: targetCheck.data, reason: "上書き前" });
    }
    if (!(await areSameFileHandles(handle, previousHandle))) {
      backupRequests.push({ data: projectForSave(), reason: "保存先変更前" });
    }
    if (!backupRequests.length) backupRequests.push({ data: projectForSave(), reason: "手動保存前" });

    for (const request of backupRequests) {
      const result = await createProjectBackup({ data: request.data, force: true, reason: request.reason });
      if (result.status === "saved") continue;
      return confirm(
        "世代バックアップを作成できませんでした。\n\n" +
          "バックアップなしでJSON保存を続けますか？\n安全のため、通常は［キャンセル］してバックアップ設定を確認してください。",
      );
    }
    return true;
  }

  async function areSameFileHandles(first, second) {
    if (!first || !second) return false;
    if (first === second) return true;
    if (typeof first.isSameEntry !== "function") return false;
    try {
      return await first.isSameEntry(second);
    } catch (_error) {
      return false;
    }
  }

  function scheduleProjectBackup() {
    clearTimeout(backupTimer);
    const lastSavedAt = readLastBackupTime(project.projectId);
    const delay = Math.max(0, BACKUP_INTERVAL - (Date.now() - lastSavedAt));
    backupTimer = window.setTimeout(() => {
      backupTimer = 0;
      createProjectBackup({ reason: "自動" }).catch((error) => {
        console.warn("世代バックアップを作成できませんでした。", error);
        setBackupState("バックアップに失敗しました（JSON自動保存は継続中）", { warning: "failed", notify: true });
      });
    }, delay);
  }

  async function createProjectBackup({ data = projectForSave(), force = false, reason = "自動" } = {}) {
    const snapshot = JSON.parse(JSON.stringify(data));
    const projectId = project.projectId;
    const projectTitle = cleanProjectTitle(snapshot.title) || project.title || "無題の台本";
    if (!force && Date.now() - readLastBackupTime(projectId) < BACKUP_INTERVAL) {
      return { status: "not-due" };
    }

    const directoryHandle = await getRememberedBackupDirectoryHandle();
    if (!directoryHandle) return { status: "no-target" };
    const permission = await queryHandleWritePermission(directoryHandle);
    if (permission !== "granted") {
      setBackupState(`バックアップの再設定が必要: ${directoryHandle.name}`, { warning: "permission", notify: true });
      return { status: "permission-required" };
    }

    const dataText = JSON.stringify(snapshot, null, 2);
    const writeTask = backupWriteChain
      .catch(() => undefined)
      .then(() => writeProjectBackup(directoryHandle, projectId, projectTitle, reason, dataText));
    backupWriteChain = writeTask.catch(() => undefined);
    try {
      return await writeTask;
    } catch (error) {
      console.warn("世代バックアップを作成できませんでした。", error);
      setBackupState("バックアップに失敗しました（JSON自動保存は継続中）", { warning: "failed", notify: true });
      return { status: "failed", error };
    }
  }

  async function writeProjectBackup(directoryHandle, projectId, projectTitle, reason, dataText) {
    const prefix = backupFilePrefix(projectId);
    const timestamp = formatBackupTimestamp(new Date());
    const fileName = `${prefix}${timestamp}_${safeFileName(reason).slice(0, 20)}_${safeFileName(projectTitle)}.json`;
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    await writeJsonToFileHandle(fileHandle, dataText);
    const savedAt = Date.now();
    localStorage.setItem(backupLastSavedKey(projectId), String(savedAt));

    let backupCount = 1;
    try {
      backupCount = await trimProjectBackups(directoryHandle, prefix);
    } catch (error) {
      console.warn("古い世代バックアップを整理できませんでした。", error);
    }
    if (project.projectId === projectId) {
      setBackupState(
        `バックアップ済み ${new Date(savedAt).toLocaleTimeString("ja-JP")}（${backupCount}/${BACKUP_MAX_FILES}世代）`,
      );
    }
    return { status: "saved", fileName };
  }

  async function trimProjectBackups(directoryHandle, prefix) {
    const names = [];
    for await (const [name, handle] of directoryHandle.entries()) {
      if (handle.kind === "file" && name.startsWith(prefix) && name.endsWith(".json")) names.push(name);
    }
    names.sort();
    const removeNames = names.slice(0, Math.max(0, names.length - BACKUP_MAX_FILES));
    for (const name of removeNames) await directoryHandle.removeEntry(name);
    return names.length - removeNames.length;
  }

  function backupFilePrefix(projectId) {
    const safeProjectId = String(projectId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    return `台本バックアップ_${safeProjectId}_`;
  }

  function formatBackupTimestamp(date) {
    const parts = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
      "-",
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0"),
      String(date.getMilliseconds()).padStart(3, "0"),
    ];
    return parts.join("");
  }

  function backupLastSavedKey(projectId) {
    return `${BACKUP_LAST_SAVED_KEY_PREFIX}${projectId}`;
  }

  function readLastBackupTime(projectId) {
    const value = Number(localStorage.getItem(backupLastSavedKey(projectId)));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function openFileHandleDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      const request = window.indexedDB.open(FILE_HANDLE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(FILE_HANDLE_STORE_NAME)) {
          database.createObjectStore(FILE_HANDLE_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readFileHandle(key) {
    const database = await openFileHandleDatabase();
    if (!database) return null;
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction(FILE_HANDLE_STORE_NAME, "readonly").objectStore(FILE_HANDLE_STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }

  async function writeFileHandle(key, handle) {
    const database = await openFileHandleDatabase();
    if (!database) return;
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(FILE_HANDLE_STORE_NAME, "readwrite");
        transaction.objectStore(FILE_HANDLE_STORE_NAME).put(handle, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  async function deleteFileHandle(key) {
    const database = await openFileHandleDatabase();
    if (!database) return;
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(FILE_HANDLE_STORE_NAME, "readwrite");
        transaction.objectStore(FILE_HANDLE_STORE_NAME).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  async function chooseJsonFileToLoad() {
    if (!window.showOpenFilePicker) {
      els.loadJsonInput.click();
      return;
    }

    const options = {
      id: "script-editor-json-open",
      multiple: false,
      types: [
        {
          description: "JSONファイル",
          accept: { "application/json": [".json"] },
        },
      ],
    };
    const currentHandle = await getRememberedJsonSaveHandle();
    if (currentHandle) options.startIn = currentHandle;

    const [handle] = await window.showOpenFilePicker(options);
    if (!handle) return;
    const file = await handle.getFile();
    if (typeof handle.requestPermission === "function") {
      const permission = await queryHandleWritePermission(handle);
      if (permission !== "granted") await handle.requestPermission({ mode: "readwrite" });
    }
    await loadJsonProject(file, handle);
  }

  function loadJsonFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    loadJsonProject(file, null)
      .catch((error) => {
        alert("JSONを読み込めませんでした。");
        console.error(error);
      })
      .finally(() => {
        els.loadJsonInput.value = "";
      });
  }

  async function loadJsonProject(file, fileHandle) {
    const rawProject = JSON.parse(await file.text());
    const nextProject = hydrateProject(rawProject);
    const nextSourceFingerprint = jsonDataFingerprint(rawProject);
    if (!(await saveCurrentProjectBeforeSwitch())) return;

    clearTimeout(backupTimer);
    backupTimer = 0;
    project = nextProject;
    loadedJsonSourceFingerprint = nextSourceFingerprint;
    loadedJsonSourceFileIdentity = fileIdentityFromFile(file);
    activeSectionId = project.activeSectionId || project.sections[0].id;
    allSectionsVisible = false;
    activeSpeakerFilter = "";
    selectedLineIds.clear();
    lineSelectionAnchorId = "";
    lineDeleteUndoStack = [];
    focusedLineId = "";

    await forgetRememberedJsonSaveHandle();
    if (fileHandle) await rememberJsonSaveHandle(fileHandle);
    normalizeProject();
    renderAll();
    scheduleSave();
  }

  function exportTxt() {
    syncProjectTitleFromInput();
    downloadBlob(buildPlainTextExport(), `${safeFileName(project.title)}.txt`, "text/plain");
  }

  function buildPlainTextExport() {
    const lineSeparator = project.settings.exportBlankLineBetweenLines ? "\n\n" : "\n";
    const blocks = project.sections.map((section) => {
      const body = section.lines
        .flatMap((line, lineIndex) => {
          const parts = shouldExportNotes()
            ? notesStartingAtLine(section, lineIndex).map(({ note, bounds }) => formatNotePlainText(note, bounds))
            : [];
          parts.push(formatScriptLinePlainText(line));
          return parts;
        })
        .join(lineSeparator);
      return `# ${section.title}\n${body}`;
    });
    return blocks.join("\n\n");
  }

  function formatScriptLinePlainText(line) {
    const body = textWithFurigana(line.body);
    return line.speaker ? `${line.speaker}：${body}` : body;
  }

  function formatNotePlainText(note, bounds) {
    const text = String(note.text || "").trim();
    const range = formatNoteRange(bounds);
    return text ? `[${range}] ${text}` : `[${range}]`;
  }

  async function copyGoogleDocsRichText() {
    await copyGoogleDocsRichTextPayload(
      buildGoogleDocsPasteHtmlDocument(),
      buildGoogleDocsPastePlainText(),
      "リッチ形式でコピーしました。Googleドキュメントに貼り付けできます。"
    );
  }

  async function copySpeakersOnlyGoogleDocsRichText() {
    const targetSections = allSectionsVisible ? project.sections : [getActiveSection()];
    const speakerNames = targetSections.flatMap((section) => {
      return section.lines.map((line) => cleanSpeakerName(line.speaker)).filter(Boolean);
    });
    if (!speakerNames.length) {
      setGoogleDocsCopyStatus("表示中のセクションにコピーできる話者がありません。");
      return;
    }
    const targetLabel = allSectionsVisible ? "全セクション" : `「${getActiveSection().title}」`;
    await copyGoogleDocsRichTextPayload(
      buildSpeakersOnlyGoogleDocsHtmlDocument(speakerNames),
      speakerNames.join("\n"),
      `${targetLabel}の話者${speakerNames.length}件を順番どおりにコピーしました。`
    );
  }

  async function copyCurrentSectionGoogleDocsRichText() {
    if (allSectionsVisible) return;
    const section = getActiveSection();
    await copyGoogleDocsRichTextPayload(
      buildGoogleDocsPasteHtmlDocumentForSections([section]),
      buildGoogleDocsPastePlainTextForSections([section]),
      `「${section.title}」をリッチコピーしました。`
    );
  }

  function updateCurrentSectionGoogleDocsButton() {
    if (!els.copyCurrentSectionGoogleDocsButton) return;
    els.copyCurrentSectionGoogleDocsButton.disabled = allSectionsVisible;
    els.copyCurrentSectionGoogleDocsButton.title = allSectionsVisible
      ? "個別セクションを選んでからコピーしてください"
      : `「${getActiveSection().title}」だけをコピー`;
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

  async function copyFilteredSpeakerGoogleDocsRichText() {
    const speakerFilter = getActiveSpeakerFilter();
    if (!speakerFilter) {
      setGoogleDocsCopyStatus("左サイドバーで表示する話者を選んでください。");
      return;
    }
    const sectionGroups = filteredSpeakerSectionGroups(speakerFilter);
    const lineCount = sectionGroups.reduce((sum, group) => sum + group.lines.length, 0);
    if (!lineCount) {
      setGoogleDocsCopyStatus(`「${speakerFilter}」の行がありません。`);
      return;
    }
    await copyGoogleDocsRichTextPayload(
      buildGoogleDocsPasteHtmlDocument(sectionGroups),
      buildGoogleDocsPastePlainText(sectionGroups),
      `「${speakerFilter}」の${lineCount}行をリッチコピーしました。`
    );
  }

  function updateFilteredGoogleDocsButton() {
    if (!els.copyFilteredGoogleDocsButton) return;
    const speakerFilter = getActiveSpeakerFilter();
    const lineCount = speakerFilter
      ? filteredSpeakerSectionGroups(speakerFilter).reduce((sum, group) => sum + group.lines.length, 0)
      : 0;
    els.copyFilteredGoogleDocsButton.disabled = !speakerFilter || lineCount === 0;
    els.copyFilteredGoogleDocsButton.textContent = speakerFilter ? `表示話者コピー (${lineCount})` : "表示話者コピー";
  }

  function filteredSpeakerSectionGroups(speakerName) {
    return project.sections
      .map((section) => ({
        title: section.title,
        lines: section.lines.filter((line) => line.speaker === speakerName),
      }))
      .filter((group) => group.lines.length > 0);
  }

  function isSectionGroupArray(value) {
    return Array.isArray(value) && value.every((item) => {
      return item && typeof item.title === "string" && Array.isArray(item.lines);
    });
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
      selectGoogleDocsFallbackHtml(html);
      const copied = document.execCommand && document.execCommand("copy");
      document.getElementById("googleDocsCopyBuffer")?.remove();
      setGoogleDocsCopyStatus(
        copied
          ? successMessage
          : "自動コピーできませんでした。ブラウザのクリップボード権限を確認してください。"
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

  function buildSpeakersOnlyGoogleDocsHtmlDocument(speakerNames) {
    const paragraphs = speakerNames.map((speakerName) => {
      const color = `#${normalizeDocxColor(project.speakers[speakerName]?.color || autoColor(speakerName))}`;
      return `<p style="${pasteParagraphStyle()}"><strong style="color:${color}; font-weight:700;">${escapeHtml(speakerName)}</strong></p>`;
    });
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
  </head>
  <body>
    ${paragraphs.join("\n")}
  </body>
</html>`;
  }

  function buildGoogleDocsPasteHtmlDocumentForSections(sections) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
  </head>
  <body>
    ${buildGoogleDocsSectionsHtml(sections)}
  </body>
</html>`;
  }

  function buildGoogleDocsPasteHtmlBody(lines = null) {
    if (isSectionGroupArray(lines)) return buildGoogleDocsSectionGroupsHtml(lines);
    if (Array.isArray(lines)) return buildGoogleDocsLinesHtml(lines);
    return buildGoogleDocsSectionsHtml(project.sections);
  }

  function buildGoogleDocsSectionsHtml(sections) {
    const includeSectionTitles = project.sections.length > 1;
    const blocks = [];
    sections.forEach((section, sectionIndex) => {
      if (includeSectionTitles) {
        if (sectionIndex > 0) blocks.push(sectionSeparatorPasteHtml());
        blocks.push(sectionTitlePasteHtml(section.title));
      }
      const includeNotes = shouldExportNotes();
      const noteBoundaries = includeNotes && project.settings.exportNoteSeparators ? noteRangeBoundaries(section) : null;
      section.lines.forEach((line, lineIndex) => {
        if (noteBoundaries?.starts.has(lineIndex) && !noteBoundaryContinuesFromPreviousLine(noteBoundaries, lineIndex)) {
          blocks.push(noteRangeSeparatorPasteHtml("start"));
        }
        if (includeNotes) {
          notesStartingAtLine(section, lineIndex).forEach(({ note, bounds }) => {
            blocks.push(notePasteHtml(note, bounds));
          });
        }
        blocks.push(linePasteHtml(line));
        if (noteBoundaries?.ends.has(lineIndex)) {
          blocks.push(noteRangeSeparatorPasteHtml("end"));
        }
        if (project.settings.exportBlankLineBetweenLines && lineIndex < section.lines.length - 1) {
          blocks.push(blankPasteParagraphHtml());
        }
      });
    });
    return blocks.length ? blocks.join("\n") : blankPasteParagraphHtml();
  }

  function buildGoogleDocsSectionGroupsHtml(sectionGroups) {
    const includeSectionTitles = project.sections.length > 1;
    const blocks = [];
    sectionGroups.forEach((group, groupIndex) => {
      if (includeSectionTitles) {
        if (groupIndex > 0) blocks.push(blankPasteParagraphHtml());
        blocks.push(sectionTitlePasteHtml(group.title));
      }
      group.lines.forEach((line, lineIndex) => {
        blocks.push(linePasteHtml(line));
        if (project.settings.exportBlankLineBetweenLines && lineIndex < group.lines.length - 1) {
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
    if (isSectionGroupArray(lines)) {
      const includeSectionTitles = project.sections.length > 1;
      const lineSeparator = project.settings.exportBlankLineBetweenLines ? "\n\n" : "\n";
      const sectionTexts = lines.map((group) => {
        const body = group.lines.map(formatScriptLinePlainText).join(lineSeparator);
        return includeSectionTitles ? `${group.title}\n${body}` : body;
      });
      return sectionTexts.join("\n\n");
    }
    if (Array.isArray(lines)) {
      const lineSeparator = project.settings.exportBlankLineBetweenLines ? "\n\n" : "\n";
      return lines.map(formatScriptLinePlainText).join(lineSeparator);
    }
    return buildGoogleDocsPastePlainTextForSections(project.sections);
  }

  function buildGoogleDocsPastePlainTextForSections(sections) {
    const includeSectionTitles = project.sections.length > 1;
    const lineSeparator = project.settings.exportBlankLineBetweenLines ? "\n\n" : "\n";
    const sectionTexts = sections.map((section) => {
      const lines = section.lines.flatMap((line, lineIndex) => {
        const parts = shouldExportNotes()
          ? notesStartingAtLine(section, lineIndex).map(({ note, bounds }) => formatNotePlainText(note, bounds))
          : [];
        parts.push(formatScriptLinePlainText(line));
        return parts;
      });
      const body = lines.join(lineSeparator);
      return includeSectionTitles ? `${section.title}\n${body}` : body;
    });
    return sectionTexts.join("\n\n");
  }

  function sectionTitlePasteHtml(title) {
    return `<p style="${pasteParagraphStyle()} margin-top:10px; margin-bottom:6px;"><strong>${escapeHtml(title)}</strong></p>`;
  }

  function sectionSeparatorPasteHtml() {
    return '<hr data-section-separator="true" style="border:0; border-top:2pt solid #9ca3af; margin:12pt 0 10pt 0; height:0;">';
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

  function notePasteHtml(note, bounds) {
    const label = formatNotePlainText(note, bounds);
    return `<p style="${pasteParagraphStyle()} color:#1d4ed8; background:#eff6ff;"><strong>${escapeHtml(label)}</strong></p>`;
  }

  function shouldExportNotes() {
    return Boolean(project.settings?.exportNotes);
  }

  function noteRangeBoundaries(section) {
    const starts = new Set();
    const ends = new Set();
    (section.notes || []).forEach((note) => {
      if (!String(note.text || "").trim()) return;
      const bounds = noteRangeBounds(section, note);
      if (!bounds) return;
      starts.add(bounds.startIndex);
      ends.add(bounds.endIndex);
    });
    return { starts, ends };
  }

  function noteBoundaryContinuesFromPreviousLine(noteBoundaries, lineIndex) {
    return lineIndex > 0 && noteBoundaries.ends.has(lineIndex - 1);
  }

  function noteRangeSeparatorPasteHtml(position) {
    const margin = position === "start" ? "8pt 0 5pt 0" : "5pt 0 8pt 0";
    return `<hr style="border:0; border-top:1.5pt solid #60a5fa; margin:${margin}; height:0;">`;
  }

  function bodyPasteHtml(line) {
    const runs = styledTextRunsWithFurigana(line.body, line.bodyMarks);
    if (!runs.length) return "";
    const defaultColor = normalizeCssColor(getSpeakerBodyColor(project.speakers[line.speaker]));
    return runs.map((run) => {
      const styles = [`font-weight:${run.bold ? "700" : "400"}`];
      const color = run.color || defaultColor;
      if (color) styles.push(`color:${color}`);
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

  function selectGoogleDocsFallbackHtml(html) {
    document.getElementById("googleDocsCopyBuffer")?.remove();
    const buffer = document.createElement("div");
    buffer.id = "googleDocsCopyBuffer";
    buffer.contentEditable = "true";
    buffer.style.position = "fixed";
    buffer.style.left = "-10000px";
    buffer.style.top = "0";
    buffer.style.width = "1px";
    buffer.style.height = "1px";
    buffer.style.overflow = "hidden";
    buffer.innerHTML = htmlDocumentBodyContent(html);
    document.body.appendChild(buffer);
    const range = document.createRange();
    range.selectNodeContents(buffer);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function htmlDocumentBodyContent(html) {
    const source = String(html || "");
    const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(source);
    return bodyMatch ? bodyMatch[1] : source;
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
        if (shouldExportNotes()) {
          notesStartingAtLine(section, lineIndex).forEach(({ note, bounds }) => {
            paragraphs.push(paragraphXml([{ text: formatNotePlainText(note, bounds), bold: true, color: "1D4ED8" }], "NoteLine"));
          });
        }
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
          const bodyColor = normalizeCssColor(getSpeakerBodyColor(project.speakers[line.speaker]));
          styledTextRunsWithFurigana(line.body, line.bodyMarks).forEach((run) => {
            runs.push({
              text: run.text,
              bold: run.bold,
              color: run.color ? normalizeDocxColor(run.color) : (bodyColor ? normalizeDocxColor(bodyColor) : ""),
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
  <w:style w:type="paragraph" w:styleId="NoteLine">
    <w:name w:val="Range Note Line"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="70" w:after="30" w:line="240" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Yu Gothic"/>
      <w:b/>
      <w:sz w:val="20"/>
      <w:szCs w:val="20"/>
      <w:color w:val="1D4ED8"/>
    </w:rPr>
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
    setSaveState("保存中...", { notify: false, preserveWarning: true });
    hasPendingSave = true;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      saveProjectNow();
    }, 250);
  }

  function markSavePending() {
    clearTimeout(saveTimer);
    hasPendingSave = true;
    setSaveState("未保存の入力があります", { notify: false, preserveWarning: true });
  }

  function flushPendingSave() {
    if (hasPendingSave) {
      clearTimeout(saveTimer);
      saveProjectNow();
    }
    if (jsonAutoSaveTimer) {
      clearTimeout(jsonAutoSaveTimer);
      jsonAutoSaveTimer = 0;
      startJsonAutoSave();
    }
  }

  function saveProjectNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    project.updatedAt = new Date().toISOString();
    project.activeSectionId = activeSectionId;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projectForSave()));
    hasPendingSave = false;
    setSaveState(`LocalStorageに自動保存済み ${new Date().toLocaleTimeString("ja-JP")}`, { notify: false, preserveWarning: true });
    scheduleJsonAutoSave();
    scheduleProjectBackup();
  }

  function scheduleJsonAutoSave(delay = JSON_AUTO_SAVE_DELAY) {
    clearTimeout(jsonAutoSaveTimer);
    jsonAutoSaveTimer = window.setTimeout(() => {
      jsonAutoSaveTimer = 0;
      startJsonAutoSave();
    }, delay);
  }

  function startJsonAutoSave() {
    if (jsonAutoSaveRunning) {
      jsonAutoSaveQueued = true;
      return jsonAutoSavePromise || Promise.resolve();
    }

    jsonAutoSaveRunning = true;
    jsonAutoSavePromise = performJsonAutoSave()
      .catch((error) => {
        console.warn("JSONを自動保存できませんでした。", error);
        if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
          setSaveState("LocalStorageに保存済み（JSON自動保存の再設定が必要です）", { warning: "permission" });
          return { status: "permission-required" };
        }
        setSaveState("JSON自動保存に失敗しました（LocalStorageには保存済みです）", { warning: "failed" });
        return { status: "failed" };
      })
      .finally(() => {
        jsonAutoSaveRunning = false;
        jsonAutoSavePromise = null;
        if (!jsonAutoSaveQueued) return;
        jsonAutoSaveQueued = false;
        scheduleJsonAutoSave(0);
      });
    return jsonAutoSavePromise;
  }

  async function performJsonAutoSave() {
    const targetVersion = jsonAutoSaveTargetVersion;
    const handle = await getRememberedJsonSaveHandle();
    if (!handle) return { status: "no-target" };

    if (typeof handle.queryPermission === "function") {
      const permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        setSaveState(`LocalStorageに保存済み（JSON自動保存の再設定が必要: ${handle.name}）`, { warning: "permission" });
        return { status: "permission-required" };
      }
    }

    if (targetVersion !== jsonAutoSaveTargetVersion) return { status: "target-changed" };
    const targetCheck = await inspectJsonSaveTarget(handle);
    if (targetCheck.status === "different-project") {
      setSaveState(`上書き防止: ${handle.name} は別の台本です（JSON保存で保存先を変更してください）`, { warning: "different-project" });
      return { status: "different-project" };
    }
    if (targetCheck.status === "legacy") {
      setSaveState(`旧形式JSONの確認が必要: ${handle.name}（JSON保存を押してください）`, { warning: "legacy-target" });
      return { status: "legacy-target" };
    }
    if (targetCheck.status === "invalid") {
      setSaveState(`上書き防止: ${handle.name} は台本JSONとして確認できません`, { warning: "invalid-target" });
      return { status: "invalid-target" };
    }
    const data = JSON.stringify(projectForSave(), null, 2);
    await writeJsonToFileHandle(handle, data);
    if (targetVersion !== jsonAutoSaveTargetVersion) return { status: "target-changed" };
    setSaveState(`LocalStorage・JSONに自動保存済み ${new Date().toLocaleTimeString("ja-JP")} : ${handle.name}`, { notify: false });
    return { status: "saved" };
  }

  async function saveCurrentProjectBeforeSwitch() {
    while (true) {
      if (hasPendingSave) saveProjectNow();

      clearTimeout(jsonAutoSaveTimer);
      jsonAutoSaveTimer = 0;
      if (jsonAutoSavePromise) await jsonAutoSavePromise;

      // 直前の保存中に追加の変更が入った場合も、最新状態でもう一度保存します。
      clearTimeout(jsonAutoSaveTimer);
      jsonAutoSaveTimer = 0;
      jsonAutoSaveQueued = false;
      const result = await startJsonAutoSave();
      if (hasPendingSave || saveTimer || jsonAutoSaveQueued || jsonAutoSaveTimer) continue;
      if (result?.status === "saved") {
        const backupResult = await createProjectBackup({ force: true, reason: "台本切替前" });
        if (backupResult.status === "saved" || backupResult.status === "no-target") return true;
        return confirm(
          "JSONは保存できましたが、切り替え前バックアップを作成できませんでした。\n\n" +
            "バックアップなしで切り替えますか？",
        );
      }
      if (result?.status === "no-target") {
        return confirm("現在の内容にはJSON自動保存先がありません。JSON保存せずに切り替えますか？");
      }

      alert("JSON自動保存を完了できないため、切り替えを中止しました。先に「JSON保存」で保存先を再設定してください。");
      return false;
    }
  }

  async function showRememberedJsonAutoSaveState() {
    const targetVersion = jsonAutoSaveTargetVersion;
    try {
      const handle = await getRememberedJsonSaveHandle();
      if (!handle) return;

      if (typeof handle.queryPermission === "function") {
        const permission = await handle.queryPermission({ mode: "readwrite" });
        if (permission !== "granted") {
          setSaveState(`LocalStorageに自動保存済み（JSON自動保存の再設定が必要: ${handle.name}）`, { warning: "permission" });
          return;
        }
      }
      if (targetVersion !== jsonAutoSaveTargetVersion) return;
      setSaveState(`LocalStorageに自動保存済み / JSON自動保存先: ${handle.name}`, { notify: false });
      scheduleJsonAutoSave(0);
    } catch (error) {
      console.warn("JSON自動保存先の状態を確認できませんでした。", error);
    }
  }

  function projectForSave() {
    return {
      ...project,
      sections: project.sections.map((section) => ({
        ...section,
        notes: Array.isArray(section.notes)
          ? section.notes.filter((note) => String(note.text || "").trim())
          : [],
      })),
    };
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => {
      normalizeProject();
      renderSpeakers();
      updateMatches();
    }, 120);
  }

  function setSaveState(text, options = {}) {
    updateStatusNotice(els.saveState, els.saveJsonButton, text, options);
  }

  function setBackupState(text, options = {}) {
    updateStatusNotice(els.backupState, els.backupSettingsButton, text, { notify: false, ...options });
  }

  function updateStatusNotice(notice, button, text, { notify = true, warning = "", preserveWarning = false } = {}) {
    if (!notice || !button) return;
    const previousWarning = button.dataset.statusWarning || "";
    // LocalStorageへの保存だけでは、JSON保存先の問題は解消しない。
    if (preserveWarning && previousWarning) return;

    if (!button.dataset.defaultTitle) button.dataset.defaultTitle = button.title;
    button.title = `${button.dataset.defaultTitle}\n${text}`;
    button.setAttribute("aria-description", text);
    button.dataset.statusWarning = warning;
    button.classList.toggle("status-warning", Boolean(warning));

    if (!notify || (warning && warning === previousWarning)) {
      if (previousWarning && !warning) {
        clearTimeout(statusNoticeTimers.get(notice));
        notice.hidden = true;
      }
      return;
    }

    clearTimeout(statusNoticeTimers.get(notice));
    notice.textContent = text;
    notice.dataset.warning = String(Boolean(warning));
    notice.hidden = false;
    statusNoticeTimers.set(notice, window.setTimeout(() => {
      notice.hidden = true;
      statusNoticeTimers.delete(notice);
    }, STATUS_NOTICE_DURATION));
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function createProjectId() {
    if (typeof window.crypto?.randomUUID === "function") return `project-${window.crypto.randomUUID()}`;
    return makeId("project");
  }

  function jsonDataFingerprint(value) {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return "";
    }
  }

  function fileIdentityFromFile(file) {
    if (!file) return null;
    return { name: file.name, size: file.size, lastModified: file.lastModified };
  }

  function sameFileIdentity(first, second) {
    if (!first || !second) return false;
    return (
      first.name === second.name &&
      Number(first.size) === Number(second.size) &&
      Number(first.lastModified) === Number(second.lastModified)
    );
  }

  function fileOperationErrorDetail(error) {
    const name = error?.name || "Error";
    const message = error?.message || "ブラウザがファイル操作を拒否しました。";
    return `${name}: ${message}`;
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

  function normalizeNoteColor(value) {
    return normalizeCssColor(value) || DEFAULT_NOTE_COLOR;
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
