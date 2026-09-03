# トラフィック配分比率（Weights）の算出根拠と設計思想

本ドキュメントでは、Cloudflare AI Gateway の動的ルーティングにおける各プロバイダー（Ollama Legacy / OpenCode Go / Command Code GOAT）へのトラフィック配分比率（Weight）の算出根拠と設計方針について詳述します。

---

## 1. 基本方針と算出モデル

各動的ルートにおける配分比率は、以下の2つの原則に基づいて決定されています。

1. **OpenCode Go : Command Code GOAT の比率**  
   各社公式が公開している「典型的な月間推定リクエスト数（Typical Requests / Month）」をベースに正規化して算出（客観的データに基づく）。
2. **Ollama Legacy の比率**  
   旧 Ollama Pro プラン等の Legacy Quota は正確な GPU/Token Allowance が非公開であるため、モデル特性（推論コストの重さ）に応じた**戦略的ヒューリスティック配分**を採用。

```text
                                [ 入力リクエスト ]
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
        【高コスト推論モデル】                      【低コスト / Flash モデル】
         (Kimi K2.7 / Kimi K3)                 (GLM-5.2 / GLM-5.3 / DeepSeek V4)
                    │                                       │
        ┌───────────┴───────────┐                           │
        ▼                       ▼                           ▼
[Ollama 先取り配分]     [残余トラフィック]              [Go : GOAT 正規化配分]
 (40% 〜 50%)          (50% 〜 60%)                 (Go / GOAT のみで 100%)
                                │                                   │
                                ▼                                   ▼
                    [Go : GOAT 正規化配分]               [Ollama: 緊急フォールバック]
```

---

## 2. 共通算出式

### 2.1 Go と GOAT の正規化比率
各社が想定する典型的なエージェントリクエスト（例: Fresh Input 約800 tokens + Cache Read 約50k + Output 約125〜200 tokens）における月間推定リクエスト数を基準に、両者の比率を正規化します。

$$
\text{Weight}_{\text{Go}} = \frac{\text{Req}_{\text{Go}}}{\text{Req}_{\text{Go}} + \text{Req}_{\text{GOAT}}}
$$

$$
\text{Weight}_{\text{GOAT}} = \frac{\text{Req}_{\text{GOAT}}}{\text{Req}_{\text{Go}} + \text{Req}_{\text{GOAT}}}
$$

### 2.2 Ollama 先取り枠がある場合（K2.7 / K3）
Ollama に割り当てた割合を $P_{\text{Ollama}}$ とし、残りのトラフィック $(1 - P_{\text{Ollama}})$ を Go と GOAT の正規化比率で按分します。

$$
\text{Weight}_{\text{Go}} = (1 - P_{\text{Ollama}}) \times \frac{\text{Req}_{\text{Go}}}{\text{Req}_{\text{Go}} + \text{Req}_{\text{GOAT}}}
$$

$$
\text{Weight}_{\text{GOAT}} = (1 - P_{\text{Ollama}}) \times \frac{\text{Req}_{\text{GOAT}}}{\text{Req}_{\text{Go}} + \text{Req}_{\text{GOAT}}}
$$

---

## 3. モデル別配分比率の算出詳細

### 3.1 Kimi K2.7 Code — `40 / 33 / 27`

- **月間推定リクエスト数**:
  - OpenCode Go: **6,750 req/月**
  - GOAT: **5,420 req/月**

#### 計算プロセス
1. **Go と GOAT の正規化**:
   - Go: $6,750 / (6,750 + 5,420) \fallingdotseq 55.46\%$
   - GOAT: $5,420 / (6,750 + 5,420) \fallingdotseq 44.54\%$
2. **Ollama に 40% を先取り割り当て**:
   - 残余枠: $60\%$
   - Go: $60\% \times 55.46\% \fallingdotseq 33.28\% \rightarrow \mathbf{33\%}$
   - GOAT: $60\% \times 44.54\% \fallingdotseq 26.72\% \rightarrow \mathbf{27\%}$

> **Ollama 40% の選定理由**:  
> K2.7 Code は長時間のコーディングエージェント向けに思考トークンが最適化された主力モデルです。Ollama Legacy 枠を死蔵させず積極的に活用しつつ、特定のプロバイダーへ偏りすぎないバランスとして初期値 40% を設定しています。

---

### 3.2 Kimi K3 — `50 / 17 / 33`

- **月間推定リクエスト数**:
  - OpenCode Go: **490 req/月**
  - GOAT: **980 req/月**
  - （Go : GOAT の比率はジャスト $1 : 2$）

#### 計算プロセス
1. **Ollama に 50% を先取り割り当て**:
   - 残余枠: $50\%$
   - Go: $50\% \times \frac{1}{3} \fallingdotseq 16.67\% \rightarrow \mathbf{17\%}$
   - GOAT: $50\% \times \frac{2}{3} \fallingdotseq 33.33\% \rightarrow \mathbf{33\%}$

> **Ollama 50% の選定理由**:  
> K3 は GOAT でも月 980 req、Go ではわずか 490 req 相当と、全モデル中で群を抜いて Quota 消費が重い高負荷モデルです。Go/GOAT の枠が非常に希少であるため、**「希少な Ollama Legacy 枠を単価の高い K3 に集中投下する」** というリソース配分戦略に基づき 50% まで引き上げています。

