# Codex・ChatGPT Work から台本を編集する

エディタで「AI接続」を有効にすると、開いている台本の読み取り・検索・編集ができます。変更はその画面に反映され、既存の自動保存・JSON保存・バックアップの処理を使います。

## 最初に行うこと

1. Node.js 22 以上を用意します。PowerShell でこのフォルダへ移動し、初回だけ依存ライブラリを入れます。

   ```powershell
   Set-Location -LiteralPath 'F:\NewPC\ProgramFile\台本エディタ'
   npm.cmd install
   ```

2. 接続サーバーを起動します。終了するまでは、この PowerShell を開いておきます。

   ```powershell
   npm.cmd start
   ```

3. いつもの `index.html` をブラウザで開き、開いていた場合は再読み込みします。「AI接続」→「接続」を押します。接続先は `http://127.0.0.1:39041` です。
4. 下の方法で Codex またはデスクトップ版 Work に登録し、新しいチャットで「接続中の台本を読んで、冒頭の台詞を自然な口調に直して」のように依頼します。

「接続」を押すと、接続先の起動を最大20秒待ちながら再試行します。待機中は「接続中…」と残り時間を表示し、「接続を中止」・「閉じる」・Escapeで中止できます。失敗後も、画面を再読み込みせず「接続」でやり直せます。

初回に接続できない場合は、Codex/GPT Workで「台本エディタの接続を確認して」と依頼したあと、もう一度「接続」を押してください。一度つながった後は、通信が途切れても接続情報を保持し、自動で復帰します。接続先が途中で停止した場合も、次のMCP操作で起動し直し、同じ接続IDで復帰します。ブラウザが台本のタブを休止させた場合は、タブを表示すると復帰します。「接続を解除」を押した場合は自動復帰しません。

編集を二重に反映しないため、通信の失敗後に編集操作は自動で繰り返しません。すでに反映した編集の結果報告だけを、同じ操作IDで再送します。操作期限を過ぎた結果報告でも接続全体は解除しません。結果が未確認の場合は、台本を再取得してから次の編集を行ってください。

