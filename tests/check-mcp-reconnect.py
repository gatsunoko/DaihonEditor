"""Browser regression checks for bounded connection retries and cancellation.

Uses a fresh local server and browser contexts; never opens a user's browser or
edits a script. Run with Node dependencies and Python Playwright installed.
"""
import os
import re
import runpy
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HELPERS = runpy.run_path(str(ROOT / "tests/check-mcp-browser.py"))
CONNECT_PATH = "**/bridge/connect"


def controls(page):
    """Read actual DOM state; button colors do not establish disabled state."""
    return page.evaluate("""() => ({
        confirmDisabled: document.getElementById('aiConnectConfirm').disabled,
        disconnectDisabled: document.getElementById('aiDisconnectButton').disabled,
        urlDisabled: document.getElementById('aiServerUrl').disabled,
        status: document.getElementById('aiConnectionStatus').textContent,
        button: document.getElementById('connectAiButton').textContent,
        dialogOpen: document.getElementById('aiConnectionDialog').open,
    })""")


def assert_idle(page):
    expect(page.locator("#aiConnectConfirm")).to_be_enabled()
    expect(page.locator("#aiDisconnectButton")).to_be_disabled()
    expect(page.locator("#aiServerUrl")).to_be_enabled()
    expect(page.locator("#connectAiButton")).to_have_text("AI接続")


def start_connect(page, base_url):
    if not page.locator("#aiConnectionDialog").is_visible():
        page.locator("#connectAiButton").click()
    page.locator("#aiServerUrl").fill(base_url)
    page.locator("#aiConnectConfirm").click()


def assert_retrying(page):
    expect(page.locator("#aiConnectionStatus")).to_have_text(re.compile(r"起動を待っています.*残り\d+秒"))
    expect(page.locator("#aiConnectConfirm")).to_be_disabled()
    expect(page.locator("#aiDisconnectButton")).to_be_enabled()
    expect(page.locator("#aiDisconnectButton")).to_have_text("接続を中止")
    expect(page.locator("#aiServerUrl")).to_be_disabled()


def disconnect(page):
    page.locator("#connectAiButton").click()
    page.locator("#aiDisconnectButton").click()
    assert_idle(page)
    page.locator("#aiConnectionClose").click()


def wait_scripts(client, page, count, expected_id=None):
    deadline = time.monotonic() + 5
    while True:
        scripts = client.call("list_scripts")["scripts"]
        if len(scripts) == count and (expected_id is None or scripts[0]["sessionId"] == expected_id):
            return scripts
        assert time.monotonic() < deadline, f"Unexpected live sessions: {scripts}"
        page.wait_for_timeout(30)


def new_editor(browser, errors):
    context = browser.new_context(viewport={"width": 1600, "height": 1000})
    page = context.new_page()
    page.set_default_timeout(5000)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto((ROOT / "index.html").as_uri())
    page.wait_for_function("Boolean(window.scriptEditorMcp)")
    return context, page


def check_delayed_start(browser, client, base_url, errors):
    context, page = new_editor(browser, errors)
    attempts = []

    def delayed_server(route):
        attempts.append(route.request.url)
        if len(attempts) == 1:
            route.abort("connectionrefused")
        else:
            route.continue_()

    try:
        page.route(CONNECT_PATH, delayed_server)
        assert client.call("list_scripts")["scripts"] == []
        assert attempts == [], "Editor connected without a user action"
        start_connect(page, base_url)
        assert_retrying(page)
        expect(page.locator("#connectAiButton")).to_have_text("AI接続中", timeout=8000)
        expect(page.locator("#aiConnectionDialog")).not_to_be_visible()
        assert len(attempts) == 2, attempts
        wait_scripts(client, page, 1)
        disconnect(page)
        wait_scripts(client, page, 0)
        print("PASS: unavailable first attempt recovers automatically with progress and one live session", flush=True)
    finally:
        context.close()


