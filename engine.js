require("dotenv").config();
const { startAutoClaimFees } = require("./claimFees");

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
const SOLANA_RPC      = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const GAS_RESERVE_SOL = parseFloat(process.env.GAS_RESERVE_SOL || "0.005");
const MIN_BUY_SOL     = parseFloat(process.env.MIN_BUY_SOL     || "0.1");
const TIMER_MS        = parseInt(process.env.TIMER_MS          || "60000");

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// ── STARTUP CHECKS ──────────────────────────────────────────────────────────
const missing = ["CREATOR_PRIVATE_KEY","FIREBASE_SERVICE_ACCOUNT_JSON","CREATOR_WALLET","TOKEN_CA"]
  .filter(k => !process.env[k]);
if (missing.length) { console.error("Missing env:", missing.join(", ")); process.exit(1); }

// ── SOLANA ──────────────────────────────────────────────────────────────────
const WS_RPC     = SOLANA_RPC.replace("https://","wss://").replace("http://","ws://");
const connection = new Connection(SOLANA_RPC, { commitment:"confirmed", wsEndpoint:WS_RPC });
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
let winTimer        = null;
let isPayingOut     = false;
let processedSigs   = new Set();

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
    () => sendAndConfirmTransaction(connection, tx, [creatorKP], { commitment:"confirmed" }),
    2, "sendSOL"
  );
}

async function updateGlobal(fields) {
  try { await db.doc("lbw_stats/global").set(fields, { merge:true }); }
  catch (e) { log("  updateGlobal error: " + e.message); }
}

function deriveBondingCurve(mintPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function resetTimer() {
  if (winTimer) clearTimeout(winTimer);
  const nextWinAt = Date.now() + TIMER_MS;
  updateGlobal({ nextWinAt: Timestamp.fromMillis(nextWinAt) });
  winTimer = setTimeout(triggerPayout, TIMER_MS);
  log("  Timer reset — winner at " + new Date(nextWinAt).toISOString());
}

async function updateLeader(wallet, solAmount, sig) {
  log("  ★ NEW LEADER: " + wallet + " | ◎" + solAmount.toFixed(4));
  lastBuyerWallet = wallet;

  try {
    await db.collection("lbw_buys").add({
      wallet:    wallet,
      amount:    solAmount,
      sig:       sig || null,
      timestamp: Timestamp.now(),
      isLeader:  true,
    });

    const prev = await db.collection("lbw_buys").where("isLeader","==",true).get();
    const batch = db.batch();
    prev.docs.forEach(d => {
      if (d.data().wallet !== wallet) batch.update(d.ref, { isLeader: false });
    });
    await batch.commit();
  } catch (e) {
    log("  lbw_buys write error: " + e.message);
  }

  await updateGlobal({
    lastBuyer:  wallet,
    lastBuyAt:  Timestamp.now(),
    lastBuySOL: solAmount,
  });

  resetTimer();
}

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

    if (sendLam <= 0) {
      log("Pot empty — new round.");
      await startNewRound();
      isPayingOut = false;
      return;
    }

    log("Sending ◎" + sendSOLAmt.toFixed(6) + " to " + winner);
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
    await db.doc("lbw_stats/global").set(statsUp, { merge:true });

    log("=== Payout complete ===");
    await startNewRound();

  } catch (e) {
    log("Payout error: " + e.message);
    await sleep(10000);
    await startNewRound();
  }

  isPayingOut = false;
}

async function startNewRound() {
  log("Starting new round...");
  lastBuyerWallet = null;
  processedSigs.clear();

  try {
    const snap = await db.collection("lbw_buys").get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } catch {}

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

async function processTxLog(sig, bondingCurveStr) {
  if (processedSigs.has(sig)) return;
  processedSigs.add(sig);
  if (processedSigs.size > 500) {
    const arr = Array.from(processedSigs);
    processedSigs = new Set(arr.slice(arr.length - 200));
  }

  try {
    await sleep(2000);

    const tx = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx || !tx.meta) return;

    const accounts     = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys || [];
    const preBalances  = tx.meta.preBalances  || [];
    const postBalances = tx.meta.postBalances || [];

    // Find the account whose SOL decreased most — that's the buyer
    let maxDecrease = 0;
    let buyerIndex  = -1;

    for (let i = 0; i < preBalances.length; i++) {
      const decrease = preBalances[i] - postBalances[i];
      if (decrease > maxDecrease && decrease > 5000) {
        maxDecrease = decrease;
        buyerIndex  = i;
      }
    }

    if (buyerIndex === -1) return;

    const solSpent = maxDecrease / LAMPORTS_PER_SOL;
    const buyer    = accounts[buyerIndex].toString();

    // Skip system accounts
    if (buyer === bondingCurveStr) return;
    if (buyer === PUMP_PROGRAM_ID.toString()) return;
    if (buyer === CREATOR_WALLET) return;

    log("  [tx] " + sig.slice(0,20) + "... buyer: " + buyer.slice(0,8) + "... ◎" + solSpent.toFixed(4));

    if (solSpent >= MIN_BUY_SOL && !isPayingOut) {
      await updateLeader(buyer, solSpent, sig);
    }

  } catch (e) {
    // silent — tx fetch failures are normal
  }
}

function subscribeToBondingCurve(bondingCurve) {
  const bondingCurveStr = bondingCurve.toString();
  log("Subscribing to bonding curve: " + bondingCurveStr);

  connection.onLogs(
    bondingCurve,
    async ({ signature, err, logs }) => {
      if (err) return;

      // Accept ALL transactions on the bonding curve
      // processTxLog handles filtering — only buyers (SOL decreasing) qualify
      log("  [ws] Transaction detected: " + signature.slice(0,20) + "...");
      await processTxLog(signature, bondingCurveStr);
    },
    "confirmed"
  );

  log("WebSocket active — watching for buys...");
}

async function balanceUpdateLoop() {
  while (true) {
    try {
      const balLam = await getBalanceLamports();
      await updateGlobal({ currentPotSOL: balLam / LAMPORTS_PER_SOL });
    } catch {}
    await sleep(30000);
  }
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
console.log("\n  LAST BUYER WINS — Engine");
console.log("  Wallet     : " + CREATOR_WALLET);
console.log("  Token      : " + TOKEN_CA);
log("Gas Reserve: ◎" + GAS_RESERVE_SOL);
log("Min Buy    : ◎" + MIN_BUY_SOL + " SOL");
log("Timer      : " + (TIMER_MS/60000) + " min");
log("Detection  : WebSocket real-time");
log("────────────────────────────────────────────");

db.doc("lbw_stats/global").get().then(snap => {
  if (!snap.exists) {
    db.doc("lbw_stats/global").set({
      currentPotSOL: 0, totalPaid: 0, totalRounds: 0,
      biggestWin: 0, lastBuyer: null, lastBuyAt: null,
      nextWinAt: Timestamp.fromMillis(Date.now() + TIMER_MS),
    });
    log("Global stats initialized.");
  }
}).catch(e => log("Init error: " + e.message));

const mintPubkey   = new PublicKey(TOKEN_CA);
const bondingCurve = deriveBondingCurve(mintPubkey);

startAutoClaimFees(connection, creatorKP, log);
startNewRound();
subscribeToBondingCurve(bondingCurve);
balanceUpdateLoop();