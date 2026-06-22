(function () {
  "use strict";

  const STORAGE_KEY = "script-editor-project-v1";
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
  let saveTimer = 0;
  let renderTimer = 0;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    project = loadProject();
    activeSectionId = project.activeSectionId || project.sections[0].id;
    bindEvents();
    normalizeProject();
    renderAll();
    setSaveState("LocalStorageに自動保存済み");
  }

  function cacheElements() {
    els.projectTitle = document.getElementById("projectTitle");
    els.saveState = document.getElementById("saveState");
    els.sectionTabs = document.getElementById("sectionTabs");
    els.addSectionButton = document.getElementById("addSectionButton");
    els.scriptRows = document.getElementById("scriptRows");
    els.addLineButton = document.getElementById("addLineButton");
    els.normalizeSpeakersButton = document.getElementById("normalizeSpeakersButton");
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
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      if (!speakerPicker) return;
      if (speakerPicker.element.contains(event.target) || speakerPicker.input === event.target) return;
      hideSpeakerPicker();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideSpeakerPicker();
    });
    window.addEventListener("resize", hideSpeakerPicker);
    window.addEventListener("scroll", hideSpeakerPicker, true);

    els.projectTitle.addEventListener("input", () => {
      project.title = els.projectTitle.value.trim() || "無題の台本";
      scheduleSave();
    });

    els.addSectionButton.addEventListener("click", addSection);
    els.addLineButton.addEventListener("click", () => {
      addLineAfter(getActiveSection().lines.length - 1);
    });
    els.normalizeSpeakersButton.addEventListener("click", () => {
      normalizeProject();
      renderAll();
      scheduleSave();
    });
    els.newProjectButton.addEventListener("click", () => {
      if (!confirm("現在の内容を破棄して新規作成しますか？")) return;
      project = createDefaultProject();
      activeSectionId = project.sections[0].id;
      renderAll();
      scheduleSave();
    });
    els.saveJsonButton.addEventListener("click", saveJson);
    els.loadJsonInput.addEventListener("change", loadJsonFile);
    els.exportTxtButton.addEventListener("click", exportTxt);
    els.exportDocxButton.addEventListener("click", exportDocx);
    els.exportBlankLineInput.addEventListener("change", () => {
      project.settings.exportBlankLineBetweenLines = els.exportBlankLineInput.checked;
      scheduleSave();
    });

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
      title: "台本制作エディタ",
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
    updateMatches();
  }

  function renderExportSettings() {
    els.exportBlankLineInput.checked = Boolean(project.settings?.exportBlankLineBetweenLines);
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
      row.className = "script-row";
      row.dataset.lineId = line.id;
      row.style.setProperty("--speaker-bg", tintColor(color, 0.84));
      row.style.setProperty("--speaker-text", darkenColor(color));
      setOptionalCssVar(row, "--body-text", bodyColor);

      const number = document.createElement("div");
      number.className = "line-number";
      number.textContent = String(index + 1).padStart(3, "0");

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
        updateMatches();
        scheduleSave();
      });
      speakerInput.addEventListener("focus", () => {
        if (!cleanSpeakerName(speakerInput.value)) showSpeakerPicker(speakerInput, line, syncRowVisual);
      });
      speakerInput.addEventListener("click", () => {
        if (!cleanSpeakerName(speakerInput.value)) showSpeakerPicker(speakerInput, line, syncRowVisual);
      });
      speakerInput.addEventListener("change", () => commitLineSpeaker(line));
      speakerInput.addEventListener("blur", () => commitLineSpeaker(line));
      speakerInput.addEventListener("paste", (event) => handlePaste(event, index));
      speakerInput.addEventListener("keydown", (event) => handleRowKey(event, index, "speaker"));

      speakerCell.append(speakerInput);

      const bodyCell = document.createElement("div");
      bodyCell.className = "body-cell";
      const colon = document.createElement("div");
      colon.className = "colon";
      colon.textContent = line.speaker ? "：" : "";
      const bodyInput = document.createElement("textarea");
      bodyInput.className = `body-input ${line.type}`;
      bodyInput.rows = 1;
      bodyInput.value = line.body;
      bodyInput.placeholder = "本文";
      bodyInput.addEventListener("input", () => {
        line.body = bodyInput.value;
        line.type = inferType(line.speaker, line.body, line.type);
        if (shouldAutoRegisterSpeaker(line)) ensureSpeaker(line.speaker, undefined, true);
        pruneUnusedAutoSpeakers();
        syncRowVisual();
        resizeBodyInput(bodyInput);
        renderSpeakers();
        renderStats();
        updateMatches();
        scheduleSave();
      });
      bodyInput.addEventListener("focus", () => centerRowForEditing(row));
      bodyInput.addEventListener("paste", (event) => handlePaste(event, index));
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
        resizeBodyInput(bodyInput);
      }
    });
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
        event.dataTransfer.setData("text/plain", name);
        item.classList.add("dragging");
      });
      handle.addEventListener("dragend", () => {
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
        scheduleSave();
      });

      const bodyColorInput = document.createElement("input");
      bodyColorInput.type = "color";
      bodyColorInput.value = getSpeakerBodyColor(speaker) || "#1f2937";
      bodyColorInput.setAttribute("aria-label", `${name}の本文色`);
      bodyColorInput.title = "本文色";
      bodyColorInput.addEventListener("input", () => {
        speaker.bodyColor = bodyColorInput.value;
        renderRows();
        scheduleSave();
      });

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
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = item.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    item.classList.toggle("drop-before", !after);
    item.classList.toggle("drop-after", after);
  }

  function handleSpeakerDrop(event, targetName, item) {
    event.preventDefault();
    const draggedName = event.dataTransfer.getData("text/plain");
    const rect = item.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    clearAllSpeakerDropClasses();
    moveSpeaker(draggedName, targetName, after);
  }

  function clearSpeakerDropClasses(item) {
    item.classList.remove("drop-before", "drop-after");
  }

  function clearAllSpeakerDropClasses() {
    els.speakerList.querySelectorAll(".speaker-item").forEach(clearSpeakerDropClasses);
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
    if (section.lines.length === 1) {
      section.lines[0] = createLine();
    } else {
      section.lines.splice(index, 1);
    }
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
        type: inferType(speaker, body),
        speakerCommitted: Boolean(speaker),
      };
    }
    return {
      id: makeId("line"),
      speaker: "",
      body: line,
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
    const counts = speakerCounts();
    Object.keys(project.speakers).forEach((name) => {
      if (project.speakers[name].auto && !counts[name]) {
        delete project.speakers[name];
      }
    });
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
    input?.select();
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
          if (before !== line[key]) count += before.split(query).length - 1;
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

  function exportDocx() {
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
          runs.push({ text: "：", bold: true });
        }
        if (line.body) runs.push({ text: line.body });
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
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      project.updatedAt = new Date().toISOString();
      project.activeSectionId = activeSectionId;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      setSaveState(`LocalStorageに自動保存済み ${new Date().toLocaleTimeString("ja-JP")}`);
    }, 250);
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

  function safeFileName(name) {
    return String(name || "script")
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 80);
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