---

### 3.3 GLM-5.2 — `48 / 52` (Ollama: 緊急フォールバック)

- **月間推定リクエスト数**:
  - OpenCode Go: **4,300 req/月**
  - GOAT: **4,740 req/月**

#### 計算プロセス
- Go: $4,300 / (4,300 + 4,740) \fallingdotseq 47.57\% \rightarrow \mathbf{48\%}$
- GOAT: $4,740 / (4,300 + 4,740) \fallingdotseq 52.43\% \rightarrow \mathbf{52\%}$

> **Ollama を通常ルーティングから除外した理由**:  
> GOAT（月 $70 クレジット全額対象）および Go（月 4,300 req 相当）ともに十分な Quota が確保されています。Go / GOAT 双方に十分な枠があるモデルで不透明な Ollama Legacy 枠を消費する必要性が薄いため、Ollama は両系障害時の緊急フォールバックとして温存しています。

---

### 3.4 GLM-5.3 Flash — `25 / 75` (Ollama: 緊急フォールバック)

- **月間推定リクエスト数**:
  - OpenCode Go: **7,900 req/月**
  - GOAT: **23,600 req/月**

#### 計算プロセス
- Go: $7,900 / (7,900 + 23,600) \fallingdotseq 25.08\% \rightarrow \mathbf{25\%}$
- GOAT: $23,600 / (7,900 + 23,600) \fallingdotseq 74.92\% \rightarrow \mathbf{75\%}$

> **設計の根拠**:  
> GOAT の枠（月 23,600 req）が Go（月 7,900 req）の約3倍存在するため、完全に $1:3$ の比率で配分しています。2社合計で月 31,500 req 相当が確保されているため、Ollama Legacy 枠は使用せず緊急フォールバックに回しています。

---

### 3.5 DeepSeek V4 Flash — `30 / 70` (Ollama: 緊急フォールバック)

- **月間推定リクエスト数**:
  - OpenCode Go: **37,800 req/月**
  - GOAT: **91,200 req/月**

#### 計算プロセス
- Go: $37,800 / (37,800 + 91,200) \fallingdotseq 29.30\% \rightarrow \mathbf{30\%}$
- GOAT: $91,200 / (37,800 + 91,200) \fallingdotseq 70.70\% \rightarrow \mathbf{70\%}$

> **GOAT 70% と Ollama 除外の根拠**:  
> GOAT では DeepSeek V4 Flash の Cache Read 単価が極めて安価（$0.007 / M tokens）であり、エージェントコーディング特有の巨大キャッシュヒットの恩恵を最大化できます。また Go + GOAT で月約 129,000 req 相当となり、K3（1,470 req）の約88倍の容量があります。低単価な Flash モデルで Legacy Quota を消費するのを避け、K3/K2.7 などの高コストモデルへ Legacy 枠を集中させます。

---

## 4. 配分比率一覧まとめ

| モデル | Go 推定req/月 | GOAT 推定req/月 | Go : GOAT 正規化比 | 実設定 Weight | Ollama の位置づけ |
| :--- | ---: | ---: | :---: | :--- | :--- |
| **Kimi K2.7 Code** | 6,750 | 5,420 | 55.5% : 44.5% | **Ollama 40% / Go 33% / GOAT 27%** | 一次トラフィック (40%) |
| **Kimi K3** | 490 | 980 | 33.3% : 66.7% | **Ollama 50% / Go 17% / GOAT 33%** | 一次トラフィック (50%) |
| **GLM-5.2** | 4,300 | 4,740 | 47.6% : 52.4% | **Go 48% / GOAT 52%** | 緊急フォールバックのみ |
| **GLM-5.3 Flash** | 7,900 | 23,600 | 25.1% : 74.9% | **Go 25% / GOAT 75%** | 緊急フォールバックのみ |
| **DeepSeek V4 Flash** | 37,800 | 91,200 | 29.3% : 70.7% | **Go 30% / GOAT 70%** | 緊急フォールバックのみ |

---

## 5. 実運用におけるモニタリングとチューニング指針

Cloudflare AI Gateway の Percentage ルーティングは**リクエスト数単位**でトラフィックを分配します。しかし、実際の消費 Quota は「コンテキスト長（トークン数）」に大きく左右されます。

運用開始後は、Cloudflare AI Gateway のメトリクスログから以下の3点を確認し、適宜 Weight を補正することを推奨します。

1. **レート制限（HTTP 429）発生率**: 特定プロバイダーで突出して 429 が発生していないか
2. **フォールバック発動率**: 一次プロバイダーの枯渇による副系への切り替え頻度
3. **Token-Weighted 消費量**: リクエスト数だけでなく、Input / Cache Read / Output の実トークン消費量

### チューニングの優先箇所
Go と GOAT の比率は公式 Allowance に準拠しているため極めて安定的です。実運用で調整すべき主な変数は、**Kimi K2.7 の Ollama 40%** および **Kimi K3 の Ollama 50%** の妥当性検証となります。
