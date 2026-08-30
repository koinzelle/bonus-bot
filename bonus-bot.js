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
const LOG_DISK_QUEUE = [];   // (2026-08-26) file d'attente pour flush disque batché (persistance 1 an, setup après DATA_DIR)
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
const _origWarn = console.warn.bind(console);
function _capture(a, tag) {
    try {
        const line = `[${new Date().toISOString()}]${tag} ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
        LOG_BUFFER.push(line);
        if (LOG_BUFFER.length > 4000) LOG_BUFFER.shift();
        LOG_DISK_QUEUE.push(line);
    } catch (_) {}
}
console.log = (...a) => { _capture(a, ''); _origLog(...a); };
// (2026-08-26) capture AUSSI error/warn : les 429 RPC de web3.js sortent par console.error → invisibles
// dans /logs avant (on était aveugle sur la tempête Helius). Désormais visibles via l'endpoint + fichiers.
console.error = (...a) => { _capture(a, ' ⛔'); _origErr(...a); };
console.warn = (...a) => { _capture(a, ' ⚠'); _origWarn(...a); };

const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || '').trim();
const CHAT_ID = (process.env.CHAT_ID || '').trim();

// ── Couche LIVE (2026-07-19) : inerte tant que LIVE≠1 sur Railway. Avec LIVE=1 + BONUS_WALLET_KEY,
// chaque entrée papier ouvre AUSSI la vraie position Bid-Ask ±34 double-sided (bonus-live.js), et
// chaque sortie papier la ferme (closeVerified + re-swap). Triggers TP/SL = ceux du paper (validés
// backtest, +6% PRIX) ; le PnL réel fees incluses est loggé À CÔTÉ (pnlSolLive) pour comparaison.
let live = { enabled: false };
try { live = require('./bonus-live'); } catch (e) { console.log('⚠️ bonus-live indisponible:', e.message, '— paper seulement'); }
if (live.enabled) {
    // (2026-08-27) annonçait `MAX_LIVE_POSITIONS || '10'` alors que le code force Math.min(5, …) → le log
    // disait 10, le bot en ouvrait 5. On affiche la valeur RÉELLE.
    console.log(`🟢 LIVE ACTIVÉ — exécution réelle armée | taille ${process.env.POSITION_SIZE_PCT || '?'}% capital | max ${Math.min(8, parseInt(process.env.MAX_LIVE_POSITIONS || '8', 10))} position(s) réelle(s) | DATA_DIR=${process.env.DATA_DIR || 'éphémère ⚠️'}`);
    if (live.sweepOrphans) {
        live.sweepOrphans().catch(e => console.log('⚠️ sweep démarrage:', String(e.message).slice(0, 60)));
        // (2026-08-30) SWEEP PÉRIODIQUE — il ne tournait qu'au démarrage : un re-swap raté au close laissait
        // les tokens au wallet jusqu'au prochain redéploiement. STONK y a dormi 19 jours (0,369 SOL), GTA6
        // une nuit (0,044 SOL). Coût : 2 lectures RPC toutes les 30 min, négligeable.
        setInterval(() => live.sweepOrphans().catch(e => console.log('⚠️ sweep périodique:', String(e.message).slice(0, 60))), 30 * 60 * 1000);
    }
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
// ── PERSISTANCE LOGS 1 an (2026-08-26) : les console.log (dont 📊 RSI/LP/peak par scan) sont flushés en
// batch dans des fichiers journaliers sur le volume → reconstruction rétrospective des opens/exits. ──
const LOG_DIR = path.join(DATA_DIR, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '365', 10);
const LOG_MAX_BYTES = parseInt(process.env.LOG_MAX_BYTES || String(2 * 1024 * 1024 * 1024), 10); // garde-fou 2 Go
function flushLogsToDisk() {
    if (!LOG_DISK_QUEUE.length) return;
    const chunk = LOG_DISK_QUEUE.splice(0, LOG_DISK_QUEUE.length);
    const day = new Date().toISOString().slice(0, 10);
    try { fs.appendFileSync(path.join(LOG_DIR, `${day}.txt`), chunk.join('\n') + '\n'); }
    catch (e) { _origLog('⚠️ flushLogs:', e.message); }
}
function rotateLogs() {
    try {
        const re = /^\d{4}-\d{2}-\d{2}\.txt$/;
        const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400e3;
        for (const f of fs.readdirSync(LOG_DIR).filter(x => re.test(x))) {   // 1) rétention par âge
            const d = Date.parse(f.slice(0, 10)); if (!isNaN(d) && d < cutoff) { try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (_) {} }
        }
        let rest = fs.readdirSync(LOG_DIR).filter(x => re.test(x)).sort();   // 2) garde-fou taille (supprime les + vieux)
        let total = rest.reduce((s, f) => { try { return s + fs.statSync(path.join(LOG_DIR, f)).size; } catch (_) { return s; } }, 0);
        while (total > LOG_MAX_BYTES && rest.length > 1) {
            const oldest = rest.shift();
            try { total -= fs.statSync(path.join(LOG_DIR, oldest)).size; fs.unlinkSync(path.join(LOG_DIR, oldest)); } catch (_) {}
        }
    } catch (_) {}
}
setInterval(flushLogsToDisk, 20 * 1000);
setInterval(rotateLogs, 6 * 3600e3);
rotateLogs();

// ── Paramètres stratégie ──────────────────────────────────────
// TP TRAILING (2026-07-19, idée user + backtest : +247%/+239% total vs +84% en TP fixe +6%, WR 80% vs 85%,
// pires pertes identiques) : une fois le high-water ≥ +5% depuis l'entrée, plus de plafond — on suit le
// pump et on sort quand le prix retombe de 1.5% sous le plus-haut. Avant l'armement : SL flip ST inchangé.
const REENTRY_COOLDOWN_MS = 30 * 60 * 1000; // pas de ré-entrée sur un token < 30 min après une sortie (anti-boucle)
// ── VERROU ANTI-COIN-MOURANT — TTL DÉSACTIVÉ PAR DÉFAUT (2026-08-27) ────────────────────────────────
// J'avais proposé un TTL 48h pour débloquer les cycleurs verrouillés à vie (CYBERLEEK et ses 65 creux
// refusés en 9h). Le backtest complet dit NON, et la remarque du user était la bonne :
//   verrou à vie : 182 trades, 12 perdants ≤-15% (-690%)
//   TTL 48h      : 193 trades, 13 perdants ≤-15% (-747%)   → +11 trades mais +1 gros perdant
//   TTL 24h      : 204 trades, 14 perdants (-802%)         → pire
//   verrou retiré: 221 trades, 17 perdants (-977%)         → bien pire
// Les 14 trades rouverts par le TTL 48h : +54% AU TOTAL, dont +76,6% pour le seul BREAKING → sans lui,
// 11 trades à **-22,6%**, avec un XST à -56%. Et sans le verrou, CYBERLEEK rouvre 6 fois pour -72% :
// le gate a RAISON sur CYBERLEEK, la fréquence qu'il coûte est méritée.
// Le TTL reste câblé mais NEUTRE (0 = verrou à vie). MOURANT_TTL_H=48 sur Railway pour le réactiver.
const MOURANT_TTL_H = parseFloat(process.env.MOURANT_TTL_H || '0');
const MOURANT_TTL_MS = MOURANT_TTL_H > 0 ? MOURANT_TTL_H * 3600 * 1000 : Infinity;
// ── SEUIL D'ENTRÉE ADAPTATIF (2026-08-27) — INTERRUPTEUR ─────────────────────────────────────────────
// Le seuil de creux est fixe : -35% (volatil) / -12% (établi MC≥5M), la MC servant de proxy grossier de
// volatilité. Alternative testée : `max(5%, ATR_K × ATR14(15m)/prix)` = on mesure la volatilité RÉELLE.
// Backtest (50 mints × 10j) : 192 trades vs 173, et surtout **4 gros perdants au lieu de 12, 3 CUT au lieu
// de 12** — or 100% des 6 perdants RÉELS du 17→27/08 sont des CUT, et 1 perdant efface 8 gagnants.
// Mesuré sur 24 744 barres, le seuil ATR donne : volatils p10 13% · médiane 26% · p90 60% (vs 35% fixe) ;
// établis p10 5% · médiane 12% · p90 37% (vs 12% fixe). La MÉDIANE des établis retombe exactement sur le
// -12% validé le 24/08 : la règle ATR *contient* les deux seuils calibrés à la main et ne corrige que les
// extrêmes — elle exige PLUS de profondeur sur les tokens sauvages (= elle refuse les couteaux qui
// produisaient les CUT) et MOINS sur les calmes (= les trades en plus).
// ⚠️ Réserve : le TOTAL du backtest est un pic à k=4 (k=3,5 → 966% ; k=4,5 → 749%) donc NON robuste ; c'est
// le nombre de gros perdants qui l'est (4-7 sur k=3,5-5 vs 12-13 en fixe). Et le backtest est en proxy-PRIX,
// qui a déjà trompé (trail-only, arm 3%, 24/08). D'où l'interrupteur :
//   ATR_ENTRY=shadow (défaut) → seuil FIXE inchangé, on LOGGE juste les désaccords → verdict sur du forward
//   ATR_ENTRY=on              → le seuil ATR pilote réellement l'entrée
const ATR_ENTRY = (process.env.ATR_ENTRY || 'shadow').toLowerCase();
const ATR_K = parseFloat(process.env.ATR_K || '4');
const ATR_FLOOR = parseFloat(process.env.ATR_FLOOR || '0.05');
function atrPct15(cs) {   // ATR14 sur les bougies 15m, en % du prix courant
    if (cs.length < 15) return null;
    let tr = 0, cnt = 0;
    for (let j = cs.length - 14; j < cs.length; j++) {
        if (j < 1) continue;
        tr += Math.max(cs[j][2] - cs[j][3], Math.abs(cs[j][2] - cs[j - 1][4]), Math.abs(cs[j][3] - cs[j - 1][4]));
        cnt++;
    }
    const px = cs[cs.length - 1][4];
    return (cnt && px > 0) ? (tr / cnt) / px : null;
}
const MC_MIN_ATH = 250_000;       // l'ATH doit avoir dépassé cette MC
const AGE_MAX_H = 24 * 365;       // garde-fou zombies 1 an — pas de MAX (EP joue les vieux coins).
const AGE_MIN_H = 10;             // MINIMUM d'âge de coin (2026-07-28, abaissé 24h→10h) : 24h bloquait Looks (16h) qui a fait +66% en V — l'âge n'est PAS un bon discriminateur (le plus jeune a gagné, les vieux saignent). 10h ne vire que les launch snipes purs (<10h) ; le pattern + anti-pump-explosif font le vrai tri.
const VOL_MIN_24H = 1_000_000;    // volume 24h ≥ $1M — filtre DexScreener exact d'EP (aligné 2026-07-22, avant 500k)
// ── SEUILS DE SORTIE — SOURCE UNIQUE (2026-08-27) : ils étaient dupliqués dans 3 endroits (scan, chemin
// bougies-KO, boucle rapide) et avaient DIVERGÉ (le chemin bougies-KO coupait encore à -35% alors que le
// backtest du 19/08 a validé -55% partout). Une seule définition = plus de dérive possible.
// ── SORTIE PROFONDE : ATTENDRE LE REBOND (2026-08-30) ───────────────────────────────────────────────
// Le CUT à -55% vendait systématiquement le creux du flush. Mesuré sur les 11 derniers CUT réels :
//   · 11/11 ont touché RSI2 > 90 APRÈS notre sortie, entre 28 et 233 minutes plus tard ;
//   · le prix est remonté après le CUT dans 11 cas sur 11 ;
//   · MAIS la sortie RSI2 exigeait `LP > 0`, ce qui demande un prix ×2,22 (LP = 0,45 × ratio − 1) :
//     une position tenue après -55% n'avait donc AUCUNE sortie et squattait un slot indéfiniment.
// Nouvelle règle : à -55% on n'ferme plus, on ARME l'attente du rebond, et on sort au premier RSI2 > 90
// quel que soit le signe du LP. Un plancher dur à -75% reprend le rôle anti-rug.
// Rejeu sur les 11 CUT : -0,4132 → -0,3407 SOL, soit +0,0725. Pire sur 3 seulement (-0,0017 / -0,0019 /
// -0,0136), meilleur sur 6 (jusqu'à +0,0413). Survit au retrait de son meilleur trade (+0,0312) et de ses
// deux meilleurs (+0,0058) — la seule idée de la semaine dans ce cas.
// Réserves : n=11, et le plancher coûte 20 points de plus le jour où un token part vraiment à zéro
// (jamais arrivé sur ces 11). Revenir en arrière = remettre BOUNCE_ARM à 0.75 (le plancher devient le CUT).
// SEUIL D'ARMEMENT 0,55 → 0,30 (2026-08-30). Balayage sur 56 positions avec trajectoire LP+RSI2 réelle,
// pas de 5 puis de 3 points. -30% n'est pas le maximum d'une courbe (elle oscille entre -9% et -27%,
// donc bruitée) mais une FRONTIÈRE : c'est le seuil le plus profond qui attrape encore les 3 CUT de la
// fenêtre, ET le plus haut qui n'ampute AUCUN gagnant.
//   -27%  →  1 gagnant amputé,  3 CUT attrapés
//   -30%  →  0 gagnant amputé,  3 CUT attrapés   ← les deux conditions tenues, +0,0585 SOL
//   -33%  →  0 gagnant amputé,  1 CUT attrapé    ← falaise, deux tiers du bénéfice perdus
// Corroboré par une mesure indépendante de la session : sur les positions qui touchent -25/-30% de LP,
// AUCUNE ne finit dans le vert (contre 50% à -20%). On n'ampute donc rien en armant là.
// Réserve : seules 3 positions concernées, la falaise tient à une seule d'entre elles. Revert = 0.55.
const RANGE_DOWN = 0.30;   // seuil d'ARMEMENT de l'attente du rebond
const CUT_HARD = 0.75;     // plancher DUR : on ferme quoi qu'il arrive (anti-rug)
const TP_PCT = 0.06;       // armement du trail (RSI2 scalpe au top en dessous, trail au-dessus)
const TRAIL = 0.01;        // trail 1% sous le peak une fois armé
// PLANCHER RSI2 ÉLARGI À -3% (2026-08-28, idée user, mesuré sur les trajectoires LP réelles) ────────────
// Le RSI2>90 non-armé est le filet qui sort les positions MOLLES avant qu'elles retombent. Il exigeait
// `realGain > 0` : une fenêtre trop étroite, qui se referme dès que la position passe sous le pair.
// Cas cc (27-28/08) : peak bloqué à 5,99% (le trail s'arme à 6,00% — raté d'un centième), puis RSI2 monte
// à 93 alors que le LP est à -2,8% → sortie bloquée par le `> 0` → plus AUCUNE issue jusqu'au CUT.
// Elle a fini à -0,048 SOL, l'équivalent de 12 trades gagnants moyens.
// Mesuré sur 25 trades clôturés + 3 ouvertes avec trajectoire LP réelle (logs persistés, fenêtre 36h) :
//   coût  : 1 seule sortie changée — PANTS +0,3% → -2,6%,  soit -0,003 SOL
//   gain  : cc  -47,8% → -2,8%,                            soit +0,045 SOL
// L'échantillon est d'un cas de chaque côté, mais l'asymétrie est STRUCTURELLE et pas statistique : le
// coût est plafonné à 3 points par déclenchement, le gain va jusqu'aux 52 points du CUT. Point mort à
// 1 déclenchement sur 17. Élargir davantage ne change rien (mesuré : -3% et -20% rattrapent les mêmes
// positions) — donc -3%, le choix qui plafonne la perte.
// N'affecte QUE le chemin non-armé : au-dessus de +6% de peak, c'est le trail qui commande, inchangé.
// REVERT 29/08 (décision user) : remis à 0 après le 1er déclenchement réel — BULLSHIT sortie à LP -2,9%
// (PnL réel -0,004 SOL) alors qu'elle est remontée à ~-0,3% de LP dans la demi-heure. Le pari en restait
// à 1 cas de chaque côté (cc sauvée / BULLSHIT coupée trop tôt) : pas de quoi maintenir un élargissement
// du plancher contre l'observation directe du user. Repasser à -0.03 exige de nouvelles données.
const RSI2_FLOOR_LP = 0;
// ── DIVERGENCE PRIX ↔ LP (2026-08-29, cas BULLSHIT) ────────────────────────────────────────────────
// Le prix vient des bougies Birdeye : GRATUIT et rafraîchi à chaque scan. La valeur LP vient d'Helius et
// coûte des crédits, d'où les paliers de cadence (8s / 10s / 45s selon la proximité d'un trigger).
// Trou constaté : une position en perte dort sur le palier 45s ; si le prix explose, personne ne relit
// la valeur LP pendant ce temps et le sommet passe inaperçu.
//   BULLSHIT, 29/08 : prix -7,6% → +30,7% → +14% en DEUX bougies d'une minute.
//   16:01:04  le scan voit prix +15,6%, mais le dernier LP connu date de 16:00 et vaut -4%
//   16:01:37  première relecture LP : +10,8% → armement → sortie à +9,5%
//   Le sommet du prix (+30,7%, soit ~+18,7% de LP) est tombé dans la fenêtre d'aveuglement.
//   Obtenu +0,0095 SOL ; le trail aurait sorti vers +17-18% de LP, soit ~+0,018 SOL.
// Correctif : quand le PRIX prend de l'avance sur le dernier LP connu, c'est qu'un mouvement vient de
// partir — on force une lecture LP immédiate et on passe la position en cadence rapide quelques minutes.
// Coût quasi nul : ne se déclenche que sur un vrai pump, quelques fois par jour, exactement quand ça
// rapporte. Ne peut pas se déclencher à la baisse (l'écart y est négatif : LP ≈ 0,86 × prix + 4,1).
const PRICE_LP_DIVERGENCE = 0.08;        // le prix a ≥ 8 points d'avance sur le LP mémorisé
const PRICE_HOT_MS = 3 * 60 * 1000;      // durée de la cadence rapide déclenchée
const MAX_POSITIONS = 10;         // positions papier simultanées (8→10, 2026-08-10 ; EP : beaucoup de petites positions, pas all-in)
// (2026-08-29, demande user) plafond DUR 5 → 8 positions réelles. Le plafond borne deux choses :
//   · l'exposition : POSITION_SIZE_PCT (7%) × 8 = 56% du capital engagé simultanément — un crash
//     memecoin corrélé peut faire plusieurs CUT -55% ensemble ;
//   · la charge RPC : la lecture par clé coûte ~3 appels par position et par cycle, donc le poste
//     « lecture de positions » des crédits Helius croît linéairement avec ce nombre.
// Réglable sans redéploiement via la variable MAX_LIVE_POSITIONS (bornée à 8).
const MAX_LIVE_POSITIONS = Math.min(8, parseInt(process.env.MAX_LIVE_POSITIONS || '8', 10));
// Scan 30s avec ticks alternés (2026-07-19, demande user) : 1 tick sur 2 = scan COMPLET (découverte +
// tous les tokens, comme avant à 60s) ; l'autre tick = UNIQUEMENT les tokens "chauds" (4/5 conditions,
// il ne manque que le retracement vers la ST) + positions ouvertes (TP/SL 2× plus réactifs). Le prix
// peut traverser la fenêtre ±3% entre 2 checks à 60s — le tick chaud à 30s divise ce risque par 2,
// sans doubler la charge API GT (les ticks chauds ne fetchent que 1-3 tokens).
const SCAN_INTERVAL_MS = 30_000;
const POSITION_SIZE_SOL = 1.0;    // taille papier (pour les stats en SOL)

let state = { positions: {}, trades: [], watch: {} };
try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
// (A/B "TP fixe vs trailing" RETIRÉ 2026-07-22, code mort supprimé le 2026-08-27 : closeFixedShadow
// n'était plus appelé nulle part et l'ombre n'a jamais dépassé 3 trades de juillet.)
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
// (2026-08-27) `_closing` est persisté par save() : un verrou posé avant un crash/redeploy rendrait la
// position définitivement infermable. On le purge au démarrage.
for (const p of Object.values(state.positions || {})) { delete p._closing; delete p._closingAt; delete p._gone; delete p._priceHotUntil; }
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
// (2026-08-30) La map garde désormais { ratio, pool } et plus seulement le ratio. La datapi Meteora nous
// dit DÉJÀ quelle pool du token a le meilleur rendement fees/TVL — c'est ce chiffre qui qualifie le token
// à l'entrée. Or `findMeteoraPool` l'ignorait et redécouvrait les pools on-chain en prenant la fee la plus
// BASSE : sur fone, le bot déposait dans une pool à 4,3 de volume/TVL alors qu'une autre était à 13,6.
// Les 16,3% qui qualifiaient fone n'étaient donc pas le rendement réellement touché.
let feeTvlMap = new Map(); // mint -> { ratio, pool } (meilleur fees/TVL 24h, rafraîchi à chaque découverte)
const FEE_TVL_FLOOR = 5;   // % : on n'ENTRE que sur des pools qui génèrent des fees (≥5%) — cas Jimothy 0.15% = LP mort
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
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOLM = 'So11111111111111111111111111111111111111112';
        const mr = await axios.get('https://dlmm.datapi.meteora.ag/pools', {
            params: { page: 1, page_size: 100, sort_by: 'fee_tvl_ratio_24h:desc', filter_by: `fee_tvl_ratio_24h>=${FEE_TVL_FLOOR} && tvl>=5000 && is_blacklisted=false` },
            headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000,
        });
        const nm = new Map(); let added = 0;
        for (const p of mr.data?.data || []) {
            const ratio = (p.fee_tvl_ratio && p.fee_tvl_ratio['24h']) || 0;
            const xm = p.token_x && p.token_x.address, ym = p.token_y && p.token_y.address;
            const tok = (xm === SOLM || xm === USDC) ? ym : (ym === SOLM || ym === USDC) ? xm : xm; // côté non-SOL/USDC
            if (!tok || tok === SOLM || tok === USDC) continue;
            const prev = nm.get(tok);
            if (!prev || ratio > prev.ratio) nm.set(tok, { ratio, pool: p.address || null }); // meilleur fees/TVL + SA pool
            if (!seen.has(tok)) { seen.add(tok); out.push({ tok, gtPool: null }); added++; } // ces coins = les vraies machines à fees
        }
        if (nm.size) feeTvlMap = nm; // remplace seulement si succès (persiste sur un hoquet datapi → pas de faux blocage)
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
        const wait = Math.max(0, 2500 - (Date.now() - candleLast));  // 2026-08-10 : 1.5s→2.5s (Birdeye 429 IP Railway)
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
let birdeyeBackoffUntil = 0, birdeye429Warned = false, birdeyeFails = 0; // BACKOFF (outage 10/08) : sur 429/échecs, on ARRÊTE de taper
// Birdeye 60s → l'IP Railway refroidit → Birdeye lève le throttle → 1er appel OK → le cache s'amorce → moins
// d'appels. Sans ça, le bot re-tape 13×/scan et ENTRETIENT le throttle (jamais de récup).
async function candlesTF(mint, gmgnRes, birdeyeType, limit, intervalSec, ttlMs, force = false) {
    const key = mint + gmgnRes;
    const c = candleCache.get(key);
    if (!force && c && Date.now() - c.ts < ttlMs) return c.cs; // cache : ÉVITE l'appel (force=on rejoue, pour le fetch HTF du pattern)
    let cs = [];
    if (force || Date.now() >= birdeyeBackoffUntil) { // pas en backoff (ou FORCÉ : fetch HTF pattern, victime sinon du backoff partagé → faux pattern-KO)
        try { cs = await throttled(() => birdeyeOhlcv(mint, birdeyeType, limit, intervalSec)); birdeye429Warned = false; birdeyeFails = 0; }
        catch (e) {
            const st = (e && e.response && e.response.status) || (e && e.code) || String(e && e.message).slice(0, 30);
            birdeyeFails++;
            if (st === 429 || birdeyeFails >= 3) { birdeyeBackoffUntil = Date.now() + 60000; birdeyeFails = 0; } // 429 OU 3 échecs → pause 60s
            if (!birdeye429Warned) { birdeye429Warned = true; console.log(`  ⏳ Birdeye échec (${st}) — backoff 60s (cache prend le relais)`); }
        }
    }
    if (cs.length < 15) { // Birdeye vide/rate-limité → fallback GMGN (épargné au max)
        try { const g = await throttled(() => gmgnKline(mint, gmgnRes, limit, intervalSec)); if (g.length > cs.length) cs = g; } catch (_) {}
    }
    if (cs.length) candleCache.set(key, { cs, ts: Date.now() });
    return cs.length ? cs : (c ? c.cs : []);
}
// TTL longs = moins d'appels : 15m→120s (support/exit) ; 1H→20min ; daily→60min (macro = lent).
const candles5 = (mint, limit = 200) => candlesTF(mint, '5m', '5m', limit, 300, 120 * 1000);   // cache 60s→120s (charge Birdeye)
const candles15 = (mint, limit = 192, ttl = 300 * 1000) => candlesTF(mint, '15m', '15m', limit, 900, ttl); // cache 300s (45s pour les tokens near-entry, cf w.nearEntry)
const candles1h = (mint, limit = 720, force = false) => candlesTF(mint, '1h', '1H', limit, 3600, 20 * 60 * 1000, force);
const candlesDay = (mint, limit = 1000, force = false) => candlesTF(mint, '1d', '1D', limit, 86400, 60 * 60 * 1000, force);

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
    return { ok, dumpDepthPct, ath1, ath2, flipRed: athAtRed != null, recovered };
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
        // (2026-08-27) FIX accolades : le recordShadow était HORS du if → quand rugcheck ne renvoie pas
        // d'insiderNetworks, maxClusterPct est null → null.toFixed() LÈVE → catch global → return true =
        // filtre qualité (holders/top10/insiders/honeypot/fees≥30 SOL) ENTIÈREMENT contourné sur ces tokens.
        if (maxClusterPct != null && (maxClusterPct >= 10 || totalInsiderPct >= 40)) {
            console.log(`⚠️ [SHADOW clusters] ${sym}: plus gros ${maxClusterPct.toFixed(1)}% | total insiders ${totalInsiderPct.toFixed(0)}% — mesure seule (ne bloque pas)`);
            recordShadow('clusters', { symbol: sym, maxClusterPct: +maxClusterPct.toFixed(1), totalInsiderPct: +totalInsiderPct.toFixed(0) });
        }
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

function emaLast(cs, n) {
    // EMA(n) sur closes 15m — null si < n bougies. Seed = SMA des n premières, puis EMA classique.
    const closes = cs.map(c => c[4]);
    if (closes.length < n) return null;
    const k = 2 / (n + 1);
    let e = closes.slice(0, n).reduce((s, v) => s + v, 0) / n;
    for (let i = n; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    return e;
}

// ── Réconciliation on-chain des positions LIVE (2026-07-25, GO user) : le bot ne vérifiait jamais que
// ses positions live existaient encore → une coupe MANUELLE (Meteora) laissait un fantôme qui squattait
// un slot indéfiniment (le bot ne s'en apercevait qu'au prochain RSI2>90). Ici on liste les positions
// réelles du wallet et on nettoie celles qui ont disparu (fermées à la main) → trade manualClose + slot
// libéré. Pattern de bot 1. Appelée 1×/scan complet (pas sur les ticks chauds, pour économiser le RPC.
// RECONCILE SANS RPC (2026-08-28) — avant : à CHAQUE scan complet et pour CHAQUE position, `positionState()`
// faisait un `DLMM.create()` NON caché (téléchargement complet de la pool) + un `getPositionsByUserAndLbPair`
// (= un getProgramAccounts, la méthode la plus chère chez Helius). Avec 3 positions : ~2 880 téléchargements
// de pool + ~2 880 getProgramAccounts PAR JOUR, juste pour répondre à une question oui/non.
// Or `allPositionValues()` — déjà appelé toutes les 8-45 s pour le trail — ramène TOUTES les positions du
// wallet. La réponse est donc déjà en mémoire. On la lit, gratuitement.
// Trois garde-fous, parce que supprimer une position du tracking est irréversible (liquidité orpheline,
// bug `world` de bot 1) :
//   1. `allKeys` (inventaire complet côté bonus-live) et pas la map enrichie, qui peut perdre une pool ;
//   2. on ne conclut JAMAIS sur une lecture périmée (`b.fresh`) — même sémantique que l'ancien 'unknown' ;
//   3. absence sur 3 lectures fraîches consécutives, PUIS un seul appel `positionState()` qui confirme.
// Coût en régime normal : 0 appel. Coût le jour d'une vraie coupe manuelle : 1 appel.
const RECONCILE_MISSES = 3;
async function reconcileLivePositions() {
    if (!live.enabled || !live.positionState) return;
    const tracked = Object.entries(state.positions).filter(([, p]) => p.live);
    if (!tracked.length) return;
    const b = await batchedPositionValues();          // 0 appel RPC si le lot est déjà frais
    if (!b.fresh || !b.map || !b.map.allKeys) return; // lecture pas fiable → on ne conclut RIEN
    for (const [tok, p] of tracked) {
        // `checked` = réponse fiable pour CETTE position (null sur le chemin de secours → on ne conclut pas)
        const conclusive = b.map.checked ? b.map.checked.has(p.live.positionKeypairPub) : true;
        const present = b.map.allKeys.has(p.live.positionKeypairPub);
        if (!conclusive) continue;
        if (present) {
            p._gone = 0;
            // Auto-réparation openValueSol : la valeur est DÉJÀ dans le lot → plus d'appel dédié.
            if (p.live.openValueSol == null) {
                const bv = b.map.get(p.live.positionKeypairPub);
                if (bv && bv.valueSol != null) {
                    p.live.openValueSol = bv.valueSol;
                    console.log(`🩹 ${p.symbol}: openValueSol ré-inscrite depuis le lot (${bv.valueSol.toFixed(4)} SOL) — base PnL restaurée, 0 appel RPC`);
                }
            }
            continue;
        }
        p._gone = (p._gone || 0) + 1;
        if (p._gone < RECONCILE_MISSES) continue;     // débounce : une liste partielle ne doit pas suffire
        const st = await live.positionState(p.live);  // CONFIRMATION directe on-chain (1 seul appel)
        if (st !== 'closed') { if (st === 'open') p._gone = 0; continue; }
        {
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
        }
    }
    save();
}

// ── Boucle principale ─────────────────────────────────────────
let scanning = false;
let scanOffset = 0; // rotation du point de départ de la boucle watch (équité sous backoff 429)
let scanTick = 0;
// Cache de la LECTURE GROUPÉE des positions (2026-08-10) : 1 appel live pour TOUTES les positions, réutilisé
// ~20s → la 1re position du scan déclenche le fetch, les autres lisent le lot en cache (coût RPC ~plat).
let _batchLv = { map: new Map(), ts: 0 };
let _batchErrWarned = false;
async function batchedPositionValues() {
    // TTL ADAPTATIF 3 PALIERS (2026-08-18, demande user) selon la proximité d'un trigger de sortie, calculé sur
    // l'état DÉJÀ en cache (peakGain, _lv = dernier gain/bin) → zéro appel RPC en plus. On prend le palier le
    // plus serré parmi les positions. Réduit le volume RPC (donc les 429) SANS retarder les vraies sorties.
    //   8s  = CHAUD  : gain ≥ +5.5% (proche armement +6%) · CUT proche (≤ -25%) · bord de range (≤5 bins)
    //   10s = SE RAPPROCHE : gain ≥ +3% · perte ≥ -15% · bord de range (≤10 bins)
    //   45s = LOIN (2026-08-27 : 15→45s = ~3× moins de getProgramAccounts → crédits Helius ; une position calme
    //         loin de tout trigger n'a pas besoin d'être lue toutes les 15s ; les paliers 8/10s reprennent dès qu'elle approche)
    let ttl = 45000;
    for (const p of Object.values(state.positions)) {
        if (!p.live) continue;
        const g = p._lv ? p._lv.rg : (p.peakGain || 0);
        const pk = p.peakGain || 0;
        const bin = p._lv ? p._lv.bin : null;
        // (2026-08-28) Seul le bord du HAUT compte pour la cadence. En s'approchant du bord du BAS il n'y a
        // AUCUNE action rapide à déclencher : le franchissement du bas ne ferme rien (il n'existe pas de
        // « CUT hors-range bas » immédiat — le seul CUT bas est celui à -55%, lent), et les deux issues sont
        // le rebond ou ce CUT. En haut au contraire, il faut banker avant que le prix redescende et rende le
        // gain. On ne mesure donc plus que la distance au bord SUPÉRIEUR.
        const distTop = (bin != null && p.live.upperBinId != null) ? (p.live.upperBinId - bin) : 999;
        // (2026-08-28) TROIS déclencheurs épinglaient une position perdante sur le palier 8s alors qu'aucun
        // trigger rapide ne pouvait se produire. Cas cc : peak 5,99% · LP -29,8% · bin -326 (sous la range).
        //  ① `pk >= 0.055` — le peak est un HIGH-WATER : il ne redescend jamais. Une position qui a touché
        //     5,99% une fois restait en lecture 8s À VIE, même à -30%. Or pour ARMER il faut que le gain
        //     COURANT atteigne +6% : c'est `g` qu'il faut surveiller vite, pas `pk`. On ne garde `pk` que
        //     s'il est réellement armé (≥ TP_PCT) — là le trail est actif et la vitesse compte vraiment.
        //  ② `g <= -0.25` / `g <= -0.15` — la profondeur de perte est une variable LENTE : on ne passe pas
        //     de -25% à -55% en dix secondes, ça prend des heures. Le CUT tombe à la même minute qu'on lise
        //     toutes les 8s ou toutes les 45s.
        //  ③ `distEdge <= 5` prenait le bord le PLUS PROCHE, haut ou bas, et était vrai aussi une fois la
        //     position DÉJÀ sortie (distance négative). Or le bord du bas ne commande rien : le franchir ne
        //     ferme aucune position, et une fois dessous c'est 100% token, plus de fees, seul le CUT lent
        //     s'applique. On ne regarde donc plus que le bord du HAUT, où il faut banker vite.
        // Le TTL retenu étant le MINIMUM sur toutes les positions, cc imposait 8s à fone et GTA6 aussi
        // (à -1%). Coût : ~8 640 lectures/jour au lieu de ~1 920.
        const outTop = distTop < 0;                                  // sorti par le HAUT → banker vite
        const nearTop = (n) => distTop >= 0 && distTop <= n;         // approche du bord HAUT, encore dans la range
        let t;
        // divergence prix↔LP détectée par le scan : un mouvement est en cours, on colle à la valeur
        if (p._priceHotUntil && Date.now() < p._priceHotUntil) t = 8000;
        else if (pk >= TP_PCT || g >= 0.055 || outTop || nearTop(5)) t = 8000;   // trail armé · sur le point d'armer · hors-range HAUT · bord haut proche
        else if (g >= 0.03 || nearTop(10)) t = 10000;
        // (2026-08-28) PALIER 15s « proche du pair » RETIRÉ après mesure. L'idée : `peakGain` n'enregistre
        // que ce qu'on VOIT, donc un pump rapide entre deux lectures rend le sommet invisible et le trail
        // s'arme plus bas. Le risque est réel (cc le 27/08 : peak interne 5,99% contre 5,5% loggé au scan),
        // mais mesuré sur 24h de logs il est INTROUVABLE — aucun pic raté sur 7 positions — alors que le
        // surcoût, lui, est chiffré : le palier couvrirait 56% du temps (22% même limité à LP ≥ -3%) et
        // ferait passer la conso de 1 787 à 2 051-2 452 crédits/h, pour un budget Helius de 1 781/h.
        // À rouvrir si le budget RPC cesse d'être la contrainte. La ligne était : else if (g >= -0.10) t = 15000;
        else t = 45000;   // perte franche / sorti par le bas : rien de rapide ne peut s'y produire
        if (t < ttl) ttl = t;
    }
    if (Date.now() - _batchLv.ts < ttl) return { map: _batchLv.map, fresh: true }; // succès < ttl = frais
    if (live.enabled && live.allPositionValues) {
        // (2026-08-28) on passe la liste suivie → lecture par CLÉ (getAccountInfo), zéro getProgramAccounts.
        const list = Object.values(state.positions).filter(p => p.live).map(p => p.live);
        try { const m = await live.allPositionValues(list); if (m) { _batchLv = { map: m, ts: Date.now() }; _batchErrWarned = false; return { map: m, fresh: true }; } }
        catch (e) { if (!_batchErrWarned) { _batchErrWarned = true; console.log(`  ⚠️ lecture groupée échouée (${String(e.message).slice(0, 70)}) → bascule lecture individuelle`); } }
    }
    return { map: _batchLv.map, fresh: false }; // échec → PÉRIMÉ : l'appelant NE doit PAS figer dessus (lecture individuelle)
}
async function scan() {
    if (scanning) return; scanning = true;
    try {
        const now = Date.now();
        if (!state.purgedAt) state.purgedAt = {};
        // (2026-08-27) purgedAt n'était JAMAIS élagué → il grossissait indéfiniment dans le JSON réécrit en
        // synchrone à chaque scan. Le cooldown de re-add est de 30 min : au-delà de 2h l'entrée est inutile.
        for (const k in state.purgedAt) if (now - state.purgedAt[k] > 2 * 3600e3) delete state.purgedAt[k];
        // PERSISTANCE PATTERN PAR MINT (2026-08-15) : le pattern EP est "collant" (ruggers sortis = acquis à vie)
        // mais il était perdu à chaque purge→re-add ET quand le fetch 1H retombait sur 15m (pattern hors champ
        // sur 48h → faux pattern-KO sur les vieux coins déjà validés, cas CATE/STONK). On mémorise la validation
        // par mint (TTL 14j, aligné athRecent) → un coin validé reste qualifié malgré purge/re-add/hoquet fetch.
        if (!state.patternOkMints) state.patternOkMints = {};
        // ANTI-MOURANT PERSISTÉ PAR MINT (2026-08-27) : lastEntryPrice/lastExitTs vivaient sur l'entrée de
        // watch → perdus à la purge/re-add. Le verrou s'appliquait donc au hasard : les tokens jetables y
        // échappaient, les machines à fees (jamais purgées) y restaient piégées. Persisté = cohérent.
        if (!state.mourantMints) state.mourantMints = {};
        for (const k in state.mourantMints) if (now - (state.mourantMints[k].exitTs || 0) > 14 * 24 * 3600e3) delete state.mourantMints[k];
        const PATTERN_TTL = 14 * 24 * 3600e3;
        for (const k in state.patternOkMints) if (now - state.patternOkMints[k] > PATTERN_TTL) delete state.patternOkMints[k]; // prune fossiles
        // Tick alterné (2026-07-19) : pair = scan COMPLET (découverte + tous les tokens, cadence 60s
        // comme avant) ; impair = UNIQUEMENT tokens chauds (4/5 conditions) + positions → réactivité 30s
        // là où ça compte, sans doubler la charge GT.
        const hotOnly = (scanTick++ % 2) === 1;
        // Réconciliation on-chain des positions live (ticks complets seulement) — détecte les coupes manuelles
        if (!hotOnly) { try { await reconcileLivePositions(); } catch (e) { console.log('reconcile:', e.message); } }
        // 1. découverte : nouveaux candidats < 48h (ticks complets uniquement)
        let discovered = [];
        if (!hotOnly) { try { discovered = await gtTrending(); } catch (e) { console.log('GT indisponible:', e.message); } }
        let replaceBudget = 3; // remplacements watch max/scan (2026-08-14) : la watch se rafraîchit progressivement, pas de thrashing
        for (const { tok, gtPool } of discovered.slice(0, 60)) { // 4-6 sources fusionnées (GT p1-3 + 1h + new + DexScreener) — trending d'abord
            if (state.watch[tok] || state.positions[tok]) continue;
            // cooldown re-add 30min après purge (sinon cycle purge→re-add sur les tokens trending morts)
            if (state.purgedAt[tok] && now - state.purgedAt[tok] < 30 * 60 * 1000) continue;
            if (Object.keys(state.watch).length >= 35 && replaceBudget <= 0) break; // pleine + plus de remplacement ce scan → stop
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
                // WATCH PLEINE → REMPLACEMENT (2026-08-14, option 2) : le coin a passé TOUS les filtres = bonne
                // pépite → on éjecte le plus VIEUX candidat ordinaire (ni position, ni fee-machine) pour lui faire
                // de la place. Garantit que les résurrections entrent toujours ; les coins morts/dormants sortent.
                if (Object.keys(state.watch).length >= 35) {
                    let oldest = null, oldestTs = Infinity;
                    for (const [t, ww] of Object.entries(state.watch)) {
                        if (state.positions[t] || feeTvlMap.has(t)) continue; // protégés : positions + fee-machines (on farme)
                        if ((ww.addedAt || 0) < oldestTs) { oldestTs = ww.addedAt || 0; oldest = t; }
                    }
                    if (!oldest) continue; // rien d'éjectable (tout est position/fee-machine) → on n'ajoute pas ce coin
                    console.log(`🔄 Remplacement watch: ${state.watch[oldest].symbol} (plus vieux, dormant) ← ${d.symbol}`);
                    state.purgedAt[oldest] = now; delete state.watch[oldest]; replaceBudget--;
                }
                const mm = state.mourantMints[tok];   // restaure le verrou anti-mourant (survit purge/re-add)
                state.watch[tok] = { symbol: d.symbol, pool: d.poolAnalysis || gtPool || d.pool, poolAlt: gtPool || d.pool, birthMs: d.birthMs, supply: d.supply, profilOk, athGmgn: gmgnAthPrice.get(tok) || null, addedAt: now, nextCheckAt: now + Math.floor(Math.random() * 30e3),
                    vol: d.vol24h,   // (2026-08-27) w.vol n'était JAMAIS écrit → vol24hK: null sur les 441 trades
                    lastEntryPrice: mm ? mm.px : undefined, lastExitTs: mm ? mm.exitTs : undefined,
                    patternValidated: !!(state.patternOkMints[tok] && now - state.patternOkMints[tok] < PATTERN_TTL) || undefined }; // restaure la qualif pattern acquise (survit purge/re-add)
                console.log(`👀 Suivi: ${d.symbol} (âge ${ageH.toFixed(1)}h, vol $${Math.round(d.vol24h / 1000)}k, pool ${gtPool ? 'GT' : 'dex'})`);
            } catch (_) {}
        }

        // 2. pour chaque token suivi : setup / entrée / gestion de position papier
        let rl429 = 0; // 429 vus ce tick — au 2e, on arrête de fetch (backoff global, le cache sert le reste)
        let cOk = 0, cKo = 0; // santé source bougies ce tick (pour le résumé de scan — repère une panne, cas bot 1)
        let fetchBudget = 9;  // max vraies requêtes bougies Birdeye par scan (6→9 le 2026-08-14 : mieux surveiller la watch de 35)
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
            if (!inPos && w.nextCheckAt && now < w.nextCheckAt) { if (!w.diag) w.lastSkip = 'nextCheck-pas-dû'; continue; }
            const ageH = (now - w.birthMs) / 3.6e6;
            if (ageH >= AGE_MAX_H && !inPos) { delete state.watch[tok]; continue; } // garde-fou zombies 1 an
            if (rl429 >= 3 && !inPos) { if (!w.diag) w.lastSkip = '429-backoff-global'; continue; } // backoff : GT sature, on réessaie au prochain tick (seuil 2→3)
            // BUDGET FETCH/SCAN (2026-08-10, demande user) : borne le BURST Birdeye — au plus fetchBudget vraies
            // requêtes bougies par scan. Un coin au cache FRAIS ne coûte rien (pas d'appel) ; les autres, une
            // fois le budget épuisé, passent au prochain tick (la rotation garantit qu'ils seront servis).
            // Les positions ne sont JAMAIS budgétées (sortie toujours vérifiée).
            // CACHE ADAPTATIF NEAR-ENTRY (2026-08-17) : un token proche de l'entrée (w.nearEntry, dipProx≥0.85 au
            // dernier tick) doit voir un prix FRAIS → cache 45s ; le reste → 300s. Le cache 300s défaisait les
            // checks 60s (entrée sur prix périmé 5 min, cas LAYOOO). Near-entry jamais gaté par le budget.
            const ttl15 = w.nearEntry ? 45 * 1000 : 300 * 1000;
            const cacheFresh15 = (() => { const cc = candleCache.get(tok + '15m'); return !!(cc && Date.now() - cc.ts < ttl15); })();
            if (!inPos && !w.nearEntry && !cacheFresh15 && fetchBudget <= 0) { if (!w.diag) w.lastSkip = 'budget-fetch-épuisé'; continue; }
            let cs;
            // Birdeye TOKEN-LEVEL (tok = mint) : 192×15m=48h pour support/sortie. Suit la migration
            // nativement → plus de bricolage pool (poolAlt/origine supprimé). Le throttle est global.
            try { cs = await candles15(tok, 192, ttl15); } catch (e) { cs = null; w.lastFetchErr = (e.message || '').slice(0, 60); }
            if (!inPos && !cacheFresh15) fetchBudget--;
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
                                const armedO = posO.peakGain >= TP_PCT;
                                console.log(`📊 ${posO.symbol} | LP ${(rg * 100).toFixed(1)}% | peak ${(posO.peakGain * 100).toFixed(1)}% | ${armedO ? 'armé✓' : 'pas-armé'} | trail≤${((posO.peakGain - TRAIL) * 100).toFixed(1)}% | src:live | bougies-KO`);
                                const exitPx = posO.lastPx || posO.entry;
                                if (r.activeBinId != null && posO.live.upperBinId != null && r.activeBinId > posO.live.upperBinId) { await closePaper(tok, posO, exitPx, `CUT hors-range HAUT (banké +${(rg * 100).toFixed(1)}% LP, bougies KO)`); continue; }
                                if (armedO && rg <= posO.peakGain - TRAIL) { await closePaper(tok, posO, exitPx, `TRAIL LP +${(rg * 100).toFixed(1)}% (peak +${(posO.peakGain * 100).toFixed(1)}%, bougies KO)`); continue; }
                                // (2026-08-27) était -0.35 en dur ici alors que tout le reste est à -55% depuis le 19/08
                                if (rg <= -RANGE_DOWN && !posO._awaitBounce) { posO._awaitBounce = true; console.log(`  ⏳ ${posO.symbol}: -${(RANGE_DOWN * 100).toFixed(0)}% franchi (bougies KO) → attente du rebond`); }
                                if (rg <= -CUT_HARD) { await closePaper(tok, posO, exitPx, `CUT PLANCHER ${(rg * 100).toFixed(1)}% LP (≤ -${(CUT_HARD * 100).toFixed(0)}%, bougies KO)`); continue; }
                            }
                        } catch (_) { /* valeur live KO aussi → rien à faire, on garde la position */ }
                    }
                }
                // BACK-OFF du token qui échoue (2026-07-27) : sinon les tokens sans cache sont re-tentés
                // CHAQUE tick → 429 en boucle (chicken-and-egg : nextCheckAt n'était posé qu'après succès).
                // On les recule de 90s → ils cessent de marteler GT → GT récupère → fetchs réussis.
                if (!inPos) w.nextCheckAt = now + 90e3;
                if (/429/.test(w.lastFetchErr || '')) { rl429++; if (!w.diag) w.lastSkip = '429-fetch-direct'; if (rl429 === 1) console.log(`  ⏳ GT rate-limit (429) ce tick — backoff, le cache prend le relais`); continue; }
                cKo++;
                if (!state.positions[tok]) {
                    w.fetchFails = (w.fetchFails || 0) + 1;
                    if (!w.diag) w.lastSkip = 'bougies-vides×' + w.fetchFails;
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
            if (cs.length < 15) {
                if (!w.diag) w.lastSkip = 'bougies<15(' + cs.length + ')';
                // FIX FAMINE (2026-08-15) : sans ça, un token à <15 bougies est re-fetché CHAQUE scan (gâche le
                // budget) et jamais purgé (ni diag, ni fetchFails) → squat éternel en None, affame les frais.
                if (!inPos) {
                    w.nextCheckAt = now + 5 * 60e3; // backoff : arrête de bouffer un slot fetch à chaque scan
                    // Birdeye n'a pas d'historique pour un token DÉJÀ vieux (≥6h) → il n'aura jamais 15 bougies → purge.
                    // Un token jeune (<6h) accumule encore ses bougies → on le garde (re-add possible sinon).
                    if (ageH >= 6 && w.addedAt && (now - w.addedAt) > 30 * 60e3) {
                        console.log(`🧹 Purge watch: ${w.symbol} (${cs.length} bougies <15, âge ${ageH.toFixed(0)}h — Birdeye sans historique)`);
                        state.purgedAt[tok] = now; delete state.watch[tok];
                    }
                }
                continue;
            }
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
                // CUT hors-range ADAPTATIF (2026-08-11, cas Jimothy coupé puis pump +30min) : gros coin établi
                // (MC≥3M) rug rarement + rebondit (cf Remus) → -50% de marge ; petit volatil peut rug → -35%.
                // (seuils RANGE_DOWN/TP_PCT/TRAIL = constantes de module, source unique)
                //   arm trail à +6% (RSI2 scalpe au top <+6%, trail au-dessus). Arm 3% établi testé 24/08 → banke ~2% de moins sur la bande +3-6% (trail sous le peak vs RSI2 au top), revert.
                // #1 TP sur la VRAIE valeur LP (2026-08-04) : le prix ≠ gain LP sur un Bid-Ask (liquidité aux
                // EXTRÊMES → un +9% au milieu capte ~0, cas CATE). En LIVE on lit positionValueSol (net
                // fees+swaps) ; en paper on garde le prix (approx). On ne ferme que sur un gain LP RÉEL.
                // DIVERGENCE PRIX↔LP : le prix (gratuit) a-t-il pris de l'avance sur la dernière valeur LP lue ?
                if (pos.live && pos._lv && (gain - pos._lv.rg) >= PRICE_LP_DIVERGENCE) {
                    pos._priceHotUntil = Date.now() + PRICE_HOT_MS;
                    _batchLv.ts = 0;   // invalide le lot → la lecture juste en dessous sera FRAÎCHE
                    console.log(`  ⚡ ${pos.symbol}: prix ${(gain * 100).toFixed(1)}% vs LP connu ${(pos._lv.rg * 100).toFixed(1)}% (écart ${((gain - pos._lv.rg) * 100).toFixed(1)} pts) → lecture LP forcée + cadence rapide ${PRICE_HOT_MS / 60000}min`);
                }
                let realGain = gain, liveBinId = null, lvSrc = 'prix';
                if (pos.live && live.enabled && pos.live.openValueSol) {
                    const b = await batchedPositionValues();
                    const bv = b.fresh ? b.map.get(pos.live.positionKeypairPub) : null; // lot PÉRIMÉ = on l'ignore (plus de gel)
                    if (bv) { recordLv(pos, bv.valueSol / pos.live.openValueSol - 1, bv.activeBinId); lvSrc = 'lot'; }
                    else if ((!pos._lv || Date.now() - pos._lv.ts > 20000) && live.positionValueAndBin) { // lot périmé/absent → individuel FRAIS (throttlé 20s)
                        try { const r = await live.positionValueAndBin(pos.live); if (r && r.valueSol != null) { recordLv(pos, r.valueSol / pos.live.openValueSol - 1, r.activeBinId); lvSrc = 'indiv'; } } catch (_) { /* garde l'ancien cache / fallback prix */ }
                    } else if (pos._lv) { lvSrc = `cache${Math.round((Date.now() - pos._lv.ts) / 1000)}s`; }
                    // Garde anti-cache-figé : on ne trust le cache LP que <90s. Sinon on retombe sur le PRIX.
                    if (pos._lv && Date.now() - pos._lv.ts < 90000) { realGain = pos._lv.rg; liveBinId = pos._lv.bin; }
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
                // ATTENTE DU REBOND (2026-08-30) : à -55% on n'ferme plus, on arme ; la sortie se fera au
                // premier RSI2>90 quel que soit le signe (plus bas dans cette même fonction).
                const deepDown = dropFromEntry >= RANGE_DOWN || realGain <= -RANGE_DOWN;
                if (deepDown && !pos._awaitBounce) {
                    pos._awaitBounce = true; save();
                    console.log(`  ⏳ ${pos.symbol}: seuil -${(RANGE_DOWN * 100).toFixed(0)}% franchi (LP ${(realGain * 100).toFixed(1)}%) → attente du rebond, sortie au 1er RSI2>90 · plancher dur -${(CUT_HARD * 100).toFixed(0)}%`);
                    tg(`⏳ ${pos.symbol}: -${(RANGE_DOWN * 100).toFixed(0)}% franchi — le bot attend le rebond (RSI2>90) au lieu de couper. Plancher -${(CUT_HARD * 100).toFixed(0)}%.`);
                }
                // PLANCHER DUR : au-delà, on ferme sans condition (anti-rug)
                if (dropFromEntry >= CUT_HARD || realGain <= -CUT_HARD) {
                    await closePaper(tok, pos, px, `CUT PLANCHER ${(realGain * 100).toFixed(1)}% LP (≤ -${(CUT_HARD * 100).toFixed(0)}%)`);
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

                // LOG position par scan (2026-08-09) : fin du silence de bot 2 + audit sortie. On affiche TOUT
                // ce que le bot VOIT — LP, prix, RSI2 (= notre critère de sortie), RSI14 (comparable DexScreener,
                // cas bot 1 où notre RSI divergeait), bin actif→haut du range, source valeur, timeframe.
                const realSource = lvSrc; // diagnostic gel valeur (2026-08-11) : lot / lot-FIGÉ / indiv / cacheXs / prix
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
                if ((!armed || pos._awaitBounce) && candleAfterEntry) {
                    const rsi2 = calculateRSI(pcs.slice(0, -1).map(c => c[4]), 2);
                    // en attente de rebond, le RSI2>90 sort QUEL QUE SOIT le signe : c'est la seule issue
                    // d'une position profondément négative (LP>0 exigerait un prix ×2,22).
                    if (rsi2 != null && rsi2 > 90 && (pos._awaitBounce || realGain > RSI2_FLOOR_LP)) {
                        // (2026-08-24) RSI2 = PLANCHER quand pas armé (< +6% LP). Sort les positions molles DANS LE
                        // VERT avant qu'elles retombent. Le trail-only l'avait retiré → hold rouge sans issue (cc
                        // aurait fermé +1.2%, s'est retrouvé -11.5% live). Au-dessus de l'arm, le trail ride les runners.
                        await closePaper(tok, pos, px, `${pos._awaitBounce ? 'REBOND ' : ''}RSI2 ${rsi2.toFixed(0)}>90 (LP ${realGain >= 0 ? '+' : ''}${(realGain * 100).toFixed(1)}%)`);
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
            // RETRY FORCÉ HTF (2026-08-17) : le fetch 1H/daily du pattern est victime du backoff Birdeye partagé
            // (un 429/400 ailleurs → tout tombe sur GMGN → 15m → pattern étalé sur semaines HORS CHAMP → FAUX
            // pattern-KO sur vieux coins déjà valides, cas TOAD/STONK). Si pas encore validé et que le fetch normal
            // retombe <12 bougies, on rejoue UNE fois en bypassant le backoff (toujours throttlé). 1 réussite → la
            // persistance par mint verrouille 14j. Limité aux non-validés → auto-borné (charge négligeable).
            const needHTF = !w.patternValidated;
            if (ageH >= 720) { try { let ds = await candlesDay(tok, 1000); if (needHTF && (!ds || ds.length < 12)) ds = await candlesDay(tok, 1000, true); if (ds && ds.length >= 12) ms = ds; } catch (_) { /* fallback cs */ } }
            else if (ageH >= 48) { try { let hs = await candles1h(tok, 720); if (needHTF && (!hs || hs.length < 12)) hs = await candles1h(tok, 720, true); if (hs && hs.length >= 12) ms = hs; } catch (_) { /* fallback cs */ } }
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
            // DIAG POURQUOI PATTERN-KO (2026-08-20, demande user : trop de faux KO) : logge la condition qui manque
            // (flip rouge / recovery / nouvel ATH) + la TF utilisée → voir où le calcul diverge de la réalité.
            if (!pInfo.ok && !w.patternValidated && (!w._patKoLog || now - w._patKoLog > 10 * 60e3)) {
                w._patKoLog = now;
                const tf = ms === cs ? '15m' : (ageH >= 720 ? 'daily' : '1H');
                const why = !pInfo.flipRed ? 'jamais de flip ST rouge (pas de 1er dump)' : !pInfo.recovered ? 'pas de recovery (ST pas re-verte après le rouge)' : 'pas de nouvel ATH > ATH1 après recovery';
                console.log(`  🔬 pattern-KO ${w.symbol} [${tf}/${ms.length}b] : flipRouge=${pInfo.flipRed} recovery=${pInfo.recovered} ATH1=${pInfo.ath1 ? pInfo.ath1.toExponential(2) : '-'} ATH2=${pInfo.ath2 ? pInfo.ath2.toExponential(2) : 'AUCUN'} → ${why}`);
            }
            if (pInfo.ok) {
                state.patternOkMints[tok] = now; // rafraîchit la qualif par mint (persiste purge/re-add, TTL 14j)
                if (!w.patternValidated) { w.patternValidated = true; console.log(`  ✓ pattern EP VALIDÉ: ${w.symbol} — ATH1 ${pInfo.ath1?.toExponential(2)} → flip ST rouge (dump -${pInfo.dumpDepthPct}%) → ATH2 ${pInfo.ath2?.toExponential(2)} (2e ATH > 1er, +${pInfo.ath1 ? (((pInfo.ath2/pInfo.ath1)-1)*100).toFixed(0) : '?'}%) — qualification acquise`); }
            }
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

            // ATH-BREAKS DE VIE (2026-08-19) : cassures MAJEURES à +10% = vrais cycles de pump façon EP, PAS les
            // micro-hauts de bruit (+2% sur-comptait : CYBERLEEK 6→3, il n'a fait que 3 vrais ATH). Recompté sur
            // toute la série ms (déjà fetchée). Sépare CYBERLEEK(3, bon) des vrais épuisés (SAME 9, BULLSHIT 5).
            let lifeBreaks = 0, mxH = null;
            for (const c of ms) { const h = c[2]; if (mxH == null) mxH = h; else if (h > mxH * 1.10) { mxH = h; lifeBreaks++; } }
            w.athBreaks = lifeBreaks;
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
            // (cadence adaptative DÉPLACÉE plus bas — FIX 3 2026-08-15 : indexée sur dumpedFromHigh, pas drawdown-ATH)
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
            const dumpThrFixe = established ? 0.12 : 0.35;           // établi -12% (dips ANSEM ~11%) / volatil -35% (2026-08-10 : -40%→-35%, backtest FOMO WR 73%→81% +13 entrées gagnantes = cadence EP)
            const aPct = atrPct15(cs);
            const dumpThrAtr = aPct != null ? Math.max(ATR_FLOOR, ATR_K * aPct) : null;
            const dumpThr = (ATR_ENTRY === 'on' && dumpThrAtr != null) ? dumpThrAtr : dumpThrFixe;
            const recentHigh = Math.max(...cs.slice(-winN).map(c => c[2]));
            const dumpedFromHigh = recentHigh > 0 ? 1 - curPrice / recentHigh : 0;
            const atDip = dumpedFromHigh >= dumpThr;
            // SHADOW ATR (mode 'shadow') : on n'enregistre QUE les désaccords entre les deux règles, 1 par
            // token/heure → après quelques jours on sait, sur du forward réel, si l'ATR aurait mieux fait.
            if (ATR_ENTRY !== 'on' && dumpThrAtr != null && !inPos && (dumpedFromHigh >= dumpThrAtr) !== atDip
                && (!w._atrShadowAt || now - w._atrShadowAt > 3600e3)) {
                w._atrShadowAt = now;
                recordShadow('atrEntry', { symbol: w.symbol, tok, price: curPrice, dumpPct: +(dumpedFromHigh * 100).toFixed(1),
                    thrFixe: +(dumpThrFixe * 100).toFixed(1), thrAtr: +(dumpThrAtr * 100).toFixed(1),
                    sens: atDip ? 'FIXE-entre-ATR-refuse' : 'ATR-entre-FIXE-refuse', established, curMcK: Math.round(curMc / 1000) });
            }
            // FIX 3 (2026-08-15) : cadence de check indexée sur la PROXIMITÉ D'ENTRÉE (dump sous le haut récent
            // vs seuil), pas sur le drawdown-sous-ATH. Un cadavre à -80% ATH dont le haut-6h a fondu (dump≈0)
            // n'est PAS près d'un déclenchement → check lent (10min) → libère le budget-fetch pour les frais.
            // Un token qui approche le -35% (ou -12% établi) → check rapide (60s). Corrige la famine où les
            // cadavres monopolisaient le 60s. dipProx=1.0 = pile au seuil ; marche pour établi ET volatil.
            if (!inPos) {
                // PALIERS DE CADENCE (2026-08-17, demande user) indexés sur la PROXIMITÉ D'ENTRÉE (dipProx =
                // dump-sous-haut-récent / seuil) → s'ADAPTE aux gros coins (seuil 12%) comme aux volatils (35%) :
                // proche ATH 5min · ~-10% 3min · ~-20% 2min · ~-25%+ 1min. Borne la latence (max 5min vs 10min avant).
                const dipProx = dumpThr > 0 ? dumpedFromHigh / dumpThr : 0;
                w.nextCheckAt = now + (dipProx >= 0.71 ? 60e3 : dipProx >= 0.57 ? 120e3 : dipProx >= 0.29 ? 180e3 : 300e3);
                w.nearEntry = dipProx >= 0.71; // dès ~-25% → cache frais 45s (les checks 1min voient enfin le vrai prix)
            }
            // ANTI-COIN-MOURANT (2026-08-04, règle user) : après un close on ne RÉ-OUVRE que si le prix a
            // re-dépassé notre dernière entrée (= il chope encore). S'il ne fait que des lower lows sous notre
            // entrée, il MEURT → on n'ouvre plus dessus (cas Slop cut -34% puis re-dump).
            if (!state.positions[tok] && w.lastEntryPrice && curPrice >= w.lastEntryPrice * 0.98) w.recovered = true;
            // Le TTL est neutre par défaut (cf MOURANT_TTL_H) : le backtest a tranché contre. Ce qui EST
            // corrigé ici, c'est la COHÉRENCE du verrou : lastEntryPrice vivait sur l'entrée de watch, donc
            // perdu à chaque purge/re-add → le gate s'appliquait au hasard (les tokens jetables y échappaient,
            // les machines à fees, jamais purgées, y restaient). Désormais persisté par mint = appliqué à tous.
            const mourantExpired = MOURANT_TTL_MS !== Infinity && w.lastExitTs && (now - w.lastExitTs) >= MOURANT_TTL_MS;
            const canReenter = !w.lastEntryPrice || w.recovered || mourantExpired;
            // ANTI-CHASE-PUMP (2026-08-04, cas CATE entré en plein +8.7%) : on n'entre QUE si survendu
            // (RSI2 bas = DANS le dump), pas quand ça pompe déjà. EP achète la peur, pas l'euphorie.
            const rsiEntry = calculateRSI(cs.slice(0, -1).map(c => c[4]), 2);
            // SEUIL 40 → 50 (2026-08-27, backtest 50 mints × 10j, bougies réelles) : +32 entrées marginales,
            // WR 88%, +122% de PnL cumulé, ZÉRO CUT supplémentaire (12 gros perdants dans les deux cas), et
            // positif sur les DEUX moitiés de période (moy +3,96% / +7,15%). Le verdict "n'ajoute aucun trade"
            // du 17/08 reposait sur 7 trades ; ici la baseline en compte 173 (calibrée : 172 trades réels).
            // La tranche RSI2 40-44 reste la PLUS FAIBLE des marginales — d'où 50 et pas plus haut.
            const RSI_ENTRY_MAX = 50;
            const rsiLow = rsiEntry != null && rsiEntry < RSI_ENTRY_MAX;   // survendu/pullback (pas en pump)
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
            // PLANCHER FEES/TVL (2026-08-10, cas Jimothy 0.15%) : n'entrer QUE sur des pools qui génèrent des
            // fees (≥5% fees/TVL 24h via la map découverte). Fail-open si map vide (hoquet datapi → pas de blocage).
            const feeTvl = (feeTvlMap.get(tok) || {}).ratio || 0;
            const feesOk = feeTvlMap.size === 0 || feeTvl >= FEE_TVL_FLOOR;
            w.hot = !!(armed && mcOk && chopOk);                     // "chaud" = choppy + armé
            // ── DIAGNOSTIC : 1re condition qui bloque + compteur global (nouveau funnel EP) ──
            let block = null;
            if (!armed) block = 'not-armed';
            else if (!mcOk) block = 'MC<250k';
            else if (ageH < AGE_MIN_H) block = 'coin<10h';
            else if (!patOk) block = 'pattern-KO';
            else if (!chopOk) block = `dumper(chop${(cr * 100).toFixed(0)}%)`; // cr==null ne bloque plus (2026-08-09) → on tombe sur le vrai blocage suivant
            else if (!atDip) block = `pas-au-creux(<${(dumpThr * 100).toFixed(0)}%${established ? '·établi' : ''})`;
            else if (!rsiLow) block = `pas-survendu(RSI>${RSI_ENTRY_MAX}=pompe)`;
            else if ((w.athBreaks || 0) >= 4 && curMc < 1_500_000) block = 'ATH-épuisé(4x·<1.5M)'; // cap ATH conditionnel MC (2026-08-17) : le 4e top qui rug = un PETIT coin (WOFL $92k → -35%). Un coin ≥1.5M qui multiplie les ATH TREND (LAYOOO $2.75M → +17.7%) → pas de cap. Validé sur la journée.
            else if (!canReenter) block = 'coin-mourant';
            else if (!feesOk) block = `fees<${FEE_TVL_FLOOR}%(${feeTvl.toFixed(0)}%)`; // pool ne génère pas assez de fees → LP mort
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
                feeTvl24h: +feeTvl.toFixed(1),                           // rendement LP de la pool (plancher ≥5%)
            };
            // DIAG NEAR-MISS (2026-08-15) : le token EST au creux (dip frais ≥ seuil) mais l'entrée est bloquée
            // par une condition ULTÉRIEURE → on log la raison (throttle 5min). Distingue "dip raté/jamais vu"
            // de "dip vu mais bloqué". block==null ici = entrée réelle (ne rien logger).
            // (2026-08-27) `block` vaut 'ENTRÉE' quand tout passe — il n'est JAMAIS null, donc le diag
            // "AU CREUX mais bloqué → ENTRÉE" se déclenchait sur les vraies entrées. On l'exclut.
            if (atDip && block && block !== 'ENTRÉE' && !state.positions[tok] && (!w.lastNearMissAt || now - w.lastNearMissAt > 5 * 60e3)) {
                w.lastNearMissAt = now;
                console.log(`🎯 DIAG near-miss: ${w.symbol} AU CREUX (dump -${(dumpedFromHigh * 100).toFixed(0)}% ≥ ${(dumpThr * 100).toFixed(0)}%) mais bloqué → ${block} | RSI2=${rsiEntry != null ? rsiEntry.toFixed(0) : '?'} recovered=${!!w.recovered} athBreaks=${w.athBreaks || 0} cooldown=${!!onCooldown} feeTvl=${feeTvl.toFixed(0)}%`);
            }
            // SHADOW ATH-ÉPUISÉ (2026-08-19, demande user) : le cap bloque ces coins → 0 trade → impossible d'évaluer
            // le cap depuis /trades (biais de sélection). On enregistre chaque coin bloqué ATH-épuisé AU CREUX +
            // survendu (= vrai candidat refusé) avec son prix → on mesure le forward (rebond vs rug) sans trader.
            // 1 record par token (au 1er blocage) → verdict : le cap sauve-t-il plus qu'il ne coûte, à quel seuil.
            // SHADOW REBOND (2026-08-27) : dans le backtest, en retirant TOUT le gate RSI, la MEILLEURE tranche
            // d'entrées marginales est RSI2 ≥ 80 (n=29, moy +11,9%, WR 90%) et la PIRE est 40-44 (moy -0,7%) —
            // c'est-à-dire qu'acheter le rebond CONFIRMÉ bat acheter le couteau. La variante `<50 OU >80` bat la
            // baseline 9 jours sur 10. MAIS le proxy-PRIX flatte mécaniquement les entrées qui montent tout de
            // suite (piège trail-only du 24/08) → on MESURE en forward avant d'y toucher.
            if (atDip && !state.positions[tok] && rsiEntry != null && rsiEntry > 80 && block === `pas-survendu(RSI>${RSI_ENTRY_MAX}=pompe)`
                && (!w._bounceShadowAt || now - w._bounceShadowAt > 3600e3)) {
                w._bounceShadowAt = now;
                recordShadow('rebondRSI80', { symbol: w.symbol, tok, price: curPrice, rsi2: +rsiEntry.toFixed(0),
                    dumpPct: +(dumpedFromHigh * 100).toFixed(1), feeTvl: +feeTvl.toFixed(1), curMcK: Math.round(curMc / 1000) });
            }
            if (atDip && rsiLow && block && block.startsWith('ATH-épuisé') && !state.positions[tok] && !w.athShadowLogged) {
                w.athShadowLogged = true;
                recordShadow('athEpuise', { symbol: w.symbol, tok, price: curPrice, athBreaks: w.athBreaks || 0, curMcK: Math.round(curMc / 1000), feeTvl: +feeTvl.toFixed(1), dumpPct: +(dumpedFromHigh * 100).toFixed(0) });
            }
            // ── ENTRÉE EP CHOP-CYCLE (2026-08-03) : coin CHOPPY (chop-rate ≥60%) + AU CREUX (dumpé ≥10% sous
            // le haut récent) + armé (>250k) + pas explosif + pas en cooldown. Plus de gate ATH/pattern/retrace :
            // on ouvre sur CHAQUE dump d'un chopper et on CYCLE (le cooldown post-close pace la ré-ouverture).
            if (armed && mcOk && ageH >= AGE_MIN_H && patOk && chopOk && atDip && rsiLow && canReenter && feesOk && ((w.athBreaks || 0) < 4 || curMc >= 1_500_000) && !explosif && !onCooldown && Object.keys(state.positions).length < MAX_POSITIONS) {
                // Pool Meteora viable requise en LIVE (sélection EP "coin AND pool selection") — lazy, cachée 30min.
                if (live.enabled && live.findMeteoraPool) {
                    if (w.meteoraOk == null || now - (w.meteoraCheckedAt || 0) > 30 * 60e3) {
                        // (2026-08-27) une ERREUR RPC n'est PAS "pas de pool" : avant, un 429 Helius posait
                        // meteoraOk=false et bloquait l'entrée — y compris PAPIER — pendant 30 min. Désormais
                        // on ne mémorise que les vraies réponses ; sur erreur on laisse passer (l'ouverture
                        // live échouera proprement en "papier seulement" si la pool manque vraiment).
                        try { w.meteoraOk = !!(await live.findMeteoraPool(tok, (feeTvlMap.get(tok) || {}).pool)); w.meteoraCheckedAt = now; }
                        catch (e) { w.meteoraOk = null; w.meteoraCheckedAt = 0; console.log(`  ⚠️ findMeteoraPool ${w.symbol} KO (${String(e.message).slice(0, 50)}) — non mémorisé`); }
                    }
                    if (w.meteoraOk === false) { state.blockCount['no-pool-meteora'] = (state.blockCount['no-pool-meteora'] || 0) + 1; continue; }
                }
                const entry = curPrice;
                w.lastEntryPrice = entry; w.recovered = false;   // anti-mourant : ré-ouvre seulement s'il re-dépasse ce prix
                const support = `chop${(cr * 100).toFixed(0)}%-dip${(dumpedFromHigh * 100).toFixed(0)}%`;
                const athAgeHr = athAgeH != null ? +athAgeH.toFixed(1) : null;
                state.positions[tok] = { symbol: w.symbol, entry, openedAt: now, ageH: +ageH.toFixed(1), athMc: Math.round(athMc), drawdownPct: +(drawdown * 100).toFixed(0), support, patternOk: patOk, athAgeH: athAgeHr, athStale48, entryCandleTs: lastC[0],
                    // features d'entrée enrichies (2026-07-29) pour l'analyse gagnants/perdants
                    dumpDepthPct: pInfo.dumpDepthPct ?? null, entryMcK: Math.round(curMc / 1000), trueAthMc: Math.round(trueAth * w.supply), pctOfTrueAth: trueAth > 0 ? +((ath / trueAth) * 100).toFixed(0) : null, vol24hK: w.vol ? Math.round(w.vol / 1000) : null,
                    athBreaks: w.athBreaks || 0, feeTvl: +feeTvl.toFixed(1),  // (2026-08-17) analyse cap-ATH/fees par trade sans reconstruire
                    // (2026-08-30) La SuperTrend était calculée à l'entrée puis JETÉE — il fallait la
                    // reconstruire depuis les bougies pour l'analyser. Mesuré sur 83 trades de gros coins :
                    // ST verte +0,0027/trade contre +0,0009 en rouge, et la distance à la ligne passe de
                    // +11% (au-dessus du support) à -11% (rien en dessous). On l'enregistre désormais.
                    stTrend: prevSt ? (prevSt.trend === 1 ? 'vert' : 'rouge') : null,
                    stDistPct: (line > 0) ? +(((curPrice / line) - 1) * 100).toFixed(1) : null,
                    stTrendHtf: (() => { const h = superTrend(ms); return h.length >= 2 ? (h[h.length - 2].trend === 1 ? 'vert' : 'rouge') : null; })(),
                    htfLabel: ms === cs ? '15m' : (ageH >= 720 ? 'daily' : '1H'),
                    downtrendEntry: downtrend, established };  // established (MC≥5M) → exit régime doux (15m, TP bas)
                save();
                if (downtrend) { console.log(`  · [SHADOW downtrend] ${w.symbol} : entrée en LOWER-HIGHS (haut récent -${((1 - recentHigh12 / priorHigh12) * 100).toFixed(0)}% vs avant) — mesure, on juge l'issue (dead-cat ?)`); recordShadow('downtrend', { symbol: w.symbol, dropHighPct: +((1 - recentHigh12 / priorHigh12) * 100).toFixed(0) }); }
                const msg = `🎯 ENTRÉE ${w.symbol} (chop-cycle${downtrend ? ' ⚠️downtrend' : ''})\nprix: $${entry.toFixed(8)} | chop ${(cr * 100).toFixed(0)}% | dumpé -${(dumpedFromHigh * 100).toFixed(0)}% sous le haut récent\nâge token: ${ageH.toFixed(1)}h | MC: $${Math.round(curMc / 1000)}k\nSortie: TP +6% OU RSI(2)>90 | cut hors-range -35% | on cycle`;
                console.log(msg.replace(/\n/g, ' | '));   // Telegram RÉEL uniquement (2026-08-11) : la notif part seulement si l'ouverture live réussit (voir plus bas)
                // ── LIVE : ouverture réelle en miroir de l'entrée papier ──
                // Cap MAX_LIVE_POSITIONS (défaut 1, 2026-07-22) : limite le blast radius en dry-run —
                // le paper peut suivre jusqu'à MAX_POSITIONS, mais on n'ouvre au réel qu'une position
                // à la fois tant qu'on valide l'exécution. Réglable par env quand la validation est faite.
                const liveOpenCount = Object.values(state.positions).filter(p => p.live).length;
                if (live.enabled && liveOpenCount >= MAX_LIVE_POSITIONS) {
                    console.log(`  ⏸️ LIVE: ${liveOpenCount}/${MAX_LIVE_POSITIONS} position(s) réelle(s) déjà ouverte(s) — ${w.symbol} en papier seulement`);
                } else if (live.enabled) {
                    try {
                        const poolAddr = await live.findMeteoraPool(tok, (feeTvlMap.get(tok) || {}).pool);   // (2026-08-30) préfère la pool que la datapi a désignée comme la plus rémunératrice
                        if (poolAddr) {
                            const lp = await live.openBidAsk(poolAddr);
                            if (lp) { state.positions[tok].live = lp; save(); tg(`${msg}\n🟢 RÉEL ouvert: ${lp.depositedSol.toFixed(3)} SOL, bins [${lp.lowerBinId}→${lp.upperBinId}]`); } // notif Telegram = uniquement l'entrée RÉELLE (avec tous les détails)
                        } else { console.log('  ⚠️ LIVE: aucune pool DLMM viable — trade papier seulement'); } // pas de notif Telegram pour le papier
                    } catch (e) { console.log(`  ⚠️ LIVE open échoué: ${String(e.message).slice(0, 80)} — papier seulement`); tg(`⚠️ LIVE ${w.symbol}: open échoué (${String(e.message).slice(0, 50)})`); }
                }
            }
        }
        console.log(`🔍 Scan ${hotOnly ? 'HOT' : 'complet'} | watch ${Object.keys(state.watch).length} | pos ${Object.keys(state.positions).length} | bougies OK ${cOk}/vide ${cKo}${rl429 ? `/429×${rl429}` : ''}${cOk === 0 && (cKo + rl429) > 0 ? ' ⚠️ SOURCE BOUGIES DOWN' : ''}`);
        // DIAG (2026-08-15) : pourquoi des tokens restent JAMAIS évalués (None) — raison du dernier skip + âge en watch.
        if (!hotOnly) {
            const nones = Object.entries(state.watch)
                .filter(([tok, w]) => !w.diag && !state.positions[tok])
                .map(([tok, w]) => `${w.symbol}(${Math.round((now - (w.addedAt || now)) / 60000)}min·${w.lastSkip || 'jamais-atteint'})`);
            if (nones.length) console.log(`🔬 DIAG None jamais évalués (${nones.length}) : ${nones.join(' · ')}`);
        }
    } finally { scanning = false; save(); }
}


