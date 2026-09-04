# Cloudflare AI Gateway 動的ルーティング (Dynamic Routing)

Cloudflare AI Gateway の動的ルーティング定義と、GitHub Actions による自動デプロイ設定を管理するリポジトリです。

---

## リポジトリ構成

```text
.
├── .github/workflows/
│   └── deploy.yml            # GitHub Actions 自動デプロイワークフロー
├── docs/
│   └── routing-weights-rationale.md # 配分・優先順位の根拠と運用方針
├── routes/                   # 各モデルの動的ルーティング定義 (JSON)
│   ├── deepseek-v4-flash.json
│   ├── gemini-3.1-pro.json
│   ├── gemini-3.5-flash-lite.json
│   ├── gemini-3.7-flash.json
│   ├── gemini-3.8-flash.json
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

`routes/` ディレクトリ内の各 JSON ファイルに含まれるカスタムプロバイダースラッグのプレースホルダーは、デプロイ時に環境変数から自動置換されます。

- `REPLACE_WITH_OLLAMA_CUSTOM_PROVIDER_SLUG`: Ollama のカスタムプロバイダースラッグ
- `REPLACE_WITH_OPENCODE_GO_CUSTOM_PROVIDER_SLUG`: OpenCode Go のカスタムプロバイダースラッグ
- `REPLACE_WITH_COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG`: Command Code GOAT のカスタムプロバイダースラッグ
- `REPLACE_WITH_SAKURA_AI_CUSTOM_PROVIDER_SLUG`: さくらのAI Engine のカスタムプロバイダースラッグ

Google AI Studio 等の Cloudflare AI Gateway 標準プロバイダー（`google-ai-studio`）を使用するルートは、カスタムプロバイダースラッグの置換不要で直接定義します。

ルート作成 API を利用する場合、トップレベルの `id` フィールドは Cloudflare 側で自動生成されるため、デプロイスクリプト側で適切に処理されます。

---

## ルート一覧

| ルート名 | プライマリ経路 | フォールバック構成 |
| :--- | :--- | :--- |
| **`gemini-3.8-flash`** | Google AI Studio 100% | 単一プロバイダー直接経路 |
| **`gemini-3.7-flash`** | Google AI Studio 100% | 単一プロバイダー直接経路 |
| **`gemini-3.5-flash-lite`** | Google AI Studio 100% | 単一プロバイダー直接経路 |
| **`gemini-3.1-pro`** | Google AI Studio 100% | 単一プロバイダー直接経路 |
| **`kimi-k2.7-code`** | **検証フェーズ: Sakura 20% / Ollama 80%** | Sakura系: Ollama → Go → GOAT / Ollama系: Sakura → Go → GOAT |
| **`kimi-k3`** | **Ollama 100%** | GOAT → OpenCode Go |
| **`glm-5.2`** | **Ollama 100%** | GOAT → OpenCode Go |
| **`glm-5.3-flash`** | OpenCode Go 25% / GOAT 75% | Ollama 緊急フォールバック |
| **`deepseek-v4-flash`** | OpenCode Go 30% / GOAT 70% | Ollama 緊急フォールバック |

> [!NOTE]
> 配分・優先順位の算出根拠、実測に基づく方針変更、Sakura Kimi K2.7 の検証基準については [**ルーティング配分・優先順位の根拠と設計思想**](docs/routing-weights-rationale.md) を参照してください。

### ルーティングの設計方針

- **同一モデルを維持**: 1つの Dynamic Route 内では LLM モデルを変更せず、同一モデルを提供する別プロバイダーへ切り替えます。
- **高コストモデルは ordered failover**: Kimi K3 / GLM-5.2 は request ごとの Percentage 分散をやめ、Ollama Legacy を優先して Go / GOAT の共有 quota 消費を抑えます。
- **Kimi K2.7 は Sakura を段階導入**: さくらのAI Engine の無料枠は月3,000 requestですが、Public Preview の応答品質は保証されないため、まず 20% の A/B トラフィックで品質を確認します。
- **Flash 系のみ Percentage を維持**: GLM-5.3 Flash / DeepSeek V4 Flash は Go / GOAT の利用可能量が大きいため、両 subscription を比例消費します。
- **`retries: 0`**: quota / rate limit / provider 障害時に同一プロバイダーで粘らず、即座に次のプロバイダーへ切り替えます。
- **タイムアウト**:
  - `kimi-k3`, `gemini-3.1-pro`: 180秒 (`180000` ms)
  - その他: 120秒 (`120000` ms)

### 動的ルートの呼び出し方法

OpenAI 互換エンドポイント（`/compat/chat/completions`）ではモデル名に次を指定します。

```text
model: "dynamic/<route-name>"
```

例:

```text
model: "dynamic/kimi-k2.7-code"
model: "dynamic/glm-5.3-flash"
```

---

## GitHub Actions & スクリプトによる自動デプロイ

本リポジトリには、GitHub Actions（[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)）および外部依存なしのデプロイスクリプト（[`scripts/deploy.mjs`](scripts/deploy.mjs)）が含まれています。

### 必要な GitHub Secrets / Variables

GitHub リポジトリの **Settings** > **Secrets and variables** > **Actions** に以下を設定してください。

| 項目名 | 種類 | 説明 |
| :--- | :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | Secret | `Account` > `AI Gateway` > `Edit` 権限を持つ Cloudflare API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | Secret / Var | Cloudflare アカウント ID |
| `CLOUDFLARE_GATEWAY_ID` | Secret / Var | 対象の AI Gateway ID（またはスラッグ） |
| `OLLAMA_CUSTOM_PROVIDER_SLUG` | Secret / Var | Ollama カスタムプロバイダースラッグ |
| `OPENCODE_GO_CUSTOM_PROVIDER_SLUG` | Secret / Var | OpenCode Go カスタムプロバイダースラッグ |
| `COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG` | Secret / Var | Command Code GOAT カスタムプロバイダースラッグ |
| `SAKURA_AI_CUSTOM_PROVIDER_SLUG` | Secret / Var | さくらのAI Engine カスタムプロバイダースラッグ |

### ワークフローの動作

- **`main` / `master` への push**: 動的ルートを Cloudflare AI Gateway へ自動デプロイ（新規作成 / 更新を自動判別）
- **Pull Request**: `--dry-run` による JSON / placeholder / payload 検証
- **手動実行 (`workflow_dispatch`)**: Dry-run または特定ルート単体のデプロイ

---

## ローカルでの実行方法

```bash
npm run dry-run
```

全ルートをデプロイ:

```bash
CLOUDFLARE_API_TOKEN="your-api-token" \
CLOUDFLARE_ACCOUNT_ID="your-account-id" \
CLOUDFLARE_GATEWAY_ID="your-gateway-id" \
OLLAMA_CUSTOM_PROVIDER_SLUG="your-ollama-slug" \
OPENCODE_GO_CUSTOM_PROVIDER_SLUG="your-opencode-slug" \
COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG="your-goat-slug" \
SAKURA_AI_CUSTOM_PROVIDER_SLUG="your-sakura-slug" \
npm run deploy
```

特定ルートのみ:

```bash
CLOUDFLARE_API_TOKEN="your-api-token" \
CLOUDFLARE_ACCOUNT_ID="your-account-id" \
CLOUDFLARE_GATEWAY_ID="your-gateway-id" \
OLLAMA_CUSTOM_PROVIDER_SLUG="your-ollama-slug" \
OPENCODE_GO_CUSTOM_PROVIDER_SLUG="your-opencode-slug" \
COMMAND_CODE_GOAT_CUSTOM_PROVIDER_SLUG="your-goat-slug" \
SAKURA_AI_CUSTOM_PROVIDER_SLUG="your-sakura-slug" \
node scripts/deploy.mjs --file kimi-k2.7-code.json
```

---

## 運用上の注意

Cloudflare AI Gateway の Percentage は request 数単位の確率分配です。Agentic coding では 1 request あたりの context / cache / output token が非常に大きくなる場合があり、request 数の均等化が subscription quota の均等消費を意味しません。

Go / GOAT の公開 Typical Requests は初期設計の参考値として使用しますが、高コストモデルでは実測 quota burn を優先して ordered failover を採用します。Flash 系の weight も、429率・fallback率・実 token 消費を観測して継続的に調整してください。
