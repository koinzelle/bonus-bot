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
let gtScan = 0;
async function gtTrending() {
    // Priorité TRENDING (2026-07-19, demande user) : comme bot 1, la découverte lit les pools trending
    // GeckoTerminal (24h + 1h) à CHAQUE scan — new_pools seulement 1 scan sur 3, en fin de liste
    // (les candidats trending passent en premier quand les slots watch sont comptés).
    const urls = [
        'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1',
        'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&page=1',
    ];
    if (gtScan++ % 3 === 2) urls.push('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1');
    const out = [];
    for (const url of urls) {
        try {
            const r = await axios.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
            for (const p of r.data?.data || []) {
                const base = p.relationships?.base_token?.data?.id || '';
                const addr = base.includes('_') ? base.split('_').slice(1).join('_') : base;
                if (addr && addr !== 'So11111111111111111111111111111111111111112') out.push(addr);
            }
        } catch (_) { /* une vue GT en échec ne bloque pas les autres */ }
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

// ── Filtre qualité GMGN (2026-07-15) — mêmes seuils que bot 1 : holders ≥ 1000, top10 ≤ 30%,
// insiders ≤ 10%, honeypot/flags dangereux. Appelé UNE fois par token, à l'ajout en watch.
// Fail-open si GMGN_API_KEY absente ou API en erreur (on ne rend pas le bot aveugle sur un 429).
const { randomUUID } = require('crypto');
const https = require('https');
const GMGN_AGENT = new https.Agent({ family: 4 });
const GMGN_BASE = 'https://openapi.gmgn.ai';
const GMGN_KEY = (process.env.GMGN_API_KEY || '').trim();
const gmgnRejected = new Map(); // tok -> ts (ne pas re-tester un rejeté à chaque scan GT)
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
        const holders = info.holder_count || 0;
        const top10raw = sec.top_10_holder_rate ?? 0;
        const top10 = top10raw <= 1 ? top10raw * 100 : top10raw;
        const insRaw = sec.insider_rate ?? 0;
        const insiders = insRaw <= 1 ? insRaw * 100 : insRaw;
        const flags = JSON.stringify(sec.flags || []).toLowerCase();
        const dangerous = sec.is_honeypot || ['vamped', 'rapidlaunch', 'bundled_launch'].some(f => flags.includes(f));
        const fails = [];
        if (holders < 1000) fails.push(`holders ${holders}`);
        if (top10 > 30) fails.push(`top10 ${top10.toFixed(0)}%`);
        if (insiders > 10) fails.push(`insiders ${insiders.toFixed(0)}%`);
        if (dangerous) fails.push('honeypot/flag');
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

// ── Boucle principale ─────────────────────────────────────────
let scanning = false;
async function scan() {
    if (scanning) return; scanning = true;
    try {
        const now = Date.now();
        // 1. découverte : nouveaux candidats < 48h
        let discovered = [];
        try { discovered = await gtTrending(); } catch (e) { console.log('GT indisponible:', e.message); }
        for (const tok of discovered.slice(0, 40)) { // 2-3 vues GT fusionnées → fenêtre élargie (trending d'abord)
            if (state.watch[tok] || state.positions[tok]) continue;
            if (Object.keys(state.watch).length >= 12) break; // cap suivi (rate limits)
            try {
                const d = await dexInfo(tok);
                if (!d || !d.birthMs || !d.supply) continue;
                const ageH = (now - d.birthMs) / 3.6e6;
                if (ageH >= AGE_MAX_H || d.vol24h < VOL_MIN_24H) continue;
                // Filtre qualité GMGN (2026-07-15, copié de bot 1) : l'univers GT trending est pollué
                // (paper 29% WR vs 46-50% sur l'univers bot 1 filtré). 1 appel à l'ajout seulement.
                if (!(await gmgnQualityOk(tok, d.symbol))) continue;
                state.watch[tok] = { symbol: d.symbol, pool: d.pool, birthMs: d.birthMs, supply: d.supply, addedAt: now };
                console.log(`👀 Suivi: ${d.symbol} (âge ${ageH.toFixed(1)}h, vol $${Math.round(d.vol24h / 1000)}k)`);
            } catch (_) {}
        }

        // 2. pour chaque token suivi : setup / entrée / gestion de position papier
        for (const [tok, w] of Object.entries(state.watch)) {
            const ageH = (now - w.birthMs) / 3.6e6;
            if (ageH >= AGE_MAX_H && !state.positions[tok]) { delete state.watch[tok]; continue; }
            let cs;
            try { cs = await candles15(w.pool, 192); } catch (e) { cs = null; }
            // Purge fetch cassé (2026-07-19) : 5/12 slots n'étaient JAMAIS évalués (bougies GT en échec
            // silencieux) → après 8 échecs consécutifs, on libère le slot. cs.length entre 1 et 14 =
            // token très jeune, légitime → on attend sans compter d'échec.
            if (!cs || cs.length === 0) {
                if (!state.positions[tok]) {
                    w.fetchFails = (w.fetchFails || 0) + 1;
                    if (w.fetchFails >= 8) { console.log(`🧹 Purge watch: ${w.symbol} (${w.fetchFails} échecs bougies consécutifs)`); delete state.watch[tok]; }
                }
                continue;
            }
            w.fetchFails = 0;
            if (cs.length < 15) continue;
            // Purge cadavres (2026-07-19, GO user) : MC courante < 200k → le token a dumpé depuis l'ajout,
            // il ne repassera plus le filtre d'entrée (250k) et squatte un des 12 slots pour rien
            // (constat du 19/07 : HOUSEM 7k, Ricky 15k, SR20 21k occupaient la watch).
            const mcNow = cs[cs.length - 1][4] * w.supply;
            if (mcNow < 200_000 && !state.positions[tok]) {
                console.log(`🧹 Purge watch: ${w.symbol} (MC $${Math.round(mcNow / 1000)}k < 200k)`);
                delete state.watch[tok];
                continue;
            }
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
            // ── Filtres 2026-07-15 (backtest univers bot 1 : base 50% WR/+0.14%/trade → fresh 83%/+4.21%) ──
            // FRESH : prix d'entrée ≥ 65% de l'ATH de vie = le vrai sens du "just made new ATH" d'EP.
            // Sans lui, "retracement vers la ST" sélectionne mécaniquement les cadavres en chute (un token
            // à -80% sous son ATH restait "armé" → les 10 SL d'affilée du paper). Pire perte -4.8% vs -36.6%.
            const freshVsAth = ath > 0 ? curPrice / ath : 0;
            // SHADOW (2026-07-19, GO user) : fresh-65% ne bloque PLUS — 0 trade en 4j et le diag du 19/07
            // a montré que les vrais bloqueurs étaient ailleurs (slots morts, trend rouge). On MESURE :
            // chaque trade porte freshPct → on jugera le seuil sur 50 trades papier (+ grille backtest).
            const isFresh = freshVsAth >= 0.65;
            // MC ACTUELLE ≥ $250k (pas seulement l'ATH historique) — ferme le trou "cadavre armé".
            const curMc = curPrice * w.supply;
            const mcOk = curMc >= MC_MIN_ATH;
            w.diag = {
                armed,
                athMcK: Math.round(athMc / 1000),
                curMcK: Math.round(curMc / 1000),
                freshPct: +(freshVsAth * 100).toFixed(0), // 100 = à l'ATH ; <65 = trop profond, bloqué
                trend: prevSt ? (prevSt.trend === 1 ? 'vert' : 'rouge') : '?',
                distToST_pct: (line > 0) ? +(((curPrice / line) - 1) * 100).toFixed(1) : null,
                cooldown: !!onCooldown,
            };
            if (armed && mcOk && prevSt && prevSt.trend === 1 && nearST && !onCooldown && Object.keys(state.positions).length < MAX_POSITIONS) {
                const entry = curPrice; // fill au prix courant réel
                const freshPct = +(freshVsAth * 100).toFixed(0);
                if (!isFresh) console.log(`  ⚠️ [SHADOW fresh] entrée à ${freshPct}% de l'ATH (<65) — aurait été bloquée avant le 19/07`);
                state.positions[tok] = { symbol: w.symbol, entry, openedAt: now, ageH: +ageH.toFixed(1), athMc: Math.round(athMc), freshPct, entryCandleTs: lastC[0] };
                save();
                const msg = `🎯 ENTRÉE ${w.symbol}\nprix: $${entry.toFixed(8)} (+${(((curPrice/line)-1)*100).toFixed(1)}% au-dessus ST)\nâge token: ${ageH.toFixed(1)}h | ATH MC: $${Math.round(athMc / 1000)}k | fresh ${freshPct}%${isFresh ? '' : ' ⚠️'}\nTP: $${(entry * 1.06).toFixed(8)} (+6%) | SL: flip ST`;
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
        ageH: pos.ageH, athMc: pos.athMc, freshPct: pos.freshPct ?? null, durMin: Math.round((Date.now() - pos.openedAt) / 60000),
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
