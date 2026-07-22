/**
 * bonus-live.js — Couche d'EXÉCUTION RÉELLE du bot Bonus Stage (bot 2).
 * ⛔ VERROUILLÉE : ne fait RIEN tant que LIVE=1 n'est pas défini dans l'environnement.
 * À n'activer qu'après validation du paper-trading (~50 trades, WR ≥ 70%, PnL net > 0).
 *
 * SPEC CANONIQUE (docs EP du 2026-07-19, screenshot Meteora UI) — IMPLÉMENTÉE ci-dessous :
 *  - Bid-Ask, Bin Range Mode CUSTOM, Lower -34 / Higher +34 = 69 bins SYMÉTRIQUES autour du prix
 *  - DOUBLE-SIDED : ~moitié de la mise swappée en token (Jupiter) → côté haut (vend la montée),
 *    l'autre moitié en SOL → côté bas (achète le dip). Pools bin step 100 / base fee 2%+.
 *  - SL canonique = "sharp breakdown + hors range" (prix sous le bin -34), en plus du flip ST du paper.
 *
 * Transplante les patterns ÉPROUVÉS de bot.js (leçons payées cash de la semaine du 04/07) :
 *  - confirmTx : vérifie value.err — une TX peut être "confirmée" EN ERREUR on-chain
 *    (bug chunk ELON Custom 6027 → 0.44 SOL fantômes). JAMAIS de send sans ce check.
 *  - dépôt réel MESURÉ par delta de solde flat-to-flat, swap inclus (jamais le montant prévu).
 *  - close vérifié : re-check on-chain position vidée + retry, sinon on garde le tracking
 *    (bug world → perte fantôme -0.58 + liquidité orpheline). Re-swap token→SOL après close.
 *
 * CHECKLIST avant le premier run LIVE (pour la prochaine session Claude ou le user) :
 *  [ ] Wallet DÉDIÉ bot 2 (BONUS_WALLET_KEY) — jamais celui de bot 1
 *  [ ] POSITION_SIZE_SOL=0.25 pour le front-test (comme l'auteur de la strat)
 *  [ ] Vérifier StrategyType.BidAsk dans la version du SDK (@meteora-ag/dlmm) : console.log(DLMM.StrategyType)
 *  [ ] TP sur VALEUR DE POSITION via positionValueSol() (implémenté : X+Y+fees convertis en SOL)
 *  [ ] Dry-run : 1 seule position à 0.1 SOL d'abord, vérifier sur Meteora UI que la shape = Bid-Ask
 *      2-sided [-34,+34] identique au screenshot EP, et que closeVerified re-swappe bien le token
 */

require('dotenv').config();

if (process.env.LIVE !== '1') {
    console.log('⛔ bonus-live: LIVE≠1 — exécution réelle désactivée. Ce module est prêt mais verrouillé.');
    module.exports = { enabled: false };
    return;
}

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm').default;
const BN = require('bn.js');
let bs58 = require('bs58'); if (bs58.default) bs58 = bs58.default; // bs58 v6 : fns sous .default
const axios = require('axios');

