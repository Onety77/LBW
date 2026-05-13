/**
 * claimFees.js — Auto-claim creator fees from pump.fun and PumpSwap
 * Handles both bonding curve and post-graduation automatically.
 */

const {
  PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const PUMP_PROGRAM_ID     = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

const PUMP_DISCRIMINATOR     = Buffer.from([20, 22, 86, 123, 198, 28, 219, 132]);
const PUMPSWAP_DISCRIMINATOR = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);

const CLAIM_INTERVAL_MS  = 30 * 1000;
const MIN_CLAIM_LAMPORTS = 100_000; // 0.0001 SOL — very low threshold to catch everything

// ── PDAs ─────────────────────────────────────────────────────────────────────
function derivePumpVault(creatorPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creatorPubkey.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function derivePumpEventAuthority() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function derivePumpSwapVaultAuthority(creatorPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), creatorPubkey.toBuffer()],
    PUMPSWAP_PROGRAM_ID
  );
  return pda;
}

function derivePumpSwapEventAuthority() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    PUMPSWAP_PROGRAM_ID
  );
  return pda;
}

// ── Phase 1: pump.fun bonding curve ──────────────────────────────────────────
async function claimPumpFees(connection, creatorKP, log) {
  const creatorPubkey     = creatorKP.publicKey;
  const vaultPDA          = derivePumpVault(creatorPubkey);
  const eventAuthorityPDA = derivePumpEventAuthority();

  let balance = 0;
  try { balance = await connection.getBalance(vaultPDA); } catch { return 0; }

  log("  [pump.fun] vault balance: " + (balance/LAMPORTS_PER_SOL).toFixed(6) + " SOL");

  if (balance <= MIN_CLAIM_LAMPORTS) return 0;

  log("  [pump.fun] Claiming " + (balance/LAMPORTS_PER_SOL).toFixed(6) + " SOL...");

  try {
    const ix = new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      data: PUMP_DISCRIMINATOR,
      keys: [
        { pubkey: creatorPubkey,           isSigner: true,  isWritable: true  },
        { pubkey: vaultPDA,                isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityPDA,       isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID,         isSigner: false, isWritable: false },
      ],
    });
    const tx  = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [creatorKP], { commitment: "confirmed" });
    log("  [pump.fun] Claimed " + (balance/LAMPORTS_PER_SOL).toFixed(6) + " SOL | TX: " + sig);
    return balance / LAMPORTS_PER_SOL;
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("AccountNotFound") || msg.includes("does not exist")) return 0;
    log("  [pump.fun] Error: " + msg.split("\n")[0]);
    return 0;
  }
}

// ── Phase 2: PumpSwap (post-graduation) ──────────────────────────────────────
async function claimPumpSwapFees(connection, creatorKP, log) {
  const creatorPubkey     = creatorKP.publicKey;
  const vaultAuthority    = derivePumpSwapVaultAuthority(creatorPubkey);
  const eventAuthorityPDA = derivePumpSwapEventAuthority();

  let balance = 0;
  try { balance = await connection.getBalance(vaultAuthority); } catch { return 0; }

  log("  [pumpswap] vault balance: " + (balance/LAMPORTS_PER_SOL).toFixed(6) + " SOL");

  // Rent for a PDA is ~890880 lamports — only claim if meaningfully above rent
  const RENT_EXEMPT = 890_880;
  if (balance <= RENT_EXEMPT + MIN_CLAIM_LAMPORTS) {
    log("  [pumpswap] balance at/near rent exempt — skipping");
    return 0;
  }

  const claimable = balance - RENT_EXEMPT;
  log("  [pumpswap] Claiming " + (claimable/LAMPORTS_PER_SOL).toFixed(6) + " SOL...");

  try {
    const ix = new TransactionInstruction({
      programId: PUMPSWAP_PROGRAM_ID,
      data: PUMPSWAP_DISCRIMINATOR,
      keys: [
        { pubkey: creatorPubkey,           isSigner: true,  isWritable: true  },
        { pubkey: vaultAuthority,          isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityPDA,       isSigner: false, isWritable: false },
        { pubkey: PUMPSWAP_PROGRAM_ID,     isSigner: false, isWritable: false },
      ],
    });
    const tx  = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [creatorKP], { commitment: "confirmed" });
    log("  [pumpswap] Claimed " + (claimable/LAMPORTS_PER_SOL).toFixed(6) + " SOL | TX: " + sig);
    return claimable / LAMPORTS_PER_SOL;
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("AccountNotFound") || msg.includes("does not exist")) return 0;
    log("  [pumpswap] Error: " + msg.split("\n")[0]);
    return 0;
  }
}

// ── Main claim ────────────────────────────────────────────────────────────────
async function claimAllFees(connection, creatorKP, log) {
  const pumpClaimed     = await claimPumpFees(connection, creatorKP, log);
  const pumpSwapClaimed = await claimPumpSwapFees(connection, creatorKP, log);
  const total = pumpClaimed + pumpSwapClaimed;
  if (total > 0) log("  [claim] Total: " + total.toFixed(6) + " SOL claimed");
  return total;
}

// ── Start loop ────────────────────────────────────────────────────────────────
function startAutoClaimFees(connection, creatorKP, log) {
  const pumpVault   = derivePumpVault(creatorKP.publicKey);
  const swapVault   = derivePumpSwapVaultAuthority(creatorKP.publicKey);
  log("[AutoClaim] pump.fun vault  : " + pumpVault.toBase58());
  log("[AutoClaim] PumpSwap vault  : " + swapVault.toBase58());
  log("[AutoClaim] Interval        : " + (CLAIM_INTERVAL_MS/1000) + "s");
  log("[AutoClaim] Min threshold   : " + (MIN_CLAIM_LAMPORTS/LAMPORTS_PER_SOL) + " SOL");

  claimAllFees(connection, creatorKP, log).catch(() => {});
  setInterval(() => {
    claimAllFees(connection, creatorKP, log).catch(() => {});
  }, CLAIM_INTERVAL_MS);
}

module.exports = { startAutoClaimFees, claimAllFees, claimPumpFees, claimPumpSwapFees };