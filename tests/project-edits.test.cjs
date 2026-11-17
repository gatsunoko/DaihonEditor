"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { applyProjectEdits, validateProject, LIMITS } = require("../mcp/project-edits.js");

function line(id, speaker = "太郎", body = "Alpha Bravo") {
  return { id, speaker, body, bodyMarks: [], type: "dialogue", speakerCommitted: true };
}

function seed() {
  return {
    projectId: "project-test",
    title: "台本",
    activeSectionId: "section-a",
    sections: [
      { id: "section-a", title: "第一章", lines: [
        { ...line("a1"), bodyMarks: [{ start: 0, end: 5, bold: true, color: "#DC2626" }], custom: { retained: true } },
        line("a2", "花子", "Second"), line("a3", "太郎", "Third"), line("a4", "花子", "Fourth"),
      ], notes: [
        { id: "note-a", kind: "camera", text: "カメラを引く", color: "#dbeafe", startLineId: "a1", endLineId: "a3", custom: "retained" },
        { id: "note-b", kind: "note", text: "単独備考", color: "#abcdef", startLineId: "a2", endLineId: "a2" },
      ], custom: { location: "室内" } },
      { id: "section-b", title: "第二章", lines: [line("b1", "花子", "Elsewhere")], notes: [] },
    ],
    speakers: { 太郎: { name: "太郎", color: "#012345", bodyColor: "#abcdef", auto: false }, 花子: { name: "花子", color: "#234567", auto: false } },
    speakerOrder: ["花子", "太郎"],
    furigana: [{ word: "台本", reading: "だいほん" }],
    settings: { showFurigana: true, exportNotes: true },
    updatedAt: "2026-10-14T00:00:00.000Z",
    custom: { preserved: [1, 2, 3] },
  };
}

function getLine(project, id) {
  return project.sections.flatMap((section) => section.lines).find((item) => item.id === id);
}

