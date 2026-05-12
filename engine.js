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
const GAS_RESERVE_SOL = parseFloat(process.env.GAS_RESERVE_SOL || "0.005");
const MIN_BUY_SOL     = parseFloat(process.env.MIN_BUY_SOL     || "0.1");
const TIMER_MS        = parseInt(process.env.TIMER_MS          || "60000");
const POLL_MS         = parseInt(process.env.POLL_MS           || "10000");

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

// ── HELPERS ──────────────────────────────────────────────────────────────────
const log   = (m) => console.log("[" + new Date().toISOString() + "] " + m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let lastBuyerWallet = null;
let lastBuyTime     = null;
let winTimer        = null;
let lastTradeSig    = null;
let isPayingOut     = false;

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
    SystemProgram.transfer({ fromPubkey: creatorKP.publicKey, toPubkey: new PublicKey(to), lamports })
  );
  return withRetry(
    () => sendAndConfirmTransaction(connection, tx, [creatorKP], { commitment: "confirmed" }),
    2, "sendSOL"
  );
}

async function updateGlobal(fields) {
  try { await db.doc("lbw_stats/global").set(fields, { merge: true }); }
  catch (e) { log("  updateGlobal error: " + e.message); }
}

// ── FETCH RECENT TRADES ───────────────────────────────────────────────────────
async function fetchRecentBuys() {
  try {
    await sleep(1000);
    const res = await fetch(
      "https://data.solanatracker.io/tokens/" + TOKEN_CA + "/trades?limit=10",
      { headers: { "x-api-key": ST_API_KEY } }
    );

    if (!res.ok) {
      log("  [trades] HTTP " + res.status);
      return [];
    }

    const raw = await res.json();

    // Log raw response once so we can see the structure
    if (!fetchRecentBuys._logged) {
      fetchRecentBuys._logged = true;
      log("  [trades] RAW SAMPLE: " + JSON.stringify(raw).slice(0, 500));
    }

    // Normalise — handle all possible response shapes
    let list = [];
    if (Array.isArray(raw))           list = raw;
    else if (Array.isArray(raw.trades)) list = raw.trades;
    else if (Array.isArray(raw.items))  list = raw.items;
    else if (Array.isArray(raw.data))   list = raw.data;

    if (list.length === 0) return [];

    // Filter buys only
    return list.filter(t => {
      const type = (t.type || t.side || t.action || "").toLowerCase();
      return type === "buy" || type === "bought";
    });

  } catch (e) {
    log("  [trades] Error: " + e.message);
    return [];
  }
}
fetchRecentBuys._logged = false;

// ── EXTRACT SOL AMOUNT FROM TRADE ────────────────────────────────────────────
function extractSOLAmount(trade) {
  // Try every known field name SolanaTracker uses
  if (trade.volume?.sol)       return trade.volume.sol;
  if (trade.volumeSol)         return trade.volumeSol;
  if (trade.sol)               return trade.sol;
  if (trade.solAmount)         return trade.solAmount;
  if (trade.amountSol)         return trade.amountSol;
  if (trade.nativeAmount)      return trade.nativeAmount / LAMPORTS_PER_SOL;
  if (trade.priceNative)       return trade.priceNative;

  // amount field — check if it's SOL side
  if (trade.amount && trade.tokenIn) {
    const tin = (trade.tokenIn || "").toLowerCase();
    if (tin.includes("sol") || tin === "so11111111111111111111111111111111111111112")
      return trade.amount;
  }

  // USD fallback — rough conversion
  const usd = trade.volume?.usd || trade.volumeUsd || trade.usdAmount || 0;
  if (usd > 0) return usd / 150; // rough SOL price estimate

  return 0;
}

// ── EXTRACT WALLET FROM TRADE ────────────────────────────────────────────────
function extractWallet(trade) {
  return trade.wallet
      || trade.buyer
      || trade.maker
      || trade.user
      || trade.signer
      || trade.owner
      || null;
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
    lastBuyer:  wallet,
    lastBuyAt:  Timestamp.fromMillis(lastBuyTime),
    lastBuySOL: solAmount,
  });

  resetTimer();
}

// ── PAYOUT ────────────────────────────────────────────────────────────────────
async function triggerPayout() {
  if (isPayingOut) return;
  if (!lastBuyerWallet) {
    log("No leader yet — resetting timer.");
    resetTimer();
    return;
  }

  isPayingOut = true;
  const winner = lastBuyerWallet;
  log("\n=== PAYOUT — Winner: " + winner + " ===");

  try {
    const balLam     = await getBalanceLamports();
    const gasLam     = Math.ceil(GAS_RESERVE_SOL * LAMPORTS_PER_SOL);
    const sendLam    = balLam - gasLam;
    const sendSOLAmt = sendLam / LAMPORTS_PER_SOL;

    log("Sending ◎" + sendSOLAmt.toFixed(6) + " to " + winner);

    if (sendLam <= 0) {
      log("Pot empty — starting new round.");
      await startNewRound();
      isPayingOut = false;
      return;
    }

    const txSig = await sendSOL(winner, sendLam);
    log("TX: " + txSig);

    await db.collection("lbw_history").add({
      winner:    winner,
      amount:    sendSOLAmt,
      txSig:     txSig,
      timestamp: Timestamp.now(),
    });

    const statsUp = {
      totalPaid:    FieldValue.increment(sendSOLAmt),
      totalRounds:  FieldValue.increment(1),
      lastWinner:   winner,
      lastWinAt:    Timestamp.now(),
      lastWinAmount:sendSOLAmt,
      currentPotSOL:0,
    };
    const gs = await db.doc("lbw_stats/global").get();
    if (gs.exists && sendSOLAmt > (gs.data().biggestWin || 0)) {
      statsUp.biggestWin = sendSOLAmt;
    }
    await db.doc("lbw_stats/global").set(statsUp, { merge: true });

    log("=== Payout complete ===");
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
  lastTradeSig    = null;
  fetchRecentBuys._logged = false; // reset so we log next raw response

  try {
    const balLam = await getBalanceLamports();
    await updateGlobal({
      currentPotSOL: balLam / LAMPORTS_PER_SOL,
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
      await updateGlobal({ currentPotSOL: balLam / LAMPORTS_PER_SOL });

      // Fetch recent buys
      const buys = await fetchRecentBuys();

      if (buys.length > 0) {
        for (const trade of buys) {
          const sig    = trade.signature || trade.txHash || trade.tx || trade.txId || null;
          const wallet = extractWallet(trade);

          // Skip already processed
          if (sig && sig === lastTradeSig) break;

          const solAmount = extractSOLAmount(trade);

          log("  [poll] buy: " + (wallet||"?") + " ◎" + solAmount.toFixed(4) + " sig: " + (sig||"none").slice(0,20));

          if (solAmount >= MIN_BUY_SOL && wallet && !isPayingOut) {
            await updateLeader(wallet, solAmount, sig);
            break;
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

// Init global doc
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
    log("Global stats initialized.");
  }
}).catch(e => log("Init error: " + e.message));

startAutoClaimFees(connection, creatorKP, log);
startNewRound();
pollTrades();