def check_permanent_failure(browser, client, base_url, errors):
    context, page = new_editor(browser, errors)
    attempts = []

    def unavailable(route):
        attempts.append(route.request.url)
        route.abort("connectionrefused")

    try:
        page.clock.install()
        page.route(CONNECT_PATH, unavailable)
        start_connect(page, base_url)
        assert_retrying(page)
        # Advancing page time exercises the real retry deadline without a
        # twenty-second wall-clock wait or changing production constants.
        page.clock.fast_forward(21000)
        assert_idle(page)
        expect(page.locator("#aiConnectionStatus")).to_contain_text("20秒")
        expect(page.locator("#aiConnectionStatus")).to_contain_text("Codex")
        before = len(attempts)
        assert before > 0
        page.clock.fast_forward(3000)
        page.wait_for_timeout(50)
        assert len(attempts) == before, "Connection attempts continued after their deadline"
        assert client.call("list_scripts")["scripts"] == []
        page.unroute(CONNECT_PATH, unavailable)
        page.locator("#aiConnectConfirm").click()
        expect(page.locator("#connectAiButton")).to_have_text("AI接続中", timeout=8000)
        disconnect(page)
        wait_scripts(client, page, 0)
        print("PASS: permanent failure stops at its deadline, restores controls, and permits manual retry", flush=True)
    finally:
        context.close()


def check_cancel_retry(browser, client, base_url, errors):
    context, page = new_editor(browser, errors)
    attempts = []

    def unavailable(route):
        attempts.append(route.request.url)
        route.abort("connectionrefused")

    try:
        page.route(CONNECT_PATH, unavailable)
        start_connect(page, base_url)
        assert_retrying(page)
        page.locator("#aiDisconnectButton").click()
        assert_idle(page)
        before = len(attempts)
        page.wait_for_timeout(1200)
        assert len(attempts) == before, "Cancelled startup continued retrying"
        assert client.call("list_scripts")["scripts"] == []
        page.unroute(CONNECT_PATH, unavailable)
        page.locator("#aiConnectConfirm").click()
        expect(page.locator("#connectAiButton")).to_have_text("AI接続中", timeout=8000)
        disconnect(page)
        wait_scripts(client, page, 0)
        print("PASS: cancelling startup stops retries and allows an immediate new connection", flush=True)
    finally:
        context.close()


def check_cancel_late_response(browser, client, base_url, errors):
    context, page = new_editor(browser, errors)
    try:
        # Hold a real successful response after the server created session A.
        # Ignoring the first AbortSignal deterministically exercises a late
        # response; an ordinary browser abort would hide its token instead.
        page.evaluate("""() => {
            const originalFetch = window.fetch.bind(window);
            const state = window.__lateConnect = { used: false, ready: false, release: null };
            window.fetch = async (url, options = {}) => {
                if (String(url).endsWith('/bridge/connect') && !state.used) {
                    state.used = true;
                    const { signal, ...uncancelled } = options;
                    const response = await originalFetch(url, uncancelled);
                    return new Promise(resolve => {
                        state.release = () => resolve(response);
                        state.ready = true;
                    });
                }
                return originalFetch(url, options);
            };
        }""")
        start_connect(page, base_url)
        page.wait_for_function("window.__lateConnect.ready")
        old_id = wait_scripts(client, page, 1)[0]["sessionId"]
        page.locator("#aiDisconnectButton").click()
        assert_idle(page)
        page.locator("#aiConnectConfirm").click()
        expect(page.locator("#connectAiButton")).to_have_text("AI接続中", timeout=8000)
        both = wait_scripts(client, page, 2)
        new_id = next(item["sessionId"] for item in both if item["sessionId"] != old_id)
        page.evaluate("window.__lateConnect.release()")
        wait_scripts(client, page, 1, new_id)
        expect(page.locator("#connectAiButton")).to_have_text("AI接続中")
        expect(page.locator("#aiConnectionDialog")).not_to_be_visible()
        disconnect(page)
        wait_scripts(client, page, 0)
        print("PASS: a late cancelled response is cleaned up and cannot replace the newer session", flush=True)
    finally:
        context.close()


def main():
    port = HELPERS["free_port"]()
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
                with urllib.request.urlopen(base_url + "/health", timeout=1):
                    break
            except (urllib.error.URLError, TimeoutError):
                if server.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError("Isolated local MCP server did not start")
                time.sleep(0.05)
        client = HELPERS["McpClient"](env)
        errors = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                check_delayed_start(browser, client, base_url, errors)
                check_permanent_failure(browser, client, base_url, errors)
                check_cancel_retry(browser, client, base_url, errors)
                check_cancel_late_response(browser, client, base_url, errors)
                assert not errors, errors
                print("All reconnect checks passed without JavaScript errors.", flush=True)
            finally:
                browser.close()
    finally:
        if client:
            client.close()
        HELPERS["stop"](server)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
