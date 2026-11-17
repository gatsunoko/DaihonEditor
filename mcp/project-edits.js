(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ScriptEditorProjectEdits = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LIMITS = Object.freeze({
    MAX_OPERATIONS: 1000,
    MAX_LINES: 1000,
    MAX_BODY_LENGTH: 100000,
    MAX_TITLE_LENGTH: 500,
    MAX_SPEAKER_LENGTH: 200,
    MAX_MARKS: 1000,
    MAX_FURIGANA_LENGTH: 500,
  });
  const LINE_TYPES = new Set(["dialogue", "direction", "sfx", "bgm"]);
  const RESERVED_SPEAKERS = new Set(["__proto__", "constructor", "prototype"]);
  const OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  let idSequence = 0;

  function fail(message) {
    const error = new Error(message);
    error.name = "ProjectEditError";
    error.code = "INVALID_EDIT";
    throw error;
  }

  function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object.`);
    return value;
  }

  function keys(value, allowed, required, label) {
    object(value, label);
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(`${label}: unknown field ${key}.`);
    }
    for (const key of required) {
      if (!OWN(value, key)) fail(`${label}: ${key} is required.`);
    }
  }

  function text(value, label, maximum, nonblank = false) {
    if (typeof value !== "string") fail(`${label} must be a string.`);
    if (maximum !== undefined && value.length > maximum) fail(`${label} exceeds ${maximum} characters.`);
    if (nonblank && !value.trim()) fail(`${label} must not be blank.`);
    return value;
  }

  function id(value, label) {
    return text(value, label, undefined, true);
  }

  function speakerName(value, label, maximum) {
    text(value, label, maximum);
    const clean = value.replace(/[：:]+$/g, "").trim();
    if (RESERVED_SPEAKERS.has(clean)) fail(`${label}: this speaker name is reserved.`);
    return clean;
  }

  function furiganaValue(value, label) {
    return text(value, label, LIMITS.MAX_FURIGANA_LENGTH, true).replace(/[\r\n]+/g, " ").trim();
  }

  function lineType(value, label) {
    if (!LINE_TYPES.has(value)) fail(`${label} must be dialogue, direction, sfx or bgm.`);
    return value;
  }

  function color(value, label, emptyAllowed = false) {
    if (emptyAllowed && value === "") return value;
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) fail(`${label} must be a #RRGGBB color.`);
    return value;
  }

  function marks(value, body, label, enforceLimits = true) {
    if (!Array.isArray(value)) fail(`${label} must be an array.`);
    if (enforceLimits && value.length > LIMITS.MAX_MARKS) fail(`${label} exceeds ${LIMITS.MAX_MARKS} marks.`);
    return value.map((mark, index) => {
      const itemLabel = `${label}[${index}]`;
      keys(mark, ["start", "end", "bold", "color"], ["start", "end"], itemLabel);
      if (!Number.isInteger(mark.start) || !Number.isInteger(mark.end) || mark.start < 0 ||
        mark.end <= mark.start || mark.end > body.length) {
        fail(`${itemLabel} must have integer offsets with 0 <= start < end <= body.length (UTF-16).`);
      }
      if (OWN(mark, "bold") && typeof mark.bold !== "boolean") fail(`${itemLabel}.bold must be a boolean.`);
      const bold = OWN(mark, "bold") ? mark.bold : false;
      const markColor = OWN(mark, "color") ? color(mark.color, `${itemLabel}.color`, true) : "";
      if (!bold && !markColor) fail(`${itemLabel} must apply bold or a color.`);
      return { start: mark.start, end: mark.end, bold, color: markColor };
    });
  }

  // Existing projects may exceed input limits; unrelated edits must still work.
  function validateProject(project) {
    object(project, "project");
    id(project.projectId, "project.projectId");
    text(project.title, "project.title");
    if (!Array.isArray(project.sections) || !project.sections.length) fail("project.sections must contain at least one section.");
    const usedIds = new Set([project.projectId]);
    const addId = (value, label) => {
      id(value, label);
      if (usedIds.has(value)) fail(`${label}: duplicate ID ${value}.`);
      usedIds.add(value);
    };
    project.sections.forEach((section, sectionIndex) => {
      const label = `project.sections[${sectionIndex}]`;
      object(section, label);
      addId(section.id, `${label}.id`);
      text(section.title, `${label}.title`);
      if (!Array.isArray(section.lines) || !section.lines.length) fail(`${label}.lines must contain at least one line.`);
      const sectionLineIds = new Set();
      section.lines.forEach((line, lineIndex) => {
        const lineLabel = `${label}.lines[${lineIndex}]`;
        object(line, lineLabel);
        addId(line.id, `${lineLabel}.id`);
        sectionLineIds.add(line.id);
        speakerName(line.speaker, `${lineLabel}.speaker`);
        text(line.body, `${lineLabel}.body`);
        lineType(line.type, `${lineLabel}.type`);
        if (OWN(line, "bodyMarks")) marks(line.bodyMarks, line.body, `${lineLabel}.bodyMarks`, false);
        if (OWN(line, "speakerCommitted") && typeof line.speakerCommitted !== "boolean") fail(`${lineLabel}.speakerCommitted must be a boolean.`);
      });
      if (OWN(section, "notes") && !Array.isArray(section.notes)) fail(`${label}.notes must be an array.`);
      (section.notes || []).forEach((note, noteIndex) => {
        const noteLabel = `${label}.notes[${noteIndex}]`;
        object(note, noteLabel);
        addId(note.id, `${noteLabel}.id`);
        if (!sectionLineIds.has(note.startLineId) || !sectionLineIds.has(note.endLineId)) fail(`${noteLabel} endpoints must refer to lines in the same section.`);
        text(note.text, `${noteLabel}.text`);
      });
    });
    if (OWN(project, "speakers")) {
      object(project.speakers, "project.speakers");
      for (const name of Object.keys(project.speakers)) speakerName(name, "project.speakers key");
    }
    if (OWN(project, "furigana") && !Array.isArray(project.furigana)) fail("project.furigana must be an array.");
    return true;
  }

  function findSection(project, sectionId) {
    id(sectionId, "sectionId");
    const section = project.sections.find((item) => item.id === sectionId);
    if (!section) fail(`Section ${sectionId} does not exist.`);
    return section;
  }

  function findLine(project, lineId) {
    id(lineId, "lineId");
    for (const section of project.sections) {
      const line = section.lines.find((item) => item.id === lineId);
      if (line) return { section, line };
    }
    fail(`Line ${lineId} does not exist.`);
  }

  function findNote(project, noteId) {
    id(noteId, "noteId");
    for (const section of project.sections) {
      const note = (section.notes || []).find((item) => item.id === noteId);
      if (note) return { section, note };
    }
    return null;
  }

  function allIds(project) {
    const result = new Set([project.projectId]);
    for (const section of project.sections) {
      result.add(section.id);
      for (const line of section.lines) result.add(line.id);
      for (const note of section.notes || []) result.add(note.id);
    }
    return result;
  }

  function newId(prefix, usedIds) {
    let result;
    do {
      idSequence += 1;
      const random = typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${idSequence.toString(36)}`;
      result = `${prefix}-${random}-${idSequence.toString(36)}`;
    } while (usedIds.has(result));
    usedIds.add(result);
    return result;
  }

  function newLine(raw, usedIds, label) {
    keys(raw, ["speaker", "body", "type", "bodyMarks"], ["body"], label);
    const body = text(raw.body, `${label}.body`, LIMITS.MAX_BODY_LENGTH);
    return {
      id: newId("line", usedIds),
      speaker: OWN(raw, "speaker") ? speakerName(raw.speaker, `${label}.speaker`, LIMITS.MAX_SPEAKER_LENGTH) : "",
      body,
      bodyMarks: OWN(raw, "bodyMarks") ? marks(raw.bodyMarks, body, `${label}.bodyMarks`) : [],
      type: OWN(raw, "type") ? lineType(raw.type, `${label}.type`) : "dialogue",
      speakerCommitted: true,
    };
  }

  function deleteLines(project, lineIds) {
    if (!Array.isArray(lineIds) || !lineIds.length || lineIds.length > LIMITS.MAX_LINES) fail(`lineIds must contain between 1 and ${LIMITS.MAX_LINES} IDs.`);
    const deleting = new Set();
    for (const lineId of lineIds) {
      id(lineId, "lineIds item");
      if (deleting.has(lineId)) fail(`lineIds contains duplicate ID ${lineId}.`);
      findLine(project, lineId);
      deleting.add(lineId);
    }
    // Resolve every affected range against its original ordering, before removal.
    for (const section of project.sections) {
      if (!section.lines.some((line) => deleting.has(line.id))) continue;
      const remaining = section.lines.filter((line) => !deleting.has(line.id));
      if (!remaining.length) fail(`Cannot delete all lines in section ${section.id}; update a line to empty instead.`);
      section.notes = (section.notes || []).flatMap((note) => {
        const start = section.lines.findIndex((line) => line.id === note.startLineId);
        const end = section.lines.findIndex((line) => line.id === note.endLineId);
        const survivingRange = section.lines.slice(Math.min(start, end), Math.max(start, end) + 1)
          .filter((line) => !deleting.has(line.id));
        if (!survivingRange.length) return [];
        return [{ ...note, startLineId: survivingRange[0].id, endLineId: survivingRange[survivingRange.length - 1].id }];
      });
      section.lines = remaining;
    }
  }

  function applyOperation(project, operation, usedIds) {
    object(operation, "operation");
    const common = ["op"];
    switch (operation.op) {
      case "set_title":
        keys(operation, common.concat("title"), ["op", "title"], operation.op);
        project.title = text(operation.title, "title", LIMITS.MAX_TITLE_LENGTH);
        return;
      case "add_section": {
        keys(operation, common.concat("title", "afterSectionId"), ["op", "title"], operation.op);
        const title = text(operation.title, "title", LIMITS.MAX_TITLE_LENGTH, true);
        const after = OWN(operation, "afterSectionId") ? findSection(project, operation.afterSectionId) : null;
        const index = after ? project.sections.indexOf(after) + 1 : project.sections.length;
        project.sections.splice(index, 0, {
          id: newId("section", usedIds), title,
          lines: [newLine({ body: "" }, usedIds, "new section line")], notes: [],
        });
        return;
      }
      case "rename_section":
        keys(operation, common.concat("sectionId", "title"), ["op", "sectionId", "title"], operation.op);
        findSection(project, operation.sectionId).title = text(operation.title, "title", LIMITS.MAX_TITLE_LENGTH, true);
        return;
      case "delete_section": {
        keys(operation, common.concat("sectionId"), ["op", "sectionId"], operation.op);
        const section = findSection(project, operation.sectionId);
        if (project.sections.length === 1) fail("Cannot delete the last section.");
        const index = project.sections.indexOf(section);
        project.sections.splice(index, 1);
        if (project.activeSectionId === section.id) project.activeSectionId = project.sections[Math.min(index, project.sections.length - 1)].id;
        return;
      }
      case "update_line": {
        keys(operation, common.concat("lineId", "body", "speaker", "type", "bodyMarks"), ["op", "lineId"], operation.op);
        if (!["body", "speaker", "type", "bodyMarks"].some((key) => OWN(operation, key))) fail("update_line requires at least one changed field.");
        const { line } = findLine(project, operation.lineId);
        const beforeBody = line.body;
        if (OWN(operation, "body")) line.body = text(operation.body, "body", LIMITS.MAX_BODY_LENGTH);
        if (OWN(operation, "bodyMarks")) line.bodyMarks = marks(operation.bodyMarks, line.body, "bodyMarks");
        else if (line.body !== beforeBody) line.bodyMarks = [];
        if (OWN(operation, "speaker")) {
          line.speaker = speakerName(operation.speaker, "speaker", LIMITS.MAX_SPEAKER_LENGTH);
          line.speakerCommitted = true;
        }
        if (OWN(operation, "type")) line.type = lineType(operation.type, "type");
        return;
      }
      case "insert_lines": {
        keys(operation, common.concat("sectionId", "afterLineId", "lines"), ["op", "sectionId", "lines"], operation.op);
        const section = findSection(project, operation.sectionId);
        if (!Array.isArray(operation.lines) || !operation.lines.length || operation.lines.length > LIMITS.MAX_LINES) fail(`lines must contain between 1 and ${LIMITS.MAX_LINES} lines.`);
        let index = section.lines.length;
        if (OWN(operation, "afterLineId")) {
          id(operation.afterLineId, "afterLineId");
          index = section.lines.findIndex((line) => line.id === operation.afterLineId);
          if (index < 0) fail("afterLineId must refer to a line in sectionId.");
          index += 1;
        }
        const lines = operation.lines.map((raw, position) => newLine(raw, usedIds, `lines[${position}]`));
        section.lines.splice(index, 0, ...lines);
        return;
      }
      case "delete_lines":
        keys(operation, common.concat("lineIds"), ["op", "lineIds"], operation.op);
        deleteLines(project, operation.lineIds);
        return;
      case "upsert_note": {
        keys(operation, common.concat("sectionId", "noteId", "startLineId", "endLineId", "text", "color"), ["op", "sectionId", "startLineId", "text"], operation.op);
        const section = findSection(project, operation.sectionId);
        const noteText = text(operation.text, "text", LIMITS.MAX_BODY_LENGTH);
        id(operation.startLineId, "startLineId");
        const endLineId = OWN(operation, "endLineId") ? id(operation.endLineId, "endLineId") : operation.startLineId;
        const startIndex = section.lines.findIndex((line) => line.id === operation.startLineId);
        const endIndex = section.lines.findIndex((line) => line.id === endLineId);
        if (startIndex < 0 || endIndex < 0) fail("Note endpoints must refer to lines in sectionId.");
        const found = OWN(operation, "noteId") ? findNote(project, operation.noteId) : null;
        if (found && found.section !== section) fail("noteId belongs to a different section.");
        if (OWN(operation, "noteId") && !found && usedIds.has(operation.noteId)) fail("noteId collides with an existing ID.");
        const noteId = found?.note.id || (OWN(operation, "noteId") ? operation.noteId : newId("note", usedIds));
        usedIds.add(noteId);
        const note = {
          ...(found ? found.note : { id: noteId, kind: "note", color: "#dbeafe" }),
          text: noteText,
          startLineId: section.lines[Math.min(startIndex, endIndex)].id,
          endLineId: section.lines[Math.max(startIndex, endIndex)].id,
        };
        if (OWN(operation, "color")) note.color = color(operation.color, "color");
        if (!section.notes) section.notes = [];
        if (found) section.notes[section.notes.indexOf(found.note)] = note;
        else section.notes.push(note);
        return;
      }
      case "delete_note": {
        keys(operation, common.concat("noteId"), ["op", "noteId"], operation.op);
        const found = findNote(project, operation.noteId);
        if (!found) fail(`Note ${operation.noteId} does not exist.`);
        found.section.notes.splice(found.section.notes.indexOf(found.note), 1);
        return;
      }
      case "upsert_furigana": {
        keys(operation, common.concat("word", "reading"), ["op", "word", "reading"], operation.op);
        const word = furiganaValue(operation.word, "word");
        const reading = furiganaValue(operation.reading, "reading");
        const entries = project.furigana ??= [];
        const existing = entries.find((entry) => entry.word === word);
        if (existing) existing.reading = reading;
        else entries.push({ word, reading });
        return;
      }
      case "delete_furigana": {
        keys(operation, common.concat("word"), ["op", "word"], operation.op);
        const word = furiganaValue(operation.word, "word");
        const index = project.furigana?.findIndex((entry) => entry.word === word);
        if (index >= 0) project.furigana.splice(index, 1);
        return;
      }
      default:
        fail("Unknown operation. Use set_title, add_section, rename_section, delete_section, update_line, insert_lines, delete_lines, upsert_note, delete_note, upsert_furigana or delete_furigana.");
    }
  }

  function applyProjectEdits(project, operations) {
    validateProject(project);
    if (!Array.isArray(operations) || !operations.length || operations.length > LIMITS.MAX_OPERATIONS) fail(`operations must contain between 1 and ${LIMITS.MAX_OPERATIONS} edits.`);
    let insertedLines = 0;
    for (const operation of operations) {
      object(operation, "operation");
      if (operation.op === "insert_lines" && Array.isArray(operation.lines)) insertedLines += operation.lines.length;
      if (operation.op === "add_section") insertedLines += 1;
    }
    if (insertedLines > LIMITS.MAX_LINES) fail(`A batch may create at most ${LIMITS.MAX_LINES} lines.`);
    let next;
    try {
      next = JSON.parse(JSON.stringify(project));
    } catch (error) {
      fail("project must contain serializable JSON data.");
    }
    const usedIds = allIds(next);
    operations.forEach((operation, index) => {
      try {
        applyOperation(next, operation, usedIds);
      } catch (error) {
        if (error.code === "INVALID_EDIT") error.message = `Operation ${index + 1}: ${error.message}`;
        throw error;
      }
    });
    validateProject(next);
    return next;
  }

  return Object.freeze({ applyProjectEdits, validateProject, LIMITS });
});
