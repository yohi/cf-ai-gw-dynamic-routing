# ルーティング配分・優先順位の根拠と設計思想

本ドキュメントでは、Cloudflare AI Gateway Dynamic Routing における各プロバイダー（Sakura AI / Ollama Legacy / OpenCode Go / Command Code GOAT）の配分・優先順位と、その根拠を記録します。

---

## 1. 基本原則

このリポジトリでは **1 Dynamic Route = 1 LLM モデル** とし、route 内でモデルを変更しません。変更するのは同一モデルを提供する upstream provider のみです。

ルーティングは次の2種類を使い分けます。

1. **Ordered failover**
   - 高コスト / 長時間 agentic workload 向け
   - primary provider を固定し、quota / 429 / timeout / provider failure 時だけ次へ進む
   - Kimi K3 / GLM-5.2、および品質検証後の Kimi K2.7 で採用する
2. **Percentage split**
   - provider 側に十分な subscription capacity がある Flash 系向け
   - OpenCode Go / GOAT の公開 Typical Requests を初期 weight の参考にする
   - GLM-5.3 Flash / DeepSeek V4 Flash で採用する

Cloudflare の Percentage は request 数単位の確率分配であり、token 使用量や subscription quota 残量を直接均等化する機能ではありません。

---

## 2. 初期設計からの方針変更

初期設計では、OpenCode Go と GOAT が公開している Typical Requests / Month をモデルごとに正規化し、高コストモデルにも Percentage を適用していました。

しかし 2026-09-04 の実運用では、OmO + Superpowers による agentic coding workload が公開 Typical Request より大幅に重いことが確認されました。

### 観測値

- **OpenCode Go**
  - 稼働開始から1日未満で weekly usage が **100.1%** に到達
  - monthly usage も **50%** に到達
  - 週次内訳は GLM 5.3 / Kimi K2.7 Code / GLM 5.3 Flash が同一 weekly window を共有して消費
- **Command Code GOAT**
  - **299 requests** で約 **43.4M tokens**
  - 単純平均で約 **145k tokens / request**

公開されている Typical Request は一般に fresh input 数百 tokens + cache read 約50k + output 数百 tokens 程度を想定しており、この実 workload では request 数だけを基準にした capacity 推定が楽観的になります。

このため、**高コストモデルでは Percentage による平常時分散をやめ、Ollama Legacy を primary とする ordered failover に変更**します。

---

## 3. Provider の位置づけ

### 3.1 Sakura AI Engine

Kimi K2.7 Code の Public Preview を提供します。

- 無料枠: **月3,000 requests**
- token 消費量ではなく request 数で無料枠を消費するため、巨大 context を持つ agentic coding との相性が良い
- 一方 Public Preview のため、安定性・応答品質は保証されない

したがって、いきなり100% primaryにはせず **20% A/B validation** から開始します。

使用する upstream model ID:

```text
preview/Kimi-K2.7-Code
```

### 3.2 Ollama Legacy

旧 Ollama Pro の legacy quota は正確な GPU / token allowance が公開されていません。

そのため定量 weight は置かず、現在は **高コスト open model の primary reservoir** として扱います。

優先対象:

- Kimi K2.7 Code
- Kimi K3
- GLM-5.2

Flash 系では通常 traffic を極力流さず、必要に応じて emergency fallback として利用します。

### 3.3 OpenCode Go / Command Code GOAT

Go / GOAT は複数モデルが同じ plan window を共有します。

したがって、モデルごとの Typical Requests を「独立した財布」として合算してはいけません。

高コストモデルでは overflow / fallback として利用し、Flash 系のみ Percentage split の primary capacity として利用します。

---

## 4. モデル別ルーティング

### 4.1 Kimi K2.7 Code — Sakura 品質検証フェーズ

現在:

```text
20% Sakura
80% Ollama
```

Sakura branch:

```text
Sakura
  ↓ failure
Ollama
  ↓
OpenCode Go
  ↓
GOAT
```

Ollama branch:

