# État du bonus-bot — mis à jour le 04/09/2026

Document **vivant** : à relire au début de chaque session et à mettre à jour à la fin.
Il existe pour éviter de re-dériver des conclusions qui ont coûté cher à établir, et
surtout pour ne pas retenter ce qui a déjà été invalidé.

---

## 1. Chiffres de référence

- **616 trades** depuis le 22/07 (529 avec `pnlSolLive`, **87 à `null`** — résidu du bug d'orphelines).
  PnL réalisé **+0,7400 SOL** sur 45 jours. Rythme 7 jours : **+0,0425 SOL/jour**.
  **Les 04 et 09/05 sont les deux meilleures journées de l'histoire du bot** (+0,1824 et +0,1023),
  soit 38 % du résultat total en deux jours — obtenues à 8 positions avec mises rabotées, à 43 %
  puis 64 % du temps à 7-8 positions. Si le rythme chute après le passage à 7/mise pleine, c'est
  la première piste à regarder.
- WR ~85 %. **Un perdant efface six gagnants** — c'est la queue qui décide, jamais la médiane.
- LP moyen par trade, par semaine : 4,81 % → 5,38 % → 4,63 % → 3,12 % → 2,15 %.
  **La baisse commence la semaine du 17/08**, avant presque toutes les modifs récentes.
- **Wallet ~1,474 SOL au 05/09** (0,913 déployé + 0,081 cash + 0,480 de rent immobilisé).
  Mise fixe 0,15. Plafond **8** (passé à 7 puis re-8 le 05/09 après dépôt ; était 5 du 26/08 au 31/08).
  **Chaque position coûte 0,21 SOL** (0,15 de mise + 0,06 de rent). Le rent est fixe quelle que soit
  la mise — une position à 0,039 immobilise 154 % de son montant — d'où la suppression du bridage.
  **Solde on-chain au 05/09 20h : 1,7959 SOL** (0,913 liquide + 0,583 déployé + 0,300 de rent),
  lu directement sur `BLwBuA1G…` : finance **8** positions pleines (besoin 1,700), 9 non.
  ⚠️ Ne PAS reconstruire le solde depuis le champ `capital` des logs : il exclut le rent et se lit
  en pleine transaction. Deux estimations fausses le 05/09 (1,474 puis 1,352 au lieu de 1,796).

**Coût Helius du plafond.** Les lectures sont proportionnelles au nombre de positions
(~11 200 lectures/jour à 6,6 positions, ~4,1 crédits par lecture). À **8 positions le quota est
dépassé ~2,4 jours avant le reset** ; à 7 il tient tout juste. 429 mesurés le 05/09 : 6,7/h aux
heures à 8 positions contre 1,9/h à 7 — ×3,5, mais 53/jour au total reste négligeable
(2 342 le 01/09) et aucun « max usage reached ».
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
| 04/09 | `fc9cc2c` | **Plus aucune position papier en mode live** | supprime les fantômes qui occupaient un slot |
| 04/09 | `80ae30a` | Timeout de dépôt sondé + **filet des positions orphelines** | corrige la cause + alerte toutes les 30 min |
| 05/09 | — | **Plafond 8 → 7 et MISE PLEINE OU RIEN** (demande user) | plus aucune ouverture bridée |
| 06/09 | — | **Trace `🔺` du pic dans la boucle rapide** | mesure seule, coût RPC nul |
| 06/09 | — | **`PRICE_LP_DIVERGENCE` 8 → 5 pts** | 71 → 151 épisodes ⚡, +2 886 crédits/j |
| 08/09 | `e3f79b6` | Shadow rendement de pool (fee/TVL réel + bin step) | mesure seule, HTTP gratuit |
| 08/09 | — | **Mesure du temps HORS RANGE BAS** (`🔻`/`🔺`, champs `outBottom*`) | mesure seule, coût nul |
| 08/09 | — | **Repli bougies GeckoTerminal** + purge gelée si source morte + alerte 200-vide | corrige une panne de 11 h |

### Le bug des positions orphelines — 04/09, six semaines de latence

`Transaction was not confirmed in 30.00 seconds. It is UNKNOWN` **n'est pas un échec**, c'est une
absence de réponse : la TX atterrit souvent après. Depuis le 22/07 le bot concluait à l'échec et
repartait, laissant une position réelle avec de l'argent dedans dont la clé n'était jamais
enregistrée — ni trail, ni RSI2, ni CUT. Et depuis le 19/07, la position papier créée juste avant
survivait à l'échec, occupait un slot et était pilotée **au prix**.

Cas concret : CTO ouverte le 04/09 à 08h45, timeout à 08h46, position toujours vivante à 0,083 SOL
et −24 % huit heures plus tard, pendant que le bot alertait sur un fantôme du même nom à −56 % de prix.

**Le signal était quotidien : 67 trades sur 591 à `pnlSolLive: null`, jusqu'à 6 sur 21 le 27/08.**
Il a été masqué six semaines parce que chaque script d'analyse commençait par
`filter(t => t.pnlSolLive != null)` pour « nettoyer » les données. La preuve du bug écartée comme
du bruit — cf. [[feedback-verifier-avant-affirmer]].

**Piège de nommage confirmé le même jour :** le « MARKET » du bot est le « GPRO » de Meteora, même
mint `GPRR2u6N…`. DexScreener, Meteora et GeckoTerminal ne nomment pas les mêmes tokens pareil.
**Toute réconciliation se fait par mint ou par clé de position, jamais par symbole.**

---

## 3. Mesuré et tranché — ne pas rouvrir sans données nouvelles

**Sorties.** La règle actuelle bat toutes les variantes testées. Le trailing sur rebond fait
trois fois moins bien (+5 pts contre +16). Le hold pur est nettement perdant (médiane ×0,43
sur les gros, ×0,32 sur les petits). L'armement du rebond à −40 % : médiane 0,0 pt, Morty
passerait de +2,7 % à −35,8 %.

**Stop de temps — MESURÉ ET REJETÉ (05/09).** Couper une position à X heures détruit de la valeur à
tous les seuils : X=4h **−0,269 SOL**, 6h **−0,329**, 8h **−0,325**, 12h **−0,184**, 24h **−0,059**.
La cohorte (65 trades >4h, 862 h-position) a perdu −0,16 SOL en réel ; un stop à 6 h l'aurait portée
à −0,49 SOL. **Robuste** : négatif dans les 4 sous-périodes, et empire au retrait des 3 meilleurs
(−0,329 → −0,412). Le stop CONDITIONNEL (LP < 0 / −10 / −20 / −30 à X heures) est négatif partout aussi.
Raison : à 6 h les perdantes sont déjà à −36 % de LP pour finir à −47 % (le stop cristallise la perte,
il ne l'évite pas), et les gagnantes sont à −4,5 % pour finir à +1,5 % (le stop les tue au creux).
Cas le plus cher : `cc`, **−45,3 % de LP à 6 h, +31,6 % à la clôture réelle**.

**La durée ne prédit rien.** Gagnantes 9,4 h de médiane, perdantes 10,2 h. Les −0,16 SOL de la cohorte
longue viennent de **9 accidents**, pas du fait de tenir. Ne pas rouvrir « couper plus tôt » sans un
mécanisme qui vise les accidents, pas l'horloge.

**Âge de l'ATH à l'entrée — mesuré, ne pas gater (05/09).** `athAgeH < 3h` concentre 5 des 7
catastrophes de l'historique, mais bloquer cette bande coûte plus qu'elle ne rapporte : on abandonne
+0,42 SOL de trades sains pour épargner −0,21 SOL de désastres. Portefeuille conservé : 89,9 % à <2h,
85,1 % à <3h, 72,5 % à <5h. Le SOL/trade est PLAT entre les tranches (0,0023 à 0,0035) — pas de gradient.
Signature à connaître : la tranche <3h a le MEILLEUR LP médian (5,00 %) et le PIRE LP moyen (3,37 %),
inversion typique d'une queue gauche épaisse.

**Glissement du trail — INTRINSÈQUE, pas un défaut (05/09).** Le trail est réglé à 1,0 point sous
le pic ; sur 202 sorties TRAIL on rend **1,50 pt de médiane et 2,09 de moyenne** (max 20,0 — Zoe,
pic +40,3 % sorti à +20,3 %). Cumulé : 220,7 points de LP au-delà du réglage, **~0,114 SOL**.
**Ce n'est PAS la cadence de lecture** : avant/après le déploiement du 02/09, la médiane est
identique (1,50 pt dans les deux cas), et le chemin « rapide » ne fait pas mieux (1,50 vs 1,60).
Le glissement suit la **vitesse du token** : pic 6-8 % → 1,83 pt de moyenne ; pic >20 % → 5,55 pt.
Lire plus souvent ne récupérerait presque rien et coûterait des crédits Helius déjà en dépassement.
Seule piste éventuelle : un trail à deux étages, plus serré sur les gros gains — mais n=8 au-dessus
de +20 %, insuffisant pour trancher, et le trail actuel est validé à ×3 contre un TP fixe.

**Resserrer le trail — TESTÉ ET REJETÉ (05/09).** Rejoué sur les **relevés LP réels du bot**
(lignes `📊` des logs persistés : 71 530 relevés, cadence médiane 50 s), 64 sorties TRAIL.
Contrôle du rejeu : écart médian **1,00 pt**. Résultat, largeur → delta SOL contre l'actuel :
0,30 pt **−0,0011** · 0,50 **−0,0071** · 0,75 **−0,0107** · 0,90 **−0,0090** · 1,00 = référence.
**Toutes les largeurs plus serrées perdent**, et le LP médian TOMBE de 7,30 % à 7,10 % : un trail
serré ne sort pas plus haut, il sort **plus tôt sur un faux creux, avant le vrai sommet**.
Robuste : le −0,0071 de la largeur 0,5 empire à −0,0108 en retirant les 3 meilleurs cas.
Variantes à paliers (plus serré au-dessus de +10/12/15 %) : **+0,0030 SOL au mieux**, sous l'erreur
de reconstruction, donc indistinguable de zéro.
**Limite : seuls les trails PLUS SERRÉS sont testables** — au-delà de 1,0 pt la position serait
restée ouverte après la fermeture réelle et il n'existe aucun relevé après. Tester 1,5 ou 2 pt
exige un shadow, pas un backtest.

**Méthode à réutiliser :** pour toute question sur les SORTIES, rejouer sur les lignes `📊` des logs
(LP réel, cadence réelle, aucun modèle) plutôt que sur des bougies + fonction de transfert. Le même
test fait sur bougies 5 min donnait un contrôle à **4,03 pt** d'écart — inexploitable.

**Sommets manqués — MESURE EN COURS, rien de conclu (06/09).** Comparaison prix-contre-prix
(aucune conversion) entre le prix max **vu** par le bot dans ses lignes 📊 et le max des bougies,
sur 138 trades : le bot voit le sommet à moins d'1 pt dans **36 %** des cas seulement, écart médian
**2,5 pt**. **26 trades sur 138 (19 %)** cumulent trail non armé (peak LP < 6 %) et sommet manqué
de ≥ 3 pts. **MAIS ce n'est pas une preuve de perte** : le haut d'une bougie est souvent une mèche
que la position LP ne traverse jamais vraiment (Zoe : +125 % de mèche pour un peak LP de 0,5 %).
D'où la trace `🔺` déployée le 06/09, qui répond sans bougie ni fonction de transfert.

**Deux erreurs de méthode commises ce jour-là, à ne pas refaire :**
1. Les lignes `📊` sont émises **une fois par SCAN** (~70 s), pas à chaque lecture. Les compter comme
   des lectures fait croire à tort que les paliers de cadence 8/10 s ne fonctionnent pas. La vérif du
   trail tourne en réalité dans `fastPositionCheck`, **toutes les 10 s**, séparée du scan.
2. Convertir un plus-haut de bougie en LP avec la fonction de transfert pour affirmer qu'un sommet a
   été raté — alors que cette fonction est documentée comme non fiable au §« transfert ».

**Seuil d'armement du trail — TESTÉ ET REJETÉ (06/09).** Balayé sur 188 trades rejoués sur les
relevés réels (contrôle : écart médian **0,00 pt**, rejeu exact). Abaisser l'armement donne
3 % **+0,1749** · 4 % **+0,0886** · 4,5 % +0,0461 · 5 % −0,0236 · 5,5 % −0,0022 · 6 % = référence.
**Non monotone**, et surtout **non robuste** : à 4 %, le total tombe à −0,0665 en retirant les
2 meilleurs cas ; le gain vient de **deux trades seulement** (rehanfal −55,1 % réel, fone −47,3 %),
c'est-à-dire de catastrophes coupées tôt, pas d'un gradient. **17 trades dégradés contre 6 améliorés.**
Instable dans le temps (+0,1458 sur un quartile, négatif sur les trois autres). Ne pas rouvrir.

**Le tripwire prix↔LP est la vraie réponse aux sommets manqués.** Le prix vient des bougies (gratuit) ;
quand il prend de l'avance sur le dernier LP lu, `_priceHotUntil` force une lecture fraîche + 3 min de
cadence 8 s. Mesuré sur 73 145 paires de relevés : un gros écart annonce surtout une **BAISSE** du LP
(−0,97 pt à 5-6 pts, −3,76 à 8-12), donc il sert autant à voir une chute qu'un sommet. Probabilité
qu'il précède un nouveau pic : 13 % (4-5 pts) · 15 % (5-6) · 17 % (6-7) · 25 % (7-8) · 19 % (≥8),
hausse moyenne ~1,2 pt dans toutes les bandes.

**Choix de la pool — NON TRANCHÉ, ne pas rouvrir sans A/B (08/09).** Trois découpages de la même
donnée donnent trois réponses opposées : par niveau de frais brut le 2 % gagne (0,00394 vs 0,00099
SOL/trade à 1 %) ; en comparant « pool désignée par le fee/TVL » contre « repli sur le fee le plus
bas », c'est le repli qui gagne (0,00598 vs 0,00281, n=25 vs 90) ; apparié token par token, le 2 %
regagne (3 tokens sur 4). Seuls **4 tokens** ont connu deux niveaux de frais et **6 trades** ont eu
lieu sur du 5 %. C'est de la sélection de tokens qu'on mesure, pas l'effet du fee. **Trancher exige
un A/B réel** : prendre délibérément la pool la plus chère une entrée sur deux.

**Le bot ne paie JAMAIS le fee de la pool — le commentaire du 04/08 était faux.** Les swaps passent
par **Jupiter** (`lite-api.jup.ag`), qui route par le chemin le moins cher de Solana et n'emprunte
pas la pool Meteora de dépôt ; à la sortie on retire la liquidité sans swap et on ne reswappe que le
résidu. Le fee de la pool est donc **du revenu pur**. Coût d'entrée réel : **−0,37 % de médiane**
sur 114 ouvertures (moyenne −0,77 %, queue à −4,7 %), et non 5-10 %. Commentaire corrigé dans
`bonus-live.js` le 08/09. `slippageBps: 1000` (10 %) explique la queue — le resserrer à 300-500
serait sans effet 99 % du temps.

**Les pools chères DÉCROCHENT du marché (mesuré, mécanique).** Sur 12 100 relevés en pool à 5 % :
**1,6 %** montrent le prix avec plus de 10 pts d'avance sur le LP, contre **0,6 %** à 1 % (×2,7).
Cause : réserves médianes **165 SOL** à 5 % contre **952** à 1 %. Dans un DLMM le bin actif ne bouge
que si l'on trade DANS cette pool ; les agrégateurs routant vers la moins chère, une pool chère et
peu profonde reste figée pendant que le token monte ailleurs — la position ne se convertit pas et
n'encaisse rien. Explique le paradoxe du 5 % : **meilleur LP médian (10,87 %) mais SOL/trade négatif
(−0,00297, n=6)**. Un plancher de réserves indexé sur le fee serait le bon garde-fou, mais n=6 ne
permet pas de le calibrer. **À surveiller : compter les lignes `⚡` sur AGI**, actuellement sur une
pool à 5 % / 331 SOL, pour chiffrer ce que coûte le décrochage.

**Couverture du fee/TVL : plafonnée par l'API, pas par le code.** Le mécanisme du 30/08 ne s'applique
qu'à **115 choix sur 225**. Augmenter `page_size` ne sert à rien : `dlmm.datapi.meteora.ag/pools`
renvoie ~101 pools quel que soit le paramètre (testé à 100/300/500), soit **60 tokens distincts**.
Seuls ces 60 dépassent réellement 3 % de fee/TVL avec ≥5 k$ de TVL. Le trou n'est pas comblable.

**LA LARGEUR DE RANGE — ne JAMAIS resserrer, désormais chiffré (08/09).** `BIN_RANGE = 34` est fixe,
mais `OK_BIN_STEPS = [80,100,125,160,200,250]` fait varier la largeur RÉELLE du simple au double :
bs80 → **-24 %** en bas, bs100 → **-29 %**, bs125 → -34 %, bs200 → **-49 %**, bs250 → -57 %.
Répartition sur 441 sélections : 65 % bs100, 20 % bs200, 10 % bs80. **La protection varie donc au
hasard de la pool, sans que rien ne le signale.**

Résultat par largeur (197 trades) : bs80 **0,00062 SOL/trade** et 7 % de catastrophes · bs100
0,00833 et 2 % · bs200 **0,01327** et 0 %. ⚠️ Cette comparaison est **confondue par le token**
(les bs200 sont sur PURR/ZCAT/CTO/AGI, les meilleurs du moment) — ne pas en conclure que large = mieux.

**Le contrefactuel propre**, lui, conclut : sur les 48 trades en bs200, **87 % auraient tenu** dans une
range -29 %, pour ~2× plus de frais (une range -29 % est 2,05× plus étroite). Ça semblait plaider pour
resserrer. **C'est faux, et voici pourquoi.**

**LE TEMPS HORS RANGE BAS EST LA MÉTRIQUE QUI PRÉCÈDE LES CATASTROPHES.** Sur 192 trades :

| | n | LP médian | SOL/trade | durée médiane |
|---|---|---|---|---|
| sorti de range par le BAS | 19 | **1,06 %** | **−0,00898** | **6,3 h** |
| resté DANS la range | 173 | **4,61 %** | **+0,01072** | **1,2 h** |

Écart : **−0,0197 SOL par trade**, et 5× plus long — hors range la position est 100 % en token,
n'encaisse plus AUCUN frais, et sa seule issue est le rebond ou le CUT. **Les CINQ pires trades de
l'historique sont TOUS des sorties par le bas** : OTC −0,0719 · HeeHaw −0,0647 · AGI −0,0605 ·
fone −0,0589 · STONK −0,0443, soit **−0,3003 SOL**.

Resserrer ferait passer le taux de sortie par le bas de 2 % à ~13 %. Le gain de concentration repose
sur une hypothèse de « 2× les frais » **non vérifiable** ; le coût, lui, est mesuré sur 19 cas réels.
**La règle « range intouchable » du user est validée**, pour une raison précise : la range large
n'augmente pas le rendement moyen, elle évite l'endroit où toutes les catastrophes se produisent.

Mesure déployée le 08/09 : lignes `🔻`/`🔺` à chaque franchissement, et champs `outBottomMin`,
`outBottomPct`, `outBottomEpisodes` sur chaque trade. **À exploiter : le temps hors-range bas
prédit-il le CUT, et à partir de quel seuil ?**

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
| `🔺 peak` (lignes de log) | Le bot rate-t-il des sommets entre deux scans ? | comparer le `peak` max des lignes **🔺** (boucle rapide, 10 s) au `peak` des lignes **📊** (scan, ~70 s) sur le même trade | 1 semaine |

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

## 5quater. PANNE DU 08/09 — Birdeye renvoie du VIDE sans erreur

**Symptôme** : de 00:00 à 11:30 UTC, `bougies OK 0/vide N ⚠️ SOURCE BOUGIES DOWN` à chaque scan,
**aucune entrée possible** (sans bougies : pas de RSI, pas de SuperTrend, pas de pattern). Le
21:52 la veille tout allait bien (`bougies OK 17/vide 2`, watch 35). Aucun redémarrage entre les deux.

**Cause technique** : `birdeyeOhlcv` fait `return (r.data?.data?.items || [])`. Un **HTTP 200 au corps
vide ne lève PAS d'exception** → aucun log, aucun backoff, aucune alerte. Le bot a tourné onze heures
en croyant simplement que les tokens n'avaient pas de bougies.

**Cause racine : NON DÉTERMINÉE.** Le quota n'était PAS épuisé (21,35K unités sur 30K, 29 % restants).
Candidats : endpoint v1 `/defi/ohlcv` devenu payant (une **v3** `/defi/v3/ohlcv` existe et l'accès
par endpoint dépend du package depuis fin 2025), ou limite de débit par seconde. Le « Credit Balance
$0.00 » du tableau de bord est un solde prépayé distinct du quota — ne pas le confondre (erreur faite
le 08/09).

**Dégât collatéral, le plus coûteux** : le bot purgeait un token du watch après 8 échecs de bougies,
en supposant le token mort. Comme c'était l'API, **la watchlist est tombée de 35 à 11 en onze heures**.

**Corrigé le 08/09 :**
1. `sourceGloballyDown` — si aucun token n'a de bougies sur un tick alors que ≥3 ont été tentés, le
   compteur d'échecs est **gelé** : plus aucune purge pendant une panne de source.
2. Alerte console + Telegram au **10e** « 200 vide » d'affilée (`birdeyeEmpty`).
3. **Repli GeckoTerminal** (`gtOhlcv`) — sans clé, gratuit, actif seulement si Birdeye ET GMGN rendent
   <15 bougies. Lent (7 s entre appels, pool résolue puis cachée 6 h) : c'est un filet, pas une source.

**Leçon générale** : les deux sources de bougies exigeaient une clé. Toute source unique keyée doit
avoir un repli sans clé, sinon une panne de facturation arrête le bot sans le dire.

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
