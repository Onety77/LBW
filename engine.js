/**
 * Last Buyer Wins — Engine
 * ─────────────────────────────────────────────────────────────────────────
 * How it works:
 *   1. Polls SolanaTracker every 30s for recent token buys
 *   2. If a buy >= MIN_BUY_SOL is found, that wallet becomes leader
 *      and the timer resets to TIMER_MS (10 minutes)
 *   3. When TIMER_MS passes with no new qualifying buy — payout fires
 *   4. Winner receives the entire creator wallet balance minus gas
 *   5. New round begins immediately
 */

require("dotenv").config();
const { startAutoClaimFees } = require("./claimFees");

const fetch = require("node-fetch");

const {
  Connection, PublicKey, Transaction,
  SystemProgram, Keypair, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const bs58 = require("bs58");
const { initializeApp, cert }    = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

// ── CONFIG ──────────────────────────────────────────────────────────────────
const CREATOR_WALLET  = process.env.CREATOR_WALLET;
const TOKEN_CA        = process.env.TOKEN_CA;
const ST_API_KEY      = process.env.SOLANATRACKER_API_KEY;
const SOLANA_RPC      = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const GAS_RESERVE_SOL = parseFloat(process.env.GAS_RESERVE_SOL || "0.003");
const MIN_BUY_SOL     = parseFloat(process.env.MIN_BUY_SOL     || "0.1");
const TIMER_MS        = parseInt(process.env.TIMER_MS          || String(10 * 60 * 1000));
const POLL_MS         = parseInt(process.env.POLL_MS           || "30000");

// ── STARTUP CHECKS ──────────────────────────────────────────────────────────
const missing = ["CREATOR_PRIVATE_KEY","FIREBASE_SERVICE_ACCOUNT_JSON","CREATOR_WALLET","TOKEN_CA"]
  .filter(k => !process.env[k]);
if (missing.length) { console.error("Missing env:", missing.join(", ")); process.exit(1); }

// ── SOLANA ──────────────────────────────────────────────────────────────────
const connection = new Connection(SOLANA_RPC, "confirmed");
const creatorKP  = Keypair.fromSecretKey(bs58.decode(process.env.CREATOR_PRIVATE_KEY));

if (creatorKP.publicKey.toBase58() !== CREATOR_WALLET) {
  console.error("Key mismatch! Expected:", CREATOR_WALLET);
  process.exit(1);
}

// ── FIREBASE ────────────────────────────────────────────────────────────────
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
const db = getFirestore();

// ── STATE ────────────────────────────────────────────────────────────────────
const log   = (m) => console.log("[" + new Date().toISOString() + "] " + m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let roundCounter   = 0;
let lastBuyerWallet= null;  // current leader wallet
let lastBuyTime    = null;  // when the last qualifying buy happened (ms)
let winTimer       = null;  // setTimeout for the payout
let lastTradeSig   = null;  // last trade signature we processed (avoid duplicates)
let isPayingOut    = false; // prevent double payout

// ── HELPERS ──────────────────────────────────────────────────────────────────
async function withRetry(fn, retries, label) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
      log("  Retry " + (i+1) + " for " + label + ": " + e.message);
      await sleep(2000 * (i+1));
    }
  }
}

async function getBalanceLamports() {
  return withRetry(() => connection.getBalance(new PublicKey(CREATOR_WALLET)), 3, "getBalance");
}

async function sendSOL(to, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: creatorKP.publicKey,
      toPubkey:   new PublicKey(to),
      lamports,
    })
  );
  return withRetry(
    () => sendAndConfirmTransaction(connection, tx, [creatorKP], { commitment: "confirmed" }),
    2, "sendSOL"
  );
}

async function updateGlobal(fields) {
  try {
    await db.doc("lbw_stats/global").set(fields, { merge: true });
  } catch (e) {
    log("  updateGlobal error: " + e.message);
  }
}

