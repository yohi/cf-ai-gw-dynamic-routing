# Cloudflare AI Gateway ログによる Context / Token 診断

このドキュメントでは、`scripts/analyze-logs.mjs` を使って Cloudflare AI Gateway のログから Agentic Coding の context/token 消費を分解・診断する方法を説明します。

主な対象は OpenCode + oh-my-openagent (OmO) + Superpowers の長時間エージェント実行です。単純な `tokens/request` だけでなく、親セッションへ残留した tool result / subagent return の再読、provider prompt-cache locality、`truncate_all_tool_outputs` の候補を可視化します。

## 目的

Agentic Coding では、1つの人間のタスクが複数の LLM request、tool call、subagent、review/fix loop に展開されます。そのため、単純な request 数や model の単価だけではコスト要因を特定できません。

本 analyzer は次を調べます。

- `tokens_in` / request の p50, p95, mean
- input context の構成比
  - `system`
  - `tool_schema`
  - `user_history`
  - `assistant_history`
  - `tool_output`
  - `subagent_return`
  - `protocol_overhead`
- session 内での `tokens_in` 増加量
- 同じ artifact が後続 request に再登場する **re-read amplification**
- provider switch の前後における prompt-cache read ratio
- OmO の標準 tool-output truncation 対象外で巨大な tool result
- Superpowers の file handoff が機能しているかを判断するための `subagent_return` 比率

## 前提

Cloudflare AI Gateway の Logs API を使います。Logpush は必要ありません。

必要な環境変数:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_GATEWAY_ID="..."
```

API token には対象 AI Gateway のログを読む権限が必要です。

request/response payload の保存を Cloudflare 側で無効化している request は、一覧の `tokens_in/out` は利用できても component 分解ができません。この場合は analyzer が取得できる情報だけを使用します。

## セットアップ

```bash
npm install
```

DuckDB を使わず Markdown/JSON/JSONL だけ生成する場合は `npm install` 前でも次のように実行できます。

```bash
node scripts/analyze-logs.mjs --no-duckdb
```

## 基本実行

直近300 request:

```bash
npm run analyze-logs
```

直近500 request:

```bash
npm run analyze-logs -- --limit 500
```

期間を限定:

```bash
npm run analyze-logs -- \
  --since 2026-09-04T00:00:00+09:00 \
  --until 2026-09-05T00:00:00+09:00 \
  --limit 1000
```

raw request/response もローカル保存したい場合のみ:

```bash
npm run analyze-logs -- --limit 500 --store-raw
```

raw payload は prompt、ソースコード、tool output 等を含み得るため、**デフォルトでは保存しません**。`data/ai-gateway/` は `.gitignore` 対象です。

## 出力

デフォルトでは `data/ai-gateway/` に次を生成します。

```text
data/ai-gateway/
├── analysis.duckdb
├── report.md
├── report.json
├── derived/
│   ├── requests.jsonl
│   ├── components.jsonl
│   ├── artifacts.jsonl
│   ├── session_deltas.jsonl
│   └── amplification.jsonl
└── raw/                 # --store-raw 指定時のみ
```

### DuckDB tables

- `requests`: Cloudflare log + normalized provider usage + session metadata
- `components`: request ごとの input component 分解
- `artifacts`: message/tool/schema 単位の fingerprint と token 推定
- `session_deltas`: session 内の turn 順、`tokens_in` 増分、provider switch
- `amplification`: 同一 artifact の再読量

### DuckDB views

- `component_share`
- `top_context_amplifiers`
- `provider_switch_cache`

例:

```sql
SELECT * FROM component_share;

SELECT *
FROM top_context_amplifiers
LIMIT 20;

SELECT *
FROM provider_switch_cache;
```

## Token 分解の考え方

Cloudflare の `tokens_in` を request 全体の authoritative total として扱います。

request payload 内の各要素は UTF-8 byte 数から概算 token を求め、その比率を使って Cloudflare の `tokens_in` を component/artifact に再配分します。

概念的には:

```text
estimated_total = Σ local_estimate(component)
scale = cloudflare.tokens_in / estimated_total
allocated(component) = local_estimate(component) × scale
```

この値は provider tokenizer と完全一致する会計値ではありません。目的は「145k のうち何が支配的か」のような**相対診断**です。

## Component の意味

### `system`

system/developer message。OmO / OpenCode / Superpowers の instructions がここに含まれる場合があります。

### `tool_schema`

request に送信された tool/function schema。

### `user_history`

現在requestに含まれる user message 群。

### `assistant_history`

過去の assistant text、tool call 等。

### `tool_output`

通常の tool result。`read`, shell/test output, MCP result など。

### `subagent_return`

`task` 等、子エージェントから親へ返った tool result。デフォルトで次を subagent tool とみなします。

```text
task
background_task
background_output
task_output
```

環境で別名を使う場合:

```bash
npm run analyze-logs -- --subagent-tools task,my_task,my_subagent
```

### `protocol_overhead`

上記以外の request option / protocol 構造。model、reasoning option 等を含みます。

## Stable session ID を metadata に入れる

session 単位の増加量・re-read amplification・provider switch を正確に測るには、AI Gateway custom metadata へ stable session ID を付けるのが最も確実です。

推奨5項目:

```json
{
  "session": "hashed-or-opaque-session-id",
  "agent": "sisyphus",
  "phase": "review",
  "category": "deep",
  "experiment": "baseline"
}
```

analyzer はデフォルトで `metadata.session` を使用します。キーを変える場合:

```bash
npm run analyze-logs -- --metadata-session-key opencode_session
```

metadata がない場合は最初の user message を fingerprint して session を推定します。ただし同じ開始promptの別sessionを誤結合する可能性があるため、精密比較では metadata を推奨します。

## Re-read amplification

Agent session のコストでは「1回大きな tool result が出た」ことより、その結果がその後何turnも parent context に残ることが問題になる場合があります。

例:

```text
reviewer return = 18k tokens
その後 parent request に 15回残留
```

この artifact は概ね:

```text
初回 resident 18k
+ 後続再読 18k × 14
```

という増幅を起こします。

analyzer は session + artifact hash で同一内容の再登場を数え、`reread_tokens` を算出します。

```sql
SELECT artifact_type, artifact_label, tool_name,
       occurrence_count, reread_tokens
