/* A manual AI connection stays enabled through temporary transport failures. */
(() => {
  "use strict";

  const REQUEST_TIMEOUT_MS = 5000;
  const POLL_TIMEOUT_MS = 25000;
  const CONNECT_TIMEOUT_MS = 20000;
  const CONNECT_RETRY_DELAY_MS = 1000;
  const MAX_REMEMBERED_COMMANDS = 256;
  let generation = 0;
  let intent = null;

  function initialize() {
    const connectButton = document.getElementById("connectAiButton");
    const status = document.getElementById("aiConnectionStatus");
    const dialog = document.getElementById("aiConnectionDialog");
    const urlInput = document.getElementById("aiServerUrl");
    const confirmButton = document.getElementById("aiConnectConfirm");
    const disconnectButton = document.getElementById("aiDisconnectButton");
    const closeButton = document.getElementById("aiConnectionClose");
    if (![connectButton, status, dialog, urlInput, confirmButton, disconnectButton, closeButton].every(Boolean)) return;

    if (location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(location.hostname) && location.port) {
      urlInput.value = location.origin;
    }

    const cancelled = () => Object.assign(new Error("接続を中止しました。"), { code: "CANCELLED" });
    const isCurrent = current => intent === current && !current.controller.signal.aborted;

    function render(message) {
      const initial = intent?.initial === true;
      const recovering = intent?.recovering === true;
      connectButton.textContent = initial ? "AI接続中…" : recovering ? "AI再接続中" : intent?.credentials ? "AI接続中" : "AI接続";
      connectButton.setAttribute("aria-expanded", String(dialog.open));
      confirmButton.disabled = Boolean(intent);
      confirmButton.textContent = initial ? "接続中…" : "接続";
      disconnectButton.disabled = !intent;
      disconnectButton.textContent = initial ? "接続を中止" : "接続を解除";
      urlInput.disabled = Boolean(intent);
      status.setAttribute("aria-busy", String(initial || recovering));
      if (message !== undefined) status.textContent = message;
    }

    function renderConnected(current) {
      if (isCurrent(current)) render(current.notice ? "接続済み。" + current.notice : "接続済み");
    }

    function parseServerUrl(value) {
      let url;
      try { url = new URL(value.trim()); }
      catch { throw new Error("接続先は http://127.0.0.1:39041 の形式で入力してください。"); }
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
          !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("接続先にはポート番号付きの http://127.0.0.1 または http://localhost を指定してください。");
      }
      return url.origin;
    }

    function editorApi() {
      const api = window.scriptEditorMcp;
      if (!api || typeof api.getSnapshot !== "function" || typeof api.applyEdits !== "function") {
        throw new Error("台本エディタの読み込みが完了してから接続してください。");
      }
      return api;
    }

    async function readMetadata(current) {
      try {
        const snapshot = await editorApi().getSnapshot();
        current.metadata = { projectId: snapshot.project.projectId, title: snapshot.project.title };
      } catch (error) {
        if (error?.code !== "BUSY" || !current.metadata) throw error;
      }
      return current.metadata;
    }

    async function post(baseUrl, path, body, { current, timeoutMs = REQUEST_TIMEOUT_MS, phase, keepalive = false } = {}) {
      const controller = new AbortController();
      const signal = current?.controller.signal;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(abort, timeoutMs);
      if (current) {
        current.phase = phase || path;
        current.activeRequest = controller;
      }
      try {
        const response = await fetch(baseUrl + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Script-Editor": "1" },
          body: JSON.stringify(body), signal: controller.signal,
          credentials: "omit", cache: "no-store", redirect: "error", keepalive,
        });
        const payload = await response.json();
        if (!response.ok) {
          const error = new Error(payload.error?.message || "AI接続サーバーとの通信に失敗しました。");
          error.code = payload.error?.code || "CONNECTION_ERROR";
          error.retryable = response.status >= 500;
          throw error;
        }
        return payload;
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (error instanceof TypeError || error?.name === "AbortError") {
          throw Object.assign(new Error("接続が途切れたため、自動で再接続しています…"), {
            code: "CONNECTION_ERROR", retryable: true,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (current?.activeRequest === controller) current.activeRequest = null;
      }
    }

    // Lifecycle events can wake a backoff immediately without creating a second loop.
    function wait(current, milliseconds) {
      return new Promise((resolve, reject) => {
        const signal = current.controller.signal;
        let timer;
        const finish = error => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (current.wake === wake) current.wake = null;
          error ? reject(error) : resolve();
        };
        const abort = () => finish(cancelled());
        const wake = () => finish();
        current.wake = wake;
        if (milliseconds !== undefined) timer = setTimeout(wake, milliseconds);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }

    function forgetRemote(baseUrl, credentials, keepalive = false) {
      if (!credentials) return;
      void post(baseUrl, "/bridge/disconnect", credentials, { keepalive }).catch(() => {});
    }

    function stop(message = "未接続", revealDialog = false, keepalive = false) {
      const previous = intent;
      intent = null;
      generation += 1;
      previous?.controller.abort();
      previous?.activeRequest?.abort();
      previous?.wake?.();
      if (previous?.credentials) forgetRemote(previous.baseUrl, previous.credentials, keepalive);
      if (revealDialog && !dialog.open) dialog.showModal();
      render(message);
    }

    function retryable(error) {
      return error?.retryable || ["DISCONNECTED", "DUPLICATE_POLL"].includes(error?.code);
    }

    function validateCredentials(response) {
      if (typeof response?.sessionId !== "string" || !response.sessionId ||
          typeof response.token !== "string" || !response.token) {
        throw new Error("AI接続サーバーからの応答が不正です。");
      }
      return { sessionId: response.sessionId, token: response.token };
    }

    async function attach(current, timeoutMs = REQUEST_TIMEOUT_MS) {
      const metadata = await readMetadata(current);
      if (!isCurrent(current)) throw cancelled();
      const previous = current.credentials;
      const response = await post(current.baseUrl, "/bridge/connect", {
        ...metadata, ...(previous || {}),
      }, { current, phase: "connecting", timeoutMs });
      const credentials = validateCredentials(response);
      if (!isCurrent(current)) {
        forgetRemote(current.baseUrl, credentials);
        throw cancelled();
      }
      if (previous && (previous.sessionId !== credentials.sessionId || previous.token !== credentials.token)) {
        // An old server may issue a new identity. Reports from the old connection
        // cannot be attached to that identity, and commands must never be replayed.
        if (current.reports.size) current.notice = "直前のAI操作は結果未確認です。台本を再取得してください。";
        current.reports.clear();
      }
      current.credentials = credentials;
      current.attached = true;
    }

    async function connectInitially(current) {
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      while (isCurrent(current)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          await attach(current, Math.min(REQUEST_TIMEOUT_MS, remaining));
          return;
        } catch (error) {
          if (!error.retryable || !isCurrent(current)) throw error;
          const timeLeft = deadline - Date.now();
          if (timeLeft <= 0) break;
          render("接続先の起動を待っています…（残り" + Math.ceil(timeLeft / 1000) + "秒）");
          await wait(current, Math.min(CONNECT_RETRY_DELAY_MS, timeLeft));
        }
      }
      if (!isCurrent(current)) throw cancelled();
      throw new Error("20秒待ちましたが接続できませんでした。Codex/GPT Workで「台本エディタの接続を確認して」と依頼してから、もう一度「接続」を押してください。");
    }

    async function flushReports(current) {
      for (const [commandId, report] of current.reports) {
        if (!isCurrent(current)) throw cancelled();
        try {
          await post(current.baseUrl, "/bridge/result", {
            ...current.credentials, commandId, ...report,
          }, { current, phase: "reporting" });
          current.reports.delete(commandId);
        } catch (error) {
          if (error.code === "EXPIRED_COMMAND") {
            current.reports.delete(commandId);
            current.notice = "直前のAI操作は応答期限を過ぎました。編集を繰り返す前に、台本を再取得してください。";
            continue;
          }
          throw error;
        }
      }
    }

    async function executeCommand(current, command) {
      if (typeof command?.id !== "string") throw new Error("AI操作の形式が不正です。");
      if (current.seen.has(command.id)) return;
      // Remember before invoking the editor: reconnecting must never apply an edit twice.
      current.seen.add(command.id);
      if (current.seen.size > MAX_REMEMBERED_COMMANDS) current.seen.delete(current.seen.values().next().value);
      current.phase = "executing";
      let report;
      try {
        if (!Number.isFinite(command.deadline) || Date.now() >= command.deadline) {
          throw Object.assign(new Error("AI操作の有効期限が切れました。台本を再取得してください。"), { code: "COMMAND_EXPIRED" });
        }
        const api = editorApi();
        if (command.action === "get_script") report = { result: await api.getSnapshot() };
        else if (command.action === "edit_script") report = { result: await api.applyEdits(command.args) };
        else throw Object.assign(new Error("対応していないAI操作です。"), { code: "INVALID_REQUEST" });
      } catch (error) {
        report = { error: { code: typeof error?.code === "string" ? error.code : "EDITOR_ERROR", message: error?.message || "台本の操作に失敗しました。" } };
      }
      current.reports.set(command.id, report);
      await flushReports(current);
    }

    async function maintain(current) {
      let failures = 0;
      while (isCurrent(current)) {
        try {
          if (current.suspended) {
            current.phase = "suspended";
            await wait(current);
            continue;
          }
          if (!current.attached || current.needsResume) {
            current.needsResume = false;
            await attach(current);
            current.recovering = false;
            failures = 0;
            renderConnected(current);
          }
          await flushReports(current);
          if (current.needsResume) continue;
          const metadata = await readMetadata(current);
          if (!isCurrent(current)) break;
          const response = await post(current.baseUrl, "/bridge/poll", {
            ...current.credentials, ...metadata,
          }, { current, phase: "polling", timeoutMs: POLL_TIMEOUT_MS });
          if (!Array.isArray(response.commands)) throw new Error("AI接続サーバーからの応答が不正です。");
          for (const command of response.commands) {
            if (!isCurrent(current)) break;
            await executeCommand(current, command);
          }
          failures = 0;
          renderConnected(current);
        } catch (error) {
          if (!isCurrent(current)) break;
          if (!retryable(error)) {
            stop(error.message || "AI接続に失敗しました。", true);
            break;
          }
          current.attached = false;
          current.recovering = true;
          current.phase = "retrying";
          render("接続が途切れたため、自動で再接続しています…" + (current.notice || ""));
          try {
            if (!current.suspended) await wait(current, Math.min(5000, 500 * 2 ** Math.min(failures++, 4)));
          } catch { break; }
        }
      }
    }

    function suspend() {
      const current = intent;
      if (!current || current.initial) return;
      current.suspended = true;
      current.needsResume = true;
      if (current.phase === "polling") current.activeRequest?.abort();
    }

    function wakeConnection() {
      const current = intent;
      if (!current || current.initial) return;
      current.suspended = false;
      current.needsResume = true;
      current.wake?.();
      // Do not abort a result report or an operation already being applied.
      if (current.phase === "polling") current.activeRequest?.abort();
    }

    connectButton.addEventListener("click", () => {
      if (!dialog.open) dialog.showModal();
      render();
    });
    closeButton.addEventListener("click", event => {
      event.preventDefault();
      if (intent?.initial) stop("接続を中止しました。");
      dialog.close();
    });
    dialog.addEventListener("close", () => {
      if (!dialog.open && intent?.initial) stop("接続を中止しました。");
      render();
    });
    dialog.addEventListener("cancel", () => {
      if (intent?.initial) stop("接続を中止しました。");
    });
    disconnectButton.addEventListener("click", event => {
      event.preventDefault();
      stop(intent?.initial ? "接続を中止しました。" : "未接続");
    });
    confirmButton.addEventListener("click", async event => {
      event.preventDefault();
      if (intent) return;
      const current = {
        generation: ++generation, controller: new AbortController(), baseUrl: "",
        initial: true, recovering: false, attached: false, credentials: null,
        metadata: null, reports: new Map(), seen: new Set(), notice: "",
        needsResume: false, suspended: false, phase: "connecting", activeRequest: null, wake: null,
      };
      intent = current;
      render("接続中…");
      try {
        current.baseUrl = parseServerUrl(urlInput.value);
        await connectInitially(current);
        if (!isCurrent(current)) return;
        current.initial = false;
        renderConnected(current);
        dialog.close();
        void maintain(current);
      } catch (error) {
        if (isCurrent(current)) stop(error.code === "BUSY" ? "文字入力を確定してから接続してください。" : error.message || "AI接続に失敗しました。");
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wakeConnection();
    });
    document.addEventListener("freeze", suspend);
    document.addEventListener("resume", wakeConnection);
    window.addEventListener("pageshow", wakeConnection);
    window.addEventListener("online", wakeConnection);
    window.addEventListener("pagehide", event => {
      if (event.persisted) suspend();
      else stop("未接続", false, true);
    });

    render("未接続");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
