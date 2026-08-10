/**
 * bonus-bot.js — Bot 2 : "Fast Bid-Ask, Bonus Stage" (stratégie LP Army / mentor Evil Panda)
 * MODE PAPER-TRADING : détecte les setups en live, envoie les signaux Telegram, logge les
 * trades SIMULÉS. AUCUNE transaction on-chain. Passer LIVE=1 plus tard, après validation.
 *
 * Stratégie (thread X du 2026-07-06, backtest maison 2026-07-07 : ~95% WR sur 50 trades simulés) :
 *  - Setup  : token < 48h de vie, nouvel ATH avec MC > $250K, volume sain
 *  - Entrée : retracement du prix sur la ligne SuperTrend 15m (tendance verte)
 *  - TP     : +6% (fourchette 5-7% du thread)
 *  - SL     : flip rouge de la SuperTrend 15m en clôture ("sharp breakdown")
 *
 * Lancement : node bonus-bot.js  (mêmes .env que bot.js : TELEGRAM_TOKEN, CHAT_ID)
 * Déploiement Railway : second service sur le même repo, start command "node bonus-bot.js".
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── Capture des logs pour GET /logs (2026-07-20) : sur Railway, console.log part dans le flux
// Railway — ce buffer donne l'accès distant aux rejets/purges/entrées (auto-diagnostic sans logs UI) ──
const LOG_BUFFER = [];
const _origLog = console.log.bind(console);
console.log = (...a) => {
    try {
        LOG_BUFFER.push(`[${new Date().toISOString()}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
        if (LOG_BUFFER.length > 4000) LOG_BUFFER.shift();
    } catch (_) {}
    _origLog(...a);
};

const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || '').trim();
const CHAT_ID = (process.env.CHAT_ID || '').trim();

// ── Couche LIVE (2026-07-19) : inerte tant que LIVE≠1 sur Railway. Avec LIVE=1 + BONUS_WALLET_KEY,
// chaque entrée papier ouvre AUSSI la vraie position Bid-Ask ±34 double-sided (bonus-live.js), et
// chaque sortie papier la ferme (closeVerified + re-swap). Triggers TP/SL = ceux du paper (validés
// backtest, +6% PRIX) ; le PnL réel fees incluses est loggé À CÔTÉ (pnlSolLive) pour comparaison.
let live = { enabled: false };
try { live = require('./bonus-live'); } catch (e) { console.log('⚠️ bonus-live indisponible:', e.message, '— paper seulement'); }
if (live.enabled) {
    console.log(`🟢 LIVE ACTIVÉ — exécution réelle armée | taille ${process.env.POSITION_SIZE_PCT || '?'}% capital | max ${process.env.MAX_LIVE_POSITIONS || '5'} position(s) réelle(s) | DATA_DIR=${process.env.DATA_DIR || 'éphémère ⚠️'}`);
    if (live.sweepOrphans) live.sweepOrphans().catch(e => console.log('⚠️ sweep démarrage:', String(e.message).slice(0, 60)));
} else console.log('🧪 Mode PAPER (LIVE≠1 ou bonus-live KO) — aucun ordre réel');

// ── Filet anti-crash GLOBAL (2026-07-22) : un bot LIVE ne doit JAMAIS mourir sur une erreur transitoire
// (RPC 429, rejet réseau, await non catché) — sinon il oublie le tracking de la position live = danger.
// On LOGGE (stack complète pour diagnostiquer) et on SURVIT. L'état est persisté sur /data, chaque tick
// est indépendant → continuer est bien plus sûr que crasher.
process.on('unhandledRejection', (e) => console.log('⚠️ unhandledRejection (survécu):', String(e?.stack || e?.message || e).slice(0, 300)));
process.on('uncaughtException', (e) => console.log('⚠️ uncaughtException (survécu):', String(e?.stack || e?.message || e).slice(0, 300)));
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { if (DATA_DIR !== __dirname) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const STATE_FILE = path.join(DATA_DIR, 'bonus_paper.json');

// ── Paramètres stratégie ──────────────────────────────────────
// TP TRAILING (2026-07-19, idée user + backtest : +247%/+239% total vs +84% en TP fixe +6%, WR 80% vs 85%,
// pires pertes identiques) : une fois le high-water ≥ +5% depuis l'entrée, plus de plafond — on suit le
// pump et on sort quand le prix retombe de 1.5% sous le plus-haut. Avant l'armement : SL flip ST inchangé.
const TRAIL_ARM_PCT = 0.05;       // armé quand le high-water atteint +5%
const TRAIL_GAP_PCT = 0.015;      // sortie à high-water -1.5% (1% marginalement mieux en backtest,
                                  // 1.5% plus robuste au polling 30s réel sur memecoin)
const NEAR_ST_PCT = 0.04;        // fenêtre pullback ≤ +4% au-dessus de la ligne ST — sweep 2026-07-19 :
                                 // WR stable 79-80% de 3 à 4.5% ; 4% = meilleure moy (+3.86%/trade, +73% total,
                                 // 19 trades vs 14 à 3%) sans nouvelle queue de perte ; 5% dégrade (-32.9% tail)
const REENTRY_COOLDOWN_MS = 30 * 60 * 1000; // pas de ré-entrée sur un token < 30 min après une sortie (anti-boucle)
const MC_MIN_ATH = 250_000;       // l'ATH doit avoir dépassé cette MC
const AGE_MAX_H = 24 * 365;       // garde-fou zombies 1 an — pas de MAX (EP joue les vieux coins).
const AGE_MIN_H = 10;             // MINIMUM d'âge de coin (2026-07-28, abaissé 24h→10h) : 24h bloquait Looks (16h) qui a fait +66% en V — l'âge n'est PAS un bon discriminateur (le plus jeune a gagné, les vieux saignent). 10h ne vire que les launch snipes purs (<10h) ; le pattern + anti-pump-explosif font le vrai tri.
const VOL_MIN_24H = 1_000_000;    // volume 24h ≥ $1M — filtre DexScreener exact d'EP (aligné 2026-07-22, avant 500k)
const ATH_FRESH_H = 4;            // l'ATH doit dater de < 4h ("just made new ATH")
const MAX_POSITIONS = 8;          // positions papier simultanées (EP : beaucoup de petites positions, pas all-in)
const MAX_LIVE_POSITIONS = parseInt(process.env.MAX_LIVE_POSITIONS || '5', 10); // positions RÉELLES max (3→5, 2026-07-28 demande user)
// Scan 30s avec ticks alternés (2026-07-19, demande user) : 1 tick sur 2 = scan COMPLET (découverte +
// tous les tokens, comme avant à 60s) ; l'autre tick = UNIQUEMENT les tokens "chauds" (4/5 conditions,
// il ne manque que le retracement vers la ST) + positions ouvertes (TP/SL 2× plus réactifs). Le prix
// peut traverser la fenêtre ±3% entre 2 checks à 60s — le tick chaud à 30s divise ce risque par 2,
// sans doubler la charge API GT (les ticks chauds ne fetchent que 1-3 tokens).
const SCAN_INTERVAL_MS = 30_000;
const POSITION_SIZE_SOL = 1.0;    // taille papier (pour les stats en SOL)

let state = { positions: {}, trades: [], watch: {} };
try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
// A/B trailing vs TP fixe (2026-07-19, demande user) : chaque entrée ouvre AUSSI une position OMBRE
// "TP fixe +6% / SL flip ST" (l'ancienne règle) qui vit sa propre vie — elle peut fermer avant ou
// après la vraie. Comparaison continue dans /status → vérification live du verdict backtest (×3).
if (!state.fixedShadow) state.fixedShadow = {};
if (!state.tradesFixed) state.tradesFixed = [];
// reset des compteurs de l'ancien funnel (refonte EP 2026-07-22) — sinon /status mélange 2 logiques
if (state.blockCount && (state.blockCount['dist>4%'] || state.blockCount['athAge>8h'] || state.blockCount['ST-rouge'])) state.blockCount = {};
// RESET one-shot des qualifications pattern COLLANTES (2026-07-25) : le hack "breakdown par prix" validait
// trop large (TRUMP2028, reliques 6 mois). patternValidated est collant → sans reset, ces fausses
// qualifications survivraient au passage à la règle ST pure. On efface pour que la ST re-juge tout le monde.
if (!state.patternResetV2) { for (const w of Object.values(state.watch || {})) delete w.patternValidated; state.patternResetV2 = true; }
// Reset one-shot au passage ST mult 3→2 (2026-07-29) : les patterns validés en mult=3 doivent être
// re-jugés en mult=2 (plus sensible) — sinon flags collants obsolètes.
if (!state.stMult2Reset) { for (const w of Object.values(state.watch || {})) delete w.patternValidated; state.stMult2Reset = true; }
// Fix migration (2026-07-25) : purge la watch pour que chaque token soit re-découvert avec sa pool
// d'ORIGINE (historique complet). Les entrées existantes ont une pool figée (post-migration) → pattern
// faux. One-shot ; les positions ouvertes sont préservées (jamais purgées).
if (!state.poolOriginResetV1) { for (const tok of Object.keys(state.watch || {})) { if (!state.positions?.[tok]) delete state.watch[tok]; } state.poolOriginResetV1 = true; }
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.log('⚠️ save:', e.message); } }

// ── SHADOW STATS PERSISTÉS (2026-07-29, demande user) : les mesures shadow étaient des console.log
// (buffer mémoire ~50 lignes, vidé au redeploy) → on perdait les vrais totaux. On les accumule ici,
// DANS l'état (donc sur le volume Railway = survit aux redeploys). Compteurs + listes plafonnées (FIFO).
if (!state.shadowStats) state.shadowStats = {};
// Coupes manuelles gardées en mémoire (2026-07-30) : on note juste le token + entrée + date → on vérifie
// NOUS-MÊMES après ~9j s'il a rebondi jusqu'à une sortie possible (EP a déjà tenu 9j à -80% et fini vert).
if (!state.shadowManualCloses) state.shadowManualCloses = [];
function trackManualClose(tok, p) {
    state.shadowManualCloses.push({ tok, symbol: p.symbol, entry: p.entry, athMc: p.athMc, closedAt: new Date().toISOString() });
    if (state.shadowManualCloses.length > 100) state.shadowManualCloses = state.shadowManualCloses.slice(-100);
}
function recordShadow(type, data) {
    const s = state.shadowStats;
    if (!s[type]) s[type] = { n: 0, records: [] };
    s[type].n++;
    if (data) {
        s[type].records.push({ ...data, ts: new Date().toISOString() });
        if (s[type].records.length > 200) s[type].records.shift(); // cap FIFO
    }
    if (data && data.level != null) { // stacking : compteur par palier
        s[type].byLevel = s[type].byLevel || {};
        s[type].byLevel[data.level] = (s[type].byLevel[data.level] || 0) + 1;
    }
}

async function tg(msg) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text: `🧪 [PAPER Bonus Stage]\n${msg}` }, { timeout: 8000 });
    } catch (e) { console.log('⚠️ telegram:', e.response?.data?.description || e.message); }
}

// ── Data ──────────────────────────────────────────────────────
let gtScan = 0;
async function gtTrending() {
    // Priorité TRENDING (2026-07-19, demande user) : comme bot 1, la découverte lit les pools trending
    // GeckoTerminal (24h + 1h) à CHAQUE scan — new_pools seulement 1 scan sur 3, en fin de liste
    // (les candidats trending passent en premier quand les slots watch sont comptés).
    // Découverte élargie (2026-07-22, demande user) : trending 24h pages 1-3 + 1h page 1 ; new_pools
    // 1 scan/3 ; DexScreener boosts (tokens mis en avant) 1 scan/2. Plus de candidats → plus de chances
    // qu'un token retrace sur l'EMA34 pendant qu'on le surveille.
    // DÉCOUVERTE ORIENTÉE JEUNES (2026-07-27, GO user, VALIDÉ PAR TEST) : le trending 24h ramenait des
    // VIEUX coins établis (MET 277j, TripleT 153j) → tous bloqués ATH>24h (19425 fois). Test des sources :
    // 1h trending = 3 jeunes qualifiants (Ryder 3h, QUIP 0.8h...) vs 24h = 1 ; new_pools = 0 (trop neufs,
    // sans volume) → INUTILE, retiré. On cible le FRAIS : trending 1h + 6h à chaque scan, 24h 1 scan/3.
    // Le gtPool ne sert plus (bougies Birdeye token-level) → n'importe quelle source va.
    const urls = [
        { label: 'GT-1h', url: 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=1' },
        { label: 'GT-6h', url: 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=6h&page=1' },
        // POOLS METEORA ACTIVES (2026-08-08, cas KINS/ANSEM) : les choppeurs ÉTABLIS d'EP ne trendent pas
        // toujours (« chops quietly, minimal mentions ») mais génèrent du volume dans leur pool Meteora.
        // On les découvre par volume 24h → capte CATE, ANSEM, STONK, KINS… = l'univers d'EP.
        { label: 'Met-vol1', url: 'https://api.geckoterminal.com/api/v2/networks/solana/dexes/meteora/pools?sort=h24_volume_usd_desc&page=1' },
        { label: 'Met-vol2', url: 'https://api.geckoterminal.com/api/v2/networks/solana/dexes/meteora/pools?sort=h24_volume_usd_desc&page=2' },
    ];
    if (gtScan % 3 === 0) urls.push({ label: 'GT-24h', url: 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1' }); // 24h occasionnel
    // Retourne [{ tok, gtPool }] : on GARDE l'adresse de pool GT (garantie indexée pour les bougies —
    // fix 19/07 : la pool DexScreener la plus liquide n'est parfois PAS sur GT → fetch bougies mort
    // en boucle → purge → watch vide alors que le token est bon).
    const out = [];
    const seen = new Set();
    const srcStats = [];   // santé PAR source (repère une source down directement dans les logs — cas bot 1)
    for (const { label, url } of urls) {
        let added = 0, ko = false;
        try {
            const r = await axios.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
            for (const p of r.data?.data || []) {
                const base = p.relationships?.base_token?.data?.id || '';
                const addr = base.includes('_') ? base.split('_').slice(1).join('_') : base;
                const poolId = p.id || '';
                const gtPool = poolId.includes('_') ? poolId.split('_').slice(1).join('_') : null;
                if (addr && addr !== 'So11111111111111111111111111111111111111112' && !seen.has(addr)) {
                    seen.add(addr);
                    out.push({ tok: addr, gtPool });
                    added++;
                }
            }
        } catch (_) { ko = true; /* une vue GT en échec ne bloque pas les autres */ }
        srcStats.push(`${label}:${ko ? 'KO⚠️' : added}`);
        await new Promise(r => setTimeout(r, 2100)); // 2026-08-09 : 150ms→2.1s — GT gratuit ≈ 30/min (1 par 2s) ;
        // à 150ms le 1er appel passait et TOUT le reste tombait en 429 (Met-vol1/2 KO = découverte établis morte)
    }
    // DexScreener boosts (1 scan/2) : tokens mis en avant/promus = souvent actifs. Pas de gtPool → la
    // watch retombera sur la pool DexScreener (candles15 essaie GT dessus ; purge si non indexé).
    if (gtScan % 2 === 0) {
        let added = 0, ko = false;
        for (const bu of ['https://api.dexscreener.com/token-boosts/top/v1', 'https://api.dexscreener.com/token-boosts/latest/v1']) {
            try {
                const r = await axios.get(bu, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
                for (const b of r.data || []) {
                    if (b.chainId !== 'solana') continue;
                    const addr = b.tokenAddress;
                    if (addr && addr !== 'So11111111111111111111111111111111111111112' && !seen.has(addr)) {
                        seen.add(addr);
                        out.push({ tok: addr, gtPool: null });
                        added++;
                    }
                }
            } catch (_) { ko = true; /* boosts KO → non bloquant */ }
        }
        srcStats.push(`DexBoost:${ko ? 'KO⚠️' : added}`);
    }
    // SOURCE FEES/TVL (2026-08-10, cas FOMO) : les MEILLEURES pools LP (fort rendement fees/TVL) sont souvent
    // PETITES (FOMO $13k TVL, 43% fees/TVL) → invisibles au tri par volume absolu (elles ne rentrent pas dans
    // le top 40). On les capte via l'API Meteora datapi triée par fee_tvl_ratio_24h. Le token passe ENSUITE
    // tous les filtres normaux (dexInfo, volume, qualité GMGN, pattern, dump, RSI, pool viable).
    try {
        const MIN_TVL = 10000, MIN_FEE_RATIO = 30, USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const SOLM = 'So11111111111111111111111111111111111111112';
        const mr = await axios.get('https://dlmm.datapi.meteora.ag/pools', {
            params: { page: 1, page_size: 100, sort_by: 'fee_tvl_ratio_24h:desc', filter_by: `tvl>=${MIN_TVL} && is_blacklisted=false` },
            headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000,
        });
        let added = 0;
        for (const p of mr.data?.data || []) {
            const ratio = (p.fee_tvl_ratio && p.fee_tvl_ratio['24h']) || 0;
            if (ratio < MIN_FEE_RATIO || (p.tvl || 0) < MIN_TVL) continue; // fort rendement LP uniquement
            const xm = p.token_x && p.token_x.address, ym = p.token_y && p.token_y.address;
            const tok = (xm === SOLM || xm === USDC) ? ym : (ym === SOLM || ym === USDC) ? xm : xm; // côté non-SOL/USDC
            if (tok && tok !== SOLM && tok !== USDC && !seen.has(tok)) { seen.add(tok); out.push({ tok, gtPool: null }); added++; }
        }
        srcStats.push(`Met-fees:${added}`);
    } catch (_) { srcStats.push('Met-fees:KO⚠️'); }
    console.log(`📡 Sources découverte: ${srcStats.join(' · ')} → ${out.length} candidats uniques`);
    gtScan++;
    return out;
}

