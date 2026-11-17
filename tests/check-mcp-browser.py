"""End-to-end checks through a real MCP client and both editor origins.

Requires Python Playwright with Chromium and the project's Node dependencies.
The JSON-lines Node fixture launches the stdio MCP proxy on an isolated port.
"""
import copy
import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
KEY = "script-editor-project-v1"
SEED = {
    "projectId": "project-mcp-browser-check",
    "title": "MCPブラウザ確認",
    "activeSectionId": "section-1",
    "sections": [{"id": "section-1", "title": "第一章", "lines": [
        {"id": "line-1", "speaker": "太郎", "body": "Alpha Bravo Charlie",
         "bodyMarks": [{"start": 0, "end": 5, "bold": True, "color": "#DC2626"},
                       {"start": 6, "end": 11, "bold": False, "color": "#2563EB"}],
         "type": "dialogue", "speakerCommitted": True},
        {"id": "line-2", "speaker": "花子", "body": "Second row unchanged",
         "bodyMarks": [], "type": "dialogue", "speakerCommitted": True},
    ], "notes": []}],
    "speakers": {name: {"name": name, "color": "#2563eb", "bodyColor": "#1f2937",
                       "auto": False, "createdAt": "2026-01-01T00:00:00.000Z"}
                 for name in ["太郎", "花子"]},
    "speakerOrder": ["太郎", "花子"], "furigana": [],
    "settings": {"showFurigana": True},
}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


