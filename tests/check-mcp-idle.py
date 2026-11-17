"""Real-browser checks for idle recovery, session resume, and edit delivery.

All servers use a random port and all pages use temporary browser contexts.
The real 23-second idle crosses the production 20-second long-poll boundary.
"""
import argparse
import concurrent.futures
import json
import os
import queue
import runpy
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HELPERS = runpy.run_path(str(ROOT / "tests/check-mcp-browser.py"))
RECONNECT = runpy.run_path(str(ROOT / "tests/check-mcp-reconnect.py"))
SERVER_PROGRAM = r"""
import readline from 'node:readline';
import { startServer } from './mcp/server.mjs';
const port = Number(process.env.SCRIPT_EDITOR_PORT);
let instance = await startServer({ port });
const answer = value => process.stdout.write(JSON.stringify(value) + '\n');
answer({ ready: true });
try {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const { op } = JSON.parse(line);
      if (op === 'expire') {
        for (const session of instance.bridge.sessions.values()) {
          session.lastSeen = Date.now() - instance.bridge.sessionTimeout - 1;
        }
        instance.bridge.prune();
      } else if (op === 'restart') {
        await instance.close();
        instance = await startServer({ port });
      } else throw new Error('Unknown test control');
      answer({ done: op });
    } catch (error) { answer({ error: error.message }); }
  }
} finally { await instance.close(); }
"""


class TestServer:
    def __init__(self, env):
        self.process = subprocess.Popen(
            ["node", "--input-type=module", "-e", SERVER_PROGRAM], cwd=ROOT, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self.messages = queue.Queue()
        self.errors = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_errors, daemon=True).start()
        try:
            assert self.message().get("ready"), "Test server did not start"
        except Exception:
            self.close()
            raise

    def _read(self):
        for line in self.process.stdout:
            try:
                self.messages.put(json.loads(line))
            except ValueError:
                self.messages.put({"error": f"Invalid server fixture output: {line}"})
        self.messages.put({"error": "Test server exited"})

    def _read_errors(self):
        for line in self.process.stderr:
            self.errors.append(line)

    def message(self):
        try:
            message = self.messages.get(timeout=10)
        except queue.Empty as error:
            raise AssertionError("Test server timed out: " + "".join(self.errors)) from error
        assert "error" not in message, str(message) + " " + "".join(self.errors)
        return message

    def control(self, op):
        self.process.stdin.write(json.dumps({"op": op}) + "\n")
        self.process.stdin.flush()
        assert self.message() == {"done": op}

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        HELPERS["stop"](self.process)


def wait_until(page, condition, message, timeout=12):
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, message
        page.wait_for_timeout(30)


def wait_same_session(client, page, session_id):
    observed = []

    def ready():
        observed[:] = client.call("list_scripts")["scripts"]
        return len(observed) == 1 and observed[0]["sessionId"] == session_id

    wait_until(page, ready, f"Session {session_id} was not resumed")
    expect(page.locator("#connectAiButton")).to_have_text("AI接続中", timeout=12000)
    return observed[0]


def record_connects(page):
    requests = []

    def record(request):
        if request.url.endswith("/bridge/connect") and request.method == "POST":
            body = request.post_data_json
            # Never include tokens in test diagnostics.
            requests.append({"sessionId": body.get("sessionId"), "authenticated": bool(body.get("token"))})

    page.on("request", record)
    return requests


def snapshot(client, session_id):
    return client.call("get_script", {"sessionId": session_id})


def lifecycle_wake(page):
    page.evaluate("""() => {
        document.dispatchEvent(new Event('resume'));
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }""")


