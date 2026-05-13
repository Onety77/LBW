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

// If token has already graduated, set RAYDIUM_POOL in Railway env
// Engine will use it directly without needing to detect graduation
const RAYDIUM_POOL    = process.env.RAYDIUM_POOL || null;

const PUMP_PROGRAM_ID    = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM_ID= new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

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

let lastBuyerWallet  = null;
let winTimer         = null;
let isPayingOut      = false;
let processedSigs    = new Set();
let currentWatchAddr = null; // the account we are currently subscribed to
let wsSubId          = null; // subscription id so we can unsub if needed

// ── DERIVE PDAs ───────────────────────────────────────────────────────────────
function deriveBondingCurve(mintPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

// ── CHECK IF TOKEN HAS GRADUATED ─────────────────────────────────────────────
// Bonding curve account has a "complete" flag set to true after graduation
async function isGraduated(bondingCurve) {
  try {
    const info = await connection.getAccountInfo(bondingCurve);
    if (!info || !info.data) return false;
    // pump.fun bonding curve: byte at offset 0x08 is the "complete" bool
    // If account doesn't exist or has minimal data — graduated
    if (info.data.length < 10) return true;
    return info.data[8] === 1;
  } catch {
    return false;
  }
}

// ── SOLANA HELPERS ────────────────────────────────────────────────────────────
async function withRetry(fn, retries, label) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries) throw e;
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

// ── TIMER ────────────────────────────────────────────────────────────────────
function resetTimer() {
  if (winTimer) clearTimeout(winTimer);
  const nextWinAt = Date.now() + TIMER_MS;
  updateGlobal({ nextWinAt: Timestamp.fromMillis(nextWinAt) });
  winTimer = setTimeout(triggerPayout, TIMER_MS);
  log("  Timer reset — winner at " + new Date(nextWinAt).toISOString());
}

// ── UPDATE LEADER ─────────────────────────────────────────────────────────────
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
    log("  lbw_buys error: " + e.message);
  }

  await updateGlobal({ lastBuyer: wallet, lastBuyAt: Timestamp.now(), lastBuySOL: solAmount });
  resetTimer();
}

// ── PAYOUT ────────────────────────────────────────────────────────────────────
async function triggerPayout() {
  if (isPayingOut) return;
  if (!lastBuyerWallet) { log("No leader — resetting."); resetTimer(); return; }

  isPayingOut = true;
  const winner = lastBuyerWallet;
  log("\n=== PAYOUT — Winner: " + winner + " ===");

  try {
    const balLam  = await getBalanceLamports();
    const gasLam  = Math.ceil(GAS_RESERVE_SOL * LAMPORTS_PER_SOL);
    let sendLam   = balLam - gasLam;

    if (sendLam <= 0) {
      log("Pot empty — waiting 30s for fees...");
      await sleep(30000);
      const bal2 = await getBalanceLamports();
      sendLam = bal2 - gasLam;
      if (sendLam <= 0) {
        log("Still empty — new round.");
        await startNewRound();
        isPayingOut = false;
        return;
      }
    }

    const sendSOLAmt = sendLam / LAMPORTS_PER_SOL;
    log("Sending ◎" + sendSOLAmt.toFixed(6) + " to " + winner);
    const txSig = await sendSOL(winner, sendLam);
    log("TX: " + txSig);

    await db.collection("lbw_history").add({
      winner, amount: sendSOLAmt, txSig, timestamp: Timestamp.now(),
    });

    const statsUp = {
      totalPaid: FieldValue.increment(sendSOLAmt),
      totalRounds: FieldValue.increment(1),
      lastWinner: winner, lastWinAt: Timestamp.now(),
      lastWinAmount: sendSOLAmt, currentPotSOL: 0,
    };
    const gs = await db.doc("lbw_stats/global").get();
    if (gs.exists && sendSOLAmt > (gs.data().biggestWin || 0)) statsUp.biggestWin = sendSOLAmt;
    await db.doc("lbw_stats/global").set(statsUp, { merge:true });

    log("=== Payout ◎" + sendSOLAmt.toFixed(6) + " complete ===");
    await startNewRound();

  } catch (e) {
    log("Payout error: " + e.message);
    await sleep(10000);
    await startNewRound();
  }

  isPayingOut = false;
}