// ── FETCH RECENT TRADES ──────────────────────────────────────────────────────
async function fetchRecentBuys() {
  try {
    await sleep(1500); // rate limit buffer
    const res = await fetch(
      "https://data.solanatracker.io/tokens/" + TOKEN_CA + "/trades?limit=20",
      { headers: { "x-api-key": ST_API_KEY } }
    );
    const raw = await res.json();

    // Normalise — SolanaTracker may return array or object with items/trades
    const list = Array.isArray(raw) ? raw
               : raw.trades ?? raw.items ?? raw.data ?? [];

    if (!list || list.length === 0) return [];

    // Filter for buys only
    return list.filter(t => {
      const type = (t.type || t.side || "").toLowerCase();
      return type === "buy";
    });
  } catch (e) {
    log("  fetchRecentBuys error: " + e.message);
    return [];
  }
}

// ── GET TOKEN PRICE FOR USD → SOL CONVERSION ─────────────────────────────────
async function getSOLPrice() {
  try {
    const res  = await fetch("https://data.solanatracker.io/price?token=So11111111111111111111111111111111111111112", {
      headers: { "x-api-key": ST_API_KEY }
    });
    const data = await res.json();
    return data?.price ?? 0;
  } catch { return 0; }
}

// ── RESET TIMER ───────────────────────────────────────────────────────────────
function resetTimer() {
  if (winTimer) clearTimeout(winTimer);
  const nextWinAt = Date.now() + TIMER_MS;
  updateGlobal({ nextWinAt: Timestamp.fromMillis(nextWinAt) });
  winTimer = setTimeout(triggerPayout, TIMER_MS);
  log("  Timer reset — winner at " + new Date(nextWinAt).toISOString());
}

// ── UPDATE LEADER ─────────────────────────────────────────────────────────────
async function updateLeader(wallet, solAmount, sig) {
  log("  NEW LEADER: " + wallet + " | ◎" + solAmount.toFixed(4));
  lastBuyerWallet = wallet;
  lastBuyTime     = Date.now();
  lastTradeSig    = sig;

  await updateGlobal({
    lastBuyer:    wallet,
    lastBuyerName:null, // no username system in LBW
    lastBuyAt:    Timestamp.fromMillis(lastBuyTime),
    lastBuySOL:   solAmount,
  });

  resetTimer();
}

// ── PAYOUT ────────────────────────────────────────────────────────────────────
async function triggerPayout() {
  if (isPayingOut) { log("Payout already in progress, skipping."); return; }
  if (!lastBuyerWallet) {
    log("No leader yet — skipping payout, resetting timer.");
    resetTimer();
    return;
  }

  isPayingOut = true;
  const thisRound = ++roundCounter;
  const winner = lastBuyerWallet;
  log("\n=== ROUND " + thisRound + " — PAYOUT ===");
  log("Winner: " + winner);

  try {
    const balLam  = await getBalanceLamports();
    const balSOL  = balLam / LAMPORTS_PER_SOL;
    const gasLam  = Math.ceil(GAS_RESERVE_SOL * LAMPORTS_PER_SOL);
    const sendLam = balLam - gasLam;
    const sendSOLAmt = sendLam / LAMPORTS_PER_SOL;

    log("Balance: ◎" + balSOL.toFixed(6) + " | Sending: ◎" + sendSOLAmt.toFixed(6));

    if (sendLam <= 0) {
      log("Pot empty — no payout. Starting new round.");
      await startNewRound();
      return;
    }

    // Send SOL to winner
    const txSig = await sendSOL(winner, sendLam);
    log("TX: " + txSig);
    log("https://solscan.io/tx/" + txSig);

    // Log to Firestore
    await db.collection("lbw_history").add({
      winner:    winner,
      amount:    sendSOLAmt,
      txSig:     txSig,
      round:     thisRound,
      timestamp: Timestamp.now(),
    });

    // Update global stats
    const statsUp = {
      totalRounds:  FieldValue.increment(1),
      totalPaid:    FieldValue.increment(sendSOLAmt),
      lastWinner:   winner,
      lastWinAt:    Timestamp.now(),
      lastWinAmount:sendSOLAmt,
      currentPotSOL:0,
    };
    const gs = await db.doc("lbw_stats/global").get();
    if (gs.exists() && sendSOLAmt > (gs.data().biggestWin || 0)) {
      statsUp.biggestWin = sendSOLAmt;
    }
    await db.doc("lbw_stats/global").set(statsUp, { merge: true });

    log("=== Round " + thisRound + " complete — ◎" + sendSOLAmt.toFixed(4) + " paid ===");

    await startNewRound();

  } catch (e) {
    log("Payout error: " + e.message);
    await sleep(10000);
    await startNewRound();
  }

  isPayingOut = false;
}

