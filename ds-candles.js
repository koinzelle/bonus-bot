// ── BOUGIES MAISON À PARTIR DE DEXSCREENER — OMBRE (2026-10-05, demande user) ──────────────────────
// DexScreener n'a pas d'API de bougies, mais son endpoint `tokens/v1` rend le prix de 30 tokens par appel
// (limite 300 appels/min, gratuit, sans clé). En relisant tout le watch toutes les 15 s (2 appels pour
// ~55 tokens), on construit nous-mêmes des bougies 5m et 15m : ouverture = 1re lecture du créneau,
// haut/bas = extrêmes lus, clôture = dernière lecture. Limite connue : une mèche plus courte que 15 s
// n'est pas vue (hauts un peu bas, bas un peu hauts). Volume non construit (le bot ne l'utilise pas).
// CE MODULE N'ALIMENTE RIEN : le bot continue d'utiliser DexPaprika / GeckoTerminal / Birdeye. Il sert à
// comparer, une fois par heure, ces bougies maison aux bougies officielles (écart de prix, RSI2, accord
// sur le signal « RSI2 < 50 »). Si l'accord est bon, on pourra basculer dessus (historique au 1er ajout
// chez GeckoTerminal, puis le direct ici → presque plus de téléchargements).
const axios = require('axios');

const TF = { '5m': 300, '15m': 900 };
const MAX_BOUGIES = 220;
const series = new Map();      // mint -> { '5m': [[t,o,h,l,c,0]], '15m': [...], debut: ts du 1er échantillon }
const stats = { appels: 0, echecs: 0, lectures: 0, memePool: 0, autrePool: 0, depuis: Date.now() };
let enCours = false;
let _getPool = null;   // (06/10) mint -> pool des bougies officielles (GeckoTerminal), si connue
// (2026-10-07, GO user) OMBRE « FLUX D'ORDRES » : dernier instantané DexScreener de la pool lue (achats/ventes et volume sur
// 5 min / 1 h / 6 h / 24 h, variations de prix, liquidité, capitalisation). Gratuit : il vient des appels déjà faits ici.
const fluxSnap = new Map();   // mint -> instantané
function _snap(p, now) {
    const t = p.txns || {}, v = p.volume || {}, c = p.priceChange || {}, l = p.liquidity || {};
    const n = x => (x == null || !isFinite(+x)) ? null : +x;
    return { t: now, pool: (p.pairAddress || '').slice(0, 8), dex: p.dexId || null,
        b5: n(t.m5 && t.m5.buys), s5: n(t.m5 && t.m5.sells), b1h: n(t.h1 && t.h1.buys), s1h: n(t.h1 && t.h1.sells),
        b6h: n(t.h6 && t.h6.buys), s6h: n(t.h6 && t.h6.sells), b24: n(t.h24 && t.h24.buys), s24: n(t.h24 && t.h24.sells),
        v5: n(v.m5), v1h: n(v.h1), v6h: n(v.h6), v24: n(v.h24), pc5: n(c.m5), pc1h: n(c.h1), pc6h: n(c.h6), pc24: n(c.h24),
        liq: n(l.usd), liqB: n(l.base), liqQ: n(l.quote), mc: n(p.marketCap != null ? p.marketCap : p.fdv) };
}
function flux(mint, maxAgeMs = 60000) { const f = fluxSnap.get(mint); return f && Date.now() - f.t <= maxAgeMs ? f : null; }

function enregistre(mint, px, tsMs) {
    let s = series.get(mint);
    if (!s) { s = { '5m': [], '15m': [], debut: tsMs }; series.set(mint, s); }
    for (const [tf, sec] of Object.entries(TF)) {
        const arr = s[tf], b = Math.floor(tsMs / 1000 / sec) * sec, last = arr[arr.length - 1];
        if (!last || last[0] !== b) {
            arr.push([b, px, px, px, px, 0]);
            if (arr.length > MAX_BOUGIES) arr.shift();
        } else {
            if (px > last[2]) last[2] = px;
            if (px < last[3]) last[3] = px;
            last[4] = px;
        }
    }
    stats.lectures++;
}

