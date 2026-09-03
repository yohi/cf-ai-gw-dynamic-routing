# Cloudflare AI Gateway 動的ルーティング (Dynamic Routing)

Cloudflare AI Gateway の動的ルーティング定義と、GitHub Actions による自動デプロイ設定を管理するリポジトリです。

---

## リポジトリ構成

```text
.
├── .github/workflows/
│   └── deploy.yml            # GitHub Actions 自動デプロイワークフロー
├── routes/                   # 各モデルの動的ルーティング定義 (JSON)
│   ├── deepseek-v4-flash.json
│   ├── glm-5.2.json
│   ├── glm-5.3-flash.json
│   ├── kimi-k2.7-code.json
│   └── kimi-k3.json
├── scripts/
│   └── deploy.mjs            # ゼロ依存デプロイスクリプト (Node.js)
├── package.json
└── README.md
```

---

## 概要

`routes/` ディレクトリ内の各 JSON ファイルに含まれるカスタムプロバイダースラッグのプレースホルダーは、デプロイ時に環境変数から自動置換されます：

- `REPLACE_WITH_OLLAMA_CUSTOM_PROVIDER_SLUG`: Ollama のカスタムプロバイダースラッグ
- `REPLACE_WITH_OPENCODE_GO_CUSTOM_PROVIDER_SLUG`: OpenCode Go のカスタムプロバイダースラッグ
- `REPLACE_WITH_COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG`: Command Code GOAT のカスタムプロバイダースラッグ

※ ルート作成 API を利用する場合、トップレベルの `id` フィールドは Cloudflare 側で自動生成されるため、デプロイスクリプト側で適切に処理されます。

---

## ルート一覧とトラフィック配分比率

| ルート名 | トラフィック配分比率（プライマリ） | フォールバック構成 |
| :--- | :--- | :--- |
| **`kimi-k2.7-code`** | Ollama 40% / OpenCode Go 33% / GOAT 27% | 相互フォールバック |
| **`kimi-k3`** | Ollama 50% / OpenCode Go 17% / GOAT 33% | 相互フォールバック |
| **`glm-5.2`** | OpenCode Go 48% / GOAT 52% | Ollama (緊急フォールバックのみ) |
| **`glm-5.3-flash`** | OpenCode Go 25% / GOAT 75% | Ollama (緊急フォールバックのみ) |
| **`deepseek-v4-flash`** | OpenCode Go 30% / GOAT 70% | Ollama (緊急フォールバックのみ) |

### ルーティングの設計方針
- **同一モデルでのフォールバック**: すべてのフォールバック先で、同一の LLM モデルを維持したまま別プロバイダーへ切り替わります。
- **リトライ回数 `retries: 0`**: レート制限やプロバイダー障害発生時に、同一プロバイダーで無駄に時間を消費せず即座に次のプロバイダーへ切り替えるため、意図的に `0` に設定しています。
- **タイムアウト設定**:
  - `kimi-k3`: 180秒（`180000`ms）
  - その他のルート: 120秒（`120000`ms）
  - ※ 重度の推論タスクで TTFT（Time to First Token）が長くなるプロバイダーがある場合は、必要に応じて `timeout` を調整してください。

### 動的ルートの呼び出し方法
OpenAI 互換エンドポイント（`/compat/chat/completions`）にて、モデル名に以下を指定してリクエストします：

```text
model: "dynamic/<route-name>"
```
（例: `dynamic/glm-5.3-flash`, `dynamic/kimi-k2.7-code`）

---

## GitHub Actions & スクリプトによる自動デプロイ

本リポジトリには、GitHub Actions（[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)）および外部依存なしのデプロイスクリプト（[`scripts/deploy.mjs`](scripts/deploy.mjs)）が含まれています。

### 必要な GitHub Secrets / Variables

GitHub リポジトリの **Settings** ＞ **Secrets and variables** ＞ **Actions** にて以下を設定してください：

| 項目名 | 種類 | 説明 |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | **Secret** | `Account` ＞ `AI Gateway` ＞ `Edit` 権限を持つ Cloudflare API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | Secret / Var | Cloudflare アカウント ID |
| `CLOUDFLARE_GATEWAY_ID` | Secret / Var | 対象の AI Gateway ID（またはスラッグ） |
| `OLLAMA_CUSTOM_PROVIDER_SLUG` | Secret / Var | AI Gateway 上の Ollama カスタムプロバイダースラッグ |
| `OPENCODE_GO_CUSTOM_PROVIDER_SLUG` | Secret / Var | AI Gateway 上の OpenCode Go カスタムプロバイダースラッグ |
| `COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG` | Secret / Var | AI Gateway 上の Command Code GOAT カスタムプロバイダースラッグ |

### ワークフローの動作
- **`main` / `master` への push**: 変更のあった動的ルートを Cloudflare AI Gateway へ自動デプロイ（新規作成または更新を自動判別）
- **Pull Request**: `--dry-run` による自動検証（構文チェック & 置換検証）
- **手動実行 (`workflow_dispatch`)**: GitHub Actions の画面から Dry-run や特定ルート単体のデプロイを実行可能

---

## ローカルでの実行方法

```bash
# Dry-run モード（API リクエストを送信せず、置換結果やペイロードをプレビュー確認）
npm run dry-run

# 全ルートをデプロイ
CLOUDFLARE_API_TOKEN="your-api-token" \
CLOUDFLARE_ACCOUNT_ID="your-account-id" \
CLOUDFLARE_GATEWAY_ID="your-gateway-id" \
OLLAMA_CUSTOM_PROVIDER_SLUG="your-ollama-slug" \
OPENCODE_GO_CUSTOM_PROVIDER_SLUG="your-opencode-slug" \
COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG="your-goat-slug" \
npm run deploy

# 特定のルートファイルのみを指定してデプロイ
CLOUDFLARE_API_TOKEN="your-api-token" \
CLOUDFLARE_ACCOUNT_ID="your-account-id" \
CLOUDFLARE_GATEWAY_ID="your-gateway-id" \
OLLAMA_CUSTOM_PROVIDER_SLUG="your-ollama-slug" \
OPENCODE_GO_CUSTOM_PROVIDER_SLUG="your-opencode-slug" \
COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG="your-goat-slug" \
node scripts/deploy.mjs --file glm-5.3-flash.json
```