// ── START NEW ROUND ───────────────────────────────────────────────────────────
async function startNewRound() {
  log("Starting new round...");
  lastBuyerWallet = null;
  lastBuyTime     = null;

  // Update balance in Firestore
  try {
    const balLam = await getBalanceLamports();
    const balSOL = balLam / LAMPORTS_PER_SOL;
    await updateGlobal({
      currentPotSOL: balSOL,
      lastBuyer:     null,
      lastBuyAt:     null,
      lastBuySOL:    null,
    });
  } catch {}

  resetTimer();
}

// ── POLL LOOP ─────────────────────────────────────────────────────────────────
async function pollTrades() {
  while (true) {
    try {
      // Update pot balance
      const balLam = await getBalanceLamports();
      const balSOL = balLam / LAMPORTS_PER_SOL;
      await updateGlobal({ currentPotSOL: balSOL });

      // Fetch recent buys
      const buys = await fetchRecentBuys();

      if (buys.length > 0) {
        // Find the most recent qualifying buy we haven't processed yet
        for (const trade of buys) {
          const sig    = trade.signature || trade.txHash || trade.tx || null;
          const wallet = trade.wallet || trade.buyer || trade.maker || trade.user || null;

          // Skip if already processed
          if (sig && sig === lastTradeSig) break;

          // Get SOL amount from the trade
          // SolanaTracker might give us volume in SOL or USD
          let solAmount = 0;

          if (trade.volume?.sol)  solAmount = trade.volume.sol;
          else if (trade.sol)     solAmount = trade.sol;
          else if (trade.amountIn && (trade.tokenIn || "").toLowerCase().includes("sol"))
            solAmount = trade.amountIn;
          else if (trade.nativeAmount) solAmount = trade.nativeAmount / LAMPORTS_PER_SOL;
          else if (trade.priceNative)  solAmount = trade.priceNative;
          else if (trade.volume?.usd) {
            // Convert USD to SOL estimate (rough)
            const solPrice = await getSOLPrice();
            if (solPrice > 0) solAmount = trade.volume.usd / solPrice;
          }

          log("  Trade detected: " + (wallet||"unknown") + " | ◎" + (solAmount||0).toFixed(4) + " | sig: " + (sig||"no-sig"));

          if (solAmount >= MIN_BUY_SOL && wallet && !isPayingOut) {
            await updateLeader(wallet, solAmount, sig);
            break; // process one new leader per poll cycle
          }
        }
      }

    } catch (e) {
      log("Poll error: " + e.message);
    }

    await sleep(POLL_MS);
  }
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
console.log("\n  LAST BUYER WINS — Engine");
console.log("  Wallet     : " + CREATOR_WALLET);
console.log("  Token      : " + TOKEN_CA);
log("Gas Reserve: ◎" + GAS_RESERVE_SOL);
log("Min Buy    : ◎" + MIN_BUY_SOL + " SOL");
log("Timer      : " + (TIMER_MS/60000) + " min");
log("Poll Every : " + (POLL_MS/1000) + "s");
log("────────────────────────────────────────────");

// Init global doc if doesn't exist
db.doc("lbw_stats/global").get().then(snap => {
  if (!snap.exists) {
    db.doc("lbw_stats/global").set({
      currentPotSOL: 0,
      totalPaid:     0,
      totalRounds:   0,
      biggestWin:    0,
      lastBuyer:     null,
      lastBuyAt:     null,
      nextWinAt:     Timestamp.fromMillis(Date.now() + TIMER_MS),
    });
    log("Global stats document created.");
  }
});

// Auto-claim pump.fun creator fees every 60s
startAutoClaimFees(connection, creatorKP, log);

// Start fresh round on boot
startNewRound();

// Start polling
pollTrades();