// RPC_URL prioritaire ; fallback HELIUS_RPC_URL (nom de variable de bot 1, déjà présent sur le service).
// Sans RPC dédié → mainnet-beta public qui rate-limite (429) → getProgramAccounts/txns échouent.
const RPC_URL = process.env.RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');
// Chargement robuste de la clé (2026-07-22) : accepte base58 (Phantom, 64o), tableau JSON
// [n,n,...] (solana-keygen), ou seed 32o. Erreur claire avec la taille (sans exposer la clé).
function loadKeypair(raw) {
    const s = (raw || '').trim().replace(/^["']|["']$/g, '');
    if (!s) throw new Error('BONUS_WALLET_KEY vide');
    if (s.startsWith('[')) {
        const arr = Uint8Array.from(JSON.parse(s));
        if (arr.length === 64) return Keypair.fromSecretKey(arr);
        if (arr.length === 32) return Keypair.fromSeed(arr);
        throw new Error(`tableau JSON de ${arr.length} octets (attendu 64 ou 32)`);
    }
    const dec = bs58.decode(s);
    if (dec.length === 64) return Keypair.fromSecretKey(dec);
    if (dec.length === 32) return Keypair.fromSeed(dec);
    throw new Error(`clé base58 décodée = ${dec.length} octets (attendu 64 ou 32) — clé tronquée ou mauvaise valeur ?`);
}
// BONUS_WALLET_KEY prioritaire ; fallback WALLET_PRIVATE_KEY (le user réutilise le wallet de bot 1,
// bot 1 étant éteint → pas de conflit). ⚠️ Ne PAS rallumer bot 1 tant que le bonus tourne sur ce wallet.
const keypair = loadKeypair(process.env.BONUS_WALLET_KEY || process.env.WALLET_PRIVATE_KEY);
console.log(`  🔑 Wallet live: ${keypair.publicKey.toString()}`);

const POSITION_SIZE_SOL = parseFloat(process.env.POSITION_SIZE_SOL || '0.25');
const BIN_RANGE = 34;              // ±34 bins = 69 bins — spec canonique EP (screenshot Meteora UI 19/07)
const TX_RESERVE_SOL = 0.02;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Découverte de pool Meteora DLMM on-chain (méthode bot 1 : getProgramAccounts + memcmp) ──
const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const LBPAIR_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
const TOKEN_X_OFFSET = 88;
const TOKEN_Y_OFFSET = 120;
const OK_BIN_STEPS = [80, 100, 125, 160, 200, 250]; // canonique EP = 100 (préféré au tri)

// Trouve la meilleure pool DLMM token/SOL : bin step 100 d'abord, puis base fee la plus haute,
// puis réserve SOL la plus profonde. Retourne l'adresse (string) ou null.
async function findMeteoraPool(tokenAddress) {
    const programId = new PublicKey(DLMM_PROGRAM_ID);
    const disc = bs58.encode(LBPAIR_DISCRIMINATOR);
    const [p1, p2] = await Promise.all([
        connection.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: disc } }, { memcmp: { offset: TOKEN_X_OFFSET, bytes: tokenAddress } }, { memcmp: { offset: TOKEN_Y_OFFSET, bytes: SOL_MINT } }], dataSlice: { offset: 0, length: 0 } }),
        connection.getProgramAccounts(programId, { filters: [{ memcmp: { offset: 0, bytes: disc } }, { memcmp: { offset: TOKEN_X_OFFSET, bytes: SOL_MINT } }, { memcmp: { offset: TOKEN_Y_OFFSET, bytes: tokenAddress } }], dataSlice: { offset: 0, length: 0 } }),
    ]);
    const addrs = [...p1, ...p2].map(p => p.pubkey);
    console.log(`  ${addrs.length} pool(s) Meteora trouvée(s) pour ${tokenAddress.slice(0, 8)}`);
    const candidates = [];
    for (const addr of addrs) {
        try {
            const pool = await DLMM.create(connection, addr);
            if (pool.tokenY.publicKey.toString() !== SOL_MINT) continue; // openBidAsk exige SOL en Y
            const binStep = pool.lbPair.binStep;
            if (!OK_BIN_STEPS.includes(binStep)) continue;
            let baseFeePct = 0;
            try { baseFeePct = parseFloat((await pool.getFeeInfo()).baseFeeRatePercentage?.toString() ?? 0); } catch (_) {}
            // Canonique EP : pools 2-5% de base fee ("harvesting 2-5% fees on churn", MANLET = 2%).
            // < 2% = pas assez de fees pour l'edge → pool écartée.
            if (baseFeePct < 2) continue;
            let reserveSol = 0;
            try { reserveSol = parseFloat((await connection.getTokenAccountBalance(pool.lbPair.reserveY)).value.uiAmount || 0); } catch (_) {}
            if (reserveSol < 1) continue; // pool quasi vide → fills/SL irréalistes
            candidates.push({ addr: addr.toString(), binStep, baseFeePct, reserveSol });
        } catch (_) {}
    }
    if (!candidates.length) return null;
    // Priorité FEES d'abord (demande user, aligné bot 1 : "5% d'abord, descendre s'il n'y a rien") —
    // une pool 5% bat toujours une 2% ; bin step 100 (canonique) puis réserve en départage.
    candidates.sort((a, b) => b.baseFeePct - a.baseFeePct || (b.binStep === 100) - (a.binStep === 100) || b.reserveSol - a.reserveSol);
    const best = candidates[0];
    console.log(`  🏆 Pool: ${best.addr.slice(0, 8)}... | bin step ${best.binStep} | fee ${best.baseFeePct}% | réserve ${best.reserveSol.toFixed(1)} SOL`);
    return best.addr;
}

