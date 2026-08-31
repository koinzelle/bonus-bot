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

// (2026-08-27) ROTATION MULTI-RPC : RPC_URLS = liste séparée par virgules (ex "https://helius…,https://drpc…").
// Failover sur 429/503/erreur réseau → provider suivant → combine les quotas gratuits (Helius 1M + dRPC 50M…)
// sans payer les $49. Fallback RPC_URL/HELIUS_RPC_URL/public. ⚠️ chaque provider doit supporter
// getProgramAccounts (le SDK Meteora l'utilise pour les pools ET les positions).
const RPC_URLS = (process.env.RPC_URLS || process.env.RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com')
    .split(',').map(s => s.trim()).filter(Boolean);
let _rpcIdx = 0;
async function rotatingFetch(_url, init) {
    let lastErr = null, lastRes = null;
    for (let i = 0; i < RPC_URLS.length; i++) {
        const idx = (_rpcIdx + i) % RPC_URLS.length;
        try {
            const res = await fetch(RPC_URLS[idx], init);
            if (res.status === 429 || res.status === 503) { lastRes = res; continue; }   // saturé → provider suivant
            if (i > 0) { _rpcIdx = idx; console.log(`  🔀 RPC bascule → #${idx} (${RPC_URLS[idx].slice(0, 28)}…)`); } // colle au provider qui répond
            return res;
        } catch (e) { lastErr = e; continue; }   // erreur réseau → provider suivant
    }
    if (lastRes) return lastRes;   // tous saturés → renvoie le dernier 429 (web3.js applique son backoff)
    throw lastErr || new Error('tous les RPC ont échoué');
}
const connection = new Connection(RPC_URLS[0], { commitment: 'confirmed', fetch: rotatingFetch });
console.log(`🌐 RPC: ${RPC_URLS.length} endpoint(s) en rotation/failover`);
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
const _poolCache = new Map(); // (2026-08-26) tokenAddress -> { addr, ts } : évite de refaire 2× getProgramAccounts (gros drain RPC Helius) pour un même mint
async function findMeteoraPool(tokenAddress, preferredPool) {
    const _pc = _poolCache.get(tokenAddress);
    if (_pc && Date.now() - _pc.ts < 30 * 60 * 1000) return _pc.addr;
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
    if (!candidates.length) { _poolCache.set(tokenAddress, { addr: null, ts: Date.now() }); return null; }
    // Priorité SCALP (2026-08-04, preuve image CATE : EP scalpe en fee 1-2% = +SOL ; notre 5% = 0% car le
    // swap round-trip du scalp mange la grosse fee + moins de volume). On prend la fee la plus BASSE
    // (viable ≥0.5%), puis la plus PROFONDE (volume), puis bin step 100 canonique. (L'ancien "5% d'abord"
    // = bot 1 classique / harvest range large — PAS le scalp bonus stage.)
    candidates.sort((a, b) => a.baseFeePct - b.baseFeePct || b.reserveSol - a.reserveSol || (b.binStep === 100) - (a.binStep === 100));
    // (2026-08-30) POOL DÉSIGNÉE PAR LA DATAPI. Le tri ci-dessus prend la fee la plus BASSE — un choix du
    // 04/08 qui ignore complètement le VOLUME traversant, donc le rendement réel. La datapi a déjà classé
    // les pools du token par fees/TVL 24h et c'est ce chiffre qui qualifie le token à l'entrée : on utilise
    // donc la même pool pour y déposer. Cas fone : pool choisie 4,3 de volume/TVL contre 13,6 disponible.
    // Sécurité : on ne la retient QUE si elle a passé tous les contrôles de viabilité ci-dessus (SOL en Y,
    // bin step admis, fee ≥ 0,5%, réserve ≥ 20 SOL). Sinon on retombe sur le tri historique.
    const wanted = preferredPool ? candidates.find(c => c.addr === preferredPool) : null;
    const best = wanted || candidates[0];
    if (preferredPool && !wanted) console.log(`  · pool datapi ${String(preferredPool).slice(0, 8)} non viable (filtrée) — repli sur le tri fee`);
    // SHADOW (2026-08-30) : on logge TOUTES les pools viables pour pouvoir comparer, dans quelques semaines,
    // « la pool choisie » à « la meilleure disponible ». Les candidates sont déjà toutes évaluées : coût nul.
    console.log(`  🔬 [SHADOW pools] ${tokenAddress.slice(0, 8)} → ${candidates.map(c => `${c.addr.slice(0, 6)}(bs${c.binStep},fee${c.baseFeePct}%,${c.reserveSol.toFixed(0)}SOL)${c.addr === best.addr ? '*' : ''}`).join(' ')}`);
    console.log(`  🏆 Pool: ${best.addr.slice(0, 8)}... | bin step ${best.binStep} | fee ${best.baseFeePct}% | réserve ${best.reserveSol.toFixed(1)} SOL${wanted ? ' | désignée par fees/TVL datapi' : ''}`);
    _poolCache.set(tokenAddress, { addr: best.addr, ts: Date.now() });
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
// (2026-08-30) Poussière : après un close, l'ATA garde souvent quelques unités brutes de reliquat.
// Jupiter refuse ces montants (400 immédiat). En dessous de ce seuil on ne tente même pas — c'est ce
// bruit qui masquait les VRAIS échecs de swap dans les logs.
const DUST_RAW = 100000n;
// (2026-08-30) retry : le 400 de Jupiter est souvent transitoire ou dû à un montant lu trop tôt.
async function jupSwap(inputMint, outputMint, rawAmount, tries = 3) {
    for (let i = 1; i <= tries; i++) {
        try { return await jupSwapOnce(inputMint, outputMint, rawAmount); }
        catch (e) {
            const st = e.response?.status, body = JSON.stringify(e.response?.data || {}).slice(0, 120);
            console.log(`  ⚠️ jupSwap ${i}/${tries} (${rawAmount} unités) : ${st || e.message} ${body}`);
            if (i === tries) throw e;
            await new Promise(r => setTimeout(r, 2000 * i));
        }
    }
}
async function jupSwapOnce(inputMint, outputMint, rawAmount) {
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
    if (raw <= DUST_RAW) return false;   // (2026-08-30) la poussière fait échouer Jupiter en boucle et masque les vrais échecs
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
            if (BigInt(info.tokenAmount.amount) > DUST_RAW) mints.add(info.mint);   // (2026-08-30) ignorer la poussière
        }
        if (!mints.size) { console.log('🧹 sweep: aucun token orphelin'); return; }
        console.log(`🧹 sweep: ${mints.size} token(s) orphelin(s) à récupérer`);
        for (const m of mints) { await sweepToken(m); await new Promise(r => setTimeout(r, 1500)); }
    } catch (e) { console.log(`⚠️ sweepOrphans: ${String(e.message).slice(0, 60)}`); }
}