いつものファイルから開く方法では、その画面の台本・保存設定を使えます。サーバーの [エディタ画面](http://127.0.0.1:39041/) から開くこともできますが、保存領域が異なります。移行する場合は、元の画面で「JSON保存」し、サーバーの画面で「JSON読込」してください。`127.0.0.1` と `localhost` も保存領域が異なります。

## Codex に登録する

PowerShell で一度実行します。

```powershell
codex mcp add script_editor -- node 'F:/NewPC/ProgramFile/台本エディタ/mcp/stdio.mjs'
```

Codex を再起動し、新しいチャットを開きます。登録した stdio 接続は必要に応じて接続サーバーを自動起動するので、以後は毎回 `npm start` を実行する必要はありません。エディタ側の「AI接続」は毎回必要です。

設定画面から登録する場合は **Settings → MCP servers → Add server → STDIO** で、コマンドを `node`、引数を `F:/NewPC/ProgramFile/台本エディタ/mcp/stdio.mjs` にして保存・再起動します。

設定ファイルを直接使う場合は、`C:/Users/gatsu/.codex/config.toml` に次の項目を追加します。同じ名前がある場合は既存項目を更新します。

```toml
[mcp_servers.script_editor]
command = "node"
args = ["F:/NewPC/ProgramFile/台本エディタ/mcp/stdio.mjs"]
cwd = "F:/NewPC/ProgramFile/台本エディタ"
startup_timeout_sec = 20
```

## デスクトップ版 ChatGPT Work に登録する

このフォルダには、ローカルの Work チャット向けプラグインとカタログを同梱しています。Codex の MCP 登録とは別にインストールします。

PowerShellから登録する場合は、次の手順を一度実行してアプリを再起動します。

```powershell
codex features enable plugins
codex plugin marketplace add 'F:/NewPC/ProgramFile/台本エディタ'
codex plugin add script-editor@script-editor-local
```

1. デスクトップアプリでこのプロジェクトを開き、アプリを再起動します。
2. **Plugins** を開き、ローカルのカタログ **台本エディタ** を選びます。
3. **台本エディタ** プラグインを開き、プラスボタンでインストールします。
4. 新しい **ローカルで実行する Work チャット** を開き、`@` から台本エディタを選んで依頼します。
5. ブラウザのエディタで「AI接続」を有効にします。

カタログは `.claude-plugin/marketplace.json`、プラグインは `mcp/plugin/` にあります。このPCのアプリに対応する `.codex-plugin/plugin.json`・`.mcp.json` 形式を使っています。プラグインはインストール時にコピーされるため、起動先にはこのエディタの絶対パスを指定しています。フォルダを移動した場合は `mcp/plugin/.mcp.json` の `args` と `cwd` を変更し、アプリを再起動してプラグインを更新してください。

アプリから `node` が見つからない場合は、プラグインの `command` または Codex のコマンド欄に、使用している `node.exe` の絶対パスを指定します。ワークスペースによっては管理者がプラグインの利用を制限しています。

## Web・クラウド版 Work を使う場合

ローカルプラグインはこの PC 上で実行するチャット用です。Web・クラウド版からこのサーバーに接続するには、別途 **Secure MCP Tunnel** を設定します。トンネルと ChatGPT 側の接続は、この実装では未設定です。

1. [Platform の Tunnel 設定](https://platform.openai.com/settings/organization/tunnels) でトンネルを作成し、使う ChatGPT ワークスペースを関連付けます。
2. 公式の `tunnel-client` を用意し、トンネル ID と実行用 API キーを使って、この PC の `http://127.0.0.1:39041/mcp` または stdio の起動コマンドへ接続します。設定方法は [Secure MCP Tunnel の公式手順](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) を確認してください。
3. `tunnel-client` の接続を維持し、[ChatGPT Plugins](https://chatgpt.com/plugins) のプラスボタン → **Add custom MCP server → Connection: Tunnel** から同じトンネルを選び、**Create as a plugin** で登録します。
4. 新しい Work チャットでプラグインを使います。エディタの「AI接続」も必要です。

トンネルには利用権限と API キーが必要です。公開 HTTPS サーバーに転送する方法もありますが、本サーバーはローカル利用を前提にしています。

## MCP の操作

| ツール | 内容 |
| --- | --- |
| `list_scripts` | 「AI接続」中の画面と `sessionId` を取得 |
| `get_script` | 最新の台本、`projectId`、`revision`、章・行・備考の ID、ふりがな辞書 `project.furigana` を取得 |
| `search_script` | 本文・話者・備考を部分一致で検索 |
| `edit_script` | 複数の変更をまとめて検証し、エディタへ反映 |

編集前に `list_scripts` で対象画面を選び、`get_script` で現在の状態を取得します。`edit_script` には取得した `sessionId`、`projectId`、`revision` を使います。例の識別子は、実際の取得結果に置き換えます。

```json
{
  "sessionId": "list_scriptsで得たsessionId",
  "projectId": "get_scriptで得たproject.projectId",
  "expectedRevision": "get_scriptで得たrevision",
  "operations": [
    {
      "op": "update_line",
      "lineId": "get_scriptで得た行のid",
      "speaker": "主人公",
      "body": "今日はここから始めよう。"
    }
  ]
}
```

利用できる `op` は、タイトル変更の `set_title`、章の `add_section`・`rename_section`・`delete_section`、行の `update_line`・`insert_lines`・`delete_lines`、備考の `upsert_note`・`delete_note`、ふりがなの `upsert_furigana`・`delete_furigana` です。`insert_lines` は `sectionId` と `lines` を指定し、`afterLineId` があればその行の後、なければ章末尾に追加します。行の `type` は `dialogue`（台詞）、`direction`（ト書き）、`sfx`（効果音）、`bgm`（BGM）です。

### ふりがなの登録・更新・削除

`get_script` の `project.furigana` で、台本全体のふりがな辞書（`word` と `reading` の一覧）を確認できます。辞書を変更するときは、本文に読みを追記せず、`edit_script` の `operations` に次の操作を指定します。

```json
{"op": "upsert_furigana", "word": "御伽話", "reading": "おとぎばなし"}
```

同じ単語が登録済みなら読みを上書きし、未登録なら追加します。

```json
{"op": "delete_furigana", "word": "七夕"}
```

未登録の単語を削除してもエラーにならず、辞書は変わりません。`word` と `reading` はそれぞれ UTF-16 で500コード単位までです。連続する改行を半角スペース1つに置き換え、前後の空白を除いた値を使います。ふりがなの表示はエディタの表示設定に従います。

## 反映と取り消し

- 手入力などで台本が変わり、取得時の `revision` と一致しない場合は編集を拒否します。台本を再取得して変更を見直します。
- 一回の `edit_script` はまとめて反映され、一部の操作が不正なら全体を中止します。反映後はエディタの `Undo` 一回で取り消せます。
- 本文を変更した行では、部分的な太字・文字色を解除します。残す場合は、新しい本文に対応する `bodyMarks` を同時に指定します。位置は UTF-16 単位です。変更しない行の装飾は保持します。
- 最後の章と、章内のすべての行は削除できません。話者の表示色やふりがなの表示切り替えはエディタで行います。
- 通信のタイムアウト時には、編集が反映済みの場合があります。繰り返す前に画面または `get_script` で確認します。
- 接続の有効状態と認証情報は、その画面のメモリ上に保持します。通信切断・接続期限切れ・サーバー再起動からは自動復帰します。画面を閉じた場合や通常の再読み込み後は「AI接続」をやり直します。閉じた台本や未接続の JSON ファイルを直接編集する機能はありません。

## 公式ドキュメント

- [Codex の MCP 登録](https://learn.chatgpt.com/docs/extend/mcp)
- [プラグインの構成・ローカルカタログ](https://developers.openai.com/plugins/build/plugins)
- [ローカル stdio プラグイン](https://developers.openai.com/plugins/deploy/desktop-only)
- [ChatGPT と Work のプラグイン利用](https://learn.chatgpt.com/docs/plugins)
- [ChatGPT へのカスタム MCP 接続](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

## 動作確認

`npm.cmd test` で編集操作と実際のHTTP MCP接続を検証します。Python版PlaywrightとChromiumがある環境では、`python tests/check-mcp-browser.py` で直接開いた台本画面とHTTP画面を実際のstdio MCPにつなぎ、保存・Undo・競合・保存失敗時の復元を検証できます。`python tests/check-mcp-idle.py` は実時間の待機、ブラウザの休止・復帰、期限切れ、サーバー再起動、編集結果の返答消失時の復旧を確認します。既存の本文取り消しは `python tests/check-body-undo.py` で確認できます。