def check_idle_and_recovery(browser, client, server, base_url, errors):
    context, page = RECONNECT["new_editor"](browser, errors)
    connects = record_connects(page)
    try:
        RECONNECT["start_connect"](page, base_url)
        expect(page.locator("#connectAiButton")).to_have_text("AI接続中", timeout=8000)
        scripts = client.call("list_scripts")["scripts"]
        assert len(scripts) == 1, scripts
        session_id = scripts[0]["sessionId"]
        initial = snapshot(client, session_id)
        started = time.monotonic()
        print("Waiting through a real 23-second idle period and the 20-second long poll...", flush=True)
        page.wait_for_timeout(23000)
        assert time.monotonic() - started >= 22
        assert snapshot(client, session_id)["project"]["projectId"] == initial["project"]["projectId"]
        wait_same_session(client, page, session_id)
        print("PASS: real idle across a production long-poll boundary remains connected", flush=True)

        dropped_polls = []

        def one_poll_loss(route):
            if not dropped_polls:
                dropped_polls.append(True)
                route.abort("connectionrefused")
            else:
                route.continue_()

        page.route("**/bridge/poll", one_poll_loss)
        before = len(connects)
        lifecycle_wake(page)
        wait_until(page, lambda: bool(dropped_polls), "A fresh poll was not issued after wake")
        wait_until(page, lambda: len(connects) > before, "Poll loss did not trigger automatic reconnection")
        wait_same_session(client, page, session_id)
        snapshot(client, session_id)
        page.unroute("**/bridge/poll", one_poll_loss)
        assert connects[-1] == {"sessionId": session_id, "authenticated": True}, connects
        expect(page.locator("#aiConnectionDialog")).not_to_be_visible()
        print("PASS: lost poll recovers automatically with the same authenticated session", flush=True)

        before = len(connects)
        cdp = context.new_cdp_session(page)
        try:
            cdp.send("Page.setWebLifecycleState", {"state": "frozen"})
            server.control("expire")
            time.sleep(0.15)
        finally:
            cdp.send("Page.setWebLifecycleState", {"state": "active"})
            cdp.detach()
        wait_until(page, lambda: len(connects) > before, "Frozen, expired page did not resume")
        wait_same_session(client, page, session_id)
        snapshot(client, session_id)
        assert connects[-1]["sessionId"] == session_id, connects
        print("PASS: actual renderer freeze, host expiry, and activation resume the same session", flush=True)

        before = len(connects)
        server.control("restart")
        # The existing stdio client must discover the new backend instance.
        wait_same_session(client, page, session_id)
        wait_until(page, lambda: len(connects) > before, "Backend restart did not trigger reattachment")
        after_restart = snapshot(client, session_id)
        assert after_restart["project"]["projectId"] == initial["project"]["projectId"]
        print("PASS: backend restart is recovered by browser and existing stdio client", flush=True)

        before = len(connects)
        lifecycle_wake(page)
        wait_until(page, lambda: len(connects) > before, "Lifecycle wake did not renew the transport")
        wait_same_session(client, page, session_id)
        snapshot(client, session_id)
        print("PASS: resume, online, and BFCache pageshow events keep one usable session", flush=True)

        check_lost_result(client, page, session_id)
        check_expired_ack(client, page, session_id)

        # Interrupt a recovery, then verify lifecycle events cannot opt back in.
        dropped = []

        def offline_poll(route):
            dropped.append(True)
            route.abort("connectionrefused")

        page.route("**/bridge/poll", offline_poll)
        lifecycle_wake(page)
        wait_until(page, lambda: bool(dropped), "Could not force a recovery to cancel")
        expect(page.locator("#connectAiButton")).to_have_text("AI再接続中", timeout=8000)
        page.locator("#connectAiButton").click()
        page.locator("#aiDisconnectButton").click()
        RECONNECT["assert_idle"](page)
        before = len(connects)
        lifecycle_wake(page)
        page.wait_for_timeout(1300)
        assert len(connects) == before, "Manual disconnect was undone by automatic recovery"
        assert client.call("list_scripts")["scripts"] == []
        print("PASS: explicit disconnect during recovery stays disconnected after lifecycle wake", flush=True)
    finally:
        context.close()


def check_lost_result(client, page, session_id):
    before = snapshot(client, session_id)
    section_id = before["project"]["sections"][0]["id"]
    marker = "MCP idle regression: insert once"
    original_count = sum(len(section["lines"]) for section in before["project"]["sections"])
    page.evaluate("""() => {
        const original = window.scriptEditorMcp;
        window.__idleApplyCount = 0;
        window.scriptEditorMcp = {
            getSnapshot: () => original.getSnapshot(),
            applyEdits: args => { window.__idleApplyCount++; return original.applyEdits(args); },
        };
    }""")
    result_ids = []

    def lose_response(route):
        body = route.request.post_data_json
        result_ids.append(body["commandId"])
        if len(result_ids) == 1:
            # Complete the real host request, then lose only the browser's ACK
            # response. Retrying the ACK must never execute the edit again.
            response = route.fetch()
            assert response.ok, response.status
            route.abort("failed")
        else:
            route.continue_()

    page.route("**/bridge/result", lose_response)
    try:
        args = {
            "sessionId": session_id, "projectId": before["project"]["projectId"],
            "expectedRevision": before["revision"],
            "operations": [{"op": "insert_lines", "sectionId": section_id, "lines": [{"body": marker}]}],
        }
        # Keep Playwright dispatching intercepted requests while the independent
        # stdio call waits for its result.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(client.call, "edit_script", args)
            wait_until(page, lambda: len(result_ids) >= 2, "Lost result ACK was not recovered")
            future.result(timeout=15)
        wait_same_session(client, page, session_id)
    finally:
        page.unroute("**/bridge/result", lose_response)
    after = snapshot(client, session_id)
    lines = [line for section in after["project"]["sections"] for line in section["lines"]]
    assert page.evaluate("window.__idleApplyCount") == 1, "An edit was replayed after response loss"
    assert len(lines) == original_count + 1
    assert sum(line["body"] == marker for line in lines) == 1
    assert len(set(result_ids)) == 1, "Recovery changed the command ID instead of retrying its ACK"
    print("PASS: lost result response retries only its ACK; the edit applies exactly once and can be read", flush=True)