// ── Ouverture : Bid-Ask DOUBLE-SIDED ±34 bins (spec canonique EP) ──
// Retourne { positionKeypairPub, poolAddress, depositedSol, lowerBinId, upperBinId, tokenMint } ou null.
async function openBidAsk(poolAddress, deployedSol) {
    const balBefore = await solBalance();
    const balSol = balBefore / LAMPORTS_PER_SOL;
    // MISE LP = X% du capital ; rent (récupéré au close) + gas réservés À CÔTÉ, ne rognent PAS la mise.
    // (2026-08-31) La mise se calculait sur le SOL LIBRE. Or chaque ouverture consomme la mise PLUS
    // 0,06 SOL de rent : à la 4e position le solde libre a fondu et 15% d'un solde amputé donne 0,06 au
    // lieu de 0,15. La taille dépendait donc du NOMBRE de positions ouvertes à cet instant — une variable
    // sans rapport avec la qualité du setup. Mesuré sur 27 ouvertures : 2,7× d'écart entre la plus petite
    // (0,0549) et la plus grosse (0,1500), pour des setups équivalents.
    // Le commentaire d'origine disait « EP dime 1-2% du CAPITAL par position » : le capital, c'est le cash
    // libre PLUS ce qui est déjà déployé en LP. C'est ce qu'on calcule maintenant.
    // NB : l'allocation devient homogène, mais le wallet se déploie plus complètement — le troisième terme
    // (balSol - rent - gas) reste le garde-fou qui empêche de descendre sous les réserves.
    // (2026-08-31, demande user) TAILLE FIXE. POSITION_SIZE_SOL n'est plus un plafond mais la mise VISÉE :
    // chaque position fait ce montant, point. Le pourcentage ne sert plus que de repli si la variable n'est
    // pas définie. Seul le troisième terme borne encore : on ne descend jamais sous les réserves rent+gas.
    const capitalSol = balSol + (deployedSol || 0);
    const cible = POSITION_SIZE_MAX_SOL < 999 ? POSITION_SIZE_MAX_SOL : capitalSol * (POSITION_SIZE_PCT / 100);
    const amountSol = Math.min(cible, balSol - RENT_RESERVE_SOL - TX_RESERVE_SOL);
    const bride = amountSol < cible - 1e-9;
    console.log(`  💵 Mise LP: ${amountSol.toFixed(4)} SOL (cible ${cible.toFixed(3)}${bride ? ' — BRIDÉE, cash libre ' + balSol.toFixed(3) : ''} | capital ${capitalSol.toFixed(3)}) + rent ~${RENT_RESERVE_SOL} SOL (récupéré au close)`);
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
    const balAfter = await solBalance();
    const depositedSol = (balBefore - balAfter) / LAMPORTS_PER_SOL; // indicatif (inclut rent+gas)
    // VALEUR D'OUVERTURE on-chain (base du PnL réel) — lue juste après le dépôt, avant tout mouvement.
    const posRef = { poolAddress, positionKeypairPub: positionKeypair.publicKey.toString() };
    let openValueSol = null;
    // Poll de propagation : la position vient d'être créée, le RPC ne l'indexe pas toujours
    // instantanément (getPositionsByUserAndLbPair renvoie vide) → on réessaie avant d'abandonner.
    for (let attempt = 0; attempt < 4 && openValueSol == null; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
        try { openValueSol = await positionValueSol(posRef, dlmmPool); } catch (_) {}
    }
    console.log(`  💰 Déposé: ${depositedSol.toFixed(4)} SOL (rent+gas inclus) | valeur LP: ${openValueSol != null ? openValueSol.toFixed(4) : '?'} SOL | bins [${minBinId}→${maxBinId}] (±${BIN_RANGE})`);
    return { positionKeypairPub: positionKeypair.publicKey.toString(), poolAddress, depositedSol, openValueSol, lowerBinId: minBinId, upperBinId: maxBinId, tokenMint: xMint };
}

