/**
 * bonus-live.js — Couche d'EXÉCUTION RÉELLE du bot Bonus Stage (bot 2).
 * ⛔ VERROUILLÉE : ne fait RIEN tant que LIVE=1 n'est pas défini dans l'environnement.
 * À n'activer qu'après validation du paper-trading (~50 trades, WR ≥ 70%, PnL net > 0).
 *
 * Transplante les patterns ÉPROUVÉS de bot.js (leçons payées cash de la semaine du 04/07) :
 *  - confirmTx : vérifie value.err — une TX peut être "confirmée" EN ERREUR on-chain
 *    (bug chunk ELON Custom 6027 → 0.44 SOL fantômes). JAMAIS de send sans ce check.
 *  - dépôt réel MESURÉ par delta de solde (jamais le montant prévu) → PnL juste même si un dépôt rate.
 *  - close vérifié : re-check on-chain position vidée + retry, sinon on garde le tracking
 *    (bug world → perte fantôme -0.58 + liquidité orpheline).
 *
 * CHECKLIST avant le premier run LIVE (pour la prochaine session Claude ou le user) :
 *  [ ] Wallet DÉDIÉ bot 2 (BONUS_WALLET_KEY) — jamais celui de bot 1
 *  [ ] POSITION_SIZE_SOL=0.25 pour le front-test (comme l'auteur de la strat)
 *  [ ] Vérifier le shape : StrategyType.BidAsk existe dans la version du SDK (@meteora-ag/dlmm)
 *  [ ] Trancher "Double Bid-Ask full range" : ici implémenté = one-sided SOL sous le prix,
 *      shape BidAsk, profondeur RANGE_DOWN_PCT (défaut -50%). À comparer au zap 2-sided de la spec.
 *  [ ] TP mesuré sur VALEUR DE POSITION (fees incluses) via getPosition — pas seulement le prix
 *  [ ] Dry-run sur devnet ou 1 seule position à 0.1 SOL d'abord
 */

require('dotenv').config();

if (process.env.LIVE !== '1') {
    console.log('⛔ bonus-live: LIVE≠1 — exécution réelle désactivée. Ce module est prêt mais verrouillé.');
    module.exports = { enabled: false };
    return;
}

const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const DLMM = require('@meteora-ag/dlmm').default;
const BN = require('bn.js');
const bs58 = require('bs58');

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');
const keypair = Keypair.fromSecretKey(bs58.decode((process.env.BONUS_WALLET_KEY || '').trim()));

const POSITION_SIZE_SOL = parseFloat(process.env.POSITION_SIZE_SOL || '0.25');
const RANGE_DOWN_PCT = parseFloat(process.env.RANGE_DOWN_PCT || '0.50'); // profondeur sous l'entrée
const TX_RESERVE_SOL = 0.02;

// ── Confirmation robuste (pattern bot.js post-ELON) ───────────
async function confirmTx(hash) {
    const res = await connection.confirmTransaction(hash, 'confirmed');
    if (res?.value?.err) throw new Error(`TX atterrie en erreur on-chain: ${JSON.stringify(res.value.err)}`);
}

async function solBalance() { return await connection.getBalance(keypair.publicKey); }

// ── Ouverture : position DLMM one-sided SOL, shape Bid-Ask, sous le prix ──
// Retourne { positionKeypairPub, poolAddress, depositedSol, lowerBinId, upperBinId } ou null.
async function openBidAsk(poolAddress) {
    const balBefore = await solBalance();
    const amountSol = Math.min(POSITION_SIZE_SOL, balBefore / LAMPORTS_PER_SOL - TX_RESERVE_SOL);
    if (amountSol < 0.05) { console.log('❌ solde insuffisant'); return null; }

    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
    const activeBin = await dlmmPool.getActiveBin();
    const binStep = dlmmPool.lbPair.binStep;
    // nombre de bins pour couvrir RANGE_DOWN_PCT : (1 + step/10000)^n = 1/(1-range)
    const nBins = Math.min(Math.ceil(Math.log(1 / (1 - RANGE_DOWN_PCT)) / Math.log(1 + binStep / 10000)), 232);
    const upperBinId = activeBin.binId;            // borne haute = bin actif (entrée au support ST)
    const lowerBinId = upperBinId - nBins;

    const positionKeypair = Keypair.generate();
    const tx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        user: keypair.publicKey,
        totalXAmount: new BN(0),                                        // 0 token
        totalYAmount: new BN(Math.floor(amountSol * LAMPORTS_PER_SOL)), // SOL one-sided
        strategy: { minBinId: lowerBinId, maxBinId: upperBinId, strategyType: DLMM.StrategyType.BidAsk },
        slippage: 100,
    });
    for (const t of Array.isArray(tx) ? tx : [tx]) {
        const h = await connection.sendTransaction(t, [keypair, positionKeypair]);
        await confirmTx(h);
        console.log(`  ✅ TX ouverture: https://solscan.io/tx/${h}`);
    }
    // dépôt RÉEL mesuré (pattern bot.js post-ELON) — jamais le montant prévu
    const balAfter = await solBalance();
    const depositedSol = (balBefore - balAfter) / LAMPORTS_PER_SOL;
    console.log(`  💰 Déposé réel: ${depositedSol.toFixed(4)} SOL | bins [${lowerBinId}→${upperBinId}] BidAsk`);
    return { positionKeypairPub: positionKeypair.publicKey.toString(), poolAddress, depositedSol, lowerBinId, upperBinId };
}

// ── Valeur de position (pour TP sur PnL réel, fees incluses) ──
async function positionValueSol(pos, solPriceUsd) {
    const dlmmPool = await DLMM.create(connection, new PublicKey(pos.poolAddress));
    const p = await dlmmPool.getPosition(new PublicKey(pos.positionKeypairPub));
    const d = p.positionData;
    // NOTE successeur : convertir amounts X (token) + Y (SOL) + fees en SOL — voir bot.js ~2540
    // (côté token via prix live / solPriceUsd ; côté Y direct en lamports). À implémenter avant LIVE.
    throw new Error('positionValueSol: à finaliser (cf bot.js FEE-VEL block) avant tout run LIVE');
}

// ── Fermeture vérifiée (pattern bot.js post-world) ────────────
async function closeVerified(pos) {
    const dlmmPool = await DLMM.create(connection, new PublicKey(pos.poolAddress));
    const pubkey = new PublicKey(pos.positionKeypairPub);
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const p = await dlmmPool.getPosition(pubkey);
            const binData = p.positionData?.positionBinData || [];
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
            return true;
        } catch (e) {
            console.log(`  ⚠️ close tentative ${attempt}/3: ${String(e.message).slice(0, 80)}`);
            if (attempt === 3) { console.log('  🚨 CLOSE INCOMPLET — garder le tracking, alerter, NE PAS logger de PnL'); return false; }
            await new Promise(r => setTimeout(r, 4000));
        }
    }
}

module.exports = { enabled: true, openBidAsk, closeVerified, positionValueSol };
