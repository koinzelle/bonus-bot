# État du bonus-bot — mis à jour le 03/09/2026

Document **vivant** : à relire au début de chaque session et à mettre à jour à la fin.
Il existe pour éviter de re-dériver des conclusions qui ont coûté cher à établir, et
surtout pour ne pas retenter ce qui a déjà été invalidé.

---

## 1. Chiffres de référence

- **465 trades** depuis le 22/07. PnL réalisé **+0,42 SOL**, latent variable.
- WR ~85 %. **Un perdant efface six gagnants** — c'est la queue qui décide, jamais la médiane.
- LP moyen par trade, par semaine : 4,81 % → 5,38 % → 4,63 % → 3,12 % → 2,15 %.
  **La baisse commence la semaine du 17/08**, avant presque toutes les modifs récentes.
- Capital ~1,2 SOL. Mise fixe 0,15. Plafond 8 positions (jamais atteint avant le 31/08).
- Helius : ~38 000 crédits/jour pour un budget de ~43 400. Cycle du 18/08 au 18/09.

---

## 2. Déployé récemment

| Date | Commit | Quoi | Effet mesuré |
|---|---|---|---|
| 30/08 | `587451e` | Attente de rebond au lieu de couper à la sortie de range | **+0,33 SOL** sur 6 semaines, robuste |
| 02/09 | `d2d0c7a` | Positions hors-range sorties du lot + `lpPct`/`openValueSol`/`rsi2Entry` sur les trades | conso 41 265 → 38 042 crédits/j |
| 02/09 | `3363c1a` | Shadows `patternKO` et `feesSeuil` | mesure seule |
| 02/09 | `2af6b50` | **Déverrouillage anti-mourant par les fees** (`feeTvlMap.has(tok)`) | bot repassé de 0 à 13 trades ; bypass **−0,0315 SOL sur 4 trades** |
| 02/09 | `b6d641d` | Cadence de lecture par position | 429 : 36/h → **94/h** (contre-productif seul) |
| 02/09 | `3a8203e` | Étalement des lectures (plafond 3, espacement 3 s) | 429 : 94/h → **0/h** |
| 03/09 | `798312c` | Shadow `planchrRsi2` | mesure seule |

---

## 3. Mesuré et tranché — ne pas rouvrir sans données nouvelles

**Sorties.** La règle actuelle bat toutes les variantes testées. Le trailing sur rebond fait
trois fois moins bien (+5 pts contre +16). Le hold pur est nettement perdant (médiane ×0,43
sur les gros, ×0,32 sur les petits). L'armement du rebond à −40 % : médiane 0,0 pt, Morty
passerait de +2,7 % à −35,8 %.

**Cap ATH-épuisé.** Simuler les 85 entrées refusées donne −3,39 %/trade contre +3,88 % réel,
24 % de catastrophes, négatif à tous les niveaux de retrait. **Et ce n'est pas un bannissement** :
13 des 16 tokens bloqués sont libérés par l'expiration du compteur glissant (1 h à 130 h), pas
par la remontée du MC. Les tokens qu'il diffère rapportent ensuite **+0,2453 SOL sur 77 trades
à 94 % de WR**. Le prix d'entrée après report est un pile ou face (médiane +1,6 %).

**Ré-entrée rapprochée = le moteur du bot.** Exiger un vrai dump depuis notre sortie couperait
344 trades sur 465 et détruirait 84 % du portefeuille. La meilleure bande est **0 à 12 % de
baisse depuis la sortie précédente** (148 trades, +0,0020/trade, WR 90 %). Plus le token a
chuté depuis notre sortie, **moins** la ré-entrée vaut.

**Profondeur de plongeon.** Une position qui plonge de 30-40 % depuis l'entrée remonte dans
**93 %** des cas. La falaise est à **−50 % de prix** : 1 sur 6 seulement s'en sort, pour
−0,3173 SOL. Couper plus tôt détruit les gagnants.

**Downtrend à l'entrée.** Aucun effet (+0,0017 contre +0,0015 sur 409 trades). Shadow fermable.

**Taille des coins.** Le bot tradait déjà 40-81 % de gros coins pendant ses meilleurs jours.
Par MC à l'entrée : petit 1-5M **+0,0025/trade** (le meilleur), très gros >20M +0,0023 (WR 91 %),
gros 5-20M +0,0001 (la zone morte), micro <1M +0,0005.

**Distance à la SuperTrend** (43 trades, depuis le 30/08). Le support détermine le **potentiel**,
pas le risque : collé à la ligne, pic médian 4-5 % et 0-25 % de plongeurs ; loin, pic 2,4-2,9 %
et 29-41 %. Les 4 grosses pertes sont dispersées sur toutes les distances — filtrer là-dessus
n'évite pas les CUT.

---

## 4. En cours de mesure — ne rien conclure avant

