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
const DLMM = require('@meteora-ag/dlmm'); // v1.9.9 : export direct (PAS .default → sinon undefined → create() plante)
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

// Sizing (2026-07-23) : EP dime 1-2% du capital PAR position (jamais all-in). On lit le solde RÉEL et on
// prend POSITION_SIZE_PCT % — auto-scaling, plus de taille fixe qui sur-engage le wallet. Un plancher/
// plafond absolu (POSITION_SIZE_SOL comme cap dur optionnel) borde le risque.
const POSITION_SIZE_PCT = parseFloat(process.env.POSITION_SIZE_PCT || '2'); // % du capital par position
const POSITION_SIZE_MAX_SOL = parseFloat(process.env.POSITION_SIZE_SOL || '999'); // plafond dur optionnel
const BIN_RANGE = 34;              // ±34 bins = 69 bins — spec canonique EP (screenshot Meteora UI 19/07)
const TX_RESERVE_SOL = 0.02;      // gas
// Rent du compte de position Meteora (~0.057 SOL) : RÉCUPÉRÉ au close (shouldClaimAndClose) — ce n'est
// PAS un coût, juste une avance. On le réserve À CÔTÉ de la mise (2026-07-24, demande user) : la mise LP
// = les X% du capital, le rent ne la rogne pas.
const RENT_RESERVE_SOL = 0.06;
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
            // Plancher fee 0.5% (2026-07-22) : le « 2-5% » canonique EP est trop strict — les bonnes
            // pools bin-step-100 profondes sont souvent à 1% (ex GMEBULL 3Qj4RbLE : 1% fee, 723 SOL de
            // réserve). On garde le tri fee décroissante (« 5% d'abord ») mais on accepte jusqu'à 0.5%.
            if (baseFeePct < 0.5) continue;
            let reserveSol = 0;
            try { reserveSol = parseFloat((await connection.getTokenAccountBalance(pool.lbPair.reserveY)).value.uiAmount || 0); } catch (_) {}
            if (reserveSol < 20) continue; // EP : "TVL in 20 → don't play, you won't earn much" (2026-07-22, avant 1 SOL)
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

// ── Swap Jupiter (générique in→out, montant en unités brutes) ──
// Endpoint lite-api v1 (2026-07-22) : quote-api.jup.ag/v6 est déprécié → ENOTFOUND. Aligné sur bot 1.
async function jupSwap(inputMint, outputMint, rawAmount) {
    const quote = await axios.get('https://lite-api.jup.ag/swap/v1/quote', {
        params: { inputMint, outputMint, amount: rawAmount.toString(), slippageBps: 1000 }, timeout: 12000, // 10% (EP: "so your transaction doesn't hang") — tokens volatils, avant 3%
    });
    const swap = await axios.post('https://lite-api.jup.ag/swap/v1/swap', {
        quoteResponse: quote.data, userPublicKey: keypair.publicKey.toString(), wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto',
    }, { timeout: 12000 });
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.data.swapTransaction, 'base64'));
    tx.sign([keypair]);
    const h = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await confirmTx(h);
    return h;
}

// ── Sweep : reswappe tout token résiduel (orphelin d'un open avorté) → SOL ──────────────────────
// @solana/spl-token pas installé → IDs des programmes token en dur.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

async function sweepToken(mint) {
    const raw = await tokenBalanceRaw(mint);
    if (raw <= 0n) return false;
    console.log(`  🧹 Sweep ${mint.slice(0, 8)}: ${raw} unités → SOL...`);
    try { await jupSwap(mint, SOL_MINT, raw); console.log('  ✅ sweep OK'); return true; }
    catch (e) { console.log(`  ⚠️ sweep échoué: ${String(e.message).slice(0, 60)}`); return false; }
}

// Balaye tous les tokens loose du wallet (hors WSOL) → SOL. Appelé au démarrage : récupère les orphelins
// d'opens avortés. Sûr : la liquidité d'une position LIVE est verrouillée dans la position DLMM, pas en
// solde SPL loose → seuls les résidus sont balayés.
async function sweepOrphans() {
    try {
        const [a, a2] = await Promise.all([
            connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM_ID }),
            connection.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
        ]);
        const mints = new Set();
        for (const acc of [...a.value, ...a2.value]) {
            const info = acc.account.data.parsed.info;
            if (info.mint === SOL_MINT) continue;
            if (BigInt(info.tokenAmount.amount) > 0n) mints.add(info.mint);
        }
        if (!mints.size) { console.log('🧹 sweep: aucun token orphelin'); return; }
        console.log(`🧹 sweep: ${mints.size} token(s) orphelin(s) à récupérer`);
        for (const m of mints) { await sweepToken(m); await new Promise(r => setTimeout(r, 1500)); }
    } catch (e) { console.log(`⚠️ sweepOrphans: ${String(e.message).slice(0, 60)}`); }
}