async function lecture(mints) {
    if (enCours || !mints.length) return;
    enCours = true;
    // (2026-10-06, demande user) MÊME POOL QUE LES BOUGIES OFFICIELLES. L'ombre prenait la « 1re paire rendue » par
    // DexScreener, souvent une autre pool que celle d'où viennent nos bougies (la plus liquide chez GeckoTerminal) :
    // une partie de l'écart de clôture (0,4-0,7 % médian) et du désaccord RSI2 (82-92 %) venait de là. Les tokens dont la
    // pool officielle est connue sont lus PAR ADRESSE DE POOL ; les autres prennent la paire la plus liquide.
    const fetchJson = async (url) => {
        stats.appels++;
        const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
        return r.data;
    };
    try {
        const parPool = [], parToken = [];
        for (const m of mints) { const pool = _getPool ? _getPool(m) : null; if (pool) parPool.push([m, pool]); else parToken.push(m); }
        for (let i = 0; i < parPool.length; i += 30) {
            const lot = parPool.slice(i, i + 30);
            try {
                const d = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/solana/${lot.map(z => z[1]).join(',')}`);
                const pairs = (d && (d.pairs || (d.pair ? [d.pair] : []))) || [];
                const now = Date.now();
                for (const [m, pool] of lot) {
                    const p = pairs.find(z => z && z.pairAddress === pool);
                    const px = p && (p.baseToken && p.baseToken.address === m ? parseFloat(p.priceUsd) : null);
                    if (px > 0) { enregistre(m, px, now); stats.memePool++; fluxSnap.set(m, _snap(p, now)); } else parToken.push(m);   // repli : par token
                }
            } catch (_) { stats.echecs++; for (const [m] of lot) parToken.push(m); }
        }
        for (let i = 0; i < parToken.length; i += 30) {
            const lot = parToken.slice(i, i + 30);
            try {
                const d = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${lot.join(',')}`);
                const now = Date.now(), best = new Map();
                for (const p of (Array.isArray(d) ? d : [])) {
                    const mint = p && p.baseToken && p.baseToken.address;
                    if (!mint || !lot.includes(mint) || !(parseFloat(p.priceUsd) > 0)) continue;
                    const b = best.get(mint);
                    if (!b || ((p.liquidity && p.liquidity.usd) || 0) > ((b.liquidity && b.liquidity.usd) || 0)) best.set(mint, p);   // la plus liquide
                }
                for (const [mint, p] of best) { enregistre(mint, parseFloat(p.priceUsd), now); stats.autrePool++; fluxSnap.set(mint, _snap(p, now)); }
            } catch (_) { stats.echecs++; }
        }
    } finally { enCours = false; }
}

// Bougies CLÔTURÉES et COMPLÈTES : on écarte le créneau en cours et le 1er créneau (commencé en cours de route).
function bougiesCloturees(mint, tf) {
    const s = series.get(mint); if (!s) return [];
    const sec = TF[tf], courant = Math.floor(Date.now() / 1000 / sec) * sec, debut = Math.floor(s.debut / 1000 / sec) * sec;
    return s[tf].filter(c => c[0] > debut && c[0] < courant);
}

function demarrer(getMints, intervalMs = 15000, getPool = null) {
    _getPool = getPool;
    setInterval(() => { lecture(getMints()).catch(() => {}); }, intervalMs);
    // ménage : on oublie les tokens qui ne sont plus suivis
    setInterval(() => { const vivants = new Set(getMints()); for (const m of series.keys()) if (!vivants.has(m)) series.delete(m); for (const m of fluxSnap.keys()) if (!vivants.has(m)) fluxSnap.delete(m); }, 3600e3);
}

module.exports = { demarrer, bougiesCloturees, stats, series, flux };