// ── Valeur de position en SOL (X + Y + fees) — LECTURE ON-CHAIN DIRECTE ──────────────────────────
// C'est la SEULE mesure de PnL fiable (2026-07-25) : le flat-to-flat du wallet était pollué par le rent
// récupéré, le gas, et surtout les positions concurrentes qui s'ouvrent/ferment pendant → PnL faux.
// PnL réel d'une position = valeur_close − valeur_open, indépendant du bruit wallet. Passe par
// getPositionsByUserAndLbPair (getPosition seul throw "Cannot read null" sur ce SDK). Retourne null si
// introuvable (position déjà vidée). dlmmPool optionnel (réutilise si fourni).
// Cache d'instances DLMM par pool (2026-08-10) : DLMM.create recharge TOUTE la pool (config + bins) = coûteux
// en RPC. La config est statique → on réutilise l'instance ~10 min ; getActiveBin/getPositions relisent le live
// dessus (données fraîches). Divise les appels RPC par lecture de position → tue le 429 Helius.
const _dlmmCache = new Map(); // poolAddress -> { pool, ts }
async function getDlmm(poolAddress) {
    const c = _dlmmCache.get(poolAddress);
    if (c && Date.now() - c.ts < 30 * 60 * 1000) return c.pool;   // (2026-08-26) 10→30min : config pool statique, réduit les DLMM.create (gros RPC) ×3
    const pool = await DLMM.create(connection, new PublicKey(poolAddress));
    _dlmmCache.set(poolAddress, { pool, ts: Date.now() });
    return pool;
}
async function positionValueSol(pos, dlmmPool = null, activeBin = null) {
    dlmmPool = dlmmPool || await getDlmm(pos.poolAddress);
    // (2026-08-28) était getPositionsByUserAndLbPair = un getProgramAccounts owner-wide POUR UNE SEULE
    // position. getPosition(clé) fait un getAccountInfo direct : même résultat, sans scan de programme.
    let d;
    try { d = (await dlmmPool.getPosition(new PublicKey(pos.positionKeypairPub))).positionData; }
    catch (e) { if (/not found/i.test(String(e && e.message))) return null; throw e; }
    const xDec = dlmmPool.tokenX.decimal ?? dlmmPool.tokenX.mint?.decimals ?? 6;
    const yDec = dlmmPool.tokenY.decimal ?? dlmmPool.tokenY.mint?.decimals ?? 9;
    activeBin = activeBin || await dlmmPool.getActiveBin();
    const priceYperX = parseFloat(activeBin.pricePerToken); // SOL par token (unités humaines)
    const xHuman = Number(d.totalXAmount?.toString() ?? 0) / 10 ** xDec;
    const yHuman = Number(d.totalYAmount?.toString() ?? 0) / 10 ** yDec;
    const feeX = Number(d.feeX?.toString() ?? 0) / 10 ** xDec;
    const feeY = Number(d.feeY?.toString() ?? 0) / 10 ** yDec;
    return yHuman + feeY + (xHuman + feeX) * priceYperX; // tout en SOL
}