FROM top_context_amplifiers
LIMIT 20;
```

Superpowers では、上位が `subagent_return` なら詳細reportを親へ全文返している可能性を疑います。

## Superpowers での解釈

現行 SDD の理想形は次です。

```text
parent/controller
    │
    ├─ task-N-brief.md
    │       ↓
    ├─ fresh implementer
    │       ├ RED / GREEN / tests / implementation
    │       └ task-N-report.md
    │
    └← status / commits / one-line test summary / concerns のみ
```

詳細report・長いtest log・調査artifactは `.superpowers/sdd/...` の file に置き、parent への return は小さくします。

判断目安として analyzer は `subagent_return` が input の15%を超えると警告します。

この閾値は絶対基準ではありません。実タスクの品質と `tokens/completed task` を見ながら調整してください。

## OmO `truncate_all_tool_outputs` の判定

OmO の通常 tool-output truncator は、既知の標準構成では主に次を対象にします。

```text
grep / safe_grep
glob / safe_glob
lsp_diagnostics
interactive_bash
skill_mcp
webfetch
```

標準 whitelist 外で単発50k tokens以上に相当する result が頻繁に出る場合、次のA/Bを検討できます。

```jsonc
"experimental": {
  "truncate_all_tool_outputs": true
}
```

ただし、50k未満の中サイズ result が多数滞留しているケースにはこれだけでは効きません。その場合は file handoff / progressive disclosure / parent context isolation が優先です。

閾値を変えて診断:

```bash
npm run analyze-logs -- --truncate-threshold 30000
```

## Provider prompt-cache locality

Cloudflare AI Gateway の response cache と provider prompt cache は別物です。

本 analyzer が見たいのは provider response payload の usage に含まれる cached-input系tokenです。代表的な field 名を正規化して:

- `provider_cache_read_tokens`
- `provider_cache_write_tokens`

として保存します。

provider が該当usageを返さない場合は `NULL` です。

session内で provider が変わったrequestと同一providerが続いたrequestを比較できます。

```sql
SELECT * FROM provider_switch_cache;
```

例えば:

```text
same provider cache ratio p50: 80%
after switch cache ratio p50: 10%
```

のような差が安定して観測されるなら、長時間Agent loopでは requestごとのPercentage分散より ordered priority/fallback の方が有利である根拠になります。

## Context growth

`session_deltas` では前requestとの差を保持します。

```sql
SELECT session_id, turn_index, tokens_in, delta_tokens_in,
       provider_switched
FROM session_deltas
ORDER BY session_id, turn_index;
```

`tokens_in` が毎turn 5k～20kずつ増える場合、parent context に artifact が継続的に追加されている可能性があります。

## A/B 評価

最適化は `tokens/request` だけで判定しないでください。

推奨する比較:

```text
Baseline
  ↓
Superpowers file handoff / parent context isolation を厳密化
  ↓
必要なら OmO の truncation 設定をA/B
```

最低限見る値:

- input tokens / request p50, p95
- input tokens / completed task
- requests / completed task
- turns / completed task
- review fix rounds
- final review pass rate
- task completion rate
- provider cache read ratio
- wall time / completed task

例えば request が145k→80kになっても、必要情報を消した結果 turns が8→15へ増えたなら最適化として失敗する可能性があります。

## 推奨判定ルール

report は初期値として次を警告します。

```text
subagent_return > 15%
  → file handoff / tiny return を確認

tool_output > 30%
  → tool別 footprint と amplification を確認

non-whitelisted single tool output >= 50k
  → truncate_all_tool_outputs=true のA/B候補

system + tool_schema > 35%
  → static prefix と prompt-cache locality を確認

user + assistant history > 40%
  → task boundary / session lifecycle を確認

provider switch 後の cache ratio が same-provider の70%未満
  → Percentageよりpriority/fallbackを検討

turn growth p50 > 5k
  → parent context のartifact滞留を確認
```

## Privacy / retention

- raw request/response の保存はデフォルトOFFです。
- `--store-raw` 使用時は gzip でローカル保存します。
- `data/ai-gateway/` はGit管理外です。
- derived JSONL には prompt本文そのものは保存せず、分類・hash・token量等を保存します。
- `metadata_json` は保存されるため、metadata に秘密情報を入れないでください。

## Offline fixture mode

Cloudflare APIを呼ばず解析ロジックを確認できます。

```bash
node scripts/analyze-logs.mjs --fixture ./sample.json --no-duckdb
```

fixture format:

```json
[
  {
    "log": {
      "id": "abc",
      "created_at": "2026-09-04T00:00:00Z",
      "provider": "ollama",
      "model": "kimi-k2.7-code",
      "tokens_in": 100000,
      "tokens_out": 1000,
      "metadata": {"session": "session-1"}
    },
    "request": {
      "model": "dynamic/kimi-k2.7-code",
      "messages": []
    },
    "response": {
      "usage": {}
    }
  }
]
```

## Test

解析coreの外部依存なしself-test:

```bash
npm run test:log-analysis
```

このtestはCloudflare APIやDuckDBを必要としません。