```text
Ollama
  ↓ failure
Sakura
  ↓
OpenCode Go
  ↓
GOAT
```

#### 20% Sakura の理由

Sakura の無料 3,000 requests は非常に魅力的ですが、Public Preview の serving quality が Ollama 等と実運用上同等かは未確認です。

まず十分な sample を集め、以下を比較します。

- task 完走率
- tool-call error / malformed call 率
- reviewer による追加修正率
- 平均 turn 数
- TDD RED → GREEN までの turn 数
- latency
- 同一種類タスクでの品質差

品質差が実用上無視できると判断できれば、次フェーズでは Percentage を削除して次の ordered route へ移行します。

```text
Sakura
  ↓
Ollama
  ↓
OpenCode Go
  ↓
GOAT
```

### 4.2 Kimi K3 — Ollama primary

```text
Ollama
  ↓
GOAT
  ↓
OpenCode Go
```

K3 は Go / GOAT の Typical Request capacity が特に小さく、長時間 reasoning で plan window を急速に消費します。

GOAT を Go より先に置くのは、公開 Typical Requests では K3 の GOAT capacity が Go より大きいためです。ただし両者とも primary にはしません。

### 4.3 GLM-5.2 — Ollama primary

```text
Ollama
  ↓
GOAT
  ↓
OpenCode Go
```

初期設計の `Go 48% / GOAT 52%` は Typical Requests の正規化としては妥当でしたが、Go / GOAT の共有 window が実 workload で1日未満に枯渇し得るため、平常時分散を停止しました。

GOAT → Go の順序は両者の公開 capacity が近い中で、GOAT側が若干大きいためです。

### 4.4 GLM-5.3 Flash — Percentage 維持

```text
25% OpenCode Go
75% GOAT
```

初期値は公開 Typical Requests の比率:

- Go: 約7,900 req/月
- GOAT: 約23,600 req/月

を正規化したものです。

Flash系は高コストモデルより capacity が大きいため、現時点では Percentage を維持します。ただし Go / GOAT の weekly / monthly shared window を監視し、必要なら weight を下げます。

### 4.5 DeepSeek V4 Flash — Percentage 維持

```text
30% OpenCode Go
70% GOAT
```

初期値は公開 Typical Requests の比率:

- Go: 約37,800 req/月
- GOAT: 約91,200 req/月

を正規化したものです。

DeepSeek V4 Flash は Go / GOAT 双方で相対的に大きな capacity があり、特に大量 utility / explore workload の overflow として利用価値があります。

---

## 5. 現在のルーティングまとめ

| モデル | Primary | Secondary | Tertiary | 備考 |
| :--- | :--- | :--- | :--- | :--- |
| **Kimi K2.7 Code** | Sakura 20% / Ollama 80% | 相互 fallback | Go → GOAT | Sakura A/B validation 中 |
| **Kimi K3** | Ollama | GOAT | Go | ordered failover |
| **GLM-5.2** | Ollama | GOAT | Go | ordered failover |
| **GLM-5.3 Flash** | Go 25% / GOAT 75% | 相互 fallback | Ollama | Percentage 維持 |
| **DeepSeek V4 Flash** | Go 30% / GOAT 70% | 相互 fallback | Ollama | Percentage 維持 |

---

## 6. モニタリング指標

Cloudflare AI Gateway のログでは、少なくともモデル × provider ごとに次を確認します。

1. **HTTP 429 / quota failure 率**
2. **fallback 発動率**
3. **input / cache / output token 使用量**
4. **latency / timeout**
5. **同一 session の provider 遷移頻度**

Sakura K2.7 の検証中はさらに品質指標として task 完走率・追加修正率・turn 数を記録します。

---

## 7. チューニング方針

優先順位は次の順で判断します。

1. 実際の weekly / monthly quota burn
2. 429 / fallback率
3. task 完走率と turn 数
4. 公開 Typical Requests

公開 Typical Requests は比較のための有用な参考値ですが、OmO / Superpowers の長大 context workloadでは実測を上位の根拠とします。