// TRAJECTOIRE LP (2026-08-19) : pose _lv ET historise (valeur%, bin, ts) → au close on l'attache au trade →
// consultable via /trades?all=1 (jamais perdue). Un trou de temps entre 2 points = lecture gelée (429) ;
// une décroissance lisse = mécanique LP. Tranche « 429 vs LP non-linéaire » sur les sorties trail tardives.
function recordLv(pos, rg, bin) {
    pos._lv = { rg, bin, ts: Date.now() };
    (pos._lvHist = pos._lvHist || []).push({ t: Date.now(), lp: +(rg * 100).toFixed(1), bin });
    if (pos._lvHist.length > 40) pos._lvHist.shift();
}
// (2026-08-27) Garde-fou anti-await-infini : AUCUN appel RPC de bonus-live.js n'a de timeout (web3.js
// n'en pose pas par défaut) → pendant une tempête 429, un close pouvait ne JAMAIS résoudre.
function withTimeout(promise, ms, label) {
    let t; return Promise.race([
        promise.finally(() => clearTimeout(t)),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms / 1000}s (${label})`)), ms); }),
    ]);
}
const CLOSE_TIMEOUT_MS = 90 * 1000;   // au-delà, on relâche le verrou et on RE-TENTE au tick suivant
async function closePaper(tok, pos, exitPrice, reason) {
    // ANTI-VERROU MORT (2026-08-27, cas Zoe 26/08) : `_closing` restait à true pour toujours quand
    // `closeVerified` ne résolvait jamais (429 Helius) → tous les closes suivants sortaient ICI, en
    // silence : trail armé à +7,2%, condition de sortie vraie 3h11, position finie à -25%, zéro alerte.
    // `_closing` est en plus persisté par save() → il survivait aux redéploiements. Watchdog + finally.
    if (pos._closing) {
        if (Date.now() - (pos._closingAt || 0) < 3 * CLOSE_TIMEOUT_MS) return;
        console.log(`⚠️ ${pos.symbol}: verrou _closing bloqué depuis ${Math.round((Date.now() - (pos._closingAt || 0)) / 1000)}s — relâché, close re-tenté`);
    }
    pos._closing = true; pos._closingAt = Date.now();
    // ── LIVE : fermer la vraie position D'ABORD. Si le close réel échoue → on GARDE le tracking
    // (pattern anti-world de bot 1 : jamais supprimer une position pas vidée on-chain).
    let pnlSolLive = null;
    if (pos.live && live.enabled) {
        // anti-spam Telegram : la sortie se re-déclenche à chaque tick tant que la position est GARDÉE
        // (close en échec) → on n'alerte qu'une fois / 15 min par position, mais on RE-TENTE le close à
        // chaque tick (silencieusement) jusqu'à ce qu'il passe.
        const alertThrottled = (msg) => { const n = Date.now(); if (!pos.lastCloseAlert || n - pos.lastCloseAlert > 15 * 60 * 1000) { tg(msg); pos.lastCloseAlert = n; } };
        try {
            const r = await withTimeout(live.closeVerified(pos.live), CLOSE_TIMEOUT_MS, `close ${pos.symbol}`);
            if (!r || !r.ok) { alertThrottled(`🚨 LIVE ${pos.symbol}: close INCOMPLET — position GARDÉE, re-tentée à chaque tick, vérifier on-chain`); pos._closing = false; return; }
            // PnL RÉEL = valeur on-chain close − open (X+Y+fees, insensible au bruit wallet). Fallback sur
            // le flat-to-flat seulement si la lecture on-chain a échoué (2026-07-25, fix mesure).
            if (r.closeValueSol != null && pos.live.openValueSol != null) {
                pnlSolLive = +(r.closeValueSol - pos.live.openValueSol).toFixed(4);
            } else {
                pnlSolLive = +(r.proceedsSol - pos.live.depositedSol).toFixed(4);
                console.log(`  ⚠️ PnL live via flat-to-flat (lecture on-chain KO) — moins fiable`);
            }
        } catch (e) {
            // timeout OU erreur : on relâche TOUJOURS le verrou (sinon la position n'a plus de sortie) et on
            // garde le tracking (jamais supprimer une position pas vidée on-chain, pattern anti-world bot 1).
            console.log(`  ⚠️ close ${pos.symbol} échoué: ${String(e.message).slice(0, 80)} — verrou relâché, re-tenté au prochain tick`);
            alertThrottled(`🚨 LIVE ${pos.symbol}: close erreur (${String(e.message).slice(0, 60)}) — position GARDÉE`);
            pos._closing = false; return;
        }
    }
    const pnlPct = exitPrice / pos.entry - 1;
    const trade = {
        pnlSolLive, // PnL RÉEL fees incluses (null en paper pur) — à comparer au pnlSol prix
        tok, symbol: pos.symbol, entry: pos.entry, exit: exitPrice,
        pnlPct: +(pnlPct * 100).toFixed(2), pnlSol: +(pnlPct * POSITION_SIZE_SOL).toFixed(4),
        ageH: pos.ageH, athMc: pos.athMc, freshPct: pos.freshPct ?? null, athAgeH: pos.athAgeH ?? null, athStale48: pos.athStale48 ?? null, stochK: pos.stochK ?? null, stochBonus: pos.stochBonus ?? null, support: pos.support ?? null, patternOk: pos.patternOk ?? null, maxStackLevel: pos.maxStackLevel ?? 0, durMin: Math.round((Date.now() - pos.openedAt) / 60000),
        drawdownPct: pos.drawdownPct ?? null, dumpDepthPct: pos.dumpDepthPct ?? null, entryMcK: pos.entryMcK ?? null, trueAthMc: pos.trueAthMc ?? null, pctOfTrueAth: pos.pctOfTrueAth ?? null, vol24hK: pos.vol24hK ?? null, downtrendEntry: pos.downtrendEntry ?? null,
        athBreaks: pos.athBreaks ?? null, feeTvl: pos.feeTvl ?? null, peakGainPct: pos.peakGain != null ? +(pos.peakGain * 100).toFixed(1) : null, // (2026-08-19) comble le trou + peak pour lire la trajectoire
        // (2026-08-30) champs calculés à l'entrée puis perdus : SuperTrend 15m + HTF, distance à la ligne,
        // et `established` (le régime de sortie 5m/15m) qui n'était nulle part dans le trade.
        stTrend: pos.stTrend ?? null, stDistPct: pos.stDistPct ?? null, stTrendHtf: pos.stTrendHtf ?? null, htfLabel: pos.htfLabel ?? null,
        established: pos.established ?? null,
        lvHist: pos._lvHist || null, // trajectoire valeur LP (lp%, bin, ts) → trous = 429, décroissance lisse = mécanique LP
        openedAt: new Date(pos.openedAt).toISOString(), closedAt: new Date().toISOString(), reason,
    };
    state.trades.push(trade);
    delete state.positions[tok];
    if (state.watch[tok]) {
        state.watch[tok].cooldownUntil = Date.now() + REENTRY_COOLDOWN_MS; // anti-boucle : pas de ré-entrée immédiate sur le même mouvement
        state.watch[tok].lastExitTs = Date.now();                          // (2026-08-27) départ du TTL 48h anti-mourant
        state.mourantMints = state.mourantMints || {};
        state.mourantMints[tok] = { px: state.watch[tok].lastEntryPrice ?? pos.entry, exitTs: Date.now() };
    }
    save();
    const tot = state.trades.reduce((s, t) => s + t.pnlSol, 0);
    const wr = state.trades.filter(t => t.pnlSol > 0).length / state.trades.length * 100;
    // PnL LP réel en % de la mise (= ce que Meteora affiche) — souvent TRÈS différent du % prix quand le
    // token a fait un V (Bid-Ask achète le dip, revend la remontée → +66% LP sur +4.9% prix, cas Looks).
    const liveOpenVal = pos.live?.openValueSol;
    const livePct = (pnlSolLive != null && liveOpenVal) ? (pnlSolLive / liveOpenVal) * 100 : null;
    const liveLine = pnlSolLive != null ? `\n💵 PnL LP RÉEL: ${livePct != null ? `${livePct > 0 ? '+' : ''}${livePct.toFixed(0)}% (` : ''}${pnlSolLive > 0 ? '+' : ''}${pnlSolLive} SOL${livePct != null ? ')' : ''} — fees incluses` : '';
    // Console = complet (papier + réel) pour le debug.
    console.log(`${pnlPct > 0 ? '✅' : '🛑'} SORTIE ${pos.symbol} — ${reason} | PnL prix ${(pnlPct * 100).toFixed(1)}% (${trade.pnlSol > 0 ? '+' : ''}${trade.pnlSol} SOL papier, ${trade.durMin} min)${liveLine.replace(/\n/g, ' ')} | 📒 ${state.trades.length} trades WR ${wr.toFixed(0)}%`);
    // Telegram = RÉEL uniquement, PnL LP RÉEL en avant (plus de PnL papier) — 2026-08-11.
    if (pos.live) {
        const good = (pnlSolLive != null ? pnlSolLive : pnlPct) > 0;
        const realPnl = pnlSolLive != null
            ? `${livePct != null ? `${livePct > 0 ? '+' : ''}${livePct.toFixed(0)}% ` : ''}(${pnlSolLive > 0 ? '+' : ''}${pnlSolLive} SOL, fees incluses)`
            : `${(pnlPct * 100).toFixed(1)}%`;
        tg(`${good ? '✅' : '🛑'} SORTIE ${pos.symbol} — ${reason}\n💵 PnL LP réel: ${realPnl} | ${trade.durMin} min`);
    }
}

// ── Serveur HTTP minimal : requis pour que Railway marque le déploiement Actif
// (sans port ouvert, le service reste "Deploying" indéfiniment) + expose les stats papier ──
const http = require('http');
http.createServer((req, res) => {
    // GET /logs/list — dates + tailles des logs persistés sur disque (2026-08-26)
    if ((req.url || '').startsWith('/logs/list')) {
        flushLogsToDisk();
        let info = [];
        try { info = fs.readdirSync(LOG_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort().map(f => { let sz = 0; try { sz = fs.statSync(path.join(LOG_DIR, f)).size; } catch (_) {} return { date: f.slice(0, 10), sizeKB: Math.round(sz / 1024) }; }); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ retentionDays: LOG_RETENTION_DAYS, days: info }));
    }
    // GET /logs/file?date=YYYY-MM-DD  ou  ?from=YYYY-MM-DD&to=YYYY-MM-DD — logs persistés (2026-08-26)
    if ((req.url || '').startsWith('/logs/file')) {
        flushLogsToDisk();
        const q = new URL(req.url, 'http://x').searchParams;
        const from = q.get('from') || q.get('date'); const to = q.get('to') || q.get('date');
        let out = [];
        try {
            for (const f of fs.readdirSync(LOG_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort()) {
                const d = f.slice(0, 10); if ((!from || d >= from) && (!to || d <= to)) out.push(fs.readFileSync(path.join(LOG_DIR, f), 'utf8'));
            }
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(out.join('') || 'aucun log persisté pour cette période');
    }
    // GET /logs?tail=N — buffer mémoire live (rejets qualité, purges, entrées, shadow)
    if ((req.url || '').startsWith('/logs')) {
        const tail = parseInt(new URL(req.url, 'http://x').searchParams.get('tail') || '300', 10);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(LOG_BUFFER.slice(-tail).join('\n'));
    }
    // GET /trades?all=1 — dump JSON de l'historique des trades (all=1 = tout ; sinon les 200 derniers).
    // Chaque trade porte désormais athBreaks/feeTvl/entryMcK → analyse cap-ATH/fees/MC sans reconstruire.
    if ((req.url || '').startsWith('/trades')) {
        const q = new URL(req.url, 'http://x').searchParams;
        const list = q.get('all') === '1' ? state.trades : state.trades.slice(-parseInt(q.get('tail') || '200', 10));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ n: state.trades.length, trades: list }));
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
    // ANALYSE PERDANTS (2026-08-11) : TOUS les trades ≤ -15% avec features + raison de sortie (le CUT hors-range
    // est-il le coupable ? EP tient hors-range) + répartition par raison + comparaison features gagnants/perdants.
    const losersAnalysis = (() => {
        const T = state.trades.filter(t => typeof t.pnlPct === 'number');
        const losers = T.filter(t => t.pnlPct <= -15);
        const wins = T.filter(t => t.pnlPct > 0);
        const byReason = {};
        for (const t of losers) { const k = (t.reason || '?').replace(/\(.*/, '').trim(); byReason[k] = (byReason[k] || 0) + 1; }
        const avg = (arr, k) => { const v = arr.map(x => x[k]).filter(x => typeof x === 'number'); return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : null; };
        return {
            nLosers: losers.length, nWins: wins.length, nTotal: T.length,
            losersByReason: byReason,
            losersAvg: { dumpDepth: avg(losers, 'dumpDepthPct'), drawdown: avg(losers, 'drawdownPct'), athAgeH: avg(losers, 'athAgeH'), durMin: avg(losers, 'durMin') },
            winsAvg: { dumpDepth: avg(wins, 'dumpDepthPct'), drawdown: avg(wins, 'drawdownPct'), athAgeH: avg(wins, 'athAgeH'), durMin: avg(wins, 'durMin') },
            losersList: losers.slice(-45).map(t => ({ s: t.symbol, tok: t.tok || null, pnl: t.pnlPct, r: (t.reason || '').slice(0, 24), entry: t.entry, closedAt: t.closedAt, dur: t.durMin })),
        };
    })();
    // ANALYSE STACKING (2026-08-15, lecture seule) : un coin qui a dippé -X% (maxStackLevel) a-t-il rebondi ?
    // WR + pnl moyen par niveau de dip → dit si stacker (moyenner à -10%) est gagnant, et sur quels coins.
    const stackingAnalysis = (() => {
        const T = state.trades.filter(t => typeof t.pnlPct === 'number');
        const g = (arr) => arr.length ? { n: arr.length, wr: Math.round(arr.filter(t => t.pnlPct > 0).length / arr.length * 100) + '%', avgPnl: +(arr.reduce((s, t) => s + t.pnlPct, 0) / arr.length).toFixed(1) } : { n: 0 };
        const parNiveau = {};
        for (let lvl = 0; lvl <= 6; lvl++) { const arr = T.filter(t => (t.maxStackLevel || 0) === lvl); if (arr.length) parNiveau[lvl === 0 ? 'pas_de_dip' : `dip_-${lvl * 10}%`] = g(arr); }
        const dippers = T.filter(t => (t.maxStackLevel || 0) >= 1);
        return {
            parNiveau,
            nonDippers: g(T.filter(t => (t.maxStackLevel || 0) === 0)),
            dippers_moins10: g(dippers),
            gros_etablis_dippers: g(dippers.filter(t => (t.entryMcK || 0) >= 3000)), // stacker seulement là ?
            petits_dippers: g(dippers.filter(t => (t.entryMcK || 0) < 3000)),
        };
    })();
    // ANALYSE TAILLE + PROFONDEUR D'ENTRÉE (2026-08-15, lecture seule) : gros vs petits coins gagnent-ils plus ?
    // Et les entrées PROFONDES (coin déjà bien dumpé) gagnent-elles mieux ? (EP : "lower entry = better margin")
    const sizeAnalysis = (() => {
        const T = state.trades.filter(t => typeof t.pnlPct === 'number');
        const g = (arr) => arr.length ? { n: arr.length, wr: Math.round(arr.filter(t => t.pnlPct > 0).length / arr.length * 100) + '%', avgPnl: +(arr.reduce((s, t) => s + t.pnlPct, 0) / arr.length).toFixed(1) } : { n: 0 };
        const byDepth = {};
        for (const [lbl, lo, hi] of [['entree_dump_0-15%', 0, 15], ['entree_dump_15-30%', 15, 30], ['entree_dump_30-50%', 30, 50], ['entree_dump_50%+', 50, 999]])
            byDepth[lbl] = g(T.filter(t => (t.dumpDepthPct || 0) >= lo && (t.dumpDepthPct || 0) < hi));
        return {
            gros_MC3M: g(T.filter(t => (t.entryMcK || 0) >= 3000)),
            petits: g(T.filter(t => (t.entryMcK || 0) < 3000)),
            parProfondeurEntree: byDepth,
            // croisement : les GROS entrés PEU profond (dump<30%) vs entrés PROFOND (dump≥30%)
            gros_entree_peu_profonde: g(T.filter(t => (t.entryMcK || 0) >= 3000 && (t.dumpDepthPct || 0) < 30)),
            gros_entree_profonde: g(T.filter(t => (t.entryMcK || 0) >= 3000 && (t.dumpDepthPct || 0) >= 30)),
        };
    })();
    res.end(JSON.stringify({
        // (2026-08-27) était 'PAPER' EN DUR alors que LIVE est armé depuis des semaines — impossible de
        // savoir depuis /status si le bot passe de vrais ordres.
        mode: live.enabled ? 'LIVE' : 'PAPER',
        maxLivePositions: MAX_LIVE_POSITIONS, maxPaperPositions: MAX_POSITIONS,
        exitTuning: { armPct: TP_PCT * 100, trailPct: TRAIL * 100, bounceArmPct: RANGE_DOWN * 100, cutHardPct: CUT_HARD * 100, rsi2FloorLpPct: RSI2_FLOOR_LP * 100 },
        entryTuning: { rsiMax: 50, mourantTtl: MOURANT_TTL_H > 0 ? MOURANT_TTL_H + 'h' : 'à vie', atrEntry: ATR_ENTRY, atrK: ATR_K },
        updatedAt: new Date().toISOString(),
        positions: state.positions, watchCount: Object.keys(state.watch).length,
        trades: state.trades.length,
        winRate: state.trades.length ? Math.round(state.trades.filter(t => t.pnlSol > 0).length / state.trades.length * 100) + '%' : null,
        pnlSolPaper: +tot.toFixed(4),
        // A/B live : trailing (réel) vs TP fixe +6% (ombre) sur les MÊMES entrées
        blockCount: state.blockCount || {}, // compteur cumulé des raisons de non-entrée → voir le vrai goulot
        shadowStats: state.shadowStats || {}, // mesures shadow accumulées (persistées sur le volume)
        downtrendVsRange, // issue AGRÉGÉE downtrend vs range sur les 141 trades (le shadow enfin exploitable)
        losersAnalysis,   // TOUS les perdants ≤-15% + raison de sortie + features (analyse CUT hors-range)
        stackingAnalysis, // WR/pnl par niveau de dip (-10/-20/-30%) : stacker paie-t-il, et sur quels coins ?
        sizeAnalysis,     // WR/pnl gros vs petits coins + par profondeur d'entrée (faut-il entrer plus profond sur les gros ?)
        athAgeBins, // issue par tranche d'âge d'ATH à l'entrée (tous les trades) — voir mémoire athage-vs-outcome
        shadowManualCloses: state.shadowManualCloses || [], // regret des coupes manuelles (exit EP possible après ?)
        lastTrades: state.trades.slice(-10),
        watch: Object.entries(state.watch).map(([tok, w]) => ({ symbol: w.symbol, mint: tok, pool: w.pool, lastSkip: w.lastSkip, fetchFails: w.fetchFails || 0, ...(w.diag || { pending: true }) })),
    }, null, 2));
}).listen(process.env.PORT || 3000, () => console.log(`🌐 /status sur port ${process.env.PORT || 3000}`));

// (2026-08-27) ces deux lignes affirmaient "aucun ordre réel" JUSTE APRÈS le log "🟢 LIVE ACTIVÉ", et le
// Telegram décrivait l'ancienne stratégie (flip ST) avec "max 8 positions". Remis en accord avec le code.
console.log(`${live.enabled ? '🟢 Bonus Stage LIVE démarré — ordres RÉELS armés' : '🧪 Bonus Stage PAPER démarré — aucun ordre réel'} | entrée RSI2<50 · anti-mourant ${MOURANT_TTL_H > 0 ? 'TTL ' + MOURANT_TTL_H + 'h' : 'à vie'} · seuil creux ${ATR_ENTRY === 'on' ? `ATR k=${ATR_K}` : 'fixe (ATR en shadow)'} | max ${MAX_POSITIONS} papier / ${MAX_LIVE_POSITIONS} réelles`);
tg(`🚀 Bot démarré (${live.enabled ? 'LIVE' : 'paper'}). Entrée : chop-cycle au creux + RSI2<50 ; sortie : trail 1% au-dessus de +6% LP, RSI2>90 en dessous, CUT hors-range ${(RANGE_DOWN * 100).toFixed(0)}% ; max ${MAX_LIVE_POSITIONS} positions réelles.`);
// scan() enveloppé : un rejet dans un tick est loggé, jamais propagé en unhandledRejection.
const safeScan = () => scan().catch(e => console.log('⚠️ scan tick (survécu):', String(e?.stack || e?.message || e).slice(0, 200)));
setInterval(safeScan, SCAN_INTERVAL_MS);
safeScan();

// BOUCLE RAPIDE POSITIONS (2026-08-10) : le scan principal (18 coins + throttles bougies) prend ~40s → trop
// lent pour le trail (valeur lag, ex TOAD bot 11% vs Meteora 16%). Cette boucle checke UNIQUEMENT les positions
// toutes les 10s via la lecture GROUPÉE (1 seul appel RPC), et applique les sorties VALEUR-LIVE : trail,
// hors-range HAUT, CUT -35% live. Le RSI + CUT prix restent au scan 30s. _closing empêche tout double-close.
let fastChecking = false;
async function fastPositionCheck() {
    if (fastChecking || !live.enabled || !Object.keys(state.positions).length) return;
    fastChecking = true;
    try {
        const b = await batchedPositionValues();
        if (!b.fresh) { fastChecking = false; return; } // lot périmé → on NE traile PAS sur du gelé (le scan fera l'individuel)
        const bmap = b.map;
        // seuils = constantes de module (plus de copie locale qui dérive)
        for (const [tok, pos] of Object.entries(state.positions)) {
            if (!pos.live || !pos.live.openValueSol || pos._closing) continue;
            const bv = bmap.get(pos.live.positionKeypairPub);
            if (!bv || bv.valueSol == null) continue;
            const rg = bv.valueSol / pos.live.openValueSol - 1;
            recordLv(pos, rg, bv.activeBinId);
            pos.peakGain = Math.max(pos.peakGain || 0, rg);
            const armed = pos.peakGain >= TP_PCT, exitPx = pos.lastPx || pos.entry;
            // CUT hors-range -55% PARTOUT (2026-08-19, backtest tenir-vs-couper : -35% coupait trop tôt, delta +121% sur 12 CUT-bas ; -55% tient les rebonds, garde un plancher anti-rug)
            if (bv.activeBinId != null && pos.live.upperBinId != null && bv.activeBinId > pos.live.upperBinId) {
                await closePaper(tok, pos, exitPx, `CUT hors-range HAUT (banké +${(rg * 100).toFixed(1)}% LP, rapide)`);
            } else if (armed && rg <= pos.peakGain - TRAIL) {
                await closePaper(tok, pos, exitPx, `TRAIL LP +${(rg * 100).toFixed(1)}% (peak +${(pos.peakGain * 100).toFixed(1)}%, rapide)`);
            } else if (rg <= -CUT_HARD) {
                await closePaper(tok, pos, exitPx, `CUT PLANCHER ${(rg * 100).toFixed(1)}% LP (≤ -${(CUT_HARD * 100).toFixed(0)}%, rapide)`);
            } else if (rg <= -RANGE_DOWN && !pos._awaitBounce) {
                pos._awaitBounce = true; save();   // la boucle rapide n'a pas le RSI2 : elle arme, le scan sortira
                console.log(`  ⏳ ${pos.symbol}: seuil -${(RANGE_DOWN * 100).toFixed(0)}% franchi (LP ${(rg * 100).toFixed(1)}%, rapide) → attente du rebond`);
            }
        }
    } catch (e) { console.log('⚠️ fast pos check:', String(e.message).slice(0, 80)); }
    finally { fastChecking = false; }
}
setInterval(() => fastPositionCheck().catch(() => {}), 10000);
