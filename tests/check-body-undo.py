"""Browser regression checks for body Undo across row focus changes."""
import copy
import json
import sys
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
KEY = "script-editor-project-v1"
TITLE = "直前の本文編集を元に戻す"


def line(line_id, speaker, body, marks=None):
    return {
        "id": line_id,
        "speaker": speaker,
        "body": body,
        "bodyMarks": marks or [],
        "type": "dialogue",
        "speakerCommitted": True,
    }


SEED = {
    "projectId": "project-body-undo-check",
    "title": "本文の取り消し確認",
    "activeSectionId": "section-1",
    "sections": [
        {"id": "section-1", "title": "第一章", "lines": [
            line("line-1", "太郎", "Alpha Bravo Charlie", [
                {"start": 0, "end": 5, "bold": True, "color": "#DC2626"},
                {"start": 6, "end": 11, "bold": False, "color": "#2563EB"},
            ]),
            line("line-2", "花子", "Second row unchanged"),
        ], "notes": []},
        {"id": "section-2", "title": "第二章", "lines": [
            line("line-3", "太郎", "Third row in another section"),
        ], "notes": []},
    ],
    "speakers": {
        name: {"name": name, "color": "#2563eb", "bodyColor": "#1f2937", "auto": False, "createdAt": "2026-01-01T00:00:00.000Z"}
        for name in ["太郎", "花子"]
    },
    "speakerOrder": ["太郎", "花子"],
    "furigana": [],
    "settings": {"showFurigana": False},
}


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.set_default_timeout(3000)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto((ROOT / "index.html").as_uri())
    failures = []

    def body(line_id):
        return page.locator(f'.script-row[data-line-id="{line_id}"] .body-input')

    def speaker(line_id):
        return page.locator(f'.script-row[data-line-id="{line_id}"] .speaker-input')

    def undo_button():
        return page.locator("#undoDeleteLineButton")

    def data():
        return page.evaluate("key => JSON.parse(localStorage.getItem(key))", KEY)

    def saved_line(line_id):
        return next(item for section in data()["sections"] for item in section["lines"] if item["id"] == line_id)

    def wait_body(line_id, text):
        expect(body(line_id)).to_have_text(text)
        page.wait_for_function("([key, id, text]) => JSON.parse(localStorage.getItem(key)).sections.flatMap(s => s.lines).find(l => l.id === id)?.body === text", arg=[KEY, line_id, text])

    def reset(seed=SEED):
        # Finish the previous scenario before seeding; beforeunload saves must
        # not overwrite the seed when a failed assertion leaves edits pending.
        page.evaluate("document.activeElement?.blur()")
        page.reload()
        page.evaluate("([key, value]) => localStorage.setItem(key, JSON.stringify(value))", [KEY, copy.deepcopy(seed)])
        page.reload()
        expect(body("line-1")).to_have_text(SEED["sections"][0]["lines"][0]["body"])
        expect(undo_button()).to_be_disabled()

    def select(line_id, start, end=None):
        if end is None:
            end = start
        body(line_id).evaluate("""(editor, [start, end]) => {
            editor.focus();
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            const position = offset => {
                for (const node of nodes) {
                    if (offset <= node.textContent.length) return [node, offset];
                    offset -= node.textContent.length;
                }
                return [editor, editor.childNodes.length];
            };
            const [a, x] = position(start);
            const [b, y] = position(end);
            const range = document.createRange();
            range.setStart(a, x); range.setEnd(b, y);
            const selection = document.getSelection();
            selection.removeAllRanges(); selection.addRange(range);
            editor.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
        }""", [start, end])

    def replace(line_id, start, end, text):
        select(line_id, start, end)
        page.keyboard.insert_text(text)

    def paste(line_id, text, html=""):
        body(line_id).evaluate("""(editor, [text, html]) => {
            const clipboard = new DataTransfer();
            clipboard.setData('text/plain', text);
            clipboard.setData('text', text);
            if (html) clipboard.setData('text/html', html);
            editor.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, cancelable:true, clipboardData:clipboard}));
        }""", [text, html])

    def compose(line_id, text):
        body(line_id).evaluate("""(editor, value) => {
            editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true, data:''}));
            editor.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, cancelable:true, inputType:'insertCompositionText', data:value, isComposing:true}));
            const range = document.getSelection().getRangeAt(0);
            range.deleteContents();
            const text = document.createTextNode(value); range.insertNode(text);
            range.setStart(text, text.length); range.collapse(true);
            document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
            editor.dispatchEvent(new CompositionEvent('compositionupdate', {bubbles:true, data:value}));
            editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertCompositionText', data:value, isComposing:true}));
            editor.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true, data:value}));
            editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertFromComposition', data:value, isComposing:false}));
        }""", text)

    def original(line_id):
        return next(item for section in SEED["sections"] for item in section["lines"] if item["id"] == line_id)

    def assert_original(line_id):
        wait_body(line_id, original(line_id)["body"])
        current = saved_line(line_id)
        for field in ["body", "bodyMarks", "speaker", "speakerCommitted", "type"]:
            assert current[field] == original(line_id)[field], (line_id, field, current[field], original(line_id)[field])

    def undo(control="button"):
        expect(undo_button()).to_be_enabled()
        if control == "button":
            undo_button().click()
        else:
            page.keyboard.press("Control+z")

    def test_cross_row_button():
        reset()
        replace("line-1", 2, 9, "XYZ")
        body("line-2").focus()
        wait_body("line-1", "AlXYZvo Charlie")
        expect(undo_button()).to_have_attribute("title", TITLE)
        undo()
        assert_original("line-1")
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    def test_cross_row_keyboard():
        for field in ["body", "speaker"]:
            reset()
            replace("line-1", 2, 9, "XYZ")
            (body if field == "body" else speaker)("line-2").focus()
            undo("keyboard")
            assert_original("line-1")
            assert_original("line-2")
            expect(undo_button()).to_be_disabled()

    def test_reverse_order():
        reset()
        replace("line-1", 2, 9, "XYZ")
        replace("line-2", 0, 6, "Another")
        speaker("line-1").focus()
        undo()
        assert_original("line-2")
        wait_body("line-1", "AlXYZvo Charlie")
        undo()
        assert_original("line-1")
        expect(undo_button()).to_be_disabled()

    def test_paste_then_typing():
        for html in ["", '<strong style="color:#059669">PASTE</strong>']:
            reset()
            select("line-1", 2, 9)
            paste("line-1", "PASTE", html)
            body("line-2").focus()
            wait_body("line-1", "AlPASTEvo Charlie")
            after_paste = copy.deepcopy(saved_line("line-1"))
            select("line-1", 7)
            page.keyboard.insert_text("TYPE")
            body("line-2").focus()
            wait_body("line-1", "AlPASTETYPEvo Charlie")
            undo()
            wait_body("line-1", after_paste["body"])
            assert saved_line("line-1")["bodyMarks"] == after_paste["bodyMarks"]
            expect(undo_button()).to_have_attribute("title", "直前の貼り付けを元に戻す")
            undo()
            assert_original("line-1")
            assert_original("line-2")
            expect(undo_button()).to_be_disabled()

    def test_delete_then_body():
        reset()
        replace("line-1", 2, 9, "XYZ")
        page.locator('.script-row[data-line-id="line-2"] .delete-row').click()
        expect(page.locator(".script-row")).to_have_count(1)
        undo()
        expect(page.locator(".script-row")).to_have_count(2)
        assert_original("line-2")
        wait_body("line-1", "AlXYZvo Charlie")
        undo()
        assert_original("line-1")
        expect(undo_button()).to_be_disabled()

    def test_all_sections():
        reset()
        page.get_by_role("tab", name="全て表示", exact=True).click()
        replace("line-3", 0, 5, "Edited")
        body("line-1").focus()
        undo("keyboard")
        assert_original("line-3")
        assert_original("line-1")
        expect(page.locator(".script-row")).to_have_count(3)

    def test_formatting():
        for selector in ["#bodyBoldButton", "#bodyColorApplyButton", "#bodyColorClearButton"]:
            reset()
            select("line-1", 6, 11)
            page.locator(selector).click()
            body("line-2").focus()
            page.wait_for_function("([key, expected]) => JSON.stringify(JSON.parse(localStorage.getItem(key)).sections[0].lines[0].bodyMarks) !== JSON.stringify(expected)", arg=[KEY, original("line-1")["bodyMarks"]])
            expect(undo_button()).to_have_attribute("title", TITLE)
            undo()
            assert_original("line-1")
            assert_original("line-2")

    def test_noop_focus():
        reset()
        body("line-1").focus()
        body("line-2").focus()
        speaker("line-1").focus()
        body("line-1").focus()
        expect(undo_button()).to_be_disabled()
        assert_original("line-1")
        assert_original("line-2")

    def test_restore_selection():
        reset()
        replace("line-1", 2, 9, "XYZ")
        body("line-2").focus()
        undo("keyboard")
        assert_original("line-1")
        page.wait_for_function("document.activeElement?.closest('.script-row')?.dataset.lineId === 'line-1'")
        offsets = body("line-1").evaluate("""editor => {
            const range = document.getSelection().getRangeAt(0);
            const a = document.createRange(); a.selectNodeContents(editor); a.setEnd(range.startContainer, range.startOffset);
            const b = document.createRange(); b.selectNodeContents(editor); b.setEnd(range.endContainer, range.endOffset);
            return [a.toString().length, b.toString().length];
        }""")
        assert offsets == [2, 9], offsets

    def test_save_reload():
        reset()
        replace("line-1", 2, 9, "XYZ")
        body("line-2").focus()
        wait_body("line-1", "AlXYZvo Charlie")
        undo()
        assert_original("line-1")
        page.reload()
        assert_original("line-1")
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()
        replace("line-1", 2, 9, "XYZ")
        body("line-2").focus()
        wait_body("line-1", "AlXYZvo Charlie")
        page.reload()
        wait_body("line-1", "AlXYZvo Charlie")
        expect(undo_button()).to_be_disabled()

    def test_simulated_composition():
        reset()
        select("line-2", 0, 6)
        compose("line-2", "日本語")
        body("line-1").focus()
        wait_body("line-2", "日本語 row unchanged")
        undo()
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    def test_typing_group():
        reset()
        select("line-2", 6)
        page.keyboard.type("abc")
        body("line-1").focus()
        wait_body("line-2", "Secondabc row unchanged")
        undo("keyboard")
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    def test_backspace_group():
        reset()
        select("line-2", 6)
        page.keyboard.press("Backspace")
        page.keyboard.press("Backspace")
        page.keyboard.press("Backspace")
        body("line-1").focus()
        wait_body("line-2", "Sec row unchanged")
        undo()
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    def test_caret_move_breaks_group():
        reset()
        select("line-2", 6)
        page.keyboard.type("abc")
        page.keyboard.press("ArrowLeft")
        page.keyboard.type("x")
        body("line-1").focus()
        wait_body("line-2", "Secondabxc row unchanged")
        undo()
        wait_body("line-2", "Secondabc row unchanged")
        expect(undo_button()).to_be_enabled()
        undo()
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    def test_delete_edited_row():
        reset()
        replace("line-1", 2, 9, "XYZ")
        page.locator('.script-row[data-line-id="line-1"] .delete-row').click()
        expect(page.locator(".script-row")).to_have_count(1)
        undo()
        expect(page.locator(".script-row")).to_have_count(2)
        wait_body("line-1", "AlXYZvo Charlie")
        assert_original("line-2")
        undo()
        assert_original("line-1")
        expect(undo_button()).to_be_disabled()

    def test_exhausted_native_history():
        reset()
        replace("line-1", 2, 9, "XYZ")
        body("line-2").focus()
        undo("keyboard")
        assert_original("line-1")
        expect(undo_button()).to_be_disabled()
        page.keyboard.press("Control+z")
        assert_original("line-1")
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()
        page.keyboard.press("Control+Shift+z")
        assert_original("line-1")
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    def test_native_speaker_undo():
        reset()
        replace("line-1", 2, 9, "XYZ")
        speaker("line-2").focus()
        page.keyboard.press("Control+a")
        page.keyboard.type("Changed")
        expect(speaker("line-2")).to_have_value("Changed")
        page.keyboard.press("Control+z")
        # Chromium may group real key presses one character at a time. Either
        # outcome must use native speaker history and leave body history intact.
        expect(speaker("line-2")).not_to_have_value("Changed")
        after_native_undo = speaker("line-2").input_value()
        expect(body("line-1")).to_have_text("AlXYZvo Charlie")
        expect(undo_button()).to_have_attribute("title", TITLE)
        undo()
        assert_original("line-1")
        expect(speaker("line-2")).to_have_value(after_native_undo)
        wait_body("line-2", original("line-2")["body"])

    def test_section_switch():
        reset()
        replace("line-1", 2, 9, "XYZ")
        page.get_by_role("tab", name="第二章", exact=True).click()
        body("line-3").focus()
        undo("keyboard")
        assert_original("line-1")
        expect(page.get_by_role("tab", name="第一章", exact=True)).to_have_attribute("aria-selected", "true")
        assert saved_line("line-3") == original("line-3")

    def test_filter_hidden_row():
        reset()
        replace("line-1", 2, 9, "XYZ")
        page.locator("#speakerFilterSelect").select_option("花子")
        expect(body("line-1")).to_have_count(0)
        body("line-2").focus()
        undo("keyboard")
        assert_original("line-1")
        assert_original("line-2")
        expect(page.locator("#speakerFilterSelect")).to_have_value("")

    def test_furigana_annotations():
        seed = copy.deepcopy(SEED)
        seed["settings"]["showFurigana"] = True
        seed["furigana"] = [{"word": "Alpha", "reading": "アルファ"}]
        reset(seed)
        annotation = body("line-1").locator(".furigana-annotation")
        initial_count = annotation.count()
        assert initial_count >= 1
        assert annotation.evaluate_all("items => items.every(el => el.contentEditable === 'false')")
        replace("line-1", 2, 9, "XYZ")
        body("line-2").focus()
        undo()
        assert_original("line-1")
        body("line-2").focus()
        expect(annotation).to_have_count(initial_count)
        assert annotation.evaluate_all("items => items.every(el => el.dataset.furigana === 'アルファ')")
        assert data()["furigana"] == seed["furigana"]
        expect(undo_button()).to_be_disabled()

    def test_composition_then_caret_change():
        reset()
        select("line-2", 0, 6)
        compose("line-2", "日本語")
        intermediate = "日本語 row unchanged"
        expect(body("line-2")).to_have_text(intermediate)
        select("line-2", len(intermediate))
        page.keyboard.type("!")
        body("line-1").focus()
        wait_body("line-2", intermediate + "!")
        undo()
        wait_body("line-2", intermediate)
        undo()
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    def test_added_row_speaker_native_undo():
        reset()
        select("line-2", len(original("line-2")["body"]))
        page.keyboard.press("Enter")
        expect(page.locator(".script-row")).to_have_count(3)
        new_id = page.locator(".script-row").last.get_attribute("data-line-id")
        speaker(new_id).focus()
        page.keyboard.type("OnlySpeaker")
        body(new_id).focus()
        page.keyboard.press("Control+z")
        expect(page.locator(".script-row")).to_have_count(3)
        expect(body(new_id)).to_have_count(1)
        assert_original("line-1")
        assert_original("line-2")

    def test_beforeinput_history_undo():
        reset()
        replace("line-1", 2, 9, "XYZ")
        body("line-2").focus()
        canceled = body("line-2").evaluate("""editor => {
            const event = new InputEvent('beforeinput', {bubbles:true, cancelable:true, inputType:'historyUndo'});
            editor.dispatchEvent(event);
            return event.defaultPrevented;
        }""")
        assert canceled
        assert_original("line-1")
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    def test_multistep_composition_commit():
        reset()
        select("line-2", 0, 6)
        body("line-2").evaluate("""editor => {
            editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true, data:''}));
            let composingNode;
            const change = (value, inputType, isComposing) => {
                if (composingNode) {
                    const selected = document.createRange();
                    selected.selectNodeContents(composingNode);
                    document.getSelection().removeAllRanges();
                    document.getSelection().addRange(selected);
                }
                editor.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, cancelable:true, inputType, data:value, isComposing}));
                if (composingNode) {
                    composingNode.textContent = value;
                } else {
                    const selected = document.getSelection().getRangeAt(0);
                    selected.deleteContents();
                    composingNode = document.createTextNode(value);
                    selected.insertNode(composingNode);
                }
                const caret = document.createRange();
                caret.setStart(composingNode, value.length); caret.collapse(true);
                document.getSelection().removeAllRanges(); document.getSelection().addRange(caret);
                editor.dispatchEvent(new InputEvent('input', {bubbles:true, inputType, data:value, isComposing}));
            };
            change('に', 'insertCompositionText', true);
            editor.dispatchEvent(new CompositionEvent('compositionupdate', {bubbles:true, data:'に'}));
            change('日本', 'insertCompositionText', true);
            editor.dispatchEvent(new CompositionEvent('compositionupdate', {bubbles:true, data:'日本'}));
            editor.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true, data:'日本語'}));
            change('日本語', 'insertFromComposition', false);
        }""")
        body("line-1").focus()
        wait_body("line-2", "日本語 row unchanged")
        undo()
        assert_original("line-2")
        expect(undo_button()).to_be_disabled()

    checks = [
        test_cross_row_button,
        test_cross_row_keyboard,
        test_reverse_order,
        test_paste_then_typing,
        test_delete_then_body,
        test_all_sections,
        test_formatting,
        test_noop_focus,
        test_restore_selection,
        test_save_reload,
        test_simulated_composition,
        test_typing_group,
        test_backspace_group,
        test_caret_move_breaks_group,
        test_delete_edited_row,
        test_exhausted_native_history,
        test_native_speaker_undo,
        test_section_switch,
        test_filter_hidden_row,
        test_furigana_annotations,
        test_composition_then_caret_change,
        test_added_row_speaker_native_undo,
        test_beforeinput_history_undo,
        test_multistep_composition_commit,
    ]
    for check in checks:
        try:
            check()
            print(f"PASS: {check.__name__}", flush=True)
        except Exception as error:
            failures.append(check.__name__)
            print(f"FAIL: {check.__name__}: {error}", flush=True)
            traceback.print_exc(limit=2)
    browser.close()
    if errors:
        print("JavaScript errors:", json.dumps(errors, ensure_ascii=False), flush=True)
        failures.append("JavaScript errors")
    if failures:
        print("Failed checks:", ", ".join(failures), flush=True)
        sys.exit(1)
    print("All body Undo browser checks passed without JavaScript errors.", flush=True)
