#!/usr/bin/env node
// Constitue et MET À JOUR un cache local de bougies 15 min, une par mint tradé.
// Relancer à volonté : ne retélécharge que ce qui manque (bougies postérieures au dernier
// horodatage stocké). Source GeckoTerminal, gratuite, débit volontairement lent.
//   usage :  node tools/fetch-candles.js            (tous les mints des trades)
//            node tools/fetch-candles.js --recent   (seulement les mints tradés ces 7 jours)
const fs = require('fs'), path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'candles-15m');
const STATUS = process.env.BOT_URL || 'https://bonus-bot-production-95ca.up.railway.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAUSE = parseInt(process.env.GT_PAUSE_MS || '6000', 10);
async function gt(u) {
    for (let i = 0; i < 8; i++) {
        try {
            const r = await fetch('https://api.geckoterminal.com/api/v2' + u, { headers: { Accept: 'application/json' } });
            if (r.status === 429) { process.stdout.write('·'); await sleep(40000); continue; }
            return await r.json();
        } catch (_) { await sleep(3000); }
    }
    return null;
}
(async () => {
    const recent = process.argv.includes('--recent');
    const trades = await (await fetch(STATUS + '/trades?all=1')).json();
    const A = (Array.isArray(trades) ? trades : (trades.trades || [])).filter(t => t.tok && t.closedAt && t.openedAt);
    const limite = recent ? Date.now() - 7 * 864e5 : 0;
    const parMint = {};
    for (const t of A) { if (Date.parse(t.closedAt) < limite) continue; (parMint[t.tok] = parMint[t.tok] || []).push(t); }
    const mints = Object.keys(parMint);
    console.log(`${mints.length} mints · ${A.length} trades · cache ${DIR}`);
    let neufs = 0, maj = 0, inchanges = 0;
    for (const mint of mints) {
        const f = path.join(DIR, mint + '.json');
        const vieux = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { mint, pool: null, bars: [] };
        const tMax = Math.max(...parMint[mint].map(t => Date.parse(t.closedAt) / 1000)) + 1800;
        const dernier = vieux.bars.length ? vieux.bars[vieux.bars.length - 1][0] : 0;
        if (dernier >= tMax - 900) { inchanges++; continue; }          // déjà couvert
        if (!vieux.pool) {
            const p = await gt(`/networks/solana/tokens/${mint}/pools?page=1`); await sleep(PAUSE);
            const d = (p && p.data) || [];
            if (!d.length) { fs.writeFileSync(f, JSON.stringify({ mint, pool: null, bars: [], sansPool: true })); console.log(`  ${parMint[mint][0].symbol} : pas de pool`); continue; }
            vieux.pool = d[0].attributes.address;
        }
        let bars = vieux.bars.slice();
        for (const page of [0, 1]) {
            const o = await gt(`/networks/solana/pools/${vieux.pool}/ohlcv/minute?aggregate=15&before_timestamp=${Math.floor(tMax - page * 900000)}&limit=1000`); await sleep(PAUSE);
            const L = ((((o && o.data) || {}).attributes) || {}).ohlcv_list || [];
            bars = bars.concat(L.map(x => [x[0], +x[1], +x[2], +x[3], +x[4]]));
            if (L.length < 1000) break;
            if (bars.length && Math.min(...L.map(x => x[0])) <= (parMint[mint].reduce((m, t) => Math.min(m, Date.parse(t.openedAt) / 1000), Infinity) - 3600)) break;
        }
        const vus = new Set(); const prop = bars.filter(b => { if (vus.has(b[0])) return false; vus.add(b[0]); return true; }).sort((a, b) => a[0] - b[0]);
        fs.writeFileSync(f, JSON.stringify({ mint, pool: vieux.pool, bars: prop }));
        if (vieux.bars.length) { maj++; console.log(`  ${String(parMint[mint][0].symbol).padEnd(11)} ${prop.length} bougies (+${prop.length - vieux.bars.length})`); }
        else { neufs++; console.log(`  ${String(parMint[mint][0].symbol).padEnd(11)} ${prop.length} bougies (nouveau)`); }
    }
    console.log(`\n${neufs} nouveaux · ${maj} mis à jour · ${inchanges} déjà à jour`);
})().catch(e => { console.error('erreur:', e.message); process.exit(1); });
