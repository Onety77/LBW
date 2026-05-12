# Last Buyer Wins — Deploy Guide

## What it is
Every qualifying buy (≥ 0.1 SOL) resets a 10-minute countdown and makes
that wallet the current leader. When the timer hits zero, the leader wins
the entire accumulated pot. SOL is sent on-chain instantly.

---

## 1. Firebase Setup

1. Create a **new** Firebase project (separate from $SOS)
2. Enable **Firestore Database** → Production mode
3. Go to **Firestore → Rules** → paste contents of `FIRESTORE_RULES.txt` → Publish
4. No indexes needed — simple queries only
5. Go to **Project Settings → General** → copy the firebaseConfig values
6. Paste them into `src/firebase.js`

---

## 2. Frontend → Vercel

Update these constants in `src/pages/Home.jsx`:
```js
const TOKEN_CA  = "your_token_ca";
const X_URL     = "https://x.com/your_handle";
const SITE_URL  = "https://lastbuyerwins.xyz";
```

Drop `logo.png` into the `public/` folder.

```bash
npm install
npm run dev     # test locally
npm run build   # build for deploy
```

Push to GitHub → connect to Vercel → deploy.
No environment variables needed on Vercel for this project.

---

## 3. Engine → Railway

1. Push repo to GitHub
2. Railway → New Project → from GitHub
3. **Variables** tab — add everything from `engine.env`
4. **Settings** → Start Command → `node engine.js`
5. Deploy → watch Logs

### Railway Variables

| Name | Value |
|---|---|
| `CREATOR_WALLET` | your creator wallet address |
| `TOKEN_CA` | your token contract address |
| `SOLANA_RPC` | `https://api.mainnet-beta.solana.com` |
| `CREATOR_PRIVATE_KEY` | base58 private key from Phantom |
| `SOLANATRACKER_API_KEY` | your SolanaTracker API key |
| `MIN_BUY_SOL` | `0.1` |
| `GAS_RESERVE_SOL` | `0.003` |
| `TIMER_MS` | `600000` (10 min) |
| `POLL_MS` | `30000` (30 sec) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | stringified service account JSON |

To stringify the service account JSON:
```bash
node -e "console.log(JSON.stringify(require('./serviceAccount.json')))"
```

---

## 4. How the engine works

```
Boot → startNewRound() → resetTimer() → pollTrades() loop

Every 30s:
  - Check creator wallet balance → update Firestore
  - Fetch recent token buys from SolanaTracker
  - If buy >= 0.1 SOL found:
      - Update lastBuyer in Firestore
      - Reset 10-minute countdown
  - If timer hits zero:
      - Send SOL to lastBuyer wallet
      - Log to lbw_history collection
      - Start new round
```

---

## 5. Firestore Collections

### `lbw_stats/global`
```json
{
  "currentPotSOL": 0.423,
  "totalPaid":     12.45,
  "totalRounds":   28,
  "biggestWin":    0.89,
  "lastBuyer":     "wallet_address",
  "lastBuyAt":     "Timestamp",
  "lastBuySOL":    0.15,
  "nextWinAt":     "Timestamp",
  "lastWinner":    "wallet_address",
  "lastWinAmount": 0.45
}
```

### `lbw_history/{id}`
```json
{
  "winner":    "wallet_address",
  "amount":    0.45,
  "txSig":     "solana_tx_signature",
  "round":     28,
  "timestamp": "Timestamp"
}
```

---

## 6. Adjusting the game

All in Railway Variables — no code changes needed:

- Make timer shorter for testing: `TIMER_MS=120000` (2 min)
- Raise minimum buy: `MIN_BUY_SOL=0.5`
- Poll more frequently: `POLL_MS=15000` (15 sec, watch rate limits)

---

The clock resets. The pot grows. One wallet wins.