// Valeur LP + bin actif en un appel (pour la sortie hors-range HAUT : bin actif > upperBinId = prix sorti
// du range par le haut → valeur LP figée en SOL, ni trail ni RSI ne peuvent fermer → on banke). RPC Solana
// → marche même quand les bougies (GMGN) tombent.
async function positionValueAndBin(pos) {
    const dlmmPool = await getDlmm(pos.poolAddress);                    // instance cachée (pas de re-download)
    const activeBin = await dlmmPool.getActiveBin();                   // bin actif lu UNE fois
    const valueSol = await positionValueSol(pos, dlmmPool, activeBin); // réutilise le bin → pas de 2e lecture
    return { valueSol, activeBinId: activeBin.binId };
}

// LECTURE GROUPÉE (2026-08-10) : 1 appel getAllLbPairPositionsByUser → TOUTES les positions (toutes pools)
// → coût RPC ~plat quel que soit le nombre de positions (permet de scaler le max). Le PRIX est pris via
// getActiveBin par pool UNIQUE (instance cachée) = MÊME source/formule que positionValueSol → aucun calcul
// de prix maison, aucun risque de valeur fausse. Renvoie Map<positionKeypairPub, {valueSol, activeBinId}>.
// LECTURE PAR CLÉ (2026-08-28) — `getAllLbPairPositionsByUser` fait un getProgramAccounts owner-wide sur
// tout le programme DLMM (classe d'appel la plus chère). Or on CONNAÎT la clé de chaque position suivie :
// `dlmmPool.getPosition(pubkey)` fait un getAccountInfo direct + un getMultipleAccounts groupé pour les bin
// arrays — zéro scan de programme. Avec ≤5 positions c'est strictement moins cher que le scan owner-wide.
// Bonus : un compte de position fermé on-chain disparaît (le rent est récupéré) → getAccountInfo renvoie
// null → « not found ». C'est une détection de coupe manuelle PAR POSITION, plus précise qu'un inventaire.
//   out.allKeys = positions trouvées PRÉSENTES
//   out.checked = positions pour lesquelles on a une réponse FIABLE (pool lisible) — une pool qui hoquette
//                 n'y figure pas, donc le reconcile ne conclura rien sur ses positions.
async function positionValuesByKeys(list) {
    const out = new Map(); out.allKeys = new Set(); out.checked = new Set();
    const byPool = new Map();
    for (const p of list) { if (!byPool.has(p.poolAddress)) byPool.set(p.poolAddress, []); byPool.get(p.poolAddress).push(p); }
    for (const [poolAddr, ps] of byPool) {
        let dlmm, ab;
        try { dlmm = await getDlmm(poolAddr); ab = await dlmm.getActiveBin(); }   // 1 lecture par POOL, pas par position
        catch (_) { continue; }                                                   // pool illisible → on ne conclut RIEN
        // Garde-fou version SDK : si `getPosition` n'existe pas dans la version installée sur Railway, on
        // rend la main au scan owner-wide (ancien comportement) plutôt que de dégrader silencieusement.
        if (typeof dlmm.getPosition !== 'function') { console.log('  ⚠️ SDK sans getPosition() — retour au scan owner-wide'); return null; }
        const priceYperX = parseFloat(ab.pricePerToken);
        const xDec = dlmm.tokenX.decimal ?? dlmm.tokenX.mint?.decimals ?? 6;
        const yDec = dlmm.tokenY.decimal ?? dlmm.tokenY.mint?.decimals ?? 9;
        for (const p of ps) {
            let d;
            try { d = (await dlmm.getPosition(new PublicKey(p.positionKeypairPub))).positionData; }
            catch (e) {
                if (/not found/i.test(String(e && e.message))) out.checked.add(p.positionKeypairPub); // compte absent = fermé
                continue;                                                        // autre erreur → pas de conclusion
            }
            out.checked.add(p.positionKeypairPub); out.allKeys.add(p.positionKeypairPub);
            const xHuman = Number(d.totalXAmount?.toString() ?? 0) / 10 ** xDec;
            const yHuman = Number(d.totalYAmount?.toString() ?? 0) / 10 ** yDec;
            const feeX = Number(d.feeX?.toString() ?? 0) / 10 ** xDec;
            const feeY = Number(d.feeY?.toString() ?? 0) / 10 ** yDec;
            out.set(p.positionKeypairPub, { valueSol: yHuman + feeY + (xHuman + feeX) * priceYperX, activeBinId: ab.binId });
        }
    }
    return out;
}
async function allPositionValues(list) {
    if (Array.isArray(list) && list.length) {
        const m = await positionValuesByKeys(list);   // chemin normal : 0 getProgramAccounts
        if (m) return m;                              // null = SDK incompatible → on retombe sur le scan
    }
    const byPair = await DLMM.getAllLbPairPositionsByUser(connection, keypair.publicKey);
    const out = new Map();
    // (2026-08-28) INVENTAIRE COMPLET, construit AVANT l'enrichissement par pool. L'enrichissement
    // ci-dessous peut échouer pool par pool (`catch → continue`) : sans cet inventaire, une position dont
    // la pool hoquette serait ABSENTE de la map alors qu'elle existe on-chain → un reconcile naïf la
    // déclarerait fermée et supprimerait le tracking d'une VRAIE position (bug `world` de bot 1).
    // `allKeys` vient directement de getAllLbPairPositionsByUser : il est complet ou il n'existe pas.
    const allKeys = new Set();
    for (const [, info] of byPair) for (const lp of info.lbPairPositionsData || []) allKeys.add(lp.publicKey.toString());
    out.allKeys = allKeys; out.checked = null;   // null = inventaire global : « absent » n'est pas concluant par position
    for (const [poolAddr, info] of byPair) {
        let priceYperX, activeBinId, xDec, yDec;
        try {
            const dlmm = await getDlmm(poolAddr);
            const ab = await dlmm.getActiveBin();
            priceYperX = parseFloat(ab.pricePerToken);
            activeBinId = ab.binId;
            xDec = dlmm.tokenX.decimal ?? dlmm.tokenX.mint?.decimals ?? 6;
            yDec = dlmm.tokenY.decimal ?? dlmm.tokenY.mint?.decimals ?? 9;
        } catch (_) { continue; } // pool illisible → les positions dessus retomberont sur le fallback individuel
        for (const lp of info.lbPairPositionsData || []) {
            const d = lp.positionData;
            const xHuman = Number(d.totalXAmount?.toString() ?? 0) / 10 ** xDec;
            const yHuman = Number(d.totalYAmount?.toString() ?? 0) / 10 ** yDec;
            const feeX = Number(d.feeX?.toString() ?? 0) / 10 ** xDec;
            const feeY = Number(d.feeY?.toString() ?? 0) / 10 ** yDec;
            out.set(lp.publicKey.toString(), { valueSol: yHuman + feeY + (xHuman + feeX) * priceYperX, activeBinId });
        }
    }
    return out;
}

// ── Existence d'une position live (réconciliation) — check INDIVIDUEL sur SA pool (méthode éprouvée,
// = celle du close). Retourne 'open' | 'closed' | 'unknown'. 'unknown' sur erreur RPC → l'appelant ne
// touche à rien (jamais de faux "fermé" qui nettoierait une position vivante). Plus sûr qu'une liste
// globale (dont un appel vide nettoierait tout).
async function positionState(pos) {
    try {
        const dlmmPool = await DLMM.create(connection, new PublicKey(pos.poolAddress));
        const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(keypair.publicKey);
        const found = userPositions.some(u => u.publicKey.toString() === pos.positionKeypairPub);
        return found ? 'open' : 'closed';
    } catch (_) { return 'unknown'; }
}

// ── Fermeture vérifiée (pattern bot.js post-world) + re-swap token→SOL ──
// Retourne { ok, proceedsSol, closeValueSol } : closeValueSol = valeur ON-CHAIN de la position (X+Y+fees)
// lue AVANT le remove = mesure FIABLE. PnL réel = closeValueSol − pos.openValueSol (insensible au bruit
// wallet). proceedsSol (flat-to-flat) gardé en secours/indicatif.
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
                return { ok: true, proceedsSol: (await solBalance() - balBefore) / LAMPORTS_PER_SOL, closeValueSol: null };
            }
            // valeur ON-CHAIN avant remove (X+Y+fees en SOL) = base du PnL réel
            let closeValueSol = null;
            try { closeValueSol = await positionValueSol(pos, dlmmPool); } catch (_) {}
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
                    // (2026-08-30, cas GTA6 20/51 + STONK) Le solde était lu UNE fois, immédiatement après
                    // la TX de fermeture — avant que le RPC ait indexé les tokens rendus. Il renvoyait donc
                    // l'ancien solde (la poussière du close précédent, ~17 unités), le garde `> 0n` passait,
                    // et le bot swappait 17 unités : Jupiter répondait 400 en 140 ms. Les milliers de vrais
                    // tokens arrivaient une seconde plus tard et restaient au wallet — 0,41 SOL immobilisés.
                    // On attend maintenant que le solde DÉPASSE la poussière, jusqu'à 8 tentatives (~20 s).
                    let raw = 0n;
                    for (let attempt = 0; attempt < 8; attempt++) {
                        raw = await tokenBalanceRaw(pos.tokenMint);
                        if (raw > DUST_RAW) break;
                        await new Promise(r => setTimeout(r, 2500));
                    }
                    if (raw > DUST_RAW) { await jupSwap(pos.tokenMint, SOL_MINT, raw); console.log(`  🔁 Token résiduel re-swappé en SOL (${raw} unités)`); }
                    else console.log(`  · pas de token à re-swapper (${raw} unités = poussière)`);
                } catch (e) { console.log(`  ⚠️ re-swap token→SOL échoué (${String(e.message).slice(0, 60)}) — résidu au wallet, rattrapé au prochain sweep`); }
            }
            const proceedsSol = (await solBalance() - balBefore) / LAMPORTS_PER_SOL;
            return { ok: true, proceedsSol, closeValueSol };
        } catch (e) {
            console.log(`  ⚠️ close tentative ${attempt}/3: ${String(e.message).slice(0, 80)}`);
            if (attempt === 3) { console.log('  🚨 CLOSE INCOMPLET — garder le tracking, alerter, NE PAS logger de PnL'); return { ok: false, proceedsSol: null }; }
            await new Promise(r => setTimeout(r, 4000));
        }
    }
}

module.exports = { enabled: true, findMeteoraPool, openBidAsk, closeVerified, positionValueSol, positionValueAndBin, allPositionValues, positionValuesByKeys, positionState, sweepToken, sweepOrphans };