function invalid(project, operations, pattern) {
  const before = structuredClone(project);
  assert.throws(() => applyProjectEdits(project, operations), (error) => {
    assert.equal(error.code, "INVALID_EDIT");
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
  assert.deepEqual(project, before, "failed batch must leave the original project unchanged");
}

test("a batch edits multiple sections and preserves project identity, metadata and speaker colors", () => {
  const project = seed();
  const before = structuredClone(project);
  const result = applyProjectEdits(project, [
    { op: "set_title", title: "新しい台本" },
    { op: "rename_section", sectionId: "section-b", title: "エピローグ" },
    { op: "update_line", lineId: "a1", body: "変更後", speaker: "新しい話者：", type: "direction" },
    { op: "update_line", lineId: "b1", body: "Another section changed" },
  ]);
  assert.equal(result.title, "新しい台本");
  assert.equal(result.sections[1].title, "エピローグ");
  assert.equal(getLine(result, "a1").speaker, "新しい話者");
  assert.equal(getLine(result, "a1").type, "direction");
  assert.equal(getLine(result, "b1").body, "Another section changed");
  for (const key of ["projectId", "speakers", "speakerOrder", "furigana", "settings", "updatedAt", "custom"]) assert.deepEqual(result[key], project[key]);
  assert.deepEqual(result.sections[0].custom, project.sections[0].custom);
  assert.deepEqual(getLine(result, "a1").custom, getLine(project, "a1").custom);
  assert.deepEqual(project, before);
  result.custom.preserved.push(4);
  assert.deepEqual(project.custom.preserved, [1, 2, 3], "returned nested metadata must be independent");
});

test("body changes clear stale formatting, while unchanged body and speaker edits preserve it", () => {
  const project = seed();
  const same = applyProjectEdits(project, [{ op: "update_line", lineId: "a1", body: "Alpha Bravo", speaker: "花子" }]);
  assert.deepEqual(getLine(same, "a1").bodyMarks, getLine(project, "a1").bodyMarks);
  const changed = applyProjectEdits(project, [{ op: "update_line", lineId: "a1", body: "New text" }]);
  assert.deepEqual(getLine(changed, "a1").bodyMarks, []);
});

test("explicit formatting offsets use UTF-16 and replace existing marks", () => {
  const result = applyProjectEdits(seed(), [{ op: "update_line", lineId: "a1", body: "😀本文", bodyMarks: [
    { start: 0, end: 2, bold: true }, { start: 2, end: 4, color: "#123456" },
  ] }]);
  assert.deepEqual(getLine(result, "a1").bodyMarks, [
    { start: 0, end: 2, bold: true, color: "" }, { start: 2, end: 4, bold: false, color: "#123456" },
  ]);
});

test("inserted lines preserve order and create unique IDs with committed speakers", () => {
  const project = seed();
  const result = applyProjectEdits(project, [
    { op: "insert_lines", sectionId: "section-a", afterLineId: "a1", lines: [
      { speaker: "新人", body: "一行目" }, { body: "効果", type: "sfx", bodyMarks: [{ start: 0, end: 2, bold: true }] },
    ] },
    { op: "insert_lines", sectionId: "section-a", lines: [{ body: "最後" }] },
  ]);
  const lines = result.sections[0].lines;
  assert.deepEqual(lines.map((item) => item.body), ["Alpha Bravo", "一行目", "効果", "Second", "Third", "Fourth", "最後"]);
  const inserted = lines.filter((item) => !project.sections[0].lines.some((original) => original.id === item.id));
  assert.equal(inserted.length, 3);
  assert.ok(inserted.every((item) => item.speakerCommitted === true));
  assert.equal(new Set(result.sections.flatMap((section) => [section.id, ...section.lines.map((item) => item.id)])).size, 10);
});

test("adding sections supports a requested insertion point and append", () => {
  const project = seed();
  const result = applyProjectEdits(project, [
    { op: "add_section", title: "幕間", afterSectionId: "section-a" },
    { op: "add_section", title: "クレジット" },
  ]);
  assert.deepEqual(result.sections.map((item) => item.title), ["第一章", "幕間", "第二章", "クレジット"]);
  assert.ok(result.sections.every((item) => item.lines.length));
  assert.equal(result.activeSectionId, project.activeSectionId);
  assert.equal(validateProject(result), true);
});

test("deleting an active section selects a surviving section and leaves identity intact", () => {
  const project = seed();
  const result = applyProjectEdits(project, [{ op: "delete_section", sectionId: "section-a" }]);
  assert.deepEqual(result.sections.map((item) => item.id), ["section-b"]);
  assert.equal(result.activeSectionId, "section-b");
  assert.equal(result.projectId, project.projectId);
  invalid(result, [{ op: "delete_section", sectionId: "section-b" }], /last section/);
});

test("deleting range endpoints trims notes to surviving original-range lines", () => {
  const result = applyProjectEdits(seed(), [{ op: "delete_lines", lineIds: ["a1", "a2"] }]);
  assert.deepEqual(result.sections[0].lines.map((item) => item.id), ["a3", "a4"]);
  assert.deepEqual(result.sections[0].notes, [
    { id: "note-a", kind: "camera", text: "カメラを引く", color: "#dbeafe", startLineId: "a3", endLineId: "a3", custom: "retained" },
  ]);
});

test("removing every line in a note range removes the note rather than attaching it to an unrelated line", () => {
  const result = applyProjectEdits(seed(), [{ op: "delete_lines", lineIds: ["a1", "a2", "a3"] }]);
  assert.deepEqual(result.sections[0].lines.map((item) => item.id), ["a4"]);
  assert.deepEqual(result.sections[0].notes, []);
});

test("deleting an internal range line preserves note endpoints and handles reversed old endpoints", () => {
  const project = seed();
  project.sections[0].notes[0].startLineId = "a3";
  project.sections[0].notes[0].endLineId = "a1";
  const result = applyProjectEdits(project, [{ op: "delete_lines", lineIds: ["a2"] }]);
  assert.equal(result.sections[0].notes[0].startLineId, "a1");
  assert.equal(result.sections[0].notes[0].endLineId, "a3");
});

test("a delete spanning sections cannot empty one section and rolls back all removals", () => {
  invalid(seed(), [{ op: "delete_lines", lineIds: ["a1", "b1"] }], /all lines/);
});

test("upsert changes note text and bounds without losing kind, color or metadata", () => {
  const project = seed();
  const result = applyProjectEdits(project, [{ op: "upsert_note", sectionId: "section-a", noteId: "note-a", startLineId: "a4", endLineId: "a2", text: "寄る" }]);
  assert.deepEqual(result.sections[0].notes[0], { ...project.sections[0].notes[0], text: "寄る", startLineId: "a2", endLineId: "a4" });
});

test("new notes support generated/custom IDs and single-line defaults; delete removes only the requested note", () => {
  const result = applyProjectEdits(seed(), [
    { op: "upsert_note", sectionId: "section-b", startLineId: "b1", text: "新備考" },
    { op: "upsert_note", sectionId: "section-a", noteId: "custom-note", startLineId: "a4", text: "背景", color: "#123456" },
    { op: "delete_note", noteId: "note-b" },
  ]);
  assert.match(result.sections[1].notes[0].id, /^note-/);
  assert.equal(result.sections[1].notes[0].endLineId, "b1");
  assert.equal(result.sections[1].notes[0].color, "#dbeafe");
  assert.deepEqual(result.sections[0].notes.map((item) => item.id), ["note-a", "custom-note"]);
});

test("notes cannot move between sections or reference lines in a different section", () => {
  invalid(seed(), [{ op: "upsert_note", sectionId: "section-b", noteId: "note-a", startLineId: "b1", text: "Moved" }], /different section/);
  invalid(seed(), [{ op: "upsert_note", sectionId: "section-a", startLineId: "b1", text: "Wrong line" }], /endpoints/);
  invalid(seed(), [{ op: "upsert_note", sectionId: "section-a", noteId: "a1", startLineId: "a1", text: "Collision" }], /collides/);
});

test("furigana upsert normalizes both fields, updates in place, and preserves the script body", () => {
  const project = seed();
  project.furigana.unshift({ word: "New York", reading: "にゅーよーく" });
  project.sections[0].lines[0].body = "New Yorkで台本を読む";
  const before = structuredClone(project);
  const result = applyProjectEdits(project, [
    { op: "upsert_furigana", word: "　New\r\n\nYork  ", reading: "\nニュー\r\r\nヨーク　" },
    { op: "upsert_furigana", word: "　読み合わせ\r\n", reading: " よみあわせ " },
  ]);
  assert.deepEqual(result.furigana, [
    { word: "New York", reading: "ニュー ヨーク" },
    { word: "台本", reading: "だいほん" },
    { word: "読み合わせ", reading: "よみあわせ" },
  ]);
  assert.deepEqual(result.sections, before.sections);
  assert.deepEqual(project, before);
});

test("furigana deletion matches the normalized word and an absent word is a no-op", () => {
  const project = seed();
  project.furigana.push({ word: "New York", reading: "ニュー ヨーク" });
  const result = applyProjectEdits(project, [{ op: "delete_furigana", word: "\r New\n\rYork　" }]);
  assert.deepEqual(result.furigana, [{ word: "台本", reading: "だいほん" }]);
  assert.deepEqual(result.sections, project.sections);
  assert.deepEqual(applyProjectEdits(result, [{ op: "delete_furigana", word: " New\r\nYork " }]), result);
});

test("blank normalized furigana fields reject the entire edit batch", () => {
  const project = seed();
  invalid(project, [
    { op: "upsert_furigana", word: "新語", reading: "しんご" },
    { op: "delete_furigana", word: "台本" },
    { op: "upsert_furigana", word: "空の読み", reading: "　\r\n " },
  ], /Operation 3/);
  invalid(project, [{ op: "upsert_furigana", word: "\r\n　", reading: "よみ" }]);
  invalid(project, [{ op: "delete_furigana", word: "\r\n　" }]);
});

test("furigana fields accept 500 raw UTF-16 units and reject longer input before trimming", () => {
  const word = "😀".repeat(250);
  const reading = "🍎".repeat(250);
  const result = applyProjectEdits(seed(), [{ op: "upsert_furigana", word, reading }]);
  assert.deepEqual(result.furigana.at(-1), { word, reading });
  assert.deepEqual(applyProjectEdits(result, [{ op: "delete_furigana", word }]).furigana, seed().furigana);

  invalid(result, [{ op: "upsert_furigana", word: `${word} `, reading }]);
  invalid(result, [{ op: "upsert_furigana", word, reading: `${reading}\n` }]);
  invalid(result, [{ op: "delete_furigana", word: ` ${word}` }]);
});

test("an invalid later operation rolls back preceding title, insertion and formatting edits", () => {
  invalid(seed(), [
    { op: "set_title", title: "Partial change must not escape" },
    { op: "insert_lines", sectionId: "section-a", lines: [{ body: "Partial insertion" }] },
    { op: "update_line", lineId: "a1", body: "Changed" },
    { op: "update_line", lineId: "missing", body: "Failure" },
  ], /Operation 4.*does not exist/);
});

test("strict keys prevent accidentally changing project identity and unknown metadata", () => {
  for (const operation of [
    { op: "set_title", title: "Title", projectId: "other-project" },
    { op: "update_line", lineId: "a1", body: "Body", id: "replacement-id" },
    { op: "insert_lines", sectionId: "section-a", lines: [{ body: "Body", id: "custom-line" }] },
    { op: "upsert_note", sectionId: "section-a", startLineId: "a1", text: "Note", kind: "camera" },
    { op: "replace_project", project: seed() },
  ]) invalid(seed(), [operation], /unknown field|Unknown operation/);
});

test("undefined optional fields are invalid rather than silently treated as omitted", () => {
  for (const operation of [
    { op: "update_line", lineId: "a1", body: undefined },
    { op: "add_section", title: "New", afterSectionId: undefined },
    { op: "upsert_note", sectionId: "section-a", startLineId: "a1", text: "Note", color: undefined },
  ]) invalid(seed(), [operation]);
});

test("invalid references and duplicate deletion IDs are rejected", () => {
  for (const operation of [
    { op: "rename_section", sectionId: "missing", title: "Title" },
    { op: "insert_lines", sectionId: "section-a", afterLineId: "b1", lines: [{ body: "Bad position" }] },
    { op: "delete_lines", lineIds: ["a1", "a1"] },
    { op: "delete_note", noteId: "missing" },
    { op: "update_line", lineId: "a1" },
  ]) invalid(seed(), [operation]);
});

test("prototype-sensitive speaker names are rejected after normalization", () => {
  for (const name of ["__proto__", "constructor", "prototype", " constructor：", "__proto__:"]) {
    invalid(seed(), [{ op: "update_line", lineId: "a1", speaker: name }], /reserved/);
    invalid(seed(), [{ op: "insert_lines", sectionId: "section-a", lines: [{ speaker: name, body: "Body" }] }], /reserved/);
  }
  const project = seed();
  project.speakers = JSON.parse('{"__proto__":{"name":"__proto__"}}');
  invalid(project, [{ op: "set_title", title: "No unsafe speaker map" }], /reserved/);
  assert.equal({}.polluted, undefined);
});

test("malformed formatting and unsafe colors are rejected before returning a project", () => {
  for (const mark of [
    { start: -1, end: 3, bold: true }, { start: 0, end: 100, bold: true },
    { start: 0.5, end: 3, bold: true }, { start: 3, end: 3, bold: true },
    { start: 0, end: 3, bold: "yes" }, { start: 0, end: 3 },
    { start: NaN, end: 3, bold: true }, { start: 0, end: 3, color: "url(javascript:alert(1))" },
    { start: 0, end: 3, bold: true, html: "<script>" },
  ]) invalid(seed(), [{ op: "update_line", lineId: "a1", bodyMarks: [mark] }]);
  invalid(seed(), [{ op: "upsert_note", sectionId: "section-a", startLineId: "a1", text: "Note", color: "red" }]);
});

test("input limits cover text, speakers, titles, lines and operations", () => {
  for (const operation of [
    { op: "set_title", title: "x".repeat(LIMITS.MAX_TITLE_LENGTH + 1) },
    { op: "update_line", lineId: "a1", body: "x".repeat(LIMITS.MAX_BODY_LENGTH + 1) },
    { op: "update_line", lineId: "a1", speaker: "x".repeat(LIMITS.MAX_SPEAKER_LENGTH + 1) },
    { op: "insert_lines", sectionId: "section-a", lines: Array.from({ length: LIMITS.MAX_LINES + 1 }, () => ({ body: "x" })) },
  ]) invalid(seed(), [operation]);
  invalid(seed(), Array.from({ length: LIMITS.MAX_OPERATIONS + 1 }, () => ({ op: "set_title", title: "x" })));
  invalid(seed(), [
    { op: "insert_lines", sectionId: "section-a", lines: Array.from({ length: 600 }, () => ({ body: "x" })) },
    { op: "insert_lines", sectionId: "section-b", lines: Array.from({ length: 401 }, () => ({ body: "x" })) },
  ], /at most 1000 lines/);
});

test("large existing bodies remain editable through unrelated operations", () => {
  const project = seed();
  getLine(project, "a2").body = "x".repeat(LIMITS.MAX_BODY_LENGTH + 1);
  const result = applyProjectEdits(project, [{ op: "set_title", title: "Only the title changed" }]);
  assert.equal(getLine(result, "a2").body.length, LIMITS.MAX_BODY_LENGTH + 1);
});

test("malformed existing IDs and note references fail without altering the source", () => {
  const projectCollision = seed();
  projectCollision.sections[0].lines[0].id = projectCollision.projectId;
  invalid(projectCollision, [{ op: "set_title", title: "Title" }], /duplicate ID/);
  const duplicateLine = seed();
  duplicateLine.sections[1].lines[0].id = "a1";
  invalid(duplicateLine, [{ op: "set_title", title: "Title" }], /duplicate ID/);
  const duplicateNote = seed();
  duplicateNote.sections[0].notes[0].id = "section-b";
  invalid(duplicateNote, [{ op: "set_title", title: "Title" }], /duplicate ID/);
  const missingEndpoint = seed();
  missingEndpoint.sections[0].notes[0].endLineId = "b1";
  invalid(missingEndpoint, [{ op: "set_title", title: "Title" }], /endpoints/);
});

test("repeated insertions generate globally distinct entity IDs", () => {
  let project = seed();
  for (let index = 0; index < 20; index += 1) {
    project = applyProjectEdits(project, [
      { op: "add_section", title: `章${index}` },
      { op: "insert_lines", sectionId: "section-a", lines: [{ body: `本文${index}` }] },
      { op: "upsert_note", sectionId: "section-b", startLineId: "b1", text: `備考${index}` },
    ]);
  }
  const ids = [project.projectId, ...project.sections.flatMap((section) => [section.id, ...section.lines.map((item) => item.id), ...section.notes.map((item) => item.id)])];
  assert.equal(ids.length, new Set(ids).size);
});

test("empty/malformed batches and non-plain operations are rejected", () => {
  for (const operations of [null, [], {}, [null], [new Date()], [{ op: "update_line", lineId: "a1", type: "unknown" }]]) invalid(seed(), operations);
});

test("the same module works as a browser global without CommonJS", () => {
  const context = vm.createContext({ seedText: JSON.stringify(seed()) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../mcp/project-edits.js"), "utf8"), context);
  const result = vm.runInContext("ScriptEditorProjectEdits.applyProjectEdits(JSON.parse(seedText), [{ op: 'set_title', title: 'ブラウザ' }])", context);
  assert.equal(result.title, "ブラウザ");
  assert.equal(result.projectId, "project-test");
});
