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

const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || '').trim();
const CHAT_ID = (process.env.CHAT_ID || '').trim();
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { if (DATA_DIR !== __dirname) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const STATE_FILE = path.join(DATA_DIR, 'bonus_paper.json');

// ── Paramètres stratégie ──────────────────────────────────────
const TP_PCT = 0.06;              // take profit +6%
const NEAR_ST_PCT = 0.03;        // entrée si le prix ACTUEL est ≤ +3% au-dessus de la ligne ST (pullback proche)
const REENTRY_COOLDOWN_MS = 30 * 60 * 1000; // pas de ré-entrée sur un token < 30 min après une sortie (anti-boucle)
const MC_MIN_ATH = 250_000;       // l'ATH doit avoir dépassé cette MC
const AGE_MAX_H = 48;             // token < 2 jours
const VOL_MIN_24H = 500_000;      // "good volume" — seuil prudent, à calibrer
const ATH_FRESH_H = 4;            // l'ATH doit dater de < 4h ("just made new ATH")
const MAX_POSITIONS = 3;          // positions papier simultanées
const SCAN_INTERVAL_MS = 60_000;
const POSITION_SIZE_SOL = 1.0;    // taille papier (pour les stats en SOL)

let state = { positions: {}, trades: [], watch: {} };
try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
function save() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.log('⚠️ save:', e.message); } }

async function tg(msg) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text: `🧪 [PAPER Bonus Stage]\n${msg}` }, { timeout: 8000 });
    } catch (e) { console.log('⚠️ telegram:', e.response?.data?.description || e.message); }
}

// ── Data ──────────────────────────────────────────────────────
let gtView = 0;
async function gtTrending() {
    const urls = [
        'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1',
        'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1',
        'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=1',
    ];
    const url = urls[gtView++ % urls.length];
    const r = await axios.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const out = [];
    for (const p of r.data?.data || []) {
        const base = p.relationships?.base_token?.data?.id || '';
        const addr = base.includes('_') ? base.split('_').slice(1).join('_') : base;
        if (addr && addr !== 'So11111111111111111111111111111111111111112') out.push(addr);
    }
    return [...new Set(out)];
}