class McpClient:
    def __init__(self, env):
        self.process = subprocess.Popen(
            ["node", str(ROOT / "tests/mcp-client.mjs")], cwd=ROOT, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self.messages = queue.Queue()
        self.errors = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_errors, daemon=True).start()
        try:
            assert self._message().get("ready") is True, "MCP fixture did not become ready"
        except Exception:
            self.close()
            raise

    def _read(self):
        for raw in self.process.stdout:
            try:
                self.messages.put(json.loads(raw))
            except ValueError:
                self.messages.put({"error": f"Invalid fixture output: {raw}"})
        self.messages.put({"error": "MCP fixture exited"})

    def _read_errors(self):
        for line in self.process.stderr:
            self.errors.append(line)

    def _message(self):
        try:
            message = self.messages.get(timeout=15)
        except queue.Empty as error:
            raise AssertionError("Timed out waiting for MCP fixture: " + "".join(self.errors)) from error
        assert "error" not in message, str(message.get("error")) + " " + "".join(self.errors)
        return message

    def call(self, name, args=None, error_code=None):
        self.process.stdin.write(json.dumps({"name": name, "args": args or {}}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        raw = self._message()["result"]
        content = raw.get("structuredContent")
        if content is None:
            content = json.loads(next(block["text"] for block in raw["content"] if block["type"] == "text"))
        if error_code is not None:
            assert raw.get("isError"), f"Expected {error_code}, got success: {content}"
            assert content.get("error", {}).get("code") == error_code, content
        else:
            assert not raw.get("isError"), content
        return content

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        stop(self.process)


def seed(page, value):
    page.evaluate("([key, value]) => localStorage.setItem(key, JSON.stringify(value))", [KEY, value])
    page.reload()
    page.wait_for_function("Boolean(window.scriptEditorMcp)")
    expect(body(page)).to_have_text(value["sections"][0]["lines"][0]["body"])


def body(page, line_id="line-1"):
    return page.locator(f'.script-row[data-line-id="{line_id}"] .body-input')


def storage(page):
    return page.evaluate("key => JSON.parse(localStorage.getItem(key))", KEY)


def first_line(project):
    return project["sections"][0]["lines"][0]


def wait_saved_line(page, expected):
    page.wait_for_function("""([key, expected]) => {
        const project = JSON.parse(localStorage.getItem(key));
        const line = project?.sections.flatMap(section => section.lines).find(line => line.id === expected.id);
        return line?.body === expected.body && JSON.stringify(line.bodyMarks) === JSON.stringify(expected.bodyMarks);
    }""", arg=[KEY, expected])


def content(project):
    result = copy.deepcopy(project)
    result.pop("updatedAt", None)
    return result


def connect(page, base_url):
    page.locator("#connectAiButton").click()
    page.locator("#aiServerUrl").fill(base_url)
    page.locator("#aiConnectConfirm").click()
    expect(page.locator("#connectAiButton")).to_have_text("AI接続中")
    expect(page.locator("#aiConnectionDialog")).not_to_be_visible()


def disconnect(page):
    page.locator("#connectAiButton").click()
    page.locator("#aiDisconnectButton").click()
    expect(page.locator("#aiConnectionStatus")).to_have_text("未接続")
    expect(page.locator("#connectAiButton")).to_have_text("AI接続")
    page.locator("#aiConnectionClose").click()


def check_furigana(page, get, edit):
    before = get()
    original_line = first_line(before["project"])
    annotation = body(page).locator(".furigana-annotation")
    expect(annotation).to_have_count(0)

    previous = before
    for reading in ("アルファ", "あるふぁ"):
        expected = [{"word": "Alpha", "reading": reading}]
        updated = edit(previous, [{"op": "upsert_furigana", **expected[0]}])
        assert updated["revision"] != previous["revision"]
        assert updated["savedTo"] == "localStorage"
        assert updated["project"]["furigana"] == expected
        assert storage(page)["furigana"] == expected
        expect(annotation).to_have_count(1)
        expect(annotation).to_have_attribute("data-furigana", reading)
        previous = updated

    removed = edit(previous, [{"op": "delete_furigana", "word": "Alpha"}])
    assert removed["revision"] != previous["revision"]
    assert removed["project"]["furigana"] == []
    assert storage(page)["furigana"] == []
    expect(annotation).to_have_count(0)

    page.locator("#undoDeleteLineButton").click()
    expect(annotation).to_have_attribute("data-furigana", expected[0]["reading"])
    page.wait_for_function("""([key, expected]) =>
        JSON.stringify(JSON.parse(localStorage.getItem(key))?.furigana) === JSON.stringify(expected)
    """, arg=[KEY, expected])
    restored = get()
    assert restored["revision"] != removed["revision"]
    assert restored["project"]["furigana"] == expected
    assert first_line(restored["project"]) == original_line, "Furigana editing changed the script line"
    expect(body(page)).to_have_text(original_line["body"])
    print("PASS: MCP furigana add, overwrite, delete, saved dictionary, and rendered Undo", flush=True)


def main():
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    env = {**os.environ, "SCRIPT_EDITOR_PORT": str(port)}
    server = subprocess.Popen(["node", str(ROOT / "mcp/server.mjs")], cwd=ROOT, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                              text=True, encoding="utf-8")
    client = None
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                with urllib.request.urlopen(base_url + "/health", timeout=1) as response:
                    assert json.load(response)["app"] == "script-editor-mcp"
                break
            except (urllib.error.URLError, TimeoutError):
                if server.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError("Local MCP server did not start")
                time.sleep(0.05)
        client = McpClient(env)
        with tempfile.TemporaryDirectory(prefix="script-editor-mcp-") as folder, sync_playwright() as playwright:
            source_file = Path(folder) / "original-script.json"
            source_file.write_text(json.dumps(SEED, ensure_ascii=False), encoding="utf-8")
            original_file = source_file.read_bytes()
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": 1600, "height": 1000})
                page.set_default_timeout(5000)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto((ROOT / "index.html").as_uri())
                seed(page, copy.deepcopy(SEED))
                assert client.call("list_scripts")["scripts"] == [], "Editor auto-connected"
                # Import through the file input without granting a write handle.
                page.locator("#loadJsonInput").set_input_files(str(source_file))
                page.wait_for_function("document.getElementById('loadJsonInput').value === ''")
                expect(body(page)).to_have_text(SEED["sections"][0]["lines"][0]["body"])
                expect(page.locator("#undoDeleteLineButton")).to_be_disabled()
                connect(page, base_url)
                scripts = client.call("list_scripts")["scripts"]
                assert len(scripts) == 1 and scripts[0]["projectId"] == SEED["projectId"], scripts
                session_id = scripts[0]["sessionId"]

                def get():
                    return client.call("get_script", {"sessionId": session_id})

                def edit(snapshot, operations, error_code=None):
                    return client.call("edit_script", {
                        "sessionId": session_id, "projectId": snapshot["project"]["projectId"],
                        "expectedRevision": snapshot["revision"], "operations": operations,
                    }, error_code)

                initial = get()
                original_line = copy.deepcopy(first_line(initial["project"]))
                original_html = body(page).inner_html()
                changed = edit(initial, [{"op": "update_line", "lineId": "line-1", "body": "AIで編集した台詞"}])
                expect(body(page)).to_have_text("AIで編集した台詞")
                assert first_line(storage(page))["body"] == "AIで編集した台詞", storage(page)
                assert first_line(storage(page))["bodyMarks"] == [], first_line(storage(page))
                assert changed["revision"] != initial["revision"]
                assert changed["savedTo"] == "localStorage"
                page.locator("#undoDeleteLineButton").click()
                expect(body(page)).to_have_text(original_line["body"])
                wait_saved_line(page, original_line)
                assert first_line(storage(page))["bodyMarks"] == original_line["bodyMarks"], first_line(storage(page))
                assert body(page).inner_html() == original_html, f"Undo did not restore decoration: {body(page).inner_html()}"
                print("PASS: file editor, stdio MCP, live edit, storage, decorated Undo", flush=True)

                check_furigana(page, get, edit)

                before_local = get()
                noop = edit(before_local, [{"op": "set_title", "title": before_local["project"]["title"]}])
                assert noop["changed"] is False and noop["revision"] == before_local["revision"], noop
                body(page).fill("人が入力した本文")
                edit(before_local, [{"op": "update_line", "lineId": "line-1", "body": "stale edit"}], "REVISION_CONFLICT")
                expect(body(page)).to_have_text("人が入力した本文")
                current = get()
                assert first_line(current["project"])["body"] == "人が入力した本文"
                assert current["revision"] != before_local["revision"]
                page.evaluate("document.activeElement?.blur()")
                wait_saved_line(page, first_line(current["project"]))
                print("PASS: no-op preserves editor references; local input invalidates an older revision", flush=True)

                before_atomic = get()
                edit(before_atomic, [{"op": "set_title", "title": "must not commit"},
                                     {"op": "update_line", "lineId": "missing-line", "body": "invalid"}], "INVALID_EDIT")
                after_atomic = get()
                assert content(after_atomic["project"]) == content(before_atomic["project"]), f"Invalid batch changed the project: {after_atomic}"
                assert after_atomic["revision"] == before_atomic["revision"]
                expect(page.locator("#projectTitle")).to_have_value(SEED["title"])
                print("PASS: invalid second operation leaves the entire batch unchanged", flush=True)

                page.evaluate("document.activeElement?.blur()")
                before_quota = get()
                stored_before_quota = storage(page)
                page.evaluate("""key => {
                    window.__mcpOriginalSetItem = Storage.prototype.setItem;
                    Storage.prototype.setItem = function(itemKey, value) {
                        if (itemKey === key) throw new DOMException('Simulated storage quota', 'QuotaExceededError');
                        return window.__mcpOriginalSetItem.call(this, itemKey, value);
                    };
                }""", KEY)
                try:
                    edit(before_quota, [{"op": "update_line", "lineId": "line-1", "body": "must roll back"}], "SAVE_FAILED")
                finally:
                    page.evaluate("Storage.prototype.setItem = window.__mcpOriginalSetItem; delete window.__mcpOriginalSetItem")
                expect(body(page)).to_have_text("人が入力した本文")
                after_quota = get()
                assert content(after_quota["project"]) == content(before_quota["project"]), f"Storage failure changed in-memory project: {after_quota}"
                assert storage(page) == stored_before_quota, "Storage failure overwrote saved project"
                print("PASS: storage quota failure rolls back UI, memory, and saved project", flush=True)

                before_composition = get()
                body(page).evaluate("editor => { editor.focus(); editor.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true})); }")
                try:
                    client.call("get_script", {"sessionId": session_id}, "BUSY")
                    edit(before_composition, [{"op": "set_title", "title": "during IME"}], "BUSY")
                    expect(page.locator("#connectAiButton")).to_have_text("AI接続中")
                finally:
                    body(page).evaluate("editor => editor.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true}))")
                assert content(get()["project"]) == content(before_composition["project"])
                # Allow the existing JSON save debounce to run; there is no file
                # handle, so the imported source must remain unchanged.
                page.wait_for_timeout(2200)
                assert source_file.read_bytes() == original_file, "MCP wrote directly to the imported JSON file"
                print("PASS: IME rejects reads and edits; source JSON stays unchanged", flush=True)

                disconnect(page)
                assert client.call("list_scripts")["scripts"] == []
                client.call("get_script", {"sessionId": session_id}, "DISCONNECTED")
                page.reload()
                expect(page.locator("#connectAiButton")).to_have_text("AI接続")
                expect(body(page)).to_have_text("人が入力した本文")
                assert client.call("list_scripts")["scripts"] == [], "Reload restored a connection token"
                print("PASS: manual disconnect and reload do not reconnect", flush=True)

                http_page = browser.new_page(viewport={"width": 1600, "height": 1000})
                http_page.on("pageerror", lambda error: errors.append(str(error)))
                http_page.goto(base_url + "/")
                other = copy.deepcopy(SEED)
                other["projectId"] = "project-mcp-http-check"
                other["title"] = "HTTP接続の台本"
                seed(http_page, other)
                assert client.call("list_scripts")["scripts"] == []
                http_page.locator("#connectAiButton").click()
                expect(http_page.locator("#aiServerUrl")).to_have_value(base_url)
                http_page.locator("#aiConnectConfirm").click()
                expect(http_page.locator("#connectAiButton")).to_have_text("AI接続中")
                http_scripts = client.call("list_scripts")["scripts"]
                assert len(http_scripts) == 1 and http_scripts[0]["projectId"] == other["projectId"], http_scripts
                http_session = http_scripts[0]["sessionId"]
                http_snapshot = client.call("get_script", {"sessionId": http_session})
                client.call("edit_script", {"sessionId": http_session, "projectId": other["projectId"],
                                           "expectedRevision": http_snapshot["revision"],
                                           "operations": [{"op": "update_line", "lineId": "line-2", "body": "HTTP側の編集"}]})
                expect(body(http_page, "line-2")).to_have_text("HTTP側の編集")
                expect(body(page, "line-2")).to_have_text("Second row unchanged")
                disconnect(http_page)
                assert client.call("list_scripts")["scripts"] == []
                http_page.reload()
                expect(body(http_page, "line-2")).to_have_text("HTTP側の編集")
                assert not errors, errors
                print("PASS: HTTP origin, server URL prefill, isolated project edit, no JavaScript errors", flush=True)
            finally:
                browser.close()
    finally:
        if client:
            client.close()
        stop(server)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