| Shadow | Question | Comment lire | Quand |
|---|---|---|---|
| `mourantBypass` (champ du trade) | Le déverrouillage anti-mourant rapporte-t-il ? | PnL des trades `mourantBypass: true` | ~20 trades, ou 1 cycle complet avec ses CUT |
| `planchrRsi2` + `rsiFloorLp` | Faut-il autoriser la sortie RSI2 dans le rouge ? | comparer `rsiFloorLp` à `lpPct` **sur le même trade** | ~20 déclenchements |
| `patternKO` | Le pattern EP coûte-t-il les meilleures pools ? | prix + mint des refusés, à rejouer | 1 semaine |
| `feesSeuil` | La règle EP « fees ≥ 30 SOL » protège-t-elle d'un wash trading ? | idem | 1 semaine |
| `athEpuise` | idem cap ATH | déjà exploité, cf. §3 | — |

**Backtest non déployé** : plancher RSI2 à −20 % donnait +0,2740 SOL (+9 %) sur 279 trades,
catastrophes 11 % → 7 %, robuste aux 3 retraits, pic unique. **Non déployé** parce que la
fonction de transfert ne modélise pas les fees — or sortir plus tôt en encaisse moins — et
qu'elle a produit le même soir un classement que les données réelles ont inversé.
Détail utile : **−3 % est moins bon que 0**, ce qui confirme le revert du 29/08.

---

## 5. Pièges de méthode — tous rencontrés le 02/09

Sept conclusions ont dû être corrigées en une session. Toutes de la même famille :
**supposer le sens d'une donnée au lieu de le vérifier.**

- `pnlPct` est la variation du **PRIX**, pas le LP. Seuls 8 % des trades ont les deux égaux.
  Le vrai LP n'était que dans la chaîne `reason` — d'où le champ `lpPct` ajouté le 02/09.
- `openedAt`/`closedAt` sont des **chaînes ISO** sur les trades, des nombres sur les positions.
  Une comparaison numérique renvoie deux moitiés vides au lieu d'une erreur.
- `maxStackLevel` n'est pas un empilement de positions : c'est le **plongeon max** par paliers
  de 10 %. Filtrer dessus est une tautologie — c'est un résultat, pas une donnée d'entrée.
- Un champ absent est lu comme `false`, pas comme « inconnu ». `established` n'existe que
  depuis le 30/08 : ses « 0 % » antérieurs sont l'absence du champ, pas un comportement.
- Compter des **lignes de log** n'est pas compter des **observations**. 259 lignes de
  diagnostic pattern portaient sur 2 tokens.
- Un appariement qui produit des doublons gonfle les totaux. Toujours dédoublonner par trade.
- Une simulation dont la fenêtre commence après l'événement mesure autre chose. Les lignes 📊
  après un CUT viennent d'une **nouvelle position** sur le même token, à un autre prix.

**Règle qui en découle** : compter dans les logs persistés plutôt que reconstruire, et
vérifier depuis quand un champ est écrit avant de l'analyser.

---

## 6. Couverture des données

- **Logs persistés : depuis le 26/08 seulement.** `/logs/list` annonce `retentionDays: 365`
  mais la liste `days` ne contient que les jours réellement écrits. Toujours l'appeler d'abord.
  Avant le 26/08 : pas de RSI2 d'entrée, pas de trajectoire de bins, pas de sources de découverte.
- **Trades** : `entry`, `exit`, `entryMcK`, `durMin`, `reason`, `pnlSolLive`, `athAgeH`, `support`
  sur tout l'historique. `peakGainPct` et `feeTvl` depuis le 18/08. `established` depuis le
  29/08, `stTrend`/`stDistPct` depuis le 30/08. `lpPct`, `openValueSol`, `rsi2Entry`,
  `mourantBypass` depuis le 02/09. `rsiFloorLp` depuis le 03/09.
- **Mint absent du 22/07 au 11/08** (129 trades). 14 symboles ont été retrouvés par recherche
  DexScreener + vérification du prix historique à l'heure du trade.
- **Bougies** : GeckoTerminal, jamais Helius. `ohlcv/hour?aggregate=1&limit=1000` = 41 jours en
  une requête ; le 15 min ne couvre que 10,4 jours. Rate-limit agressif : 6-12 s entre appels.

---

## 7. Ce qui reste ouvert

**La baisse du LP par trade depuis mi-août** (5,38 % → 2,15 %) n'est expliquée par aucune
modification. Elle précède presque toutes. Les logs de la période n'existent pas, donc les
conditions d'entrée de l'époque sont irrécupérables — seul le forward tranchera.

**L'univers tradable.** 73 candidats par scan mais seulement 13 tokens distincts au watch
(contre 55 le 27/08). Le goulot est le filtre d'ajout, dominé par GMGN `fees < 30 SOL` —
230 rejets sur une semaine, médiane 1 SOL de fees. Le correctif des accolades du 28/08 a
rétabli ce contrôle et fait passer le ratio rejetés/ajoutés de 0,23 à 1,69. C'est un vrai
correctif de bug, mais c'est aussi la cause principale de la chute du nombre de trades.
Le shadow `feesSeuil` tranchera.