async function dexInfo(token) {
    const r = await axios.get(`https://api.dexscreener.com/token-pairs/v1/solana/${token}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
    const pairs = (r.data || []).filter(p => p.chainId === 'solana');
    if (!pairs.length) return null;
    pairs.sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0));
    const p = pairs[0];
    const created = pairs.map(q => q.pairCreatedAt).filter(Boolean);
    const price = parseFloat(p.priceUsd || 0), mc = parseFloat(p.marketCap || 0);
    return {
        pool: p.pairAddress,
        symbol: p.baseToken?.symbol || token.slice(0, 6),
        birthMs: created.length ? Math.min(...created) : null,
        price, mc,
        supply: price > 0 && mc > 0 ? mc / price : null,
        vol24h: Math.max(...pairs.map(q => parseFloat((q.volume || {}).h24 || 0)), 0),
    };
}

async function candles15(pool, limit = 200) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/minute?aggregate=15&before_timestamp=${Math.floor(Date.now() / 1000)}&limit=${limit}`;
    const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
    return (r.data?.data?.attributes?.ohlcv_list || []).sort((a, b) => a[0] - b[0]); // [ts,o,h,l,c,v]
}

// ── SuperTrend (10, 3) — réplique bot.js, retourne [{i, trend, line}] ──
function superTrend(cs) {
    if (cs.length < 12) return [];
    const trs = [];
    for (let i = 1; i < cs.length; i++)
        trs.push(Math.max(cs[i][2] - cs[i][3], Math.abs(cs[i][2] - cs[i - 1][4]), Math.abs(cs[i][3] - cs[i - 1][4])));
    const out = []; let prev = null;
    for (let i = 10; i < cs.length; i++) {
        const atr = trs.slice(i - 10, i).reduce((s, v) => s + v, 0) / 10;
        const hl2 = (cs[i][2] + cs[i][3]) / 2;
        const bu = hl2 + 3 * atr, bl = hl2 - 3 * atr;
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

// ── Boucle principale ─────────────────────────────────────────
let scanning = false;
async function scan() {
    if (scanning) return; scanning = true;
    try {
        const now = Date.now();
        // 1. découverte : nouveaux candidats < 48h
        let discovered = [];
        try { discovered = await gtTrending(); } catch (e) { console.log('GT indisponible:', e.message); }
        for (const tok of discovered.slice(0, 25)) {
            if (state.watch[tok] || state.positions[tok]) continue;
            if (Object.keys(state.watch).length >= 12) break; // cap suivi (rate limits)
            try {
                const d = await dexInfo(tok);
                if (!d || !d.birthMs || !d.supply) continue;
                const ageH = (now - d.birthMs) / 3.6e6;
                if (ageH >= AGE_MAX_H || d.vol24h < VOL_MIN_24H) continue;
                state.watch[tok] = { symbol: d.symbol, pool: d.pool, birthMs: d.birthMs, supply: d.supply, addedAt: now };
                console.log(`👀 Suivi: ${d.symbol} (âge ${ageH.toFixed(1)}h, vol $${Math.round(d.vol24h / 1000)}k)`);
            } catch (_) {}
        }

        // 2. pour chaque token suivi : setup / entrée / gestion de position papier
        for (const [tok, w] of Object.entries(state.watch)) {
            const ageH = (now - w.birthMs) / 3.6e6;
            if (ageH >= AGE_MAX_H && !state.positions[tok]) { delete state.watch[tok]; continue; }
            let cs;
            try { cs = await candles15(w.pool, 192); } catch (e) { continue; }
            if (!cs || cs.length < 15) continue;
            const st = superTrend(cs);
            if (!st.length) continue;
            const last = st[st.length - 1];
            const lastC = cs[cs.length - 1];
            const pos = state.positions[tok];

            if (pos) {
                // TP/SL uniquement sur les bougies qui commencent APRÈS l'entrée (sinon on compte
                // le mouvement d'avant notre entrée = TP fantôme instantané). last = dernière bougie.
                const candleAfterEntry = lastC[0] > (pos.entryCandleTs || 0);
                if (candleAfterEntry && lastC[2] >= pos.entry * (1 + TP_PCT)) {
                    closePaper(tok, pos, pos.entry * (1 + TP_PCT), 'TP +6%');
                } else if (candleAfterEntry && last.trend === -1) {
                    closePaper(tok, pos, lastC[4], `SL flip SuperTrend (${((lastC[4] / pos.entry - 1) * 100).toFixed(1)}%)`);
                }
                continue;
            }

            // détection setup : ATH de vie (bougies couvrent toute la vie du token < 48h)
            let ath = 0, athTs = 0;
            for (const c of cs) if (c[2] > ath) { ath = c[2]; athTs = c[0]; }
            const athMc = ath * w.supply;
            // Armé = a fait un ATH > 250K dans sa vie (< 48h, déjà filtré à la découverte). PAS de
            // fenêtre de fraîcheur : elle se refermait avant que le prix ait le temps de retracer vers
            // la ST → 0 entrée. Le backtest à 96% WR armait ainsi (sans expiration) jusqu'au retracement.
            const armed = athMc > MC_MIN_ATH;
            // Référence = dernière bougie CLOSE (ligne ST stable, tendance confirmée)
            const prevSt = st.length >= 2 ? st[st.length - 2] : null;
            const line = prevSt ? prevSt.line : null;
            const curPrice = lastC[4]; // prix ACTUEL (close de la dernière bougie) = fill réaliste
            // "près de la ligne" = prix entre la ligne et +NEAR_ST_PCT au-dessus (pullback vers le support,
            // pas déjà reparti en l'air). On entre au prix RÉEL, jamais à la ligne historique (sinon TP fantôme).
            const nearST = line > 0 && curPrice >= line && curPrice <= line * (1 + NEAR_ST_PCT);
            const onCooldown = w.cooldownUntil && now < w.cooldownUntil;
            w.diag = {
                armed,
                athMcK: Math.round(athMc / 1000),
                trend: prevSt ? (prevSt.trend === 1 ? 'vert' : 'rouge') : '?',
                distToST_pct: (line > 0) ? +(((curPrice / line) - 1) * 100).toFixed(1) : null,
                cooldown: !!onCooldown,
            };
            if (armed && prevSt && prevSt.trend === 1 && nearST && !onCooldown && Object.keys(state.positions).length < MAX_POSITIONS) {
                const entry = curPrice; // fill au prix courant réel
                state.positions[tok] = { symbol: w.symbol, entry, openedAt: now, ageH: +ageH.toFixed(1), athMc: Math.round(athMc), entryCandleTs: lastC[0] };
                save();
                const msg = `🎯 ENTRÉE ${w.symbol}\nprix: $${entry.toFixed(8)} (+${(((curPrice/line)-1)*100).toFixed(1)}% au-dessus ST)\nâge token: ${ageH.toFixed(1)}h | ATH MC: $${Math.round(athMc / 1000)}k\nTP: $${(entry * 1.06).toFixed(8)} (+6%) | SL: flip ST`;
                console.log(msg.replace(/\n/g, ' | ')); tg(msg);
            }
        }
    } finally { scanning = false; save(); }
}

function closePaper(tok, pos, exitPrice, reason) {
    const pnlPct = exitPrice / pos.entry - 1;
    const trade = {
        symbol: pos.symbol, entry: pos.entry, exit: exitPrice,
        pnlPct: +(pnlPct * 100).toFixed(2), pnlSol: +(pnlPct * POSITION_SIZE_SOL).toFixed(4),
        ageH: pos.ageH, athMc: pos.athMc, durMin: Math.round((Date.now() - pos.openedAt) / 60000),
        openedAt: new Date(pos.openedAt).toISOString(), closedAt: new Date().toISOString(), reason,
    };
    state.trades.push(trade);
    delete state.positions[tok];
    if (state.watch[tok]) state.watch[tok].cooldownUntil = Date.now() + REENTRY_COOLDOWN_MS; // anti-boucle : pas de ré-entrée immédiate sur le même mouvement
    save();
    const tot = state.trades.reduce((s, t) => s + t.pnlSol, 0);
    const wr = state.trades.filter(t => t.pnlSol > 0).length / state.trades.length * 100;
    const msg = `${pnlPct > 0 ? '✅' : '🛑'} SORTIE ${pos.symbol} — ${reason}\nPnL: ${(pnlPct * 100).toFixed(1)}% (${trade.pnlSol > 0 ? '+' : ''}${trade.pnlSol} SOL papier, ${trade.durMin} min)\n📒 Total papier: ${state.trades.length} trades | WR ${wr.toFixed(0)}% | ${tot > 0 ? '+' : ''}${tot.toFixed(3)} SOL`;
    console.log(msg.replace(/\n/g, ' | ')); tg(msg);
}

// ── Serveur HTTP minimal : requis pour que Railway marque le déploiement Actif
// (sans port ouvert, le service reste "Deploying" indéfiniment) + expose les stats papier ──
const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const tot = state.trades.reduce((s, t) => s + t.pnlSol, 0);
    res.end(JSON.stringify({
        mode: 'PAPER', updatedAt: new Date().toISOString(),
        positions: state.positions, watchCount: Object.keys(state.watch).length,
        trades: state.trades.length,
        winRate: state.trades.length ? Math.round(state.trades.filter(t => t.pnlSol > 0).length / state.trades.length * 100) + '%' : null,
        pnlSolPaper: +tot.toFixed(4),
        lastTrades: state.trades.slice(-10),
        watch: Object.entries(state.watch).map(([tok, w]) => ({ symbol: w.symbol, ...(w.diag || { pending: true }) })),
    }, null, 2));
}).listen(process.env.PORT || 3000, () => console.log(`🌐 /status sur port ${process.env.PORT || 3000}`));

console.log('🧪 Bonus Stage PAPER bot démarré — aucun ordre réel ne sera passé.');
tg('🚀 Bot démarré (paper-trading). Setups: token <48h, ATH>$250K frais, entrée au retracement ST 15m, TP +6% / SL flip ST.');
setInterval(scan, SCAN_INTERVAL_MS);
scan();
