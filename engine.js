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
const POLL_MS         = parseInt(process.env.POLL_MS           || "10000");

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

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
let winTimer        = null;
let lastSig         = null; // last processed signature
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

// ── DERIVE BONDING CURVE ──────────────────────────────────────────────────────
// pump.fun bonding curve PDA: seeds = ["bonding-curve", mint_pubkey]
function deriveBondingCurve(mintPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

// ── DETECT BUYS VIA SOLANA RPC ────────────────────────────────────────────────
// Gets recent transactions on the bonding curve and finds buy instructions
async function detectRecentBuys(bondingCurve) {
  try {
    // Get last 10 signatures for the bonding curve account
    const sigs = await connection.getSignaturesForAddress(bondingCurve, { limit: 3 });
    if (!sigs || sigs.length === 0) return [];

    const newSigs = [];
    for (const s of sigs) {
      if (s.signature === lastSig) break;
      newSigs.push(s.signature);
    }

    if (newSigs.length === 0) return [];

    log("  [rpc] " + newSigs.length + " new tx(s) on bonding curve");

    const buys = [];

    for (const sig of newSigs) {
      try {
        const tx = await connection.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });

        if (!tx || !tx.meta) continue;

        const accounts  = tx.transaction.message.accountKeys;
        const preBalances  = tx.meta.preBalances;
        const postBalances = tx.meta.postBalances;

        // Check if this involves the pump.fun program
        const involvesPump = accounts.some(a =>
          (a.pubkey || a).toString() === PUMP_PROGRAM_ID.toString()
        );
        if (!involvesPump) continue;

        // Find the buyer — the account whose SOL balance decreased the most
        // (excluding the bonding curve itself and program accounts)
        let maxDecrease = 0;
        let buyerIndex  = -1;

        for (let i = 0; i < preBalances.length; i++) {
          const decrease = preBalances[i] - postBalances[i];
          if (decrease > maxDecrease) {
            maxDecrease = decrease;
            buyerIndex  = i;
          }
        }

        if (buyerIndex === -1 || maxDecrease <= 0) continue;

        const solSpent = maxDecrease / LAMPORTS_PER_SOL;
        const buyer    = (accounts[buyerIndex].pubkey || accounts[buyerIndex]).toString();

        // Skip if buyer is the bonding curve or program itself
        if (buyer === bondingCurve.toString() || buyer === PUMP_PROGRAM_ID.toString()) continue;
        if (buyer === CREATOR_WALLET) continue;

        log("  [rpc] tx: " + sig.slice(0,20) + "... buyer: " + buyer.slice(0,8) + "... ◎" + solSpent.toFixed(4));

        buys.push({ sig, buyer, solSpent });

      } catch (e) {
        // Skip failed tx parse
      }
    }

    // Update lastSig to most recent processed
    if (newSigs.length > 0) lastSig = newSigs[0];

    return buys;

  } catch (e) {
    log("  [rpc] Error: " + e.message);
    return [];
  }
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
async function updateLeader(wallet, solAmount) {
  log("  ★ NEW LEADER: " + wallet + " | ◎" + solAmount.toFixed(4));
  lastBuyerWallet = wallet;
  await updateGlobal({
    lastBuyer:  wallet,
    lastBuyAt:  Timestamp.now(),
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
  lastSig         = null;

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
  const mintPubkey   = new PublicKey(TOKEN_CA);
  const bondingCurve = deriveBondingCurve(mintPubkey);
  log("Bonding curve: " + bondingCurve.toBase58());

  while (true) {
    try {
      // Update pot balance
      const balLam = await getBalanceLamports();
      await updateGlobal({ currentPotSOL: balLam / LAMPORTS_PER_SOL });

      // Detect buys directly from Solana RPC
      if (!isPayingOut) {
        const buys = await detectRecentBuys(bondingCurve);

        for (const { sig, buyer, solSpent } of buys) {
          if (solSpent >= MIN_BUY_SOL) {
            await updateLeader(buyer, solSpent);
            break; // one leader update per poll
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