async function dexInfo(token) {
    const r = await axios.get(`https://api.dexscreener.com/token-pairs/v1/solana/${token}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
    const pairs = (r.data || []).filter(p => p.chainId === 'solana');
    if (!pairs.length) return null;
    pairs.sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0));
    const p = pairs[0];
    const created = pairs.map(q => q.pairCreatedAt).filter(Boolean);
    // Pool d'ANALYSE (2026-07-25) = la plus ANCIENNE (origine, ex pumpswap) : contient TOUTE la vie du
    // token, migration incluse (cas fomo : dump -89% visible sur pumpswap, pas sur meteora).
    // ⚠️ (2026-07-27) EXCLURE la bonding curve pump.fun (dexId 'pumpfun') : GeckoTerminal ne l'indexe PAS
    // pour les bougies (1 seule bougie → token skippé). On prend la plus ancienne pool RÉELLE (pumpswap).
    const withDate = pairs.filter(q => q.pairCreatedAt && q.dexId !== 'pumpfun');
    const pool4analysis = withDate.length ? withDate : pairs.filter(q => q.pairCreatedAt);
    const oldest = pool4analysis.length ? pool4analysis.reduce((a, b) => a.pairCreatedAt <= b.pairCreatedAt ? a : b) : p;
    const price = parseFloat(p.priceUsd || 0), mc = parseFloat(p.marketCap || 0);
    return {
        pool: p.pairAddress,
        poolAnalysis: oldest.pairAddress, // bougies pattern/ATH — historique complet
        poolAnalysisDex: oldest.dexId,
        symbol: p.baseToken?.symbol || token.slice(0, 6),
        birthMs: created.length ? Math.min(...created) : null,
        price, mc,
        supply: price > 0 && mc > 0 ? mc / price : null,
        vol24h: Math.max(...pairs.map(q => parseFloat((q.volume || {}).h24 || 0)), 0),
        // Règle EP n°5 : "main supplier LEGIT" = profil DexScreener payé (image) + X (any pair)
        hasTwitter: pairs.some(q => (q.info?.socials || []).some(s => s.type === 'twitter')),
        hasImage: pairs.some(q => !!q.info?.imageUrl),
    };
}

// ── BOUGIES : BIRDEYE primaire + GMGN fallback (2026-07-27, bascule depuis GeckoTerminal) ──────────
// GT throttlait l'IP Railway (429 en boucle → famine 6/18). Birdeye PRIMAIRE (choix user : épargner
// GMGN, déjà rate-limité sur bot 1) : à 1.5s d'espacement séquentiel = 6/6 sans 429 ET 192 bougies
// (vs 44 GMGN). GMGN en FALLBACK seulement quand Birdeye vide/rate-limité. On MINIMISE les appels :
// fréquence adaptative (peu de tokens dus/tick) + caches longs (macro pattern/ATH lent) + throttle
// global 1.5s. Les deux TOKEN-LEVEL → suivent la migration (supprime le bricolage pool d'origine).
const BIRDEYE_KEY = (process.env.BIRDEYE_API_KEY || '').trim();
const { randomUUID: _uuid } = require('crypto');
// throttle global partagé (sérialise + espace) — 1.5s mini entre 2 appels bougies (Birdeye tient à 1.5s).
let candleChain = Promise.resolve();
let candleLast = 0;
function throttled(fn) {
    const run = candleChain.then(async () => {
        const wait = Math.max(0, 1500 - (Date.now() - candleLast));
        if (wait) await new Promise(r => setTimeout(r, wait));
        candleLast = Date.now();
        return fn();
    });
    candleChain = run.catch(() => { });
    return run;
}
async function gmgnKline(mint, res, limit, intervalSec) {
    const now = Date.now(), from = now - limit * intervalSec * 1000;
    const r = await axios.get(`${GMGN_BASE}/v1/market/token_kline`, {
        httpsAgent: GMGN_AGENT, headers: { 'X-APIKEY': GMGN_KEY },
        params: { chain: 'sol', address: mint, resolution: res, from, to: now, timestamp: Math.floor(now / 1000), client_id: _uuid() }, timeout: 12000,
    });
    const list = r.data?.data?.list || r.data?.data || [];
    // GMGN {time(ms),open,high,low,close,volume} → [ts(sec),o,h,l,c,v]
    return list.map(k => [Math.floor((k.time || k.timestamp || 0) / 1000), +k.open, +k.high, +k.low, +k.close, +k.volume]).sort((a, b) => a[0] - b[0]);
}
async function birdeyeOhlcv(mint, type, limit, intervalSec) {
    const to = Math.floor(Date.now() / 1000), from = to - limit * intervalSec;
    const r = await axios.get('https://public-api.birdeye.so/defi/ohlcv', {
        params: { address: mint, type, time_from: from, time_to: to },
        headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }, timeout: 12000,
    });
    return (r.data?.data?.items || []).map(k => [k.unixTime, +k.o, +k.h, +k.l, +k.c, +k.v]).sort((a, b) => a[0] - b[0]);
}
const candleCache = new Map(); // (mint+res) -> { cs, ts }
async function candlesTF(mint, gmgnRes, birdeyeType, limit, intervalSec, ttlMs) {
    const key = mint + gmgnRes;
    const c = candleCache.get(key);
    if (c && Date.now() - c.ts < ttlMs) return c.cs; // cache : ÉVITE l'appel (le principal minimiseur)
    let cs = [];
    try { cs = await throttled(() => birdeyeOhlcv(mint, birdeyeType, limit, intervalSec)); } catch (_) {} // PRIMAIRE
    if (cs.length < 15) { // Birdeye vide/rate-limité → fallback GMGN (épargné au max)
        try { const g = await throttled(() => gmgnKline(mint, gmgnRes, limit, intervalSec)); if (g.length > cs.length) cs = g; } catch (_) {}
    }
    if (cs.length) candleCache.set(key, { cs, ts: Date.now() });
    return cs.length ? cs : (c ? c.cs : []);
}
// TTL longs = moins d'appels : 15m→120s (support/exit) ; 1H→20min ; daily→60min (macro = lent).
const candles5 = (mint, limit = 200) => candlesTF(mint, '5m', '5m', limit, 300, 60 * 1000);
const candles15 = (mint, limit = 192) => candlesTF(mint, '15m', '15m', limit, 900, 120 * 1000);
const candles1h = (mint, limit = 720) => candlesTF(mint, '1h', '1H', limit, 3600, 20 * 60 * 1000);
const candlesDay = (mint, limit = 1000) => candlesTF(mint, '1d', '1D', limit, 86400, 60 * 60 * 1000);

// chop-rate (2026-08-03) : sur les bougies récentes, quelle fraction des dumps REBONDIT (+8% avant -30%)
// vs continue à mourir (-30% = hors range). Chopper (NEEGY ~88%) → on cycle ; dumper (breadcat bas) → on
// bloque. Remplace les gates ATH : pas "a-t-il fait un nouvel ATH ?" mais "ses dumps rebondissent-ils ?".
function chopRate(cs, pump = 0.08, down = 0.30) {
    let i = 0; const n = cs.length; let wins = 0, cuts = 0;
    while (i < n - 1) {
        if (i >= 3 && cs[i][4] < Math.min(cs[i - 1][4], cs[i - 2][4], cs[i - 3][4])) {
            const E = cs[i][4]; let j = i + 1, done = false;
            while (j < n) {
                const p = cs[j][4];
                if (p >= E * (1 + pump)) { wins++; i = j + 1; done = true; break; }
                if (p <= E * (1 - down)) { cuts++; i = j + 1; done = true; break; }
                j++;
            }
            if (!done) i = n;
        } else i++;
    }
    const tot = wins + cuts;
    return tot >= 3 ? wins / tot : null; // besoin d'un minimum d'échantillon
}

// ── SuperTrend (10, 2) — ATR en RMA WILDER. MULTIPLICATEUR 3→2 (2026-07-29, GO user, backtest) : notre
// ST(10,3) divergeait de DexScreener/GMGN (identiques, autorité) — sur tokens volatils la bande était
// trop large → ratait les 1ers dumps (cas FRANK : rouge-vert-rouge sur les charts, vert chez nous).
// Backtest 23 tokens : mult3 = 2/23 patterns (trop strict), mult2 = 8/23 dont 5 gagnants / 1 perdant
// des nouveaux captés. mult=2 dans NOTRE calcul reproduit le rouge-vert-rouge affiché à (10,3) sur
// DexScreener/GMGN. Retourne [{i, trend, line}].
const ST_MULT = 2;
function superTrend(cs) {
    if (cs.length < 12) return [];
    const trs = [];
    for (let i = 1; i < cs.length; i++)
        trs.push(Math.max(cs[i][2] - cs[i][3], Math.abs(cs[i][2] - cs[i - 1][4]), Math.abs(cs[i][3] - cs[i - 1][4])));
    const out = []; let prev = null; let rma = null;
    for (let i = 10; i < cs.length; i++) {
        // RMA Wilder : seed = SMA des 10 premiers TR, puis rma = (rma×9 + TR)/10
        if (rma == null) rma = trs.slice(i - 10, i).reduce((s, v) => s + v, 0) / 10;
        else rma = (rma * 9 + trs[i - 1]) / 10;
        const atr = rma;
        const hl2 = (cs[i][2] + cs[i][3]) / 2;
        const bu = hl2 + ST_MULT * atr, bl = hl2 - ST_MULT * atr;
        let fu = bu, fl = bl;
        if (prev) {
            fu = (bu < prev.fu || cs[i - 1][4] > prev.fu) ? bu : prev.fu;
            fl = (bl > prev.fl || cs[i - 1][4] < prev.fl) ? bl : prev.fl;
        }
        const c = cs[i][4];
        const trend = !prev ? (c > fl ? 1 : -1) : prev.trend === 1 ? (c < fl ? -1 : 1) : (c > fu ? 1 : -1);
        prev = { trend, fu, fl };
        out.push({ i, trend, line: trend === 1 ? fl : fu });
    }
    return out;
}

// ── Pattern de sélection EP (transcript live 2h, 2026-07-22) — SHADOW, ne bloque RIEN ──────────────
// "break up la SuperTrend → 1er break down (là où snipers/bundlers/insiders/devs dumpent) → nouvel ATH
// APRÈS" = ruggers sortis, holders restants sérieux → coin safe pour bonus stage. On mesure sur l'univers
// réel (avec les rugs) le WR pattern-OK vs pattern-KO, avant d'envisager d'en faire un gate dur.
// Backtest offline (univers bot 1 présélectionné, donc sans rugs) : 2/23 tokens, 100% WR mais volume ×5
// plus faible → non concluant, d'où la mesure live.
function patternInfo(cs, st) {
    // PATTERN EP (2026-07-27, précision user sur chart BlackBear) : DUMP (ST ROUGE) → RECOVERY (ST re-verte
    // après le rouge) → NOUVEL ATH. On ne requiert PLUS un VERT AVANT le rouge : les JEUNES tokens pumpent
    // AVANT que la ST ait assez de données → la ST "apparaît" déjà ROUGE (1er pump/ATH/dump déjà passés),
    // puis flip VERTE au 2e pump. La séquence ROUGE→VERT signifie donc "1er dump fait, 2e ATH en cours".
    // Le 1er flip ROUGE (quel qu'il soit, y compris au démarrage) = le 1er dump ; fige l'ATH pré-dump.
    // Recovery = ST verte APRÈS ce rouge. Pattern validé = nouvel ATH > ATH pré-dump APRÈS la recovery.
    // (TRUMP2028 : jamais de rouge → jamais validé ; looong : rouge sans nouvel ATH → pas validé.)
    let ath = 0, athAtRed = null, recovered = false, ok = false, minAfterRed = null;
    let ath1 = null, ath2 = null;
    const stByI = new Map(st.map(p => [p.i, p]));
    for (let i = 0; i < cs.length; i++) {
        const h = cs[i][2], l = cs[i][3];
        if (h > ath) {
            ath = h;
            if (recovered && athAtRed != null && ath > athAtRed) { ok = true; ath2 = ath; } // nouvel ATH après recovery
        }
        const p = stByI.get(i);
        if (p && p.trend === -1 && athAtRed == null) { athAtRed = ath; ath1 = ath; }         // 1er ROUGE = 1er dump
        if (p && p.trend === 1 && athAtRed != null) recovered = true;                        // VERT après le rouge = recovery
        if (athAtRed != null && !ok && (minAfterRed == null || l < minAfterRed)) minAfterRed = l; // creux du dump
    }
    const dumpDepthPct = (athAtRed && minAfterRed != null) ? +((1 - minAfterRed / athAtRed) * 100).toFixed(0) : null;
    // ok = 1er rouge (dump) ET recovery (verte après) ET ath2>ath1 (nouvel ATH). Marche aussi si ST démarre rouge.
    return { ok, dumpDepthPct, ath1, ath2, flipRed: athAtRed != null };
}

// ── Indicateurs de SORTIE evil panda = bonus stage (copiés de bot 1, éprouvés) ────────────────────
// Sortie EP : RSI(2) > 90 ET (prix > BB sup OU 1re barre verte MACD) ET PnL > 0.
function calculateRSI(closes, period = 2) {
    if (closes.length < period + 1) return null;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const ch = closes[i] - closes[i - 1];
        if (ch > 0) avgGain += ch; else avgLoss += Math.abs(ch);
    }
    avgGain /= period; avgLoss /= period;
    for (let i = period + 1; i < closes.length; i++) {
        const ch = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}
function calculateEMA(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
}
function calculateMACD(closes) {
    if (closes.length < 35) return null;
    const mv = [];
    for (let i = 26; i <= closes.length; i++) {
        const s = closes.slice(0, i); const e12 = calculateEMA(s, 12), e26 = calculateEMA(s, 26);
        if (e12 !== null && e26 !== null) mv.push(e12 - e26);
    }
    if (mv.length < 9) return null;
    const cM = mv[mv.length - 1], pM = mv[mv.length - 2];
    const cS = calculateEMA(mv, 9), pS = calculateEMA(mv.slice(0, -1), 9);
    if (cS === null || pS === null) return null;
    return { histogram: cM - cS, histogramTurnsGreen: (pM - pS) <= 0 && (cM - cS) > 0 };
}
function bollinger(closes, n = 20, k = 2) {
    if (closes.length < n) return null;
    const w = closes.slice(-n); const sma = w.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - sma) ** 2, 0) / n);
    return { upper: sma + k * sd, lower: sma - k * sd, sma };
}

// ── Filtre qualité GMGN (2026-07-15) — mêmes seuils que bot 1 : holders ≥ 1000, top10 ≤ 30%,
// insiders ≤ 10%, honeypot/flags dangereux. Appelé UNE fois par token, à l'ajout en watch.
// Fail-open si GMGN_API_KEY absente ou API en erreur (on ne rend pas le bot aveugle sur un 429).
const { randomUUID } = require('crypto');
const https = require('https');
const GMGN_AGENT = new https.Agent({ family: 4 });
const GMGN_BASE = 'https://openapi.gmgn.ai';
const GMGN_KEY = (process.env.GMGN_API_KEY || '').trim();
const gmgnRejected = new Map(); // tok -> ts (ne pas re-tester un rejeté à chaque scan GT)
const gmgnAthPrice = new Map(); // tok -> ath_price GMGN (ATH de vie officiel, capturé au check qualité)
const profilWarned = new Set(); // tok déjà loggé [SHADOW profil] — anti-spam (RACY 60×/h le 20/07)
let gmgnKeyWarned = false;
async function gmgnQualityOk(tok, sym) {
    if (!GMGN_KEY) {
        if (!gmgnKeyWarned) { gmgnKeyWarned = true; console.log('⚠️ GMGN_API_KEY absente — filtre qualité DÉSACTIVÉ (ajouter la var sur Railway)'); }
        return true; // fail-open
    }
    const rej = gmgnRejected.get(tok);
    if (rej && Date.now() - rej < 6 * 3600 * 1000) return false; // rejeté récemment → skip direct
    try {
        const auth = () => ({ timestamp: Math.floor(Date.now() / 1000), client_id: randomUUID() });
        const [infoR, secR] = await Promise.all([
            axios.get(`${GMGN_BASE}/v1/token/info`, { httpsAgent: GMGN_AGENT, headers: { 'X-APIKEY': GMGN_KEY }, params: { chain: 'sol', address: tok, ...auth() }, timeout: 10000 }),
            axios.get(`${GMGN_BASE}/v1/token/security`, { httpsAgent: GMGN_AGENT, headers: { 'X-APIKEY': GMGN_KEY }, params: { chain: 'sol', address: tok, ...auth() }, timeout: 10000 }),
        ]);
        const info = infoR.data?.data, sec = secR.data?.data;
        if (!info || !sec) return true; // data manquante → fail-open
        // ATH de vie officiel GMGN (2026-07-22, idée user) — capturé ici (0 appel en plus), lu à l'ajout watch
        if (info.ath_price) gmgnAthPrice.set(tok, parseFloat(info.ath_price));
        const holders = info.holder_count || 0;
        const top10raw = sec.top_10_holder_rate ?? 0;
        const top10 = top10raw <= 1 ? top10raw * 100 : top10raw;
        const insRaw = sec.insider_rate ?? 0;
        const insiders = insRaw <= 1 ? insRaw * 100 : insRaw;
        const flags = JSON.stringify(sec.flags || []).toLowerCase();
        const dangerous = sec.is_honeypot || ['vamped', 'rapidlaunch', 'bundled_launch'].some(f => flags.includes(f));
        // Règle EP n°1 (2026-07-19) : "demande réelle" = fees totales GMGN ≥ 30 SOL. Un token qui
        // affiche $1M de volume avec < 30 SOL de fees = wash trading ("your neighbor is lying").
        const totalFee = info.total_fee != null ? parseFloat(info.total_fee) : null;
        // Règle EP n°3b : phishing wallets ≤ 20% (rugcheck) + CLUSTERS "virus" (2026-07-22, demande user)
        // = insiderNetworks de rugcheck = les paquets de wallets connectés (équivalent des "virus clusters"
        // bubblemaps qu'EP refuse à l'œil). Règle : plus gros cluster ≥ 10% (le "12-14% cluster" d'EP) OU
        // total réseaux insiders ≥ 40% → rejet. (GMEBULL : plus gros 2.9%, total 14% → passe, comme EP.)
        let phishPct = null, maxClusterPct = null, totalInsiderPct = null;
        try {
            const rug = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tok}/report`, { timeout: 8000 });
            const topHolders = rug.data?.topHolders || [];
            const known = rug.data?.knownAccounts || {};
            phishPct = topHolders.reduce((s, h) => known[h.owner]?.type === 'PHISHING' ? s + (h.pct || 0) : s, 0);
            const nets = rug.data?.insiderNetworks || [];
            const supplyRaw = parseFloat(rug.data?.token?.supply || 0);
            if (supplyRaw > 0 && nets.length) {
                const pcts = nets.map(n => 100 * (n.tokenAmount || 0) / supplyRaw);
                maxClusterPct = Math.max(...pcts);
                totalInsiderPct = pcts.reduce((s, v) => s + v, 0);
            }
        } catch (_) { /* rugcheck KO → fail-open sur ce critère */ }
        // ÉTABLI (2026-08-08, cas ANSEM) : un coin avec bcp de holders / gros MC a survécu des semaines →
        // la concentration top10/insiders n'est PLUS un signal de rug (ANSEM 192M, top10 63% = EP le scalpe).
        // On relâche les rug-guards de CONCENTRATION pour les établis, on les garde stricts pour le frais.
        const mcUsd = parseFloat(info.market_cap ?? info.usd_market_cap ?? info.fdv ?? 0);
        const established = holders >= 5000 || mcUsd >= 5_000_000;
        const fails = [];
        if (holders < 1000) fails.push(`holders ${holders}`);
        if (top10 > (established ? 85 : 30)) fails.push(`top10 ${top10.toFixed(0)}%`);
        if (!established && insiders > 10) fails.push(`insiders ${insiders.toFixed(0)}%`);
        if (dangerous) fails.push('honeypot/flag');
        // fees ≥ 30 SOL EN DUR (2026-07-22, demande user) : EP l'exige (« demande réelle », anti-wash).
        // Le souci "token jeune pas encore 30 SOL" tombe : on cible désormais des coins PLUS VIEUX
        // (post-1er-dump), qui ont eu le temps d'accumuler → gate légitime.
        if (totalFee != null && totalFee < 30) fails.push(`fees ${totalFee.toFixed(0)} SOL < 30`);
        if (phishPct != null && phishPct > 20) fails.push(`phishing ${phishPct.toFixed(0)}% > 20%`);
        // Clusters "virus" (rugcheck insiderNetworks) EN SHADOW (2026-07-22, demande user) : on mesure,
        // on ne bloque pas. Seuils candidats : plus gros cluster ≥ 10% OU total insiders ≥ 40%.
        if (maxClusterPct != null && (maxClusterPct >= 10 || totalInsiderPct >= 40))
            console.log(`⚠️ [SHADOW clusters] ${sym}: plus gros ${maxClusterPct.toFixed(1)}% | total insiders ${totalInsiderPct.toFixed(0)}% — mesure seule (ne bloque pas)`);
            recordShadow('clusters', { symbol: sym, maxClusterPct: +maxClusterPct.toFixed(1), totalInsiderPct: +totalInsiderPct.toFixed(0) });
        if (fails.length) {
            gmgnRejected.set(tok, Date.now());
            console.log(`🚫 Qualité GMGN: ${sym} rejeté (${fails.join(', ')})`);
            return false;
        }
        return true;
    } catch (e) {
        return true; // 429/timeout → fail-open, pas de blocage aveugle
    }
}

// ── Indicateurs trigger (2026-07-19, grille backtest 15m : rec8h+stoch = 83% WR/+3.64%/trade
// vs base 57%/+0.94 ; le 5m testé = TOUTES variantes négatives → 15m canonique confirmé) ──
function stochK(cs) {
    // Stoch RSI(14,14,3) %K par bougie (null tant que pas assez d'historique)
    const closes = cs.map(c => c[4]); const n = closes.length;
    const rsis = new Array(n).fill(null);
    if (n >= 15) {
        let g = 0, l = 0;
        for (let i = 1; i <= 14; i++) { const ch = closes[i] - closes[i - 1]; g += Math.max(ch, 0); l += Math.max(-ch, 0); }
        let ag = g / 14, al = l / 14;
        rsis[14] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
        for (let i = 15; i < n; i++) {
            const ch = closes[i] - closes[i - 1];
            ag = (ag * 13 + Math.max(ch, 0)) / 14;
            al = (al * 13 + Math.max(-ch, 0)) / 14;
            rsis[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
        }
    }
    const raw = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        if (rsis[i] == null) continue;
        const win = [];
        for (let j = Math.max(0, i - 13); j <= i; j++) if (rsis[j] != null) win.push(rsis[j]);
        if (win.length < 14) continue;
        const mn = Math.min(...win), mx = Math.max(...win);
        raw[i] = mx === mn ? 0 : (rsis[i] - mn) / (mx - mn) * 100;
    }
    const sk = new Array(n).fill(null);
    for (let i = 2; i < n; i++) {
        if (raw[i] == null || raw[i - 1] == null || raw[i - 2] == null) continue;
        sk[i] = (raw[i] + raw[i - 1] + raw[i - 2]) / 3;
    }
    return sk;
}
function emaLast(cs, n) {
    // EMA(n) sur closes 15m — null si < n bougies. Seed = SMA des n premières, puis EMA classique.
    const closes = cs.map(c => c[4]);
    if (closes.length < n) return null;
    const k = 2 / (n + 1);
    let e = closes.slice(0, n).reduce((s, v) => s + v, 0) / n;
    for (let i = n; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    return e;
}
const ema100Last = cs => emaLast(cs, 100); // support des alertes EP (25h d'historique — souvent null)

// ── Réconciliation on-chain des positions LIVE (2026-07-25, GO user) : le bot ne vérifiait jamais que
// ses positions live existaient encore → une coupe MANUELLE (Meteora) laissait un fantôme qui squattait
// un slot indéfiniment (le bot ne s'en apercevait qu'au prochain RSI2>90). Ici on liste les positions
// réelles du wallet et on nettoie celles qui ont disparu (fermées à la main) → trade manualClose + slot
// libéré. Pattern de bot 1. Appelée 1×/scan complet (pas sur les ticks chauds, pour économiser le RPC.
async function reconcileLivePositions() {
    if (!live.enabled || !live.positionState) return;
    const tracked = Object.entries(state.positions).filter(([, p]) => p.live);
    for (const [tok, p] of tracked) {
        const st = await live.positionState(p.live); // 'open' | 'closed' | 'unknown'
        if (st === 'closed') {
            // position live disparue on-chain = fermée manuellement → nettoyage + comptabilité
            console.log(`🧹 Position live ${p.symbol} fermée à la main (absente on-chain) — nettoyage tracking`);
            const trade = {
                symbol: p.symbol, entry: p.entry, exit: null, pnlPct: null, pnlSol: null, pnlSolLive: null,
                manualClose: true, ageH: p.ageH, athMc: p.athMc, support: p.support ?? null, patternOk: p.patternOk ?? null,
                durMin: Math.round((Date.now() - p.openedAt) / 60000),
                openedAt: new Date(p.openedAt).toISOString(), closedAt: new Date().toISOString(), reason: 'close MANUEL (hors bot)',
            };
            state.trades.push(trade);
            trackManualClose(tok, p); // shadow regret : suivi post-close (coupe à la main hors bot)
            delete state.positions[tok];
            if (state.watch[tok]) state.watch[tok].cooldownUntil = Date.now() + REENTRY_COOLDOWN_MS;
            tg(`🧹 ${p.symbol}: position live fermée à la main détectée — tracking nettoyé, slot libéré`);
        } else if (st === 'open' && p.live.openValueSol == null && live.positionValueSol) {
            // Auto-réparation : la valeur d'ouverture a échoué à l'open (RPC pas encore indexé) →
            // openValueSol=null = PnL non mesurable. Maintenant que la position est indexée, on
            // ré-inscrit une base propre (best-effort). Rattrapé vite = quasi-exact.
            try {
                const v = await live.positionValueSol(p.live);
                if (v != null) {
                    p.live.openValueSol = v;
                    console.log(`🩹 ${p.symbol}: openValueSol ré-inscrite (${v.toFixed(4)} SOL) — base PnL restaurée`);
                }
            } catch (e) { console.log(`reconcile openValueSol ${p.symbol}:`, e.message); }
        }
    }
    save();
}

// ── Boucle principale ─────────────────────────────────────────
let scanning = false;
let scanOffset = 0; // rotation du point de départ de la boucle watch (équité sous backoff 429)
let scanTick = 0;
async function scan() {
    if (scanning) return; scanning = true;
    try {
        const now = Date.now();
        if (!state.purgedAt) state.purgedAt = {};
        // Tick alterné (2026-07-19) : pair = scan COMPLET (découverte + tous les tokens, cadence 60s
        // comme avant) ; impair = UNIQUEMENT tokens chauds (4/5 conditions) + positions → réactivité 30s
        // là où ça compte, sans doubler la charge GT.
        const hotOnly = (scanTick++ % 2) === 1;
        // Réconciliation on-chain des positions live (ticks complets seulement) — détecte les coupes manuelles
        if (!hotOnly) { try { await reconcileLivePositions(); } catch (e) { console.log('reconcile:', e.message); } }
        // 1. découverte : nouveaux candidats < 48h (ticks complets uniquement)
        let discovered = [];
        if (!hotOnly) { try { discovered = await gtTrending(); } catch (e) { console.log('GT indisponible:', e.message); } }
        for (const { tok, gtPool } of discovered.slice(0, 60)) { // 4-6 sources fusionnées (GT p1-3 + 1h + new + DexScreener) — trending d'abord
            if (state.watch[tok] || state.positions[tok]) continue;
            // cooldown re-add 30min après purge (sinon cycle purge→re-add sur les tokens trending morts)
            if (state.purgedAt[tok] && now - state.purgedAt[tok] < 30 * 60 * 1000) continue;
            if (Object.keys(state.watch).length >= 18) break; // cap suivi 12→18 (2026-07-19, budget GT ok avec ticks alternés)
            try {
                const d = await dexInfo(tok);
                if (!d || !d.birthMs || !d.supply) continue;
                const ageH = (now - d.birthMs) / 3.6e6;
                // L'âge n'est plus un critère (paliers TF + ATH≤14j) — juste le garde-fou zombies 1 an.
                if (ageH >= AGE_MAX_H || d.vol24h < VOL_MIN_24H) continue;
                // MC EN PREMIER (2026-07-22, demande user) : MC pas bonne → skip IMMÉDIAT, avant l'appel
                // qualité GMGN (comme bot 1). Seuil = MC_MIN_ATH (250k), identique à l'entrée : un token
                // < 250k ne peut PAS entrer, inutile de le suivre.
                if (d.mc < MC_MIN_ATH) continue;
                // Règle EP n°5 (profil DexScreener payé + X) : SHADOW (2026-07-19, décision user) —
                // on logge UNE FOIS par token (anti-spam : RACY loggé 60×/h le 20/07), on ne bloque pas.
                const profilOk = d.hasTwitter && d.hasImage;
                if (!profilOk && !profilWarned.has(tok)) {
                    profilWarned.add(tok);
                    console.log(`⚠️ [SHADOW profil] ${d.symbol}: profil DexScreener incomplet (Twitter:${d.hasTwitter} image:${d.hasImage}) — mesure seule`);
                    recordShadow('profil', { symbol: d.symbol, twitter: !!d.hasTwitter, image: !!d.hasImage });
                }
                // Filtre qualité GMGN (2026-07-15, copié de bot 1) : l'univers GT trending est pollué
                // (paper 29% WR vs 46-50% sur l'univers bot 1 filtré). 1 appel à l'ajout seulement.
                if (!(await gmgnQualityOk(tok, d.symbol))) continue;
                // bougies : pool GT du trending (garantie indexée) en priorité, DexScreener en fallback
                // pool = ORIGINE (historique complet, fix migration 2026-07-25) ; poolAlt = fallback (GT
                // trending / plus liquide) si l'origine n'est pas indexée par GeckoTerminal.
                state.watch[tok] = { symbol: d.symbol, pool: d.poolAnalysis || gtPool || d.pool, poolAlt: gtPool || d.pool, birthMs: d.birthMs, supply: d.supply, profilOk, athGmgn: gmgnAthPrice.get(tok) || null, addedAt: now, nextCheckAt: now + Math.floor(Math.random() * 30e3) };
                console.log(`👀 Suivi: ${d.symbol} (âge ${ageH.toFixed(1)}h, vol $${Math.round(d.vol24h / 1000)}k, pool ${gtPool ? 'GT' : 'dex'})`);
            } catch (_) {}
        }

        // 2. pour chaque token suivi : setup / entrée / gestion de position papier
        let rl429 = 0; // 429 vus ce tick — au 2e, on arrête de fetch (backoff global, le cache sert le reste)
        let cOk = 0, cKo = 0; // santé source bougies ce tick (pour le résumé de scan — repère une panne, cas bot 1)
        // ROTATION (2026-07-24, GO user) : l'ordre d'itération était fixe → quand le backoff 429 coupait
        // le tick, c'était TOUJOURS la même queue de liste qui sautait → 8 tokens jamais évalués (diag
        // None depuis des heures). Départ tournant : chaque token passe en tête à tour de rôle.
        const watchEntries = Object.entries(state.watch);
        scanOffset = (scanOffset + 1) % Math.max(watchEntries.length, 1);
        const rotated = [...watchEntries.slice(scanOffset), ...watchEntries.slice(0, scanOffset)];
        for (const [tok, w] of rotated) {
            const inPos = !!state.positions[tok];
            // FRÉQUENCE ADAPTATIVE (2026-07-27, idée user) : un token LOIN de l'entrée (-35%) n'a pas besoin
            // d'être checké souvent → on concentre les appels GT là où ça compte (proche entrée / positions).
            // dd<20% → 10min ; 20-30% → 3min ; ≥30% → 1min ; position → chaque tick (pour la sortie).
            // Divise la charge GT ~×5-8 → fin de la famine 429 (13/18 tokens jamais évalués).
            if (!inPos && w.nextCheckAt && now < w.nextCheckAt) continue;
            const ageH = (now - w.birthMs) / 3.6e6;
            if (ageH >= AGE_MAX_H && !inPos) { delete state.watch[tok]; continue; } // garde-fou zombies 1 an
            if (rl429 >= 3 && !inPos) continue; // backoff : GT sature, on réessaie au prochain tick (seuil 2→3)
            let cs;
            // Birdeye TOKEN-LEVEL (tok = mint) : 192×15m=48h pour support/sortie. Suit la migration
            // nativement → plus de bricolage pool (poolAlt/origine supprimé). Le throttle est global.
            try { cs = await candles15(tok, 192); } catch (e) { cs = null; w.lastFetchErr = (e.message || '').slice(0, 60); }
            // Purge fetch cassé (2026-07-19) : après 8 échecs consécutifs, on libère le slot — MAIS un 429
            // (rate-limit) n'est PAS une pool morte (2026-07-22 : les purges 429 tuaient des tokens
            // QUALIFIÉS comme Jimothy911) → le 429 ne compte plus comme échec, il déclenche le backoff.
            if (!cs || cs.length === 0) {
                // STOP RÉSILIENT (2026-08-09) : bougies KO ≠ position sans stop. Pour un LIVE, la valeur LP
                // on-chain ne dépend PAS des bougies → on évalue trail + CUT même en panne de data feed
                // (sinon un hoquet GMGN laisse la position nue, cas vu le 09/08). Chemin normal inchangé.
                if (inPos) {
                    const posO = state.positions[tok];
                    if (posO.live && live.enabled && live.positionValueAndBin && posO.live.openValueSol) {
                        try {
                            const r = await live.positionValueAndBin(posO.live);
                            if (r && r.valueSol != null) {
                                const rg = r.valueSol / posO.live.openValueSol - 1;
                                posO.peakGain = Math.max(posO.peakGain || 0, rg);
                                const armedO = posO.peakGain >= 0.06;
                                console.log(`📊 ${posO.symbol} | LP ${(rg * 100).toFixed(1)}% | peak ${(posO.peakGain * 100).toFixed(1)}% | ${armedO ? 'armé✓' : 'pas-armé'} | trail≤${((posO.peakGain - 0.01) * 100).toFixed(1)}% | src:live | bougies-KO`);
                                const exitPx = posO.lastPx || posO.entry;
                                if (r.activeBinId != null && posO.live.upperBinId != null && r.activeBinId > posO.live.upperBinId) { await closePaper(tok, posO, exitPx, `CUT hors-range HAUT (banké +${(rg * 100).toFixed(1)}% LP, bougies KO)`); continue; }
                                if (armedO && rg <= posO.peakGain - 0.01) { await closePaper(tok, posO, exitPx, `TRAIL LP +${(rg * 100).toFixed(1)}% (peak +${(posO.peakGain * 100).toFixed(1)}%, bougies KO)`); continue; }
                                if (rg <= -0.35) { await closePaper(tok, posO, exitPx, `CUT valeur LP ${(rg * 100).toFixed(1)}% (≤ -35% hors-range, bougies KO)`); continue; }
                            }
                        } catch (_) { /* valeur live KO aussi → rien à faire, on garde la position */ }
                    }
                }
                // BACK-OFF du token qui échoue (2026-07-27) : sinon les tokens sans cache sont re-tentés
                // CHAQUE tick → 429 en boucle (chicken-and-egg : nextCheckAt n'était posé qu'après succès).
                // On les recule de 90s → ils cessent de marteler GT → GT récupère → fetchs réussis.
                if (!inPos) w.nextCheckAt = now + 90e3;
                if (/429/.test(w.lastFetchErr || '')) { rl429++; if (rl429 === 1) console.log(`  ⏳ GT rate-limit (429) ce tick — backoff, le cache prend le relais`); continue; }
                cKo++;
                if (!state.positions[tok]) {
                    w.fetchFails = (w.fetchFails || 0) + 1;
                    if (w.fetchFails >= 8) {
                        console.log(`🧹 Purge watch: ${w.symbol} (${w.fetchFails} échecs bougies consécutifs — ${w.lastFetchErr || 'réponse vide'})`);
                        state.purgedAt[tok] = now;
                        delete state.watch[tok];
                    }
                }
                continue;
            }
            w.fetchFails = 0;
            cOk++;
            if (cs.length < 15) continue;
            // Purge cadavres (2026-07-19) : MC courante < MC_MIN_ATH (250k, aligné entrée 2026-07-22) →
            // le token ne peut plus entrer et squatte un slot. Cooldown re-add 60min évite l'oscillation.
            const mcNow = cs[cs.length - 1][4] * w.supply;
            if (mcNow < MC_MIN_ATH && !state.positions[tok]) {
                console.log(`🧹 Purge watch: ${w.symbol} (MC $${Math.round(mcNow / 1000)}k < ${Math.round(MC_MIN_ATH / 1000)}k — a dumpé après ajout)`);
                state.purgedAt[tok] = now;
                delete state.watch[tok];
                continue;
            }
            const st = superTrend(cs);
            if (!st.length) continue;
            const last = st[st.length - 1];
            const lastC = cs[cs.length - 1];
            const pos = state.positions[tok];

            // (A/B "TP fixe +6%" RETIRÉ 2026-07-22 — comparait trailing vs fixe, obsolète depuis la sortie EP)
            if (pos) {
                // ── SORTIE EP CANONIQUE (2026-07-22) : RSI(2)>90 sur bougie FERMÉE + PnL>0. SEULE sortie.
                // PAS de SL, PAS de coupe-temps (2026-07-23, décision user) — EP TIENT pour le rebond,
                // jusqu'à 9 jours ("I just left it there... after 9 days it bounced, closed in profits ;
                // you must wait for your exit criteria no matter what"). Le coupe-temps 24h était la règle
                // de l'EVIL PANDA (LP au sommet), PAS du bonus stage (dip au support) → retiré. La
                // protection = le pattern (le coin rebondit) + petites positions (jamais all-in).
                // ── SHADOW STACKING (2026-07-27, demande user) : EP ajoute une position quand la 1re est à
                // ~-10% ("I open the second when the first is about minus 10%", jusqu'à 3-5 positions). On
                // MESURE seulement (n'ouvre RIEN) : on logge chaque palier -10% franchi + on note la
                // profondeur max atteinte sur le trade → après quelques trades on saura si le stacking aide
                // (un trade qui plonge à -30% puis sort vert = le stacking aurait baissé le prix moyen).
                // ── SORTIE REFONTE EP CHOP-CYCLE (2026-08-03) : monitoring en 5m (EP cycle vite, ~1 cycle/6h
                // sur NEEGY). Exit = TP +6% PnL OU RSI2>90 (tous deux en profit). CUT HORS-RANGE si le prix
                // sort par le bas du ±34 (≈-30%) = fermeture STRUCTURELLE d'EP (ligne 108) → le cycle
                // ré-ouvrira plus bas si le coin chope encore (chop-rate, Phase 2).
                // TF de sortie ADAPTATIF (2026-08-08, cas STONK/CATE LP 0%) : un ÉTABLI (MC≥5M) chope DOUX sur
                // des heures → RSI(2) 5m explose sur un micro-wiggle → sort à LP ~0% avant le vrai bounce. On
                // le monitore en 15m. NEW/VOLATIL = 5m INCHANGÉ (verrouillé sur pos.established, défaut 5m).
                let pcs = cs;
                try { const c = pos.established ? await candles15(tok, 200) : await candles5(tok, 200); if (c && c.length >= 5) pcs = c; } catch (_) { /* fallback */ }
                const plast = pcs[pcs.length - 1];
                const px = plast[4];
                pos.lastPx = px;   // mémorisé pour le PnL papier du stop résilient (si les bougies tombent ensuite)
                const dropFromEntry = 1 - px / pos.entry;
                const gain = px / pos.entry - 1;
                const RANGE_DOWN = 0.35, TP_PCT = 0.06;  // uniforme (à recaler sur le % réel d'EP — mesure en cours)
                // #1 TP sur la VRAIE valeur LP (2026-08-04) : le prix ≠ gain LP sur un Bid-Ask (liquidité aux
                // EXTRÊMES → un +9% au milieu capte ~0, cas CATE). En LIVE on lit positionValueSol (net
                // fees+swaps) ; en paper on garde le prix (approx). On ne ferme que sur un gain LP RÉEL.
                let realGain = gain, liveBinId = null;
                if (pos.live && live.enabled && live.positionValueAndBin && pos.live.openValueSol) {
                    try { const r = await live.positionValueAndBin(pos.live); if (r && r.valueSol != null) { realGain = r.valueSol / pos.live.openValueSol - 1; liveBinId = r.activeBinId; } } catch (_) { /* fallback prix */ }
                }

                // CUT HORS-RANGE HAUT (2026-08-09, cas LOUIE +50% prix) : prix sorti par le HAUT du ±34 → la
                // valeur LP est FIGÉE en SOL (plus de token à vendre) → ni trail ni RSI ne peuvent fermer, et
                // on rend le gain si le prix redescend. Bin actif > upperBinId → on banke et le cycle ré-ouvre
                // plus bas (règle EP : cassure hors-range = close, HAUT comme bas). 0 fee hors range de toute façon.
                if (liveBinId != null && pos.live.upperBinId != null && liveBinId > pos.live.upperBinId) {
                    await closePaper(tok, pos, px, `CUT hors-range HAUT (banké +${(realGain * 100).toFixed(1)}% LP, bin ${liveBinId}>${pos.live.upperBinId})`);
                    continue;
                }

                // CUT HORS-RANGE : prix sorti par le bas du ±34 → close (plus de fees hors range).
                if (dropFromEntry >= RANGE_DOWN) {
                    await closePaper(tok, pos, px, `CUT hors-range (-${(dropFromEntry * 100).toFixed(0)}%, sorti du ±34)`);
                    continue;
                }

                // SHADOW stacking (mesure only, inchangé)
                const stackLevel = dropFromEntry > 0 ? Math.floor(dropFromEntry / 0.10) : 0;
                if (stackLevel >= 1 && stackLevel > (pos.stacksLogged || 0) && stackLevel <= 5) {
                    pos.stacksLogged = stackLevel;
                    if (stackLevel > (pos.maxStackLevel || 0)) pos.maxStackLevel = stackLevel;
                    recordShadow('stacking', { symbol: pos.symbol, level: stackLevel + 1, dropPct: +(dropFromEntry * 100).toFixed(0) });
                }

                // SORTIE = TP 5-7% PnL LP (comme EP, ligne 108) OU RSI2>90 en profit — sur le gain LP RÉEL.
                // (Anti-churn retiré : l'entrée RSI-survendu empêche déjà d'ouvrir en plein pump.)
                // TRAILING (2026-08-04, data live : le RSI coupait les gains à +2.5% vs cuts -30%, breakeven).
                // - Runner : dès +6% LP (armé), on TRAIL 1% → sort quand ça retombe 1% sous le peak (ride le
                //   pump, ex JLY +12%). - Petit bounce pas encore armé : RSI2>90 + profit (scalp). Sur realGain.
                pos.peakGain = Math.max(pos.peakGain || 0, realGain);
                const armed = pos.peakGain >= TP_PCT;   // +6% LP atteint
                const TRAIL = 0.01;   // uniforme

                // LOG position par scan (2026-08-09) : fin du silence de bot 2 + audit sortie. On affiche TOUT
                // ce que le bot VOIT — LP, prix, RSI2 (= notre critère de sortie), RSI14 (comparable DexScreener,
                // cas bot 1 où notre RSI divergeait), bin actif→haut du range, source valeur, timeframe.
                const realSource = liveBinId != null ? 'live' : 'prix';
                const rsi2v = calculateRSI(pcs.slice(0, -1).map(c => c[4]), 2);
                const rsi14v = calculateRSI(pcs.slice(0, -1).map(c => c[4]), 14);
                console.log(`📊 ${pos.symbol} | LP ${(realGain * 100).toFixed(1)}% | peak ${(pos.peakGain * 100).toFixed(1)}% | ${armed ? 'armé✓' : 'pas-armé'} | trail≤${((pos.peakGain - TRAIL) * 100).toFixed(1)}% | prix ${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(1)}% | RSI2 ${rsi2v != null ? rsi2v.toFixed(0) : '—'} · RSI14 ${rsi14v != null ? rsi14v.toFixed(0) : '—'} | bin ${liveBinId != null ? liveBinId : '—'}→${pos.live?.upperBinId ?? '—'} | src:${realSource} | ${pos.established ? '15m' : '5m'}`);

                // TRAILING TEMPS RÉEL (2026-08-09, cas STONK sorti à la main) : le trail est un STOP de
                // protection → il agit sur la valeur LP live à CHAQUE scan, PLUS derrière candleAfterEntry
                // (sinon il attend une bougie 15m clôturée = 15 min de retard, rate les pullbacks rapides).
                if (armed && realGain <= pos.peakGain - TRAIL) {
                    await closePaper(tok, pos, px, `TRAIL LP +${(realGain * 100).toFixed(1)}% (peak +${(pos.peakGain * 100).toFixed(1)}%)`);
                    continue;
                }

                // RSI2>90 = scalp au top quand pas encore armé → reste sur bougie CLÔTURÉE (le RSI en a besoin).
                const candleAfterEntry = plast[0] > (pos.entryCandleTs || 0);
                if (!armed && candleAfterEntry) {
                    const rsi2 = calculateRSI(pcs.slice(0, -1).map(c => c[4]), 2);
                    if (rsi2 != null && rsi2 > 90 && realGain > 0) {
                        await closePaper(tok, pos, px, `RSI2 ${rsi2.toFixed(0)}>90 (LP +${(realGain * 100).toFixed(1)}%)`);
                        continue;
                    }
                }
                continue;
            }

            // ── SETUP EP BONUS STAGE (2026-07-22, refonte) : sur un coin QUALIFIÉ par le pattern
            // (breakup→breakdown→nouvel ATH = ruggers sortis), entrer quand le prix a retracé ≥40% sous
            // l'ATH courant ET touche un support (ligne ST / bande basse Bollinger / EMA34). PAS d'exigence
            // ST verte : on entre sur le DIP (ST souvent rouge à -40/-50%), en pariant sur le rebound.
            // ── MACRO (ATH, pattern, drawdown) — PALIERS de timeframe selon l'âge (2026-07-22, GO user) :
            // comme un humain qui zoome. <48h → 192×15m (toute la vie) ; 48h-30j → 720×1H ; >30j →
            // daily×1000 (~3 ans). L'ÂGE N'EST PLUS UN CRITÈRE (EP : "no minimum age", il a ouvert FOMO
            // sur un chart daily en live) — le travail est fait par pattern + ATH récent ≤14j.
            let ms = cs;
            if (ageH >= 720) { try { const ds = await candlesDay(tok, 1000); if (ds && ds.length >= 12) ms = ds; } catch (_) { /* fallback cs */ } }
            else if (ageH >= 48) { try { const hs = await candles1h(tok, 720); if (hs && hs.length >= 12) ms = hs; } catch (_) { /* fallback cs */ } }
            // ATH = celui des BOUGIES (2026-07-23, décision user) : avec les paliers de TF (daily pour les
            // vieux coins ≈ 3 ans), l'ATH bougies EST l'ATH de vie. Plus de dépendance à GMGN (souvent None
            // sur les vieux coins). Le gate ATH-récent ≤14j gère les zombies : ATH ancien = bloqué.
            let ath = 0, athTs = 0;
            for (const c of ms) if (c[2] > ath) { ath = c[2]; athTs = c[0]; }
            const athMc = ath * w.supply;
            const armed = athMc > MC_MIN_ATH;                       // a fait un ATH > 250K dans sa vie
            // GATE DUR pattern EP — qualification COLLANTE (2026-07-22) : une fois validé (ruggers sortis),
            // c'est ACQUIS ("by that time they already out"). Sans ça, la fenêtre de bougies glissante
            // dé-qualifiait un token quand le breakup/breakdown sortait de la fenêtre.
            const pInfo = patternInfo(ms, ms === cs ? st : superTrend(ms));
            if (pInfo.ok && !w.patternValidated) { w.patternValidated = true; console.log(`  ✓ pattern EP VALIDÉ: ${w.symbol} — ATH1 ${pInfo.ath1?.toExponential(2)} → flip ST rouge (dump -${pInfo.dumpDepthPct}%) → ATH2 ${pInfo.ath2?.toExponential(2)} (2e ATH > 1er, +${pInfo.ath1 ? (((pInfo.ath2/pInfo.ath1)-1)*100).toFixed(0) : '?'}%) — qualification acquise`); }
            const patOk = !!w.patternValidated;
            // VRAI ATH via lookback DAILY (2026-07-29, cas dog) : la fenêtre 1H/15m ne remonte pas assez
            // loin pour les vieux coins (dog 694h : la série 1H ne voyait que $2.33M, alors que le VRAI ATH
            // était $8.78M le 30/06). Résultat : le bot validait un dead-cat bounce à -73% sous l'ATH comme
            // un "nouvel ATH". EP veut un VRAI nouvel ATH (force), pas un rebond de cadavre. On croise donc
            // le plus haut récent (ath) avec le plus haut de vie (daily) et on exige qu'il en soit proche.
            // Fetch UNIQUEMENT si patOk (candidats only) et ageH≥48h (sous 48h la série courte = toute la vie).
            let trueAth = ath;
            if (patOk && ageH >= 48) {
                try { const ds = await candlesDay(tok, 1000); if (ds && ds.length) for (const c of ds) if (c[2] > trueAth) trueAth = c[2]; } catch (_) { /* fallback ath */ }
            }
            // ATH officiel GMGN (capturé au check qualité, w.athGmgn) CROISÉ avec les bougies : on prend le
            // PLUS HAUT des deux → on ne sous-estime JAMAIS l'ATH de vie (sinon un pump local passerait pour
            // un ATH et un dead-cat serait qualifié). GMGN souvent null sur vieux coins → daily prend le relais.
            if (w.athGmgn && w.athGmgn > trueAth) trueAth = w.athGmgn;
            // Max glissant du vrai ATH (2026-07-29) : référence STABLE pour la ré-entrée (nouvel ATH global).
            // Compteur de CASSURES D'ATH (règle EP ligne 79 : 2e/3e OK, 4e = MAX → pump épuisé, rug probable
            // après → on ne LP plus). Compte les vrais nouveaux plus-hauts de vie (>2% au-dessus du max), pas
            // les cycles. 1re observation = pas une cassure.
            if (w.maxTrueAth == null) w.maxTrueAth = trueAth;
            else if (trueAth > w.maxTrueAth * 1.02) { w.maxTrueAth = trueAth; w.athBreaks = (w.athBreaks || 0) + 1; }
            // Migration transition (2026-07-29) : tout token DÉJÀ tradé avant ce fix (position ouverte OU
            // marqueur d'entrée antérieure lastEntryAth/lastEntryTrueAth) n'a pas de lastEntryPeak → on
            // l'initialise au max COURANT. Effet : il ne pourra ré-entrer que sur un vrai NOUVEL ATH global
            // (> max courant), jamais sur un re-pump local. Corrige le cas Gnomes (ré-entrées répétées).
            if (w.lastEntryPeak == null && (state.positions[tok] || w.lastEntryAth || w.lastEntryTrueAth)) w.lastEntryPeak = w.maxTrueAth;
            const newAthIsReal = trueAth <= 0 || ath >= trueAth * 0.9; // le sommet récent EST (≈) le vrai ATH de vie
            // GARDE-FOU ANTI-PUMP EXPLOSIF (2026-07-28, demande user — cas breadcat) : un token qui a fait
            // x5+ de MC EN UNE bougie 15m depuis un prix ÉTABLI = snipe/manipulation qui crashe (breadcat :
            // x12.8 puis -75%). On mesure le JUMP = high / close de la bougie PRÉCÉDENTE (pas high/low, qui
            // attraperait la bougie de NAISSANCE open≈0 → x100 sur TOUS les tokens = faux positif, cas Ryder
            // x108 = juste son launch). Le jump exclut la naissance (pas de close avant). Calibré : gagnants
            // ≤x2.5 (BUNKEE), breadcat x12.8 → seuil x5. On démarre à j=1 (pas de close avant la 1re bougie).
            let maxPump15 = 1;
            for (let j = 1; j < cs.length; j++) {
                if (cs[j - 1][4] > 0 && cs[j][2] / cs[j - 1][4] > maxPump15) maxPump15 = cs[j][2] / cs[j - 1][4];
            }
            const explosif = maxPump15 >= 5;
            const prevSt = st.length >= 2 ? st[st.length - 2] : null;
            const line = prevSt ? prevSt.line : null;
            const curPrice = lastC[4];
            const curMc = curPrice * w.supply;
            const mcOk = curMc >= MC_MIN_ATH;
            const drawdown = ath > 0 ? 1 - curPrice / ath : 0;      // retracement depuis l'ATH courant
            const ddOk = drawdown >= 0.40;                          // tolérance dès -40% (2026-07-27, demande user — avant 35%)
            // fréquence adaptative : prochain check plus tôt à mesure qu'on approche l'entrée (-40%)
            w.nextCheckAt = now + (drawdown >= 0.35 ? 60e3 : drawdown >= 0.25 ? 180e3 : 600e3);
            const ddShadow35 = drawdown >= 0.35 && drawdown < 0.40; // SHADOW : ce que le seuil 35% donnerait en plus
            // supports (±4% = NOTRE calibration ; EP dit juste "near support")
            const nearST = line > 0 && Math.abs(curPrice / line - 1) <= 0.04;
            const ema34 = emaLast(cs, 34);
            const nearEMA34 = ema34 != null && Math.abs(curPrice / ema34 - 1) <= 0.04;
            const bbNow = bollinger(cs.map(c => c[4]));
            const nearBBlo = bbNow != null && curPrice <= bbNow.lower * 1.02;  // à/sous la bande basse = survente
            const atSupport = nearST || nearEMA34 || nearBBlo;
            const onCooldown = w.cooldownUntil && now < w.cooldownUntil;
            const athAgeH = athTs > 0 ? (now / 1000 - (athTs > 1e12 ? athTs / 1000 : athTs)) / 3600 : null;
            // ATH RÉCENT ≤14j (2026-07-22, remplace le cap d'âge) : on n'entre que sur le retrace d'un TOP
            // RÉCENT (EP entre après le dip d'un sommet frais, cas FOMO). Sans ça, un coin qualifié il y a
            // 3 mois et à -80% depuis serait "dd≥40%" en permanence = entrée sur qualification fossile.
            // ATH RÉCENT ≤24h (2026-07-24, GO user — APPUYÉ PAR LA DATA) : mesure sur 23 tokens bot 1
            // (bougies 1min) → le retrace post-ATH arrive VITE : -35% médiane 24min (max 7.3h), -50%
            // médiane 1.8h (max 14.5h), 100% sous 24h. Un "retrace" avec un ATH de 3-7j n'est PAS le dip
            // post-ATH (passé depuis longtemps) = coin qui traîne au fond / pump local (cas HBULL#3 live
            // -33%, 旺旺#2). Trade-off assumé : on perd les 1res entrées sur vieux bounceurs (HBULL#1 +19%
            // avait un ATH de ~6j) — le cycle propre = nouvel ATH (<24h) → dump → retrace → entrée.
            const athRecent = athAgeH != null && athAgeH <= 24;
            const athStale48 = athAgeH != null && athAgeH > 48; // tag legacy conservé sur les trades (mesure)
            // PURGE des coincés (2026-07-27, GO user) : ATH > 72h ET pas en position = fenêtre d'entrée
            // (ATH≤24h) close depuis longtemps, le token squatte un slot. S'il re-pompe (nouvel ATH), il
            // revient via le trending. 72h = 3× le seuil d'entrée, marge pour les cyclers.
            // ── CHOP-RATE + AU CREUX (2026-08-03, refonte EP chop-cycle) — REMPLACE les gates ATH ──
            const cr = chopRate(cs);                                 // fraction des dumps qui rebondissent
            const chopOk = cr == null || cr >= 0.40;                 // filtre ANTI-DUMPER (2026-08-09) : bloque SEULEMENT les dumpers connus (<40%), laisse passer les inconnus (pas de gate obligatoire — EP choisit au jugement, pas de chop-rate formel)
            // ENTRÉE ADAPTATIVE AU RÉGIME (2026-08-08, mesure ANSEM/CATE) : un ÉTABLI (MC≥5M) chope DOUX
            // (dips médiane ~11% sur ANSEM, sur des jours) ; un volatil dumpe -40% en 6h. On adapte seuil +
            // fenêtre → sinon l'entrée -40%/6h ne se déclenche JAMAIS sur les établis (KINS/ANSEM = 0 trade).
            const established = curMc >= 5_000_000;
            const winN = established ? 96 : 24;                      // haut récent : 24h (établi, 1h de chop lent) vs 6h (volatil)
            const dumpThr = established ? 0.12 : 0.35;               // établi -12% (dips ANSEM ~11%) / volatil -35% (2026-08-10 : -40%→-35%, backtest FOMO WR 73%→81% +13 entrées gagnantes = cadence EP)
            const recentHigh = Math.max(...cs.slice(-winN).map(c => c[2]));
            const dumpedFromHigh = recentHigh > 0 ? 1 - curPrice / recentHigh : 0;
            const atDip = dumpedFromHigh >= dumpThr;
            const atST = line != null && line > 0 ? curPrice <= line * 1.02 : true; // retrace VERS la ST (EP, ST intouchable) — prix à/sous la ligne ST
            // ANTI-COIN-MOURANT (2026-08-04, règle user) : après un close on ne RÉ-OUVRE que si le prix a
            // re-dépassé notre dernière entrée (= il chope encore). S'il ne fait que des lower lows sous notre
            // entrée, il MEURT → on n'ouvre plus dessus (cas Slop cut -34% puis re-dump).
            if (!state.positions[tok] && w.lastEntryPrice && curPrice >= w.lastEntryPrice * 0.98) w.recovered = true;
            const canReenter = !w.lastEntryPrice || w.recovered;
            // ANTI-CHASE-PUMP (2026-08-04, cas CATE entré en plein +8.7%) : on n'entre QUE si survendu
            // (RSI2 bas = DANS le dump), pas quand ça pompe déjà. EP achète la peur, pas l'euphorie.
            const rsiEntry = calculateRSI(cs.slice(0, -1).map(c => c[4]), 2);
            const rsiLow = rsiEntry != null && rsiEntry < 40;   // survendu/pullback (pas en pump) — pas trop strict
            // SHADOW anti-downtrend (2026-08-05) : lower highs = déclin terminal (dead-cat avant full dump).
            // Mesure ONLY : on tague l'entrée, on comparera l'issue downtrend vs range avant d'en faire un gate.
            const recentHigh12 = Math.max(...cs.slice(-12).map(c => c[2]));
            const priorHigh12 = cs.length >= 36 ? Math.max(...cs.slice(-36, -12).map(c => c[2])) : recentHigh12;
            const downtrend = priorHigh12 > 0 && recentHigh12 < priorHigh12 * 0.75; // haut récent 25%+ sous le haut d'avant
            // Purge chop : un DUMPER clair (chop < 40%) hors position = poids mort → slot libéré.
            if (cr != null && cr < 0.40 && !state.positions[tok]) {
                console.log(`🧹 Purge watch: ${w.symbol} (dumper, chop ${(cr * 100).toFixed(0)}% — dumps sans rebond)`);
                state.purgedAt[tok] = now; delete state.watch[tok]; continue;
            }
            // Rotation watch (2026-08-09, demande user) : le pattern se base sur l'historique — s'il n'est
            // pas là après 30 min d'observation, attendre ne le créera pas → purge pour libérer le slot.
            // Re-add possible via découverte s'il forme un nouveau cycle ATH plus tard.
            if (!patOk && !state.positions[tok] && w.addedAt && (now - w.addedAt) > 30 * 60e3) {
                console.log(`🧹 Purge watch: ${w.symbol} (pattern-KO depuis >30min — rotation)`);
                state.purgedAt[tok] = now; delete state.watch[tok]; continue;
            }
            w.hot = !!(armed && mcOk && chopOk);                     // "chaud" = choppy + armé
            // ── DIAGNOSTIC : 1re condition qui bloque + compteur global (nouveau funnel EP) ──
            let block = null;
            if (!armed) block = 'not-armed';
            else if (!mcOk) block = 'MC<250k';
            else if (ageH < AGE_MIN_H) block = 'coin<10h';
            else if (!patOk) block = 'pattern-KO';
            else if (!chopOk) block = `dumper(chop${(cr * 100).toFixed(0)}%)`; // cr==null ne bloque plus (2026-08-09) → on tombe sur le vrai blocage suivant
            else if (!atDip) block = `pas-au-creux(<${(dumpThr * 100).toFixed(0)}%${established ? '·établi' : ''})`;
            else if (!rsiLow) block = 'pas-survendu(RSI>40=pompe)';
            else if ((w.athBreaks || 0) >= 4) block = 'ATH-épuisé(4x)';
            else if (!canReenter) block = 'coin-mourant';
            else if (explosif) block = `pump-explosif-x${maxPump15.toFixed(0)}`;
            else if (onCooldown) block = 'cooldown';
            else if (Object.keys(state.positions).length >= MAX_POSITIONS) block = 'max-pos';
            else block = 'ENTRÉE';
            state.blockCount = state.blockCount || {};
            state.blockCount[block] = (state.blockCount[block] || 0) + 1;
            w.diag = {
                hot: w.hot, block, armed, patternOk: patOk,
                athMcK: Math.round(athMc / 1000), curMcK: Math.round(curMc / 1000),
                drawdownPct: +(drawdown * 100).toFixed(0),               // retracement actuel sous l'ATH
                ddOk, athAgeH: athAgeH != null ? +athAgeH.toFixed(1) : null,
                trend: prevSt ? (prevSt.trend === 1 ? 'vert' : 'rouge') : '?',
                distToST_pct: (line > 0) ? +(((curPrice / line) - 1) * 100).toFixed(1) : null,
                distEMA34_pct: ema34 != null ? +(((curPrice / ema34) - 1) * 100).toFixed(1) : null,
                nearST, nearEMA34, nearBBlo, atSupport, cooldown: !!onCooldown,
            };
            if (ddOk) w.dd35Logged = false;
            // ── ENTRÉE EP CHOP-CYCLE (2026-08-03) : coin CHOPPY (chop-rate ≥60%) + AU CREUX (dumpé ≥10% sous
            // le haut récent) + armé (>250k) + pas explosif + pas en cooldown. Plus de gate ATH/pattern/retrace :
            // on ouvre sur CHAQUE dump d'un chopper et on CYCLE (le cooldown post-close pace la ré-ouverture).
            if (armed && mcOk && ageH >= AGE_MIN_H && patOk && chopOk && atDip && rsiLow && canReenter && (w.athBreaks || 0) < 4 && !explosif && !onCooldown && Object.keys(state.positions).length < MAX_POSITIONS) {
                // Pool Meteora viable requise en LIVE (sélection EP "coin AND pool selection") — lazy, cachée 30min.
                if (live.enabled && live.findMeteoraPool) {
                    if (w.meteoraOk == null || now - (w.meteoraCheckedAt || 0) > 30 * 60e3) {
                        try { w.meteoraOk = !!(await live.findMeteoraPool(tok)); } catch (_) { w.meteoraOk = false; }
                        w.meteoraCheckedAt = now;
                    }
                    if (!w.meteoraOk) { state.blockCount['no-pool-meteora'] = (state.blockCount['no-pool-meteora'] || 0) + 1; continue; }
                }
                const entry = curPrice;
                w.lastEntryPrice = entry; w.recovered = false;   // anti-mourant : ré-ouvre seulement s'il re-dépasse ce prix
                const support = `chop${(cr * 100).toFixed(0)}%-dip${(dumpedFromHigh * 100).toFixed(0)}%`;
                const athAgeHr = athAgeH != null ? +athAgeH.toFixed(1) : null;
                state.positions[tok] = { symbol: w.symbol, entry, openedAt: now, ageH: +ageH.toFixed(1), athMc: Math.round(athMc), drawdownPct: +(drawdown * 100).toFixed(0), support, patternOk: patOk, athAgeH: athAgeHr, athStale48, entryCandleTs: lastC[0],
                    // features d'entrée enrichies (2026-07-29) pour l'analyse gagnants/perdants
                    dumpDepthPct: pInfo.dumpDepthPct ?? null, entryMcK: Math.round(curMc / 1000), trueAthMc: Math.round(trueAth * w.supply), pctOfTrueAth: trueAth > 0 ? +((ath / trueAth) * 100).toFixed(0) : null, vol24hK: w.vol ? Math.round(w.vol / 1000) : null,
                    downtrendEntry: downtrend, established };  // established (MC≥5M) → exit régime doux (15m, TP bas)
                save();
                if (downtrend) { console.log(`  · [SHADOW downtrend] ${w.symbol} : entrée en LOWER-HIGHS (haut récent -${((1 - recentHigh12 / priorHigh12) * 100).toFixed(0)}% vs avant) — mesure, on juge l'issue (dead-cat ?)`); recordShadow('downtrend', { symbol: w.symbol, dropHighPct: +((1 - recentHigh12 / priorHigh12) * 100).toFixed(0) }); }
                const msg = `🎯 ENTRÉE ${w.symbol} (chop-cycle${downtrend ? ' ⚠️downtrend' : ''})\nprix: $${entry.toFixed(8)} | chop ${(cr * 100).toFixed(0)}% | dumpé -${(dumpedFromHigh * 100).toFixed(0)}% sous le haut récent\nâge token: ${ageH.toFixed(1)}h | MC: $${Math.round(curMc / 1000)}k\nSortie: TP +6% OU RSI(2)>90 | cut hors-range -35% | on cycle`;
                console.log(msg.replace(/\n/g, ' | ')); tg(msg);
                // ── LIVE : ouverture réelle en miroir de l'entrée papier ──
                // Cap MAX_LIVE_POSITIONS (défaut 1, 2026-07-22) : limite le blast radius en dry-run —
                // le paper peut suivre jusqu'à MAX_POSITIONS, mais on n'ouvre au réel qu'une position
                // à la fois tant qu'on valide l'exécution. Réglable par env quand la validation est faite.
                const liveOpenCount = Object.values(state.positions).filter(p => p.live).length;
                if (live.enabled && liveOpenCount >= MAX_LIVE_POSITIONS) {
                    console.log(`  ⏸️ LIVE: ${liveOpenCount}/${MAX_LIVE_POSITIONS} position(s) réelle(s) déjà ouverte(s) — ${w.symbol} en papier seulement`);
                } else if (live.enabled) {
                    try {
                        const poolAddr = await live.findMeteoraPool(tok);
                        if (poolAddr) {
                            const lp = await live.openBidAsk(poolAddr);
                            if (lp) { state.positions[tok].live = lp; save(); tg(`🟢 LIVE ${w.symbol}: position réelle ouverte — ${lp.depositedSol.toFixed(3)} SOL, bins [${lp.lowerBinId}→${lp.upperBinId}]`); }
                        } else { console.log('  ⚠️ LIVE: aucune pool DLMM viable — trade papier seulement'); tg(`⚠️ LIVE ${w.symbol}: pas de pool DLMM viable, papier seulement`); }
                    } catch (e) { console.log(`  ⚠️ LIVE open échoué: ${String(e.message).slice(0, 80)} — papier seulement`); tg(`⚠️ LIVE ${w.symbol}: open échoué (${String(e.message).slice(0, 50)})`); }
                }
            }
        }
        console.log(`🔍 Scan ${hotOnly ? 'HOT' : 'complet'} | watch ${Object.keys(state.watch).length} | pos ${Object.keys(state.positions).length} | bougies OK ${cOk}/vide ${cKo}${rl429 ? `/429×${rl429}` : ''}${cOk === 0 && (cKo + rl429) > 0 ? ' ⚠️ SOURCE BOUGIES DOWN' : ''}`);
    } finally { scanning = false; save(); }
}

// clôture de l'ombre A/B "TP fixe" — comptabilité séparée (state.tradesFixed), pas de Telegram (anti-spam)
function closeFixedShadow(tok, fx, exitPrice, reason) {
    const pnlPct = exitPrice / fx.entry - 1;
    state.tradesFixed.push({
        symbol: fx.symbol, pnlPct: +(pnlPct * 100).toFixed(2), pnlSol: +(pnlPct * POSITION_SIZE_SOL).toFixed(4),
        durMin: Math.round((Date.now() - fx.openedAt) / 60000), closedAt: new Date().toISOString(), reason,
    });
    delete state.fixedShadow[tok];
    save();
    console.log(`👥 [A/B fixe] SORTIE ${fx.symbol} ${reason} → ${(pnlPct * 100).toFixed(1)}%`);
}

async function closePaper(tok, pos, exitPrice, reason) {
    // ── LIVE : fermer la vraie position D'ABORD. Si le close réel échoue → on GARDE le tracking
    // (pattern anti-world de bot 1 : jamais supprimer une position pas vidée on-chain).
    let pnlSolLive = null;
    if (pos.live && live.enabled) {
        // anti-spam Telegram : la sortie se re-déclenche à chaque tick tant que la position est GARDÉE
        // (close en échec) → on n'alerte qu'une fois / 15 min par position, mais on RE-TENTE le close à
        // chaque tick (silencieusement) jusqu'à ce qu'il passe.
        const alertThrottled = (msg) => { const n = Date.now(); if (!pos.lastCloseAlert || n - pos.lastCloseAlert > 15 * 60 * 1000) { tg(msg); pos.lastCloseAlert = n; } };
        try {
            const r = await live.closeVerified(pos.live);
            if (!r || !r.ok) { alertThrottled(`🚨 LIVE ${pos.symbol}: close INCOMPLET — position GARDÉE, re-tentée à chaque tick, vérifier on-chain`); return; }
            // PnL RÉEL = valeur on-chain close − open (X+Y+fees, insensible au bruit wallet). Fallback sur
            // le flat-to-flat seulement si la lecture on-chain a échoué (2026-07-25, fix mesure).
            if (r.closeValueSol != null && pos.live.openValueSol != null) {
                pnlSolLive = +(r.closeValueSol - pos.live.openValueSol).toFixed(4);
            } else {
                pnlSolLive = +(r.proceedsSol - pos.live.depositedSol).toFixed(4);
                console.log(`  ⚠️ PnL live via flat-to-flat (lecture on-chain KO) — moins fiable`);
            }
        } catch (e) { alertThrottled(`🚨 LIVE ${pos.symbol}: close erreur (${String(e.message).slice(0, 60)}) — position GARDÉE`); return; }
    }
    const pnlPct = exitPrice / pos.entry - 1;
    const trade = {
        pnlSolLive, // PnL RÉEL fees incluses (null en paper pur) — à comparer au pnlSol prix
        symbol: pos.symbol, entry: pos.entry, exit: exitPrice,
        pnlPct: +(pnlPct * 100).toFixed(2), pnlSol: +(pnlPct * POSITION_SIZE_SOL).toFixed(4),
        ageH: pos.ageH, athMc: pos.athMc, freshPct: pos.freshPct ?? null, athAgeH: pos.athAgeH ?? null, athStale48: pos.athStale48 ?? null, stochK: pos.stochK ?? null, stochBonus: pos.stochBonus ?? null, support: pos.support ?? null, patternOk: pos.patternOk ?? null, maxStackLevel: pos.maxStackLevel ?? 0, durMin: Math.round((Date.now() - pos.openedAt) / 60000),
        drawdownPct: pos.drawdownPct ?? null, dumpDepthPct: pos.dumpDepthPct ?? null, entryMcK: pos.entryMcK ?? null, trueAthMc: pos.trueAthMc ?? null, pctOfTrueAth: pos.pctOfTrueAth ?? null, vol24hK: pos.vol24hK ?? null, downtrendEntry: pos.downtrendEntry ?? null,
        openedAt: new Date(pos.openedAt).toISOString(), closedAt: new Date().toISOString(), reason,
    };
    state.trades.push(trade);
    delete state.positions[tok];
    if (state.watch[tok]) state.watch[tok].cooldownUntil = Date.now() + REENTRY_COOLDOWN_MS; // anti-boucle : pas de ré-entrée immédiate sur le même mouvement
    save();
    const tot = state.trades.reduce((s, t) => s + t.pnlSol, 0);
    const wr = state.trades.filter(t => t.pnlSol > 0).length / state.trades.length * 100;
    // PnL LP réel en % de la mise (= ce que Meteora affiche) — souvent TRÈS différent du % prix quand le
    // token a fait un V (Bid-Ask achète le dip, revend la remontée → +66% LP sur +4.9% prix, cas Looks).
    const liveOpenVal = pos.live?.openValueSol;
    const livePct = (pnlSolLive != null && liveOpenVal) ? (pnlSolLive / liveOpenVal) * 100 : null;
    const liveLine = pnlSolLive != null ? `\n💵 PnL LP RÉEL: ${livePct != null ? `${livePct > 0 ? '+' : ''}${livePct.toFixed(0)}% (` : ''}${pnlSolLive > 0 ? '+' : ''}${pnlSolLive} SOL${livePct != null ? ')' : ''} — fees incluses` : '';
    const msg = `${pnlPct > 0 ? '✅' : '🛑'} SORTIE ${pos.symbol} — ${reason}\nPnL: ${(pnlPct * 100).toFixed(1)}% (${trade.pnlSol > 0 ? '+' : ''}${trade.pnlSol} SOL papier, ${trade.durMin} min)${liveLine}\n📒 Total papier: ${state.trades.length} trades | WR ${wr.toFixed(0)}% | ${tot > 0 ? '+' : ''}${tot.toFixed(3)} SOL`;
    console.log(msg.replace(/\n/g, ' | ')); tg(msg);
}

// ── Serveur HTTP minimal : requis pour que Railway marque le déploiement Actif
// (sans port ouvert, le service reste "Deploying" indéfiniment) + expose les stats papier ──
const http = require('http');
http.createServer((req, res) => {
    // GET /logs?tail=N — accès distant aux logs (rejets qualité, purges, entrées, shadow)
    if ((req.url || '').startsWith('/logs')) {
        const tail = parseInt(new URL(req.url, 'http://x').searchParams.get('tail') || '300', 10);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(LOG_BUFFER.slice(-tail).join('\n'));
    }
    // GET /close?symbol=X  ou  /close?all=1 — CLOSE MANUEL (stop-loss humain, rôle EP). Ferme la vraie
    // position live si présente (closeVerified), retire du tracking, comptabilise en manualClose.
    if ((req.url || '').startsWith('/close')) {
        const q = new URL(req.url, 'http://x').searchParams;
        const sym = q.get('symbol'); const all = q.get('all') === '1';
        const targets = Object.entries(state.positions).filter(([, p]) => all || p.symbol === sym);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (!targets.length) return res.end(`aucune position ${all ? '' : 'nommée ' + sym} à fermer`);
        (async () => {
            const done = [];
            for (const [tok, p] of targets) {
                if (p.live && live.enabled) { try { await live.closeVerified(p.live); } catch (_) {} } // best-effort on-chain
                state.trades.push({ symbol: p.symbol, entry: p.entry, exit: null, pnlPct: null, pnlSol: null, pnlSolLive: null, manualClose: true, ageH: p.ageH, athMc: p.athMc, support: p.support ?? null, patternOk: p.patternOk ?? null, durMin: Math.round((Date.now() - p.openedAt) / 60000), openedAt: new Date(p.openedAt).toISOString(), closedAt: new Date().toISOString(), reason: 'close MANUEL (commande /close)' });
                trackManualClose(tok, p); // shadow regret : suivi post-close pour voir si un exit EP était possible
                delete state.positions[tok];
                if (state.watch[tok]) state.watch[tok].cooldownUntil = Date.now() + REENTRY_COOLDOWN_MS;
                done.push(p.symbol);
            }
            save();
            const m = `🧹 Close manuel: ${done.join(', ')} — ${done.length} position(s) fermée(s) + slots libérés`;
            console.log(m); tg(m);
        })();
        return res.end(`fermeture lancée: ${targets.map(([, p]) => p.symbol).join(', ')}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const tot = state.trades.reduce((s, t) => s + t.pnlSol, 0);
    // athAgeBins (2026-07-30, demande user) : issue par tranche d'âge de l'ATH à l'entrée, sur TOUS les
    // trades fermés → le tableau athAgeH↔issue se remplit tout seul. À relire quand ~30-40+ trades (voir
    // mémoire project-athage-vs-outcome-review). Bin = <2h / 2-5h / 5-12h / >12h.
    const athAgeBins = (() => {
        const b = { '<2h': [], '2-5h': [], '5-12h': [], '>12h': [] };
        for (const t of state.trades) {
            if (t.athAgeH == null || t.pnlPct == null) continue;
            const k = t.athAgeH < 2 ? '<2h' : t.athAgeH < 5 ? '2-5h' : t.athAgeH < 12 ? '5-12h' : '>12h';
            b[k].push(t.pnlPct);
        }
        const out = {};
        for (const [k, arr] of Object.entries(b)) {
            out[k] = arr.length ? { n: arr.length, wins: arr.filter(x => x > 0).length, avgPnlPct: +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(1) } : { n: 0 };
        }
        return out;
    })();
    // AGRÉGAT DOWNTREND vs RANGE (2026-08-09) : le tag downtrendEntry prédit-il les perdants ? Calculé sur
    // TOUS les trades chiffrés (les closes manuels ont pnlPct null → exclus). Réponse au shadow downtrend.
    const downtrendVsRange = (() => {
        const g = (flag) => {
            const arr = state.trades.filter(t => t.downtrendEntry === flag && typeof t.pnlPct === 'number');
            if (!arr.length) return { n: 0 };
            const wins = arr.filter(t => t.pnlPct > 0).length;
            return { n: arr.length, wr: Math.round(wins / arr.length * 100) + '%',
                avgPnlPct: +(arr.reduce((s, t) => s + t.pnlPct, 0) / arr.length).toFixed(1),
                sumPnlSol: +arr.reduce((s, t) => s + (t.pnlSol || 0), 0).toFixed(4) };
        };
        return { downtrend: g(true), range: g(false) };
    })();
    res.end(JSON.stringify({
        mode: 'PAPER', updatedAt: new Date().toISOString(),
        positions: state.positions, watchCount: Object.keys(state.watch).length,
        trades: state.trades.length,
        winRate: state.trades.length ? Math.round(state.trades.filter(t => t.pnlSol > 0).length / state.trades.length * 100) + '%' : null,
        pnlSolPaper: +tot.toFixed(4),
        // A/B live : trailing (réel) vs TP fixe +6% (ombre) sur les MÊMES entrées
        blockCount: state.blockCount || {}, // compteur cumulé des raisons de non-entrée → voir le vrai goulot
        shadowStats: state.shadowStats || {}, // mesures shadow accumulées (persistées sur le volume)
        downtrendVsRange, // issue AGRÉGÉE downtrend vs range sur les 141 trades (le shadow enfin exploitable)
        athAgeBins, // issue par tranche d'âge d'ATH à l'entrée (tous les trades) — voir mémoire athage-vs-outcome
        shadowManualCloses: state.shadowManualCloses || [], // regret des coupes manuelles (exit EP possible après ?)
        abFixedVsTrailing: {
            trailing: { n: state.trades.length, pnlSol: +tot.toFixed(4) },
            fixed: { n: state.tradesFixed.length, pnlSol: +state.tradesFixed.reduce((s, t) => s + t.pnlSol, 0).toFixed(4),
                     wr: state.tradesFixed.length ? Math.round(state.tradesFixed.filter(t => t.pnlSol > 0).length / state.tradesFixed.length * 100) + '%' : null },
            shadowOpen: Object.keys(state.fixedShadow).length,
        },
        lastTrades: state.trades.slice(-10),
        watch: Object.entries(state.watch).map(([tok, w]) => ({ symbol: w.symbol, ...(w.diag || { pending: true }) })),
    }, null, 2));
}).listen(process.env.PORT || 3000, () => console.log(`🌐 /status sur port ${process.env.PORT || 3000}`));

console.log('🧪 Bonus Stage PAPER bot démarré — aucun ordre réel ne sera passé.');
tg('🚀 Bot démarré (paper). Refonte EP : entrée = pattern breakup→breakdown→newATH + retrace au support ; sortie = RSI(2)>90 + vert (on TIENT jusqu\'au rebond, pas de SL/coupe-temps) ; max 8 positions.');
// scan() enveloppé : un rejet dans un tick est loggé, jamais propagé en unhandledRejection.
const safeScan = () => scan().catch(e => console.log('⚠️ scan tick (survécu):', String(e?.stack || e?.message || e).slice(0, 200)));
setInterval(safeScan, SCAN_INTERVAL_MS);
safeScan();
