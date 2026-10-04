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
const stats = { appels: 0, echecs: 0, lectures: 0, depuis: Date.now() };
let enCours = false;

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
    try {
        for (let i = 0; i < mints.length; i += 30) {
            const lot = mints.slice(i, i + 30);
            try {
                stats.appels++;
                const r = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${lot.join(',')}`,
                    { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
                const now = Date.now(), vu = new Set();
                for (const p of (Array.isArray(r.data) ? r.data : [])) {
                    const mint = p && p.baseToken && p.baseToken.address, px = p && parseFloat(p.priceUsd);
                    if (!mint || vu.has(mint) || !lot.includes(mint) || !(px > 0)) continue;
                    vu.add(mint);                 // une seule paire par token : la principale (1re rendue)
                    enregistre(mint, px, now);
                }
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

function demarrer(getMints, intervalMs = 15000) {
    setInterval(() => { lecture(getMints()).catch(() => {}); }, intervalMs);
    // ménage : on oublie les tokens qui ne sont plus suivis
    setInterval(() => { const vivants = new Set(getMints()); for (const m of series.keys()) if (!vivants.has(m)) series.delete(m); }, 3600e3);
}

module.exports = { demarrer, bougiesCloturees, stats, series };