// ── Confirmation robuste (pattern bot.js post-ELON) ───────────
async function confirmTx(hash) {
    const res = await connection.confirmTransaction(hash, 'confirmed');
    if (res?.value?.err) throw new Error(`TX atterrie en erreur on-chain: ${JSON.stringify(res.value.err)}`);
}

async function solBalance() { return await connection.getBalance(keypair.publicKey); }

async function tokenBalanceRaw(mint) {
    const accs = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new PublicKey(mint) });
    let total = 0n;
    for (const a of accs.value) total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
    return total; // unités brutes
}

// ── Swap Jupiter v6 (générique in→out, montant en unités brutes) ──
async function jupSwap(inputMint, outputMint, rawAmount) {
    const quote = await axios.get('https://quote-api.jup.ag/v6/quote', {
        params: { inputMint, outputMint, amount: rawAmount.toString(), slippageBps: 300 }, timeout: 12000,
    });
    const swap = await axios.post('https://quote-api.jup.ag/v6/swap', {
        quoteResponse: quote.data, userPublicKey: keypair.publicKey.toString(), wrapAndUnwrapSol: true,
    }, { timeout: 12000 });
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
    tx.sign([keypair]);
    const h = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await confirmTx(h);
    return h;
}

// ── Ouverture : Bid-Ask DOUBLE-SIDED ±34 bins (spec canonique EP) ──
// Retourne { positionKeypairPub, poolAddress, depositedSol, lowerBinId, upperBinId, tokenMint } ou null.
async function openBidAsk(poolAddress) {
    const balBefore = await solBalance();
    const amountSol = Math.min(POSITION_SIZE_SOL, balBefore / LAMPORTS_PER_SOL - TX_RESERVE_SOL);
    if (amountSol < 0.05) { console.log('❌ solde insuffisant'); return null; }

    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
    const xMint = dlmmPool.tokenX.publicKey.toString();
    const yMint = dlmmPool.tokenY.publicKey.toString();
    if (yMint !== SOL_MINT) { console.log('❌ pool non SOL-quote (tokenY ≠ WSOL) — non géré'); return null; }
    const activeBin = await dlmmPool.getActiveBin();
    const minBinId = activeBin.binId - BIN_RANGE;
    const maxBinId = activeBin.binId + BIN_RANGE;

    // ~moitié de la mise en token → côté HAUT du Bid-Ask (base vendue pendant la montée)
    const halfLamports = Math.floor((amountSol / 2) * LAMPORTS_PER_SOL);
    console.log(`  🔁 Swap ${(halfLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL → token (côté haut)...`);
    await jupSwap(SOL_MINT, xMint, halfLamports);
    const tokenRaw = await tokenBalanceRaw(xMint);
    if (tokenRaw <= 0n) { console.log('❌ swap confirmé mais 0 token reçu — abandon'); return null; }

    const positionKeypair = Keypair.generate();
    const tx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: keypair.publicKey,
        totalXAmount: new BN(tokenRaw.toString()),   // token → bins hauts (ask)
        totalYAmount: new BN(halfLamports),          // SOL → bins bas (bid)
        strategy: { minBinId, maxBinId, strategyType: DLMM.StrategyType.BidAsk },
        slippage: 100,
    });
    for (const t of Array.isArray(tx) ? tx : [tx]) {
        const h = await connection.sendTransaction(t, [keypair, positionKeypair]);
        await confirmTx(h);
        console.log(`  ✅ TX ouverture: https://solscan.io/tx/${h}`);
    }
    // dépôt RÉEL mesuré flat-to-flat, swap inclus (pattern bot.js post-ELON)
    const balAfter = await solBalance();
    const depositedSol = (balBefore - balAfter) / LAMPORTS_PER_SOL;
    console.log(`  💰 Déposé réel: ${depositedSol.toFixed(4)} SOL | bins [${minBinId}→${maxBinId}] (±${BIN_RANGE}) Bid-Ask 2-sided`);
    return { positionKeypairPub: positionKeypair.publicKey.toString(), poolAddress, depositedSol, lowerBinId: minBinId, upperBinId: maxBinId, tokenMint: xMint };
}