// ── NEW ROUND ─────────────────────────────────────────────────────────────────
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
      lastBuyer: null, lastBuyAt: null, lastBuySOL: null,
    });
  } catch {}

  resetTimer();
}

// ── PROCESS TX ────────────────────────────────────────────────────────────────
async function processTx(sig, watchedAddrStr) {
  if (processedSigs.has(sig)) return;
  processedSigs.add(sig);
  if (processedSigs.size > 1000) {
    const arr = Array.from(processedSigs);
    processedSigs = new Set(arr.slice(arr.length - 500));
  }

  try {
    const tx = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx || !tx.meta) return;

    const accounts     = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys || [];
    const preBalances  = tx.meta.preBalances  || [];
    const postBalances = tx.meta.postBalances || [];

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

    if (buyer === watchedAddrStr) return;
    if (buyer === PUMP_PROGRAM_ID.toString()) return;
    if (buyer === PUMPSWAP_PROGRAM_ID.toString()) return;
    if (buyer === CREATOR_WALLET) return;

    log("  [tx] " + sig.slice(0,16) + "... " + buyer.slice(0,8) + "... ◎" + solSpent.toFixed(4));

    if (solSpent >= MIN_BUY_SOL && !isPayingOut) {
      await updateLeader(buyer, solSpent, sig);
    }

  } catch {}
}

// ── SUBSCRIBE TO AN ADDRESS ───────────────────────────────────────────────────
function subscribeToAddress(address) {
  const str = address.toString();
  if (currentWatchAddr === str) return; // already watching this
  currentWatchAddr = str;

  log("Subscribing to: " + str);

  connection.onLogs(
    address,
    async ({ signature, err }) => {
      if (err) return;
      log("  [ws] " + signature.slice(0,16) + "...");
      await processTx(signature, str);
    },
    "confirmed"
  );

  log("WebSocket active on: " + str);
}

// ── GRADUATION WATCHER ────────────────────────────────────────────────────────
// Checks every 2 minutes if the bonding curve has graduated
// When it does, switches WebSocket to the PumpSwap pool
async function graduationWatcher(bondingCurve) {
  // If RAYDIUM_POOL is already set — token already graduated, skip watching
  if (RAYDIUM_POOL) return;

  log("Graduation watcher started — checks every 2min");

  while (true) {
    await sleep(2 * 60 * 1000);
    try {
      const graduated = await isGraduated(bondingCurve);
      if (graduated) {
        log("🎓 TOKEN GRADUATED! Switching to PumpSwap pool...");
        log("Add RAYDIUM_POOL to Railway env with the pool address from Raydium/Solscan");
        log("Then redeploy to complete the switch.");
        // Engine keeps running on bonding curve until pool address is provided
        break;
      }
    } catch {}
  }
}

// ── BALANCE LOOP ──────────────────────────────────────────────────────────────
async function balanceUpdateLoop() {
  while (true) {
    try {
      const balLam = await getBalanceLamports();
      await updateGlobal({ currentPotSOL: balLam / LAMPORTS_PER_SOL });
    } catch {}
    await sleep(15000);
  }
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
console.log("\n  LAST BUYER WINS — Engine");
console.log("  Wallet : " + CREATOR_WALLET);
console.log("  Token  : " + TOKEN_CA);
log("Gas Reserve : ◎" + GAS_RESERVE_SOL);
log("Min Buy     : ◎" + MIN_BUY_SOL + " SOL");
log("Timer       : " + (TIMER_MS/60000) + " min");
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

// Decide what to watch
if (RAYDIUM_POOL) {
  // Token already graduated — watch the PumpSwap pool directly
  log("Token graduated — watching PumpSwap pool: " + RAYDIUM_POOL);
  subscribeToAddress(new PublicKey(RAYDIUM_POOL));
} else {
  // Token still on bonding curve
  log("Watching bonding curve: " + bondingCurve.toBase58());
  subscribeToAddress(bondingCurve);
  graduationWatcher(bondingCurve);
}

startAutoClaimFees(connection, creatorKP, log);
startNewRound();
balanceUpdateLoop();