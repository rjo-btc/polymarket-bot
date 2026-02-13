# Kelly Criterion Position Sizing — Design Doc

## Overview
Replace flat 7% risk per trade with **confidence-adjusted half-Kelly** sizing based on observed win rate and payout ratios. Activates after 30 trades. Hard cap at 20%.

## Formula

### Full Kelly
```
f* = (b × p - q) / b
```
- `f*` = optimal fraction of capital to risk
- `b` = net payout ratio (profit per $1 risked on a win)
  - For Polymarket: `b = (1 / entry_price) - 1`
  - Example: entry at 0.40 → b = 1.5 (win $1.50 per $1 risked)
  - Example: entry at 0.70 → b = 0.43 (win $0.43 per $1 risked)
- `p` = observed win rate
- `q` = 1 - p

### Half Kelly (what we use)
```
half_kelly = f* / 2
```

### Confidence Scaling
Small sample = less trust in the win rate. Scale up as trades accumulate:
```
confidence = min(1.0, sqrt(n / 20))
```
- At 8 trades: confidence = 0.52 (half strength)
- At 15 trades: confidence = 0.71
- At 30 trades: confidence = 1.0 (full half-Kelly)

### Final Sizing
```
risk_pct = min(half_kelly × confidence, 0.20) × 100
stake = current_capital × risk_pct
```

## Per-Strategy Calculation
EMA and Session strategies will have **independent** Kelly calculations since they have different win rates and entry price profiles.

## Data Needed (tracked per strategy)
| Field | Source |
|-------|--------|
| `win_rate` | resolved wins / resolved total |
| `avg_entry_price` | mean entry_price for wins |
| `avg_payout_ratio` | mean `(1/entry_price - 1)` across wins |
| `n_resolved` | total resolved trades |
| `n_wins` | total wins |

## Implementation Plan

### 1. Track per-strategy stats
Add to `/api/summary` response:
```json
{
  "kelly": {
    "ema": {
      "n": 34,
      "win_rate": 0.794,
      "avg_payout_ratio": 1.12,
      "full_kelly_pct": 38.2,
      "half_kelly_pct": 19.1,
      "confidence": 1.0,
      "adjusted_pct": 19.1,
      "capped_pct": 19.1
    },
    "session": { ... },
    "combined": {
      "recommended_risk_pct": 15.4,
      "current_risk_pct": 7.0,
      "status": "collecting_data | active"
    }
  }
}
```

### 2. Activation threshold
- Below 30 resolved trades per strategy: use flat 7% (current behavior)
- At 30+: switch to confidence-adjusted half-Kelly
- Display on dashboard: "Collecting data (12/30 trades)" or "Kelly active: 14.2%"

### 3. Dashboard additions (on bot URL page)
Add a **Kelly Sizing** card to the dashboard showing:
- Current risk % per strategy
- Kelly-recommended % per strategy
- Confidence level (with progress bar to 30 trades)
- Win rate and avg payout ratio
- Visual: recommended vs actual as a gauge or bar

### 4. Hard cap: 20%
Regardless of what Kelly says, never risk more than 20% per trade. This protects against:
- Win rate regression
- Small sample flukes
- Correlated losses

### 5. Edge cases
- If Kelly returns negative → edge is negative → risk 0% (don't trade that strategy)
- If win rate < 50% with bad odds → Kelly auto-shuts it down
- Minimum bet: $1 (don't bother with dust)

## Example Scenarios

| Win Rate | Avg Entry | Payout (b) | Full Kelly | Half Kelly | Capped |
|----------|-----------|------------|------------|------------|--------|
| 80% | 0.65 | 0.54 | 43.1% | 21.5% | **20.0%** |
| 75% | 0.50 | 1.00 | 50.0% | 25.0% | **20.0%** |
| 75% | 0.70 | 0.43 | 16.7% | 8.3% | 8.3% |
| 60% | 0.55 | 0.82 | 24.0% | 12.0% | 12.0% |
| 55% | 0.60 | 0.67 | 7.5% | 3.7% | 3.7% |

## Notes
- Half Kelly gives ~75% of optimal growth rate with ~50% less max drawdown
- The confidence ramp prevents overcommitting on small samples
- Per-strategy Kelly means EMA can bet big while Session stays conservative if their stats diverge
- Review/recalibrate monthly or after significant regime changes