def check_close_cancels_opt_in(browser, client, base_url, errors):
    context, page = RECONNECT["new_editor"](browser, errors)
    connects = record_connects(page)
    try:
        page.route("**/bridge/connect", lambda route: route.abort("connectionrefused"))
        RECONNECT["start_connect"](page, base_url)
        RECONNECT["assert_retrying"](page)
        page.locator("#aiConnectionClose").click()
        RECONNECT["assert_idle"](page)
        before = len(connects)
        lifecycle_wake(page)
        page.wait_for_timeout(1300)
        assert len(connects) == before, "Closing pending connection retained automatic opt-in"
        assert client.call("list_scripts")["scripts"] == []
        print("PASS: closing a pending manual connection cancels later automatic recovery", flush=True)
    finally:
        context.close()


def check_expired_ack(client, page, session_id):
    before = snapshot(client, session_id)
    title = before["project"]["title"] + " (expired ACK)"
    page.evaluate("""() => {
        const original = window.scriptEditorMcp;
        window.__expiredApplyCount = 0;
        window.scriptEditorMcp = {
            getSnapshot: () => original.getSnapshot(),
            applyEdits: args => { window.__expiredApplyCount++; return original.applyEdits(args); },
        };
    }""")
    injected = []

    def expired_response(route):
        # The edit completes on the real host so the stdio client receives its
        # result; the browser then receives the formerly fatal expiry error.
        response = route.fetch()
        assert response.ok, response.status
        injected.append(route.request.post_data_json["commandId"])
        headers = {key: value for key, value in response.headers.items()
                   if key.lower() not in {"content-length", "content-encoding", "transfer-encoding"}}
        route.fulfill(status=400, headers=headers, body=json.dumps({"error": {
            "code": "EXPIRED_COMMAND", "message": "Test: command acknowledgment expired",
        }}))

    page.route("**/bridge/result", expired_response)
    try:
        args = {
            "sessionId": session_id, "projectId": before["project"]["projectId"],
            "expectedRevision": before["revision"],
            "operations": [{"op": "set_title", "title": title}],
        }
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(client.call, "edit_script", args)
            wait_until(page, lambda: bool(injected), "EXPIRED_COMMAND response was not injected")
            expect(page.locator("#aiConnectionStatus")).to_contain_text("応答期限")
            future.result(timeout=15)
    finally:
        page.unroute("**/bridge/result", expired_response)
    wait_same_session(client, page, session_id)
    expect(page.locator("#aiConnectionDialog")).not_to_be_visible()
    after = snapshot(client, session_id)
    assert after["sessionId"] == session_id
    assert after["project"]["title"] == title
    assert page.evaluate("window.__expiredApplyCount") == 1, "Expiry handling replayed the edit"
    assert len(injected) == 1, "An expired acknowledgment was repeatedly resent"
    print("PASS: EXPIRED_COMMAND acknowledgment preserves the session, applies once, and permits the next read", flush=True)


def check_expired_ack_only(browser, client, base_url, errors):
    context, page = RECONNECT["new_editor"](browser, errors)
    try:
        RECONNECT["start_connect"](page, base_url)
        expect(page.locator("#connectAiButton")).to_have_text("AI接続中", timeout=8000)
        scripts = client.call("list_scripts")["scripts"]
        assert len(scripts) == 1, scripts
        check_expired_ack(client, page, scripts[0]["sessionId"])
        RECONNECT["disconnect"](page)
    finally:
        context.close()


def main(expired_ack_only=False):
    port = HELPERS["free_port"]()
    base_url = f"http://127.0.0.1:{port}"
    env = {**os.environ, "SCRIPT_EDITOR_PORT": str(port)}
    server = TestServer(env)
    client = None
    try:
        client = HELPERS["McpClient"](env)
        errors = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                if expired_ack_only:
                    check_expired_ack_only(browser, client, base_url, errors)
                else:
                    check_idle_and_recovery(browser, client, server, base_url, errors)
                    check_close_cancels_opt_in(browser, client, base_url, errors)
                assert not errors, errors
                print("Selected idle recovery checks passed without JavaScript errors." if expired_ack_only
                      else "All persistent idle recovery checks passed without JavaScript errors.", flush=True)
            finally:
                browser.close()
    finally:
        if client:
            client.close()
        server.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expired-ack-only", action="store_true", help="Run only the expired acknowledgment regression")
    try:
        main(expired_ack_only=parser.parse_args().expired_ack_only)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