// ── Ouverture : Bid-Ask DOUBLE-SIDED ±34 bins (spec canonique EP) ──
// Retourne { positionKeypairPub, poolAddress, depositedSol, lowerBinId, upperBinId, tokenMint } ou null.
async function openBidAsk(poolAddress) {
    const balBefore = await solBalance();
    const balSol = balBefore / LAMPORTS_PER_SOL;
    // MISE LP = X% du capital ; rent (récupéré au close) + gas réservés À CÔTÉ, ne rognent PAS la mise.
    const pctSize = balSol * (POSITION_SIZE_PCT / 100);
    const amountSol = Math.min(pctSize, POSITION_SIZE_MAX_SOL, balSol - RENT_RESERVE_SOL - TX_RESERVE_SOL);
    console.log(`  💵 Mise LP: ${amountSol.toFixed(4)} SOL (${POSITION_SIZE_PCT}% de ${balSol.toFixed(3)}) + rent ~${RENT_RESERVE_SOL} SOL (récupéré au close)`);
    if (amountSol < 0.01) { console.log(`❌ mise trop faible (${amountSol.toFixed(4)} SOL < 0.01) ou solde insuffisant`); return null; }

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
    // Propagation RPC (2026-07-22) : le solde token n'est PAS visible instantanément après le confirm
    // → lecture immédiate = 0 → abandon à tort (alors que le swap a réussi = tokens orphelins). Bot 1
    // attend 2s ; ici on poll jusqu'à ~12s pour être robuste avant d'abandonner.
    let tokenRaw = 0n;
    for (let attempt = 0; attempt < 6 && tokenRaw <= 0n; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        tokenRaw = await tokenBalanceRaw(xMint);
    }
    if (tokenRaw <= 0n) { console.log('❌ swap confirmé mais 0 token reçu après 12s — abandon'); return null; }

    const positionKeypair = Keypair.generate();
    try {
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
    } catch (e) {
        // Dépôt échoué APRÈS le swap → les tokens sont orphelins : on les reswappe tout de suite en SOL.
        console.log(`  ⚠️ dépôt LP échoué (${String(e.message).slice(0, 60)}) — sweep du token swappé...`);
        await sweepToken(xMint);
        return null;
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
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            // Position RÉELLE via getPositionsByUserAndLbPair (charge les bin arrays — sinon removeLiquidity
            // lit .data sur un compte null = "Cannot read properties of null"). Modèle éprouvé bot 1.
            const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(keypair.publicKey);
            const p = userPositions.find(u => u.publicKey.toString() === pos.positionKeypairPub);
            if (!p) { // introuvable = déjà vidée on-chain → close réussi
                console.log('  ✓ position introuvable on-chain = déjà fermée');
                return { ok: true, proceedsSol: (await solBalance() - balBefore) / LAMPORTS_PER_SOL };
            }
            const fromBinId = Number(p.positionData.lowerBinId);
            const toBinId = Number(p.positionData.upperBinId);
            let removeTxs;
            try {
                removeTxs = await dlmmPool.removeLiquidity({
                    position: p.publicKey, user: keypair.publicKey,
                    fromBinId, toBinId, bps: new BN(10000), shouldClaimAndClose: true,
                });
            } catch (removeErr) {
                console.log(`  ⚠️ removeLiquidity échoué (${String(removeErr.message).slice(0, 50)}) — fallback closePosition`);
                removeTxs = [];
            }
            const txList = Array.isArray(removeTxs) ? removeTxs : (removeTxs ? [removeTxs] : []);
            if (txList.length === 0) {
                const closeTx = await dlmmPool.closePosition({ owner: keypair.publicKey, position: p });
                const h = await connection.sendTransaction(closeTx, [keypair]); await confirmTx(h);
                console.log(`  ✅ TX closePosition: https://solscan.io/tx/${h}`);
            } else {
                for (const t of txList) {
                    const h = await connection.sendTransaction(t, [keypair]);
                    await confirmTx(h);
                    console.log(`  ✅ TX fermeture: https://solscan.io/tx/${h}`);
                }
            }
            // re-swap du token récupéré → SOL (sinon PnL faussé + poussière qui traîne)
            if (pos.tokenMint) {
                try {
                    const raw = await tokenBalanceRaw(pos.tokenMint);
                    if (raw > 0n) { await jupSwap(pos.tokenMint, SOL_MINT, raw); console.log('  🔁 Token résiduel re-swappé en SOL'); }
                } catch (e) { console.log(`  ⚠️ re-swap token→SOL échoué (${String(e.message).slice(0, 60)}) — résidu au wallet, PnL à corriger à la main`); }
            }
            const proceedsSol = (await solBalance() - balBefore) / LAMPORTS_PER_SOL;
            return { ok: true, proceedsSol };
        } catch (e) {
            console.log(`  ⚠️ close tentative ${attempt}/3: ${String(e.message).slice(0, 80)}`);
            if (attempt === 3) { console.log('  🚨 CLOSE INCOMPLET — garder le tracking, alerter, NE PAS logger de PnL'); return { ok: false, proceedsSol: null }; }
            await new Promise(r => setTimeout(r, 4000));
        }
    }
}

module.exports = { enabled: true, findMeteoraPool, openBidAsk, closeVerified, positionValueSol, sweepToken, sweepOrphans };