// ── Valeur de position en SOL (X + Y + fees, pour TP sur PnL réel fees incluses) ──
async function positionValueSol(pos) {
    const dlmmPool = await DLMM.create(connection, new PublicKey(pos.poolAddress));
    const p = await dlmmPool.getPosition(new PublicKey(pos.positionKeypairPub));
    const d = p.positionData;
    const xDec = dlmmPool.tokenX.decimal ?? dlmmPool.tokenX.mint?.decimals ?? 6;
    const yDec = dlmmPool.tokenY.decimal ?? dlmmPool.tokenY.mint?.decimals ?? 9;
    const activeBin = await dlmmPool.getActiveBin();
    const priceYperX = parseFloat(activeBin.pricePerToken); // SOL par token (unités humaines)
    const xHuman = Number(d.totalXAmount?.toString() ?? 0) / 10 ** xDec;
    const yHuman = Number(d.totalYAmount?.toString() ?? 0) / 10 ** yDec;
    const feeX = Number(d.feeX?.toString() ?? 0) / 10 ** xDec;
    const feeY = Number(d.feeY?.toString() ?? 0) / 10 ** yDec;
    return yHuman + feeY + (xHuman + feeX) * priceYperX; // tout en SOL
}

// ── Fermeture vérifiée (pattern bot.js post-world) + re-swap token→SOL ──
// Retourne { ok, proceedsSol } : proceeds = SOL revenus au wallet (close + fees + re-swap), mesuré
// flat-to-flat → PnL réel = proceedsSol - pos.depositedSol (fees INCLUSES — reporting, pas trigger).
async function closeVerified(pos) {
    const balBefore = await solBalance();
    const dlmmPool = await DLMM.create(connection, new PublicKey(pos.poolAddress));
    const pubkey = new PublicKey(pos.positionKeypairPub);
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const tx = await dlmmPool.removeLiquidity({
                position: pubkey, user: keypair.publicKey,
                fromBinId: pos.lowerBinId, toBinId: pos.upperBinId,
                bps: new BN(10000), shouldClaimAndClose: true,
            });
            for (const t of Array.isArray(tx) ? tx : [tx]) {
                const h = await connection.sendTransaction(t, [keypair]);
                await confirmTx(h);
                console.log(`  ✅ TX fermeture: https://solscan.io/tx/${h}`);
            }
            // vérif on-chain : position réellement vidée ? (anti-world)
            try {
                const check = await dlmmPool.getPosition(pubkey);
                const remaining = (check.positionData?.positionBinData || []).some(b => parseFloat(b.positionLiquidity || 0) > 0);
                if (remaining) throw new Error('liquidité restante après remove');
            } catch (e) { if (String(e.message).includes('restante')) throw e; /* position introuvable = vidée ✓ */ }
            // re-swap du token récupéré → SOL (sinon PnL faussé + poussière qui traîne)
            if (pos.tokenMint) {
                try {
                    const raw = await tokenBalanceRaw(pos.tokenMint);
                    if (raw > 0n) { await jupSwap(pos.tokenMint, SOL_MINT, raw); console.log('  🔁 Token résiduel re-swappé en SOL'); }
                } catch (e) { console.log(`  ⚠️ re-swap token→SOL échoué (${String(e.message).slice(0, 60)}) — résidu au wallet, PnL à corriger à la main`); }
            }
            const balAfter = await solBalance();
            const proceedsSol = (balAfter - balBefore) / LAMPORTS_PER_SOL;
            return { ok: true, proceedsSol };
        } catch (e) {
            console.log(`  ⚠️ close tentative ${attempt}/3: ${String(e.message).slice(0, 80)}`);
            if (attempt === 3) { console.log('  🚨 CLOSE INCOMPLET — garder le tracking, alerter, NE PAS logger de PnL'); return { ok: false, proceedsSol: null }; }
            await new Promise(r => setTimeout(r, 4000));
        }
    }
}

module.exports = { enabled: true, findMeteoraPool, openBidAsk, closeVerified, positionValueSol };
