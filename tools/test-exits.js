#!/usr/bin/env node
// Rejoue des règles de SORTIE sur les trades passés, à partir du cache local de bougies 15 min.
// Aucun appel réseau : lancer d'abord `node tools/fetch-candles.js` pour constituer/compléter le cache.
//   usage :  node tools/test-exits.js                  (tous les trades)
//            node tools/test-exits.js --new            (tokens non établis)
//            node tools/test-exits.js --etabli         (MC >= 5M)
//            node tools/test-exits.js --horsrange      (seulement les positions sorties de range par le bas)
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'candles-15m');
const STATUS = process.env.BOT_URL || 'https://bonus-bot-production-95ca.up.railway.app';
const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; const o = [e]; for (let i = 1; i < a.length; i++) { e = a[i] * k + e * (1 - k); o.push(e); } return o; };
const rma = (a, n) => { const o = [a[0]]; for (let i = 1; i < a.length; i++) o.push((o[i - 1] * (n - 1) + a[i]) / n); return o; };
function rsi(cl, n = 14) { const g = [0], p = [0]; for (let i = 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g.push(Math.max(0, d)); p.push(Math.max(0, -d)); } const ag = rma(g, n), ap = rma(p, n); return cl.map((_, i) => ap[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / ap[i])); }
const macd = cl => { const a = ema(cl, 12), b = ema(cl, 26); const m = cl.map((_, i) => a[i] - b[i]); const s = ema(m, 9); return { m, s, h: m.map((v, i) => v - s[i]) }; };
const med = x => { const c = x.filter(v => v != null).sort((p, q) => p - q); return c.length ? c[Math.floor(c.length / 2)] : null; };
(async () => {
    const trades = await (await fetch(STATUS + '/trades?all=1')).json();
    const A = (Array.isArray(trades) ? trades : (trades.trades || [])).filter(t => t.tok && t.closedAt && t.openedAt && t.lpPct != null);
    const D = [];
    for (const t of A) {
        const f = path.join(DIR, t.tok + '.json');
        if (!fs.existsSync(f)) continue;
        const { bars } = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!bars || bars.length < 60) continue;
        const t0 = Date.parse(t.openedAt) / 1000, t1 = Date.parse(t.closedAt) / 1000;
        const iE = bars.findIndex(b => b[0] >= t0), iS = bars.findIndex(b => b[0] >= t1);
        if (iE < 40 || iS <= iE + 4) continue;
        const cl = bars.map(b => b[4]);
        D.push({ t, bars, cl, iE, iS, pS: cl[iS], M: macd(cl), R: rsi(cl), E50: ema(cl, 50), E20: ema(cl, 20) });
    }
    let S = D;
    if (process.argv.includes('--new')) S = S.filter(d => !d.t.established);
    if (process.argv.includes('--etabli')) S = S.filter(d => d.t.established);
    if (process.argv.includes('--horsrange')) S = S.filter(d => d.t.outBottomMin > 0);
    const P = S.filter(d => d.t.lpPct <= 0), G = S.filter(d => d.t.lpPct > 0);
    const g = (d, i) => i >= 0 && i < d.iS ? ((d.cl[i] / d.pS - 1) * 100) : null;
    const first = (d, f) => { for (let i = d.iE + 2; i < d.iS; i++) if (f(d, i)) return i; return -1; };
    const R = [
        ['RSI14 sous 45', d => first(d, (d, i) => d.R[i] < 45 && d.R[i - 1] >= 45)],
        ['RSI14 sous 35', d => first(d, (d, i) => d.R[i] < 35 && d.R[i - 1] >= 35)],
        ['clôture sous EMA50', d => first(d, (d, i) => d.cl[i] < d.E50[i] && d.cl[i - 1] >= d.E50[i - 1])],
        ['EMA20 sous EMA50', d => first(d, (d, i) => d.E20[i] < d.E50[i] && d.E20[i - 1] >= d.E50[i - 1])],
        ['MACD histo rebond avorté', d => { let rec = 0; for (let i = d.iE + 1; i < d.iS; i++) { const h = d.M.h; if (h[i] < 0 && h[i] > h[i - 1]) rec++; else if (h[i] < 0 && h[i] < h[i - 1] && h[i - 1] < h[i - 2] && rec >= 2) return i; else if (h[i] >= 0) rec = 0; } return -1; }],
        ['MACD croisement baissier', d => first(d, (d, i) => d.M.m[i] < d.M.s[i] && d.M.m[i - 1] >= d.M.s[i - 1])],
        ['MACD croisement sous zéro', d => first(d, (d, i) => d.M.m[i] < d.M.s[i] && d.M.m[i - 1] >= d.M.s[i - 1] && d.M.m[i] < 0)],
    ];
    const hasard = d => { const n = d.iS - d.iE - 2; if (n < 2) return null; let s = 0, k = 0; for (let t = 0; t < 300; t++) { const i = d.iE + 2 + Math.floor(Math.random() * (n - 1)); const v = g(d, i); if (v != null) { s += v; k++; } } return k ? s / k : null; };
    console.log(`\n${S.length} trades exploitables (${P.length} perdants, ${G.length} gagnants) — cache ${DIR}\n`);
    console.log('  indicateur                     perdants            gagnants            NET (pts LP)');
    const lignes = [];
    for (const [n, f] of R) {
        const gp = P.map(d => g(d, f(d))).filter(v => v != null), gg = G.map(d => g(d, f(d))).filter(v => v != null);
        lignes.push({ n, gp, gg, net: gp.reduce((a, b) => a + b * 0.65, 0) - gg.reduce((a, b) => a + Math.abs(Math.min(0, b)) * 0.41, 0) });
    }
    const hp = P.map(hasard).filter(v => v != null), hg = G.map(hasard).filter(v => v != null);
    lignes.push({ n: 'PLACEBO hasard', gp: hp, gg: hg, net: hp.reduce((a, b) => a + b * 0.65, 0) - hg.reduce((a, b) => a + Math.abs(Math.min(0, b)) * 0.41, 0) });
    lignes.sort((a, b) => b.net - a.net);
    for (const l of lignes)
        console.log('  ' + l.n.padEnd(29) + String(l.gp.length).padStart(3) + '/' + String(P.length).padEnd(3) + ' méd ' + ((med(l.gp) >= 0 ? '+' : '') + (med(l.gp) || 0).toFixed(1) + '%').padStart(8)
            + '    ' + String(l.gg.length).padStart(3) + '/' + String(G.length).padEnd(3) + ' méd ' + ((med(l.gg) >= 0 ? '+' : '') + (med(l.gg) || 0).toFixed(1) + '%').padStart(8)
            + '    ' + (l.net >= 0 ? '+' : '') + l.net.toFixed(0).padStart(6));
    console.log('\n  Le PLACEBO est le seuil à battre : sur une position qui descend, toute sortie précoce paraît bonne.');
})().catch(e => { console.error('erreur:', e.message); process.exit(1); });
