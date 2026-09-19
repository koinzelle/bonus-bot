# État du bonus-bot — mis à jour le 04/09/2026

Document **vivant** : à relire au début de chaque session et à mettre à jour à la fin.
Il existe pour éviter de re-dériver des conclusions qui ont coûté cher à établir, et
surtout pour ne pas retenter ce qui a déjà été invalidé.

---

## ⛔ SORTIE STAGNATION — RETIRÉE LE 18/09, NE PAS LA REMETTRE

**Déployée le 16/09, retirée le 18/09 après 12 fermetures. Coût réel : -0,6079 SOL en deux jours**
pendant que le reste du bot faisait +1,2476. Sur la seule journée du 18/09 : TRAIL +0,2608,
RSI2 +0,0321, **STAGNATION -0,3519** — elle a transformé une journée verte en journée négative.

**La cause est structurelle.** Elle se déclenchait entre -13 % et -15 % de LP après 6 h de calme,
soit la description exacte d'un **creux dans un token qui chope** — précisément ce que l'entrée
cherche (dumpé 35 %, chop ≥ 40 %, RSI2 < 50). Elle vendait le creux du cycle dans une stratégie
qui s'appelle chop-cycle. Vérifié sur bougies fraîches : **7 des 11 coupes mesurables ont fortement
rebondi, 5 seraient repassées positives** — KNOTS +63 % de plus-haut, ALLINU +82 %, PERPSPAD +87 %.

**4e backtest prix→LP démenti par le réel, toujours dans le même sens** (cf. section 21) :
backtest +0,93 SOL, réel -0,6079 en deux jours. Corriger l'ancrage sur le pic n'avait pas suffi.

**Ce qui reste :** uniquement la COLLECTE — `feesSol`, `feeVel1h`, `tvlVarPct`, séries `_feeHist`
et `_tvlHist`. Elle ne décide de rien.

---

### L'ancienne consigne, sans objet depuis le retrait

**Pourquoi c'est urgent et pas reportable :** GeckoTerminal ne renvoie que **200 bougies de 15 min,
soit 50 h**. Le trajet du prix APRÈS une coupe n'est donc reconstituable que pendant deux jours.
Passé ce délai, la mesure est **définitivement perdue** — et c'est la seule façon de savoir si la
règle STAGNATION coupe trop tôt.

**Quoi faire :** pour chaque fermeture dont `reason` contient `STAGNATION` et qui a moins de 48 h,
mesurer le prix à +1 h / +3 h / +6 h / +12 h / +24 h après la coupe, plus les extrêmes. Script de
référence : `/tmp/apresstag.js` (à réécrire s'il a disparu). Lecture : **négatif = la coupe était
justifiée, positif = on a coupé trop tôt.**

Relever en même temps les champs persistés depuis le 17-18/09 — `feesSol`, `feeVel`, `feeVel1h`,
`feeHours`, `tvlEntry`, `tvlExit`, `tvlVarPct`, `volTvl*`, `tvlMin/Max`, `tvlPoints` — et tester les
**deux hypothèses ouvertes** : faut-il épargner les positions à forte vélocité de frais, et un
vol/TVL élevé annonce-t-il l'effondrement ?

**Accumuler les relevés en section 20**, ne pas les laisser dans le fil de conversation.

**Discipline :** AUC de chaque variable AVANT de chercher une règle. Dix champs neufs et peu de
trades : on trouvera toujours quelque chose, et ce sera du bruit.

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

**HORS-RANGE BAS ≠ POSITION MORTE — 67 % REVIENNENT (09/09).** ⚠️ Correction d'une erreur commise
le 09/09 : j'avais proposé d'armer l'attente du rebond dès la sortie de range, au motif qu'une
position hors range n'encaisse plus de frais. **C'est faux et ça aurait coupé 14 gagnantes.**

Mesuré sur 21 positions sorties de range par le bas : **14 ont fini POSITIVES (67 %)**, dont
SOLCAT plongée à −55 % pour finir à **+12,1 %**, CTO à −52 % → +6,3 %, SOLCAT à −51 % → +5,3 %,
fone à −54 % → +1,1 %, ZCAT à −55 % → +0,6 %. Des positions descendues 25 points sous leur borne
basse sont revenues en territoire positif.

C'est exactement ce que le seuil de **−55 %** protège, et il avait déjà été validé le 23/08
(+3,27 %/trade contre −45 % et −35 % qui font moins bien — « les mèches rebondissent »).
**NE PAS armer plus tôt. NE PAS fermer manuellement une position hors range à −45/−52 %.**

**L'asymétrie réelle, elle, subsiste** : les 14 gagnantes rapportent **+0,1296 SOL**, les 7 perdantes
coûtent **−0,4887 SOL** — presque 4×. Le problème n'est donc pas de sortir plus tôt (les deux tiers
reviennent) mais que les 7 qui ne reviennent pas coûtent très cher. Et le backtest du stop de temps
(07/09) a montré qu'on ne sait pas les distinguer à l'avance : toute coupe anticipée détruit plus
qu'elle ne sauve. **La question ouverte est donc : existe-t-il un signal, connu AVANT ou PENDANT,
qui sépare les 14 des 7 ?** Les champs `outBottomMin` / `outBottomPct` / `outBottomEpisodes`
déployés le 08/09 sont là pour y répondre.

**RSI2 EN 15 MIN SUR LES VOLATILS — TESTÉ ET REJETÉ (10/09).** Question : sur un token volatil
(sortie en bougies 5 min), vaudrait-il mieux attendre le RSI2>90 en **15 min** ? Rejoué sur 35 des
68 sorties RSI2 de volatils (bougies GeckoTerminal 15 min, RSI calculé comme le bot sur les bougies
CLOSES uniquement), comparaison **prix contre prix** — sans fonction de transfert.

Résultat : écart médian **+0,00 %**, écart moyen **−6,32 %**, seulement **13/35 (37 %)** meilleures,
délai médian **88 min** après la sortie réelle. **Robuste** : sans les 3 meilleurs cas la moyenne
tombe à −8,30 %.

Répartition : 31 % pire de +10 % · 31 % équivalent · 23 % mieux de 2-10 % · 9 % mieux de +10 %.

**Le mécanisme est une asymétrie de queue.** Meilleurs cas : AGI +15,2 % (143 min plus tard),
HeeHaw +14,7 %. Pires cas : HeeHaw **−45,6 % (594 min plus tard)**, MANLET −41,7 % (878 min).
Un RSI2 en 15 min est lent : si le token continue de descendre, le signal n'arrive qu'après une
vraie remontée — des heures plus tard, à un prix bien pire. Le gain est plafonné (~+15 %), la perte
ne l'est pas. Le 5 min sort au premier rebond réel, avant que l'attente ne devienne un pari.

**Ne pas unifier les timeframes de sortie.** La règle actuelle (15 min si `established` = holders
≥ 5 000 OU MC ≥ 5 M$, sinon 5 min) est validée dans les deux sens.

**FILTRE « fees ≥ 30 SOL » — VALIDÉ, NE PAS ASSOUPLIR (10/09).** C'était le dernier levier ouvert et
il est fermé. Rejoué sur les **116 occasions distinctes** du shadow `feesSeuil` (200 records → 116
mints, dédoublonnés), en appliquant les règles de sortie réelles du bot sur bougies GT 15 min :

- **79 sur 116 (68 %) n'ont AUCUNE pool indexée par GeckoTerminal** — ce sont des marchés morts, pas
  une lacune de données GMGN. Le doute inscrit dans le code est levé.
- Sur les 36 simulables : LP médian **+1,86 %**, 28/36 gagnants (78 %) — et pourtant **−0,6758 SOL**
  au total, soit **−0,01877 SOL/trade** contre **+0,00497** pour le bot réel.
- Décomposition : RSI2 19 trades +0,3304 · TRAIL 10 trades +0,2976 · **CUT 6 trades, LP médian
  −81,15 %, −1,3020 SOL**. Six catastrophes détruisent vingt-neuf gagnants.
- **Robuste** : sans les 3 meilleurs trades le total passe de −0,68 à −1,02.

**Conséquence : la piste « augmenter le volume en assouplissant les fees » est MORTE.** Le volume
bloqué est du mauvais volume. Le bot rejette ~230 tokens/semaine et il a raison.

**Et donc, au 10/09, TOUS les leviers testés sont fermés** — sortir plus tôt, sortir plus tard,
filtrer à l'entrée (âge ATH, distance ST), le regroupement temporel, le volume. Les 13 pertes
(−1,0449 SOL, dont 11 REBOND) sont le **prix de la stratégie** : le bot entre délibérément dans des
dumps, et 2 % ne rebondissent pas. Rien dans les données d'entrée ne les distingue.

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

## 3ter. LE PnL AFFICHÉ N'EST PAS LE PnL DE CAISSE (10/09) — À LIRE AVANT TOUTE ANALYSE DE PnL

Point de départ : « on fait que win mais j'ai pas l'impression de gagner du sol ».

**Ce que `pnlSolLive` mesure vraiment.** `pnlSolLive = closeValueSol − openValueSol`, or `openValueSol`
est lu **après** le dépôt (`bonus-live.js:407`) et `closeValueSol` **avant** le retrait
(`bonus-live.js:610`). La mesure couvre donc uniquement l'intérieur de la pool : les swaps Jupiter et
les transferts d'entrée/sortie sont hors champ. `depositedSol` et `proceedsSol`
(`bonus-live.js:404,655`) sont, eux, le mouvement réel du wallet — mais n'étaient pas journalisés.

**Mesuré (pas modélisé).**
- Ouverture : déposé **0,3323 SOL** → valeur LP **~0,2700 SOL**. En retirant ~0,052 de rent (rendue à
  la fermeture), le coût d'entrée réel est **~0,010 SOL par trade**.
- **15 des 28 mints** des 140 derniers trades portent des frais de transfert Token-2022, **11 à 3,00 %**
  (ZCAT, PURR, UBER, BTC, LEVERCAT, KNOTS, S3, RAYCAT, TREE, MUCHWOW, NEARKAT), 4 à 1 %.

**La répartition qui compte :**

| | trades | PnL annoncé |
|---|---:|---:|
| tokens à 3 % de frais | 73 | +1,3277 SOL |
| tokens à 1 % de frais | 15 | +0,1376 SOL |
| **tokens SANS frais** | **52** | **+0,0150 SOL** |
| total | 140 | +1,4803 SOL |

**99 % du PnL affiché vient de tokens taxés.** Sur les 52 trades où la mesure ne peut pas être faussée
par une taxe invisible, le résultat est **nul**. C'est le fait le plus solide du lot.

**CONCLUSION CHIFFRÉE (rent vérifiée on-chain le 10/09 : 0,052235 SOL, identique sur les 6 positions,
comptes de 10 828 octets — ce n'est pas une estimation).**

```
coût d'entrée réel   -0,0101 SOL   (-3,67 % de la mise de 0,2742)
gain LP moyen        +0,0105 SOL   (+3,82 %)
net AVANT sortie     +0,0004 SOL/trade  ->  +0,057 SOL sur 140 trades
```

Distribution du gain LP réel sur 140 trades : 8 sous -10 %, 1 entre -3 et 0, **35 entre 0 et +3 %**,
44 entre +3 et +6 %, 34 entre +6 et +12 %, 18 au-dessus de +12 %. Moyenne +3,82 %, médiane +5,14 %.

**C'est la réponse à « on fait que win mais je gagne pas de SOL ».** Le bot gagne réellement ses
trades — 131 sur 140 sont positifs en LP. Mais le coût d'entrée est prélevé sur **les 140**, y compris
les 35 trades à 0-3 % qui sont perdants nets une fois payé. Le gain brut et le coût d'entrée
s'annulent à 0,0004 SOL près.

**Ne pas se laisser tromper par les +12 % :** ils existent, mais ne représentent que 18 trades sur
140 (13 %).

**Ce qui N'EST PAS établi.** Le coût de SORTIE (pas encore mesuré — c'est l'objet de la ligne `💸`) et
le nombre de transferts taxés par aller-retour. J'avais modélisé 4
(swap-in, dépôt, retrait, swap-out) → −1,28 SOL ; le user objecte qu'il n'y en a que 2, et le
`🔁 Token résiduel re-swappé` n'a tiré que **2 fois** sur toute la période, ce qui plaide pour une
sortie majoritairement en SOL — donc **moins de 4**. Ne pas citer le −1,28 comme un résultat.

**Erreur de méthode commise ce jour-là :** j'ai annoncé un écart de −1,6 SOL à partir d'un solde
historique (0,7215) que le recomptage des flux a contredit (+0,0152), parce que mon premier scan
faisait `if(!tx) continue` — il avalait en silence les transactions non lues. **Ne jamais sommer des
deltas on-chain sans compter les échecs de lecture.**

**Instrument déployé :** ligne `💸` à chaque fermeture — PnL pool, PnL caisse, et l'écart ; plus les
champs `pnlCaisse` / `ecartCaisse` sur le trade. **Critère de lecture :** après ~30 fermetures,
l'écart moyen par trade, séparé entre tokens taxés et non taxés. C'est ce chiffre qui tranchera, pas
un modèle.

**Vérifié et écarté :** aucun achat de NFT n'est sorti du wallet du bot (les 5 sorties de −0,1922 SOL
portent le programme Meteora DLMM `LBUZKhRxPF3X` = ouvertures de position).

## 3quater. FILTRE FRAIS DE TRANSFERT — DÉPLOYÉ le 10/09

**Mesure finale, sur la chaîne, sans déduction** (30 fermetures appariées à leurs TX, tokens à 3 %) :

```
SOL sorti du wallet par trade   0,2800
SOL rentré au wallet            0,2811
résultat réel                  +0,0011 SOL  (+0,41 %)
IC 95 %                        [-0,0029 ; +0,0052]  <- CONTIENT ZÉRO
```

| | par trade |
|---|---:|
| ce que le bot annonce | +6,7 % |
| ce que le wallet encaisse | +0,41 % |
| **écart** | **−6,3 points** |

Les 6,3 points sont la taxe : **4 transferts × 3 %**, chacun sur ~la moitié de la mise. Taux observé
3,00 % sur **30 fermetures / 30**, dans les deux sens (dépôt comme retrait). Le reswap de sortie tire
**329 fois** dans les logs — c'est routinier, pas exceptionnel (j'avais dit « 2 fois » sur une fenêtre
trop courte : faux).

**Deux des quatre transferts ne sont PAS des trades** : déposer ses propres tokens dans sa propre
position, puis les en ressortir. Un trader ordinaire paie 2 fois, le LP paie 4 fois.

**Déployé** : `MAX_TRANSFER_FEE_BPS` (défaut 300 = 3 %) dans `bonus-live.js` (`transferFeeBps`, cache
24 h) et gate d'entrée dans `bonus-bot.js`. Lecture RPC impossible = `null` = **on laisse passer**
(une panne ne doit pas geler les entrées). Compteur `blockCount['frais-transfert']`.

**AVERTISSEMENT AVANT DE ROUVRIR :** ces tokens portaient **tout l'alpha brut** — +6,71 %/trade contre
**+0,10 %** sur les 52 trades en tokens propres. Le filtre supprime la taxe **et** le gain. Il n'a
jamais été démontré qu'il rend le bot gagnant ; il arrête de le faire tourner à vide. Critère de
lecture : si après ~40 trades le capital ne monte toujours pas, le problème n'était pas la taxe.

**Backtest one-sided (entrée 100 % SOL) : NON CONCLUANT.** Le contrôle échoue (erreur médiane
**8,91 pt** entre simulation double-sided et LP réellement relevé). Rien n'en est utilisable. Fait
acquis en revanche : le prix descend **toujours** sous l'entrée (0 exception sur 74 épisodes, médiane
−14,5 %), donc une échelle SOL sous le prix serait toujours remplie. Refaire avec les fees par bin.

**Piège de méthode du jour :** j'ai annoncé deux fois un chiffre dérivé d'un postulat déjà invalidé
(le « wallet n'a pas bougé »), et une fois un total de flux faux parce que le scan faisait
`if(!tx) continue` — 6 transactions non lues suffisent à inverser le signe. Toujours compter les
échecs de lecture et refuser de conclure quand ils sont > 0.

## 3quinquies. ENTRÉE ONE-SIDED SUR LES MINTS TAXÉS (11/09)

**Mesure de référence — la seule méthode fiable trouvée.** État du wallet à deux dates, positions
valorisées à leur **coût** (`openValueSol`), **même nombre de positions** aux deux dates :
`total = SOL liquide + Σ openValueSol + 0,052235 × nb_positions`.
Blocage des ≥3 % déployé le 10/09 21:50. Avant **2,5384** → 11/09 14:35 **2,5638** = **+0,0254 SOL en 17 h**
(les logs du bot donnent +0,0300, concordant), contre **−0,420 SOL** les 3 jours précédents. **Le blocage
marchait.** On le remplace par mieux, pas par l'ancien comportement.

**Le blocage devient un aiguillage.** `ONESIDED_FEE_BPS` (défaut **100**) : tout mint à ≥1 % de frais
entre désormais **100 % en SOL**, 34 bins sous le prix, sans swap ni dépôt de token. `MAX_TRANSFER_FEE_BPS`
(défaut 1000) ne refuse plus que les taxes extrêmes. Lecture RPC impossible → double-sided (une panne ne
change pas la géométrie en silence).

**Pourquoi 34 bins et pas 68.** À capital égal, 34 bins concentrent **deux fois** plus de liquidité par
bin, et les fees se perçoivent par bin traversé. Plongeons mesurés sur 109 épisodes : médiane **−6,7 %**,
p25 −17 %, p10 −27 %, pire −54,7 %. Donc −28,7 % (34 bins à bs100) garde **92 %** des épisodes en range ;
68 bins n'en gagnent que 7 de plus en divisant la densité par deux. **61 %** du mouvement de prix tient
dans ces 34 bins.

| | brut | taxe | net |
|---|---:|---:|---:|
| double-sided actuel (3 %) | 6,57 % | −6,00 % | +0,57 % |
| one-sided 68 bins | 4,21 % | −0,42 % | +3,79 % |
| **one-sided 34 bins** | **8,01 %** | **−0,42 %** | **+7,59 %** |

**Le +7,59 % est un MAJORANT**, pas une prévision : il suppose que les fees doublent quand la densité
double (vrai seulement tant qu'on est petit devant la pool) et que les 100 % du brut se comportent comme
des fees — or seulement **67 %** du PnL en vient. Fourchette réaliste **+3 % à +7 %**. Tout l'intervalle
bat le +0,57 % actuel.

**CUT.** Les protections du bas sont **inchangées** : `RANGE_DOWN` (−55 % prix ou LP) et `CUT_HARD` (−75 %)
sont fondés sur le prix, pas sur les bins. Seul ajout : en one-sided, `upperBinId` **est** le bin d'entrée,
donc franchir le haut n'est pas une cassure mais la **fin normale et gagnante** du cycle (100 % SOL, zéro
taxe de sortie). Tampon `ONESIDED_TOP_BUFFER` (défaut 3 bins) pour que le bruit autour du prix d'entrée
ne ferme pas la position dans la seconde. 18 tests unitaires passés (routage, géométrie, tampon, CUT bas).

**Retour arrière sans redéploiement :** `ONESIDED_FEE_BPS=10000` (tout en double-sided),
`MAX_TRANSFER_FEE_BPS=300` (restaure le blocage du 10/09).

**Correction d'un chiffre que j'avais donné faux :** « 42 % du mouvement sous l'entrée » était une moyenne
des ratios par épisode. Pondéré par le mouvement — le bon calcul, les fees suivant le mouvement — c'est
**64 %**. C'est ce qui faisait conclure à tort « garder le double-sided sur les 1 % ».

**Ligne `💸` RETIRÉE.** Déployée le 10/09, elle reposait sur `proceedsSol` mesuré flat-to-flat : avec
7 positions concurrentes, écarts de ±0,14 à 0,20 SOL (la taille d'une ouverture), moyenne **+0,0092/trade**,
un écart positif donc du bruit pur. Un instrument faux est pire que pas d'instrument.

## 3quaterdecies. LP FIGÉ — CAUSE TROUVÉE ET CORRIGÉE (13/09) — clôt le §3sexies

**L'instrumentation du 12/09 a capturé le bug en flagrant délit. Cas baton, 12/09 23:44→23:49 :**

```
23:42:49   LP 6,21%   px 0.000128765   chaîne lue il y a   4,2s   ← pic, armement
23:44:05   LP 5,26%   px 0.000126228   lu 2s                      ← dernière lecture fraîche
23:45:13   LP 5,26%   px 0.000126228   chaîne lue il y a  70,0s
23:46:13   LP 5,26%   px 0.000126228   chaîne lue il y a 130,0s
23:49:03   LP 5,54%   px 0.000126228   chaîne lue il y a  90,2s
23:49:13   LP 0,40%   ← première lecture fraîche
23:49:22   SORTIE TRAIL à +0,4% (peak +6,2%)
```

**Le prix de pool `px` est resté IDENTIQUE pendant 5 minutes** pendant que le prix des bougies passait
de +7,0 % à −2,5 %. Le LP était bloqué à **5,26 % pour un seuil de trail à 5,21 %** — cinq centièmes
au-dessus. À la première lecture fraîche, chute de 5,27 % à 0,40 % et déclenchement immédiat du trail.
**4,8 points de LP perdus, ~0,013 SOL sur ce seul trade.**

**CAUSE (bonus-bot.js ~1558).** Le repli « lecture individuelle fraîche » ne se déclenchait que si le
lot ne contenait **RIEN** :
```js
const bv = b.fresh ? b.map.get(clé) : null;
if (bv) { recordLv(...); }          // utilise le lot, même vieux de 130 s
else if (...) { /* individuelle */ }
```
Un lot contenant une valeur vieille de deux minutes était donc préféré à une lecture fraîche.

**Pourquoi ça a résisté deux jours :** `âge donnée` affichait **0,0 s** tout du long — il mesure l'âge du
dernier *enregistrement*, pas de la dernière *lecture*. C'est `readTs` (posé le 12/09) qui a permis de
voir les 130 s. Sans lui, cinq hypothèses ont été formulées et réfutées à tort (§3sexies).

**CORRECTIF.** Une position **ARMÉE** dont la lecture chaîne dépasse `ARMED_MAX_AGE_MS` (défaut **10 s**,
= la cadence de `fastPositionCheck` ; descendre plus bas n'apporterait rien puisque le contrôle n'a lieu
que toutes les 10 s)
ignore le lot et force une lecture individuelle. Log `🕓`. Restreint aux positions armées — **24
armements en 5 jours**, donc coût RPC négligeable, et c'est le seul état où la fraîcheur décide d'une
sortie. Les positions non armées gardent le comportement actuel (le user avait refusé un plafond
d'ancienneté généralisé le 12/09 pour raison de consommation Helius : celui-ci est 30× plus étroit).

**Critère de lecture :** la ligne `🕓 … lecture individuelle forcée` doit apparaître quelques fois par
jour. Si elle apparaît en continu, le lot ne rafraîchit plus du tout et le problème est en amont.

## 3sexies. LP FIGÉ — BUG SYSTÉMIQUE NON RÉSOLU (11/09) — instrumentation déployée

**Découvert via RAYCAT (10/09 23:09).** Le user a vu sur Meteora le LP tomber de +15 % à +10 % ; les
logs du bot affichaient 15,21 % au même instant, seuil de trail à 14,21 %. Le trail n'est donc jamais
parti. Le user a fermé à la main, le bot a ensuite lu une position vide (**-97,55 %**), a tenté un close
sur une position déjà fermée (erreur on-chain `Custom 3007`), et a **enregistré le trade à -0,0813 SOL
pour une position qui valait +15,2 %**.

**Le balayage 5 jours (27 014 relevés) montre que ce n'est pas un incident :**

```
231 cas — bin actif FIGÉ ≥5 relevés pendant que le prix bouge ≥5 points
137 sur tokens à 3%   ·   37 à 1%   ·   57 SANS taxe   ·   24 avec le trail ARMÉ
```

Pires cas : **NEARKAT 53 min / 39 relevés / 15,1 pts de prix / LP inchangé au centième**,
RAYCAT 43 min / 29 relevés / 21,9 pts, MUCHWOW 5 min / 24,2 pts.

**CINQ hypothèses formulées et TOUTES réfutées** — ne pas les reproposer sans élément neuf :
1. *Lot périmé / cadence* — réfuté : RAYCAT était au palier 8 s et lu à chaque cycle.
2. *Cache `_dlmmCache` 30 min* — réfuté deux fois : `getActiveBin()` relit la chaîne
   (`node_modules/@meteora-ag/dlmm/dist/index.js:17883` : `await this.program.account.lbPair.fetch`),
   et deux gels dépassent 30 min (43 et 53 min).
3. *Divergence bougies↔pool par la taxe Token-2022* — réfuté : 57 cas sur des tokens SANS taxe.
4. *LP réellement plat* — réfuté par le user, témoin direct de l'écran Meteora.
5. *Close cassé* — réfuté : le close n'a échoué QUE parce que la position était déjà fermée à la main.

**Signature à retenir :** pendant un gel, la valeur ne bouge que par **accumulation de fees**
(15,10 → 15,21, strictement croissant), jamais par le prix. Une valeur qui bouge par les fees mais
jamais par le prix = valorisée à un prix mort.

**Instrumentation déployée (11/09)** — aucun changement de comportement : `positionValuesByKeys` et
`allPositionValues` exposent désormais `px` (prix de pool), `x` (token + fees), `y` (SOL + fees) et
`readTs`. **`readTs` n'est posé QUE lorsque la chaîne est réellement interrogée** — l'ancien
`âge donnée` mesurait l'âge du dernier *enregistrement*, pas de la *lecture*, et affichait donc
`0.0s` sur une valeur figée depuis 50 minutes. Les quatre termes apparaissent sur `⏱️` (armées) ET sur
`📊` (toutes, car 207 des 231 gels concernent des positions NON armées).

**Critère de lecture :** à la prochaine occurrence (231 en 5 jours → quelques heures), comparer `px`
avec le prix réel de la pool. Si `px` est figé alors que `lu:` est récent, le défaut est dans le SDK ou
le calcul ; si `lu:` grandit, c'est la lecture qui ne part pas.

**⚠️ CE BUG INVALIDE PARTIELLEMENT** toute analyse appuyée sur `peakGainPct`, sur le trail ou sur les
relevés LP — dont le « trail rend 1,06 pt médian » du 11/09, qui mesurait peut-être surtout des gels.

**Corrigé le 11/09 (commit suivant) :**
- *Close raté → pas de PnL faux.* `pnlSolLive` passe à `null` et le trade porte `pnlSource:
  'flat-to-flat'`. Le trade n'est PAS effacé — filtrer une anomalie pour « nettoyer » est ce qui avait
  masqué 67 trades cassés six semaines — il est juste exclu des sommes.
- *`src:` honnête.* Une valeur réinjectée pour une position écartée s'affichait `src:lot`, comme une
  lecture fraîche. Elle affiche désormais **`src:lot-PÉRIMÉ`**. C'est ce mensonge qui a rendu les 231
  gels invisibles à l'œil.

**REFUSÉ par le user (11/09) :** plafond d'ancienneté à 90 s avec lecture individuelle forcée au-delà.
Raison : consommation Helius. Ne pas le reproposer sans un budget RPC élargi. Conséquence assumée : les
gels restent possibles, ils sont seulement devenus **visibles** (`src:lot-PÉRIMÉ` + `lu:Ns`).

**Fréquence dans le temps — le bug s'AGGRAVE :** 1,67‰ le 27/08, 0,45‰ le 30/08, 2,06‰ le 02/09,
2,01‰ le 04/09, 4,84‰ le 06/09, 4,68‰ le 08/09, **12,57‰ le 10/09**. ×28 en onze jours. La rupture date
du **02/09**, jour de la modif « cadence PAR POSITION », et s'aggrave avec le nombre de positions
simultanées (passé à 7). Suspect principal : `const place = Math.max(0, READ_BURST_MAX - urgentes.length)`
— avec `READ_BURST_MAX = 3`, dès que 3 positions sont au palier rapide, `place` vaut **0** et AUCUNE
position lente n'est servie, contrairement à ce qu'affirme le commentaire du code. **Pièce qui ne colle
pas encore :** RAYCAT était ARMÉ, donc dans les `urgentes`, jamais différées. À trancher avec `lu:`.

## 3decies. PLANCHER bs100 SUR LA SÉLECTION DE POOL (12/09)

**Constat :** bs80 représentait encore **12 % des sélections** et **3 des 6 positions ouvertes** au
12/09 (MET, baton, TripleT). Le plancher posé la veille ne s'appliquait qu'au tri par rendement ; la
pool désignée par la datapi et le tri historique de repli l'ignoraient.

**Résultat par palier (trades appariés à leur pool via les lignes 🏆) :**

| bin step | trades | PnL total | PnL moyen | pire |
|---|---:|---:|---:|---:|
| **bs80** | 29 | **-0,0016** | **-0,0001** | -0,1957 |
| bs100 | 176 | +1,6263 | +0,0092 | -0,1684 |
| bs125 | 21 | +0,1973 | +0,0094 | -0,0813 |
| bs200 | 92 | +1,2854 | **+0,0140** | -0,0792 |

bs80 est le **seul palier à moyenne négative**. ⚠️ **MAIS sa perte tient à EMBER (-0,1957) : sans lui il
remonte à +0,0069/trade.** L'argument retenu n'est donc PAS le PnL passé — ce serait refaire l'erreur de
sur-ajustement des règles de coupe (§3decies précédent) — mais la **mécanique** : à ±34 bins, bs80 ne
couvre que **-23,7 %** contre -29 % pour bs100, et **19 % des bs80 sortent de range par le bas contre 6 %
des bs200**, or la sortie par le bas précède toutes les catastrophes.

**Coût quasi nul :** sur 987 décisions avec inventaire complet, 168 contenaient une pool bs<100 et **155
(92 %) avaient une alternative bs>=100**. Seuls **13 cas (1,3 %)** n'avaient que du bs<100.

**Implémentation :** filtre posé sur `candidates` **avant** que quiconque y pioche, dans
`findMeteoraPool`. Un seul endroit, donc les trois chemins sont couverts d'un coup — datapi, tri par
rendement, tri historique. C'est la leçon du bug one-sided de la veille, où le tampon n'avait été posé
que sur un des trois chemins de CUT et où la position UBER en est morte.
**Repli explicite :** si aucune bs>=100 n'existe, on garde la bs<100 plutôt que de rater l'entrée.
Log `🧱 N pool(s) bs<100 écartée(s)` à chaque filtrage, `⚠️ aucune pool bs>=100` sur le repli.

## 3nonies. ONE-SIDED — DÉSACTIVÉ LE 12/09, NE PAS LE ROUVRIR SANS CHANGER LE TIMING D'ENTRÉE

**Verdict après une nuit de production : +0,001 SOL sur trois cycles. Désactivé.**

```
UBER      +0,0 % LP    0 SOL         14 min
ZCAT      +0,4 % LP   +0,001 SOL    119 min
NEARKAT   +0,0 % LP    0 SOL          2 min
```

Deux des trois ferment à **0,0 % en moins de 20 minutes** — le critère de churn posé la veille (§3septies)
est atteint en une seule nuit. Pendant la même fenêtre, les positions double-sided produisaient EMBER
+0,03 SOL (trail +10,8 %), OTC +0,0059, KETCHUP +0,0012.

**CAUSE — diagnostic du user, confirmé par les données.** L'échelle est posée **sous** le prix d'entrée,
or le bot entre quand le dump est **fini**, juste avant le rebond. Le prix ne redescend donc pas, l'échelle
ne se remplit jamais, et la position ne perçoit **aucune** fee. UBER : −5,1 % de prix affiché pour 0,0 %
de LP. NEARKAT : fermé au bout de 2 minutes.

**Un APR de pool élevé n'y changerait rien** (question du user) : une échelle qui ne se remplit pas ne
perçoit rien, quel que soit le rendement de la pool. Le blocage n'est pas le rendement, c'est le **sens du
prix après l'entrée**.

**Ce qui reste VRAI et vérifié :** le mécanisme fonctionne parfaitement. Taxe d'entrée mesurée sur deux
ouvertures réelles à **0,0000 SOL** (`Déposé 0,3219 → LP 0,2800`) contre **−0,0100 SOL** en double-sided
(`0,3323 → 0,2700`). Le one-sided n'est pas cassé, il est **incompatible avec ce timing d'entrée**.

**Configuration de retour (défauts dans le code, aucune variable Railway nécessaire) :**
- `ONESIDED_FEE_BPS = 10000` → désactivé. Remettre `100` pour réactiver.
- `MAX_TRANSFER_FEE_BPS = 101` → **plafond à 1 % de taxe** (demande user du 12/09). 300 ne bloquait que
  les ≥3 % et aurait laissé passer un mint à 2 %. À 101, tout ce qui dépasse strictement 1,00 % est
  refusé ; les 1 % (tip, AGI, 🎒, USEFUL) et les tokens propres passent.

**Univers de trading résultant :** que du bid-ask double-sided, sur des tokens taxés à **1 % maximum**.
Rappel du coût : à 1 % la taxe prend ~0,7 % de la mise par aller-retour (4 transferts × 1 % × la moitié
de la mise) contre ~6,3 % à 3 %. Et c'est la classe la plus rentable mesurée — **+3,30 % brut / +2,60 %
net**, contre +0,10 % brut sur les tokens SANS frais, qui ne rapportent rien.

**Pourquoi rebloquer les 3 % :** c'est la seule modif de toute la session dont l'effet positif soit
**mesuré** — +0,0254 SOL en 17 h (wallet, positions au coût, même nombre de positions) contre −0,420 SOL
sur les trois jours précédents. Le one-sided devait les réhabiliter sans la taxe ; il n'a rien rapporté.

**À quelle condition rouvrir le sujet :** uniquement si le timing d'entrée change — c'est-à-dire si le bot
entre **pendant** le dump plutôt qu'après. Tant qu'il entre au creux, une échelle placée dessous restera
vide. Ne pas le réactiver sur une intuition de rendement.

**Bilan de la nuit, pour contexte :** wallet 2,5638 → 2,5032 = **−0,0606 SOL en 17 h**. Mais EMBER seul
coûte −0,1957 : **sans lui la nuit est à +0,135 SOL**. Et quatre règles de coupe ont été testées sur EMBER
ce soir-là, toutes rejetées (§3decies). Les gros perdants restent le coût de la stratégie.

## 3septies. ONE-SIDED — PREMIERS TRADES RÉELS ET BUG CORRIGÉ (11/09 21h)

**Le mécanisme d'entrée fonctionne, mesuré sur 2 ouvertures réelles :**

```
double-sided   Déposé 0.3323 SOL → valeur LP 0.2700   = -0.0100 SOL de taxe d'entrée
ONE-SIDED      Déposé 0.3219 SOL → valeur LP 0.2800   =  0.0000 SOL
```

**Taxe d'entrée exactement nulle.** Bins `[-583→-549]` = 34 de large, échelle posée comme prévu.
Gain acquis : **+0,0100 SOL par trade**, avant toute considération de fees.

**BUG INTRODUIT ET CORRIGÉ LE MÊME JOUR.** La règle « CUT hors-range HAUT » existe à **TROIS**
endroits — scan (~1524), boucle rapide (~2438), repli « bougies KO » (~1391) — et le tampon
`ONESIDED_TOP_BUFFER` n'avait été posé que sur le premier. Conséquence : UBER, première position
one-sided de l'histoire du bot, fermée par la boucle rapide **à 0,0 % de LP après 15 minutes**, avec
le prix à **-5,3 %** (donc SOUS l'entrée). En one-sided `upperBinId` EST le bin d'entrée : sans tampon,
le moindre tick au-dessus ferme la position. **Leçon : chercher TOUTES les occurrences d'une règle
avant de la modifier — celle-ci en avait trois.**

**RISQUE DE CHURN À SURVEILLER.** Une position one-sided dont le prix monte juste après l'entrée est
100 % SOL, n'encaisse aucune fee, et sera fermée à ~0 %. Elle aura consommé un slot, la rent et le gas
pour rien. UBER en est l'exemple : 15 min, 0,0 %. Le tampon de 3 bins limite le déclenchement sur le
bruit mais ne règle pas le cas où le prix part franchement à la hausse. **Critère : si plusieurs
`CYCLE ONE-SIDED COMPLET` tombent à 0,0 % de LP en moins de 20 min, il faut une condition d'âge
minimum ou exiger `rg > 0` pour banker.**

**Arbitrage de fond, à garder en tête :** prix qui monte juste après l'entrée → le double-sided gagne
(il détient des tokens qui montent), le one-sided ne gagne rien mais ne perd rien. Prix qui descend
d'abord → le one-sided écrase le double-sided. Le bot entrant sur un dump, le second cas devrait
dominer, mais ce n'est PAS encore démontré sur trades réels.

**Observation annexe :** le bin actif bouge bien (LEVERCAT -340 → -341 quand le prix repasse sous
l'entrée). Les « gels » de bin observés sur UBER (`-549→-549`) correspondaient à un prix de pool qui
n'avait pas franchi de bin, alors que le champ `prix` (issu des bougies) bougeait de 5 points. Les deux
sources divergent réellement — ne pas confondre avec le bug de LP figé du §3sexies.

## 3octies. SÉLECTION DE POOL PAR RENDEMENT RÉEL (12/09)

**Déclencheur :** le user demande pourquoi le bot a ouvert MET sur une pool à ~0 % de fees. Réponse :
le `feeTvl` enregistré (22,3) est celui du **TOKEN** agrégé sur toutes ses pools, pas de la pool où le
bot dépose. `FEE_TVL_FLOOR` filtre donc le token, jamais la pool.

**Mesure sur le shadow rendement (566 décisions distinctes, 6 jours) :**

```
491 (87%)  déjà la meilleure pool
 77 (13%)  meilleure MANQUÉE — 10,7 %/j pris contre 18,4 %/j disponible
```

Taux d'échec par pas : **bs80 47 %** (7/15) · **bs200 28 %** (46/165) · bs125 7 % · bs100 5,6 %.
Et **70 des 77 meilleures pools sont des bs100** — d'où le plancher.

```
plancher bin step   décisions récupérées   rendement récupéré
  aucun                  77/77                  100%
  bs >= 100              74/77                   97%
```

**Déployé.** `dexInfo` renvoie désormais `metPools: [{addr, tvl, vol24h}]` — la réponse DexScreener
contenait déjà ces champs et les jetait (seul `vol24h` agrégé était conservé). Stocké sur
`state.watch[tok]`, passé à `findMeteoraPool(tokenAddress, preferredPool, metPools)` aux deux appels.
La sélection classe les candidates de `binStep >= 100` par `vol24h × fee ÷ TVL` et prend la meilleure.
Log `📈 Pool choisie au RENDEMENT` quand ça diffère du tri historique.

**Coût : nul.** Aucun appel HTTP supplémentaire, aucune latence à l'ouverture, aucun crédit RPC — la
donnée était déjà en mémoire. C'est la remarque du user qui a permis ça : ma première proposition
prévoyait un appel DexScreener bloquant avec timeout 2 s, inutile puisque le token est déjà en watch.

**Priorités préservées :** la pool désignée par la datapi (`preferredPool`) écrase tout, comme avant.
Tous les filtres de viabilité restent (SOL en Y, bin step admis, fee ≥ 0,5 %, réserve ≥ 20 SOL). Repli
intégral sur le tri historique si `metPools` est absent, vide, ou sans TVL exploitable. Le départage
par plus grand bin step du 08/09 reste en dernier critère.

**Ce qui N'EST PAS touché :** le tri `a.baseFeePct - b.baseFeePct` reste en place comme repli. La note
« quel niveau de fee rapporte le plus n'est PAS tranché, ne pas modifier sans A/B » porte sur le niveau
de fee comme heuristique — ici on ne devine plus, on classe par un rendement mesuré.

**Impact attendu, modeste :** ~7,7 points de rendement journalier en plus sur les cas concernés, soit
~0,0009 SOL par trade et **~0,07 SOL sur 6 jours**. Gratuit et sans risque, mais ne pas en attendre un
redressement. **Critère de lecture :** compter les lignes `📈 Pool choisie au RENDEMENT` et vérifier
que le shadow `⚠️RANG` se raréfie.

## 3duodecies. TRI DES CANDIDATS À L'ENTRÉE — REJETÉ HORS ÉCHANTILLON (12/09)

**Le constat est réel :** le bot ouvre sur le **premier** candidat de la rotation
(`bonus-bot.js:1357-1360`), alors qu'il a le choix entre 2 et 14 candidats dans **79 %** des scans
(74 % en ont ≥3). Sur 162 ouvertures réelles avec alternatives connues, **69 %** avaient une
alternative plus performante.

**Ce qui semblait marcher — et qui était CIRCULAIRE.** Trier par la plus petite market cap donnait
+0,0135 SOL/h contre +0,0080 pour la rotation, soit **+1,587 SOL** sur la période, robuste au retrait
des six meilleurs contributeurs (+1,148), avec 60 décisions améliorées contre 40 dégradées.

**Trois contrôles passaient, et ils étaient tous insuffisants :**
- contre le hasard : 400 tirages aléatoires donnent 0,0080 (= la rotation), max 0,0102, le tri MC les
  dépasse tous ;
- stabilité de la performance par token : **r = 0,728** entre 1re et 2e moitié des trades (46 tokens) ;
- gros gagnants préservés : **0 des 5 meilleurs tokens** n'est abandonné par le tri.

**Le test HORS ÉCHANTILLON le tue :**

```
coupe au 04/09  (15 décisions)   tri MC  -0,0006
coupe au 06/09  (51 décisions)   tri MC  -0,0004
coupe au 08/09  (42 décisions)   tri MC  +0,0013
```

Deux coupes sur trois sont négatives. Le gain venait de ce que j'évaluais chaque token avec sa
performance mesurée sur **la période même des décisions** : son « taux » incluait les trades censés
être prédits.

**LEÇON DE MÉTHODE — la plus importante de la session.** Les trois premiers contrôles testaient la
**description**, pas la **prédiction**. Un critère peut battre le hasard, être stable et épargner les
gagnants, et ne rien prédire. **Tester hors échantillon AVANT de présenter un chiffre, jamais après.**

**Note :** le tri par profondeur de dump s'en sort marginalement mieux (+0,0013 · +0,0017 · -0,0001)
mais sur 15 à 51 décisions et des effets au dix-millième de SOL/h — indiscernable du bruit. Ne pas le
déployer sans un échantillon bien plus large.

## 3undecies. SEIZE RÈGLES DE SORTIE TESTÉES ET REJETÉES (11-12/09) — NE PAS LES REPROPOSER

**Déclencheur :** les trades de plus de 5 h occupent **1161 h de slot sur 1609 (72 %)** pour **-0,842 SOL**,
quand ceux de moins de 2 h font **+3,687 SOL sur 224 h**. Constat solide — il n'utilise que `durMin` et
`pnlSolLive`. **Mais AUCUNE règle de sortie ne sait le convertir en gain.**

| règle | vs réel | robustesse |
|---|---:|---|
| couper au 1er hors-range bas | +0,009 | 143 h libérées, gain nul |
| couper au 2e hors-range bas | +0,142 | **-0,022 sans EMBER** |
| couper au 3e hors-range bas | +0,322 | **-0,077 sans les 3 meilleurs**, 4 dégradés sur 9 |
| armer le rebond au 1er hors-range | -0,061 | — |
| armer le rebond au 2e hors-range | -0,009 | — |
| couper à 2 h | -1,082 | — |
| couper à 3 h | -0,632 | — |
| couper à 4 h | -0,526 | — |
| couper à 6 h | -0,172 | dégrade 38 trades sur 46 |
| couper à 8 h | +0,128 | **+0,008 sans le meilleur**, dégrade 23 sur 29 |
| couper à 10 h | +0,042 | dégrade 19 sur 26 |
| couper à 12 h | -0,015 | — |
| armer le rebond à 1 h | -0,299 | -0,645 sans les 3 meilleurs |
| armer le rebond à 2 h | -0,364 | -0,692 |
| armer le rebond à 4 h | -0,212 | -0,539 |
| armer le rebond à 6 h | +0,090 | -0,188 |

**Motif commun :** une poignée de trades (EMBER +0,17, PURPS +0,14, OTC +0,09) fabrique le gain apparent,
et la majorité des trades touchés est **dégradée**. Le seuil de -55 % gagne contre tout parce qu'une
position en perte finit presque toujours par rebondir un peu — sortir avant fige la perte.

## ⚠️ PIÈGE MAJEUR : `lvHist` EST TRONQUÉ — NE JAMAIS S'EN SERVIR POUR DATER

`lvHist` est **plafonné à 40 relevés**. Son premier élément n'est donc PAS l'ouverture du trade :
**93 % des trades** ont `lvHist[0].t` plus de 10 min après `openedAt`, décalage médian **71 min**, et sur
les trades de plus de 4 h le décalage médian atteint **490 min (8 heures)**.

Le 12/09 j'ai produit une série entière de résultats faux avec `lvHist[0].t` comme heure d'ouverture —
time stop annoncé à +1,63/+2,5 SOL, armement à 2 h annoncé à +0,866 SOL, balayage de 24 configurations,
tests de robustesse. Tout était invalide : le « marqueur à 4 h » tombait après la fin réelle du trade, et
les relevés trouvés appartenaient à d'AUTRES trades du même token.

**MÉTHODE CORRECTE :** fenêtrer chaque trade par `openedAt`/`closedAt` réels, reconstruire le LP depuis
les lignes `📊` des logs, **exclure les fenêtres qui se chevauchent** pour un même token, et **valider par
un contrôle** — dernier LP relevé contre `pnlSolLive` enregistré. Contrôle obtenu le 12/09 : erreur
médiane **0,06 pt**, p90 2,07 pt sur 324 trades. Sans ce contrôle, ne rien publier.

## 3terdecies. RÉOUVERTURE DES MINTS TAXÉS AVEC PLANCHER RSI2 INDEXÉ (13/09)

**Le diagnostic complet.** Sur 385 trades depuis le 20/08, Meteora affiche **+3,66 SOL** ; mon compte
indépendant du brut donne **+3,616** (concordance à 1,2 %). Mais après coûts réels :

| classe | n | brut | taxe | NET |
|---|---:|---:|---:|---:|
| 3 % | 124 | +1,804 | **-1,852** | **-0,048** |
| 1 % | 38 | +0,445 | -0,211 | +0,235 |
| propres | 223 | +1,367 | -0,060 | +1,307 |
| **total** | **385** | **+3,616** | **-2,122** | **+1,494** |

Plus **-0,235 SOL** sortis du wallet hors trading (achat NFT Magic Eden 0,135 le 08/09, transfert
0,100 le 10/09 — vérifiés on-chain sur 1006 transactions, 0 non lue au second passage) et -0,027 de
frais réseau. **Net réel depuis le 20/08 : +1,232 SOL.**

**COÛTS MESURÉS ON-CHAIN (et non plus déduits) :**
- entrée : 2 transferts × taxe × 50 % de la mise → **3,23 % mesuré sur 125 ouvertures** pour un 3 %
- sortie : la position est encore **48,0 % en token** sur une sortie TRAIL, **53,9 % sur une sortie RSI2**
  (mesuré sur 15 fermetures : SOL du close + SOL du reswap). Donc 2,88 % et 3,23 % respectivement.
- **seuil de rentabilité ≈ taxe × 2,078** : 6,23 % à 3 %, 2,08 % à 1 %, 0,12 % sur un token propre.

**LA CAUSE DE LA NON-RENTABILITÉ DES 3 % :** le trail sortait à 7,69 % de LP (+0,330 SOL sur 75 trades),
les **42 sorties RSI2 sortaient à 2,58 %** — sous le seuil de 6,23 % — pour **-0,393 SOL**. Le plancher
`RSI2_FLOOR_LP` valant 0, le bot vendait dès que le LP était positif, donc systématiquement à perte.

**DÉPLOYÉ :** `rsi2FloorFor(pos)` = `taxe × 2,078 × 1,05`. **Un token sans taxe retourne
`RSI2_FLOOR_LP` (0) — comportement strictement inchangé sur les 223 trades propres qui portent le gain.**
`MAX_TRANSFER_FEE_BPS` repasse à 1000 (rouvre les 3 %), et **`MAX_TAXED_POSITIONS = 2`** borne
l'exposition (demande user : « si cela foire on en a pas trop »). Log `🧮` quand le plafond reporte une
entrée, compteur `blockCount['plafond-taxes']`.

**Effet simulé : +0,456 SOL** sur les 124 trades à 3 % (de -0,048 à +0,456).

**RÉSERVES ASSUMÉES — à relire avant de juger :**
- 31 trades modifiés seulement ; **2e moitié de période à -0,12** (1re à +0,59).
- Le prix post-sortie est **estimé** via l'entrée/sortie des positions suivantes du même token, pas mesuré.
- Sur les tokens à **1 %**, l'effet est **négatif** (-0,033 sur 12 trades) : leurs sorties RSI2 se font
  déjà au-dessus du seuil. Le plancher ne les aide pas, il ne les tue pas non plus.
- Les 24 sorties RSI2 qui n'atteignent PAS le seuil d'armement voient le prix tomber à **-15,2 % médian**
  (p10 -23,6 %). C'est chiffré et inclus dans le +0,456 via la courbe prix→LP mesurée par tranche
  (ratio 0,408 à -5 %, 0,442 à -20 %, 0,725 au-delà de -30 % quand la position sort de range).

**CRITÈRE DE LECTURE, ~20 trades :** si les sorties RSI2 sur mints taxés disparaissent au profit du TRAIL,
ça marche. Si les positions taxées s'accumulent sans sortir, refermer (`MAX_TRANSFER_FEE_BPS=101`).

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

## 4bis. RÈGLE DE DÉPLOIEMENT — ne pas pousser si un trail est armé

**Avant tout `git push`, vérifier qu'aucune position n'a `armé✓`.** Un push redéploie Railway et
redémarre le bot ; pendant la coupure, **le trail n'est plus évalué**. Or une position armée est
celle qui peut devoir sortir dans les 10 secondes — mesuré le 08/09, la boucle rapide l'évalue
toutes les 10 s sur des données de moins de 2 s, et HONTER a perdu **5,6 points de LP dans une
seule fenêtre** (pic 8,65 % → sortie 3,1 %). Redémarrer à cet instant, c'est risquer de rendre un
gain acquis.

Comment vérifier : chercher `armé✓` dans les lignes `📊` de `/logs`, ou les lignes `⏱️ … armé`.
Les positions NON armées ne courent pas ce risque (RSI2, CUT et rebond sont des variables lentes).
Exception : un correctif urgent (bot aveugle, positions non gérées) prime — pousser et le signaler.

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

**UN 200-VIDE EST FACTURÉ (constat du 08/09 midi).** Le tableau de bord Birdeye compte l'usage de la
v1 ET de la v3 alors qu'aucune bougie ne revient : ces API facturent la **requête servie**, pas le
résultat utile. Sans backoff, le bot brûlait ses 8 650 CU restants sur du vide — et le repli v3→v1
que j'avais ajouté à 11 h **doublait** la facture (~1 988 CU/jour, épuisement en 4,4 jours pour rien).
Corrigé : pause de 30 min après **5** réponses vides (~240 CU/jour), et plus jamais de 2e essai sur un
vide — on ne tente l'autre version que si la 1re a levé une ERREUR.

**Ce qu'on sait / ce qu'on ne sait pas.** La clé est VALIDE (l'usage est compté ; une clé morte
renverrait 401 sans consommer). Ni le quota (29 % restants) ni le rate-limit (0,4 RPS mesuré pour
1 RPS autorisé) n'expliquent la panne. Les deux endpoints existent (401 sans clé, pas 404). **Cause
racine toujours indéterminée** : paramètre renommé côté Birdeye, couverture de tokens réduite sur le
package Standard (les memecoins ne sont pas des actifs majeurs), ou OHLCV retiré du palier avec un
200-vide en guise de refus. **Le test qui trancherait** : le bac à sable de la doc Birdeye, connecté
au compte du user — il montre la réponse exacte sans exposer la clé. NE PAS régénérer la clé : elle
fonctionne.

**Leçon générale** : les deux sources de bougies exigeaient une clé. Toute source unique keyée doit
avoir un repli sans clé, sinon une panne de facturation arrête le bot sans le dire. Et toute source
facturée doit avoir un **backoff sur réponse vide**, pas seulement sur erreur.

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

---

## 8. 14/09 — Le drapeau d'attente de rebond était COLLANT (corrigé)

**Le défaut.** `_awaitBounce` était posé à `true` par trois endroits du code et **remis à
`false` par aucun**. Une position ayant franchi −55 % (en prix depuis l'entrée **ou** en LP)
gardait donc à vie une sortie dégradée : `rsi2 > 90 && (pos._awaitBounce || realGain > plancher)`
— le `||` court-circuite le plancher, donc sortie au premier RSI2 > 90 à **n'importe quel LP**.

**Le cas qui l'a révélé.** YOYO, 14/09 : sortie de range par le bas → armement. Puis retour
**dans** la range (bin −265 pour une borne basse à −266), LP remonté de −34,5 % à −27,3 %,
fees de nouveau encaissées. Le bot allait quand même la vider au premier RSI2 > 90.

**Ce que disent les données** (21 positions sorties par le bas, depuis le 08/09) :

| | issue |
|---|---|
| revenues dans la range (plusieurs épisodes) | CATE +0,58 % · AGI +1,43 % · KETCHUP +0,43 % · ZCAT +4,91 % · baton +12,67 % |
| restées dehors (un seul long épisode) | BUTTHOLE −35,2 % · fone −43,7 % · OTC −44,5 % |

Le retour dans la range **est** le signal que la thèse est de nouveau vivante.

**Le correctif.** Désarmement quand le bin actif revient à l'intérieur de `[lowerBinId, upperBinId]`
**et** que `deepDown` est redevenu faux. Le second test évite le battement arm/désarm : sans lui,
la ligne d'armement qui suit ré-arme immédiatement. Log `↩️` + notification Telegram.

**Ce que ça ne fait pas.** Aucune position saine n'est touchée — le drapeau n'existe que sur
celles qui ont franchi −55 %. Le plancher RSI2 normal (dont le plancher taxe) est simplement
rétabli.

### Mesures de la session du 13-14/09 — ce qui est TRANCHÉ

| piste | verdict |
|---|---|
| sortie sur bougie close au lieu du tick | **rejetée** — médiane 0,00 pt, et −0,65 pt sans l'unique outlier |
| trail sur le rebond des positions hors range | **rejetée** — +5,8 % en bougies 1 h, **0** en bougies 15 min avec robustesse |
| plancher de rentabilité sur les sorties RSI2 | **rejetée** — après une sortie RSI2 le token fait **−7,1 % médian** à +6 h (63 cas) : la règle protège, elle ne scalpe pas |
| chopRate recalculé en continu comme sortie | **rejetée** — ne se déclenche jamais, ni sur perdants ni sur gagnants |
| coupe sur cassure du SuperTrend | **rejetée** — entrer sous le ST est la meilleure configuration (ST HTF rouge : +4,77 % moyen contre +3,58 % vert ; distance < −30 % : +5,95 %) |
| relever le plancher chop-rate au-dessus de 40 % | **rejetée** — les perdants avaient un chop **plus élevé** (88,4 %) que les gagnants (80,0 %) |

### En cours de validation

**Filtre d'entrée `cr == null`.** `chopOk = cr == null || cr >= 0.40` laisse passer les tokens
dont le chop-rate n'est pas calculable. Ce sont de gros coins établis et vieux (MC 10,6 M contre
2,4 M, âge 626 h contre 151 h, fee/TVL 6,7 % contre 17,7 %) : les seuils ±8 %/−30 % de `chopRate`
ne se résolvent jamais sur eux. Résultat : **LP +2,66 % contre +4,18 %, slot immobilisé 190 min
contre 73 min**. 10 % des entrées, toujours les mêmes tokens (MARKET ×6, STONK ×5, TripleT ×5).

**Sortie « rebond avorté ».** MACD 15 min (histogramme rouge qui se résorbe ≥2 bougies puis
s'élargit 2 bougies) **+** rebonds d'amplitude décroissante, la première qui se déclenche.
18 perdants attrapés sur 21, 2 gagnants touchés sur 45. Hors échantillon sur les trois sorties
REBOND de la nuit du 13 au 14 : MINI +57,2 % / 56,5 h, OTC +169,0 % / 35,3 h, baton +64,1 % / 13,5 h.
**Backtest en cours sur les 328 gagnants restants** — c'est lui qui décide.

---

## 9. 14/09 — Vélocité de fees journalisée (instrumentation, aucune règle)

**Pourquoi.** Les fees accumulées étaient lues à chaque cycle depuis toujours — mais **repliées
dans `x` et `y`** par `positionValuesByKeys`, donc invisibles. Impossible de savoir si une position
paie son loyer. C'est la porte **BOREDOM** d'Evil Panda, la seule des trois qui manque au bot :
*« a position that is not earning its keep in fees after a fair trial closes at the first small
profit and is not reopened. Dead liquidity is the most expensive thing on the book, because it
looks like nothing is wrong. »*

**Mesuré le 14/09** sur les 7 positions ouvertes, un aller-retour coûtant ~0,0046 SOL :

| position | fees/h | paie son aller-retour en |
|---|---|---|
| KNOTS | 0,00144 | 3 h |
| baton | 0,00075 | 6 h |
| MINI | 0,00053 | 9 h |
| OTC | 0,00048 | 10 h |
| TripleT | 0,00029 | 16 h |
| **ZCAT** | **0,00005** | **92 h** |

**Ce qui est déployé.** `fees` exposé séparément dans `bonus-live.js`, accumulé dans `recordLv`
(`pos._fees`, `pos._feeVel`, `pos._feeHours`), affiché dans la ligne `📊` sous la forme
`💰31.41m (1.44m/h, paie en 3h)` — en milli-SOL. Coût nul : la donnée était déjà en mémoire.

**Ce qui n'est PAS déployé.** Aucune règle de coupe. On regarde d'abord dans le temps si le signal
est exploitable. Attention au piège : 5 des 7 positions du 14/09 n'ont **jamais** été positives, or
la règle d'EP ferme « au premier petit profit » — elle ne se déclencherait donc jamais sur elles.

### La sortie « rebond avorté » — état de la mesure

Règle testée : histogramme MACD 15 min négatif qui se résorbe ≥2 bougies puis s'élargit 2 bougies
(**bougies closes**), couplée aux rebonds d'amplitude décroissante, la première qui parle.

| variante | perdants attrapés | gagnants touchés | net (pts de LP) |
|---|---|---|---|
| MACD seul | 12/18 (+464) | 27/200 (−139) | +326 |
| MACD + prix < −35 % | 4/18 (+45) | **0**/200 | +45 |
| **MACD + position HORS RANGE** | **12/18 (+464)** | **7/200 (−27)** | **+438** |

**Le couplage hors-range domine.** Il attrape les mêmes 12 perdants que le MACD seul en ne touchant
que 7 gagnants au lieu de 27 — et sur ces 7, deux sortiraient *plus haut* (CATE +3,0 %, AGI +2,2 %).

La raison est arithmétique : « hors range par le bas » **est** la vélocité de fees nulle (100 % token,
plus aucun frais encaissé), et c'est un test exact que le bot fait déjà. Un seuil de prix fixe n'en est
qu'un proxy : la couverture basse d'une range ±34 bins vaut −23,7 % en bs80, −28,7 % en bs100,
−34,5 % en bs125, −49,0 % en bs200, −56,8 % en bs250.

Validation hors échantillon sur les trois sorties REBOND de la nuit du 13 au 14 :
MINI +57,2 % / 56,5 h · OTC +169,0 % / 35,3 h · baton +64,1 % / 13,5 h.

**Réserves.** 18 perdants seulement. Les gains sont en **prix** — la conversion en LP utilise un
coefficient de 0,65 pour les positions hors range (100 % token) et 0,41 pour celles dans la range.
Rien n'est déployé.

---

## 10. 14/09 — Ombre « prise de profit sur objectif de prix »

**L'origine.** EP place son edge sur la sortie : *« fee income, EARLY profit-taking and small,
decided losses »*, et sa porte HAUT prend le profit *« when a move looks stretched, BEFORE it
gives the gains back »*. Toute la session avait porté sur les 20 perdants ; la puissance
statistique est en réalité sur les **254 gagnants**.

**Ce qui a été mesuré** (cache de bougies 15 min, `tools/test-exits.js`) :

| règle | déclenche | LP total avant → après | améliorés / dégradés |
|---|---|---|---|
| objectif +10 % de prix | 105/254 | 1236 → 1339 | 64 / 41 |
| objectif +15 % | 71/254 | 1236 → 1326 | 45 / 26 |
| **objectif +25 %** | 27/254 | 1236 → 1303 | **21 / 6** |

Et **sortir sur la faiblesse est mauvais** : 1re bougie rouge après un plus-haut −6,5 %,
2 bougies rouges −9,5 %, RSI2 > 95 −1,3 %. Le trail fait mieux que ces signaux. Ce n'est donc
pas « sortir plus tôt » — c'est « ne pas attendre le retracement » une fois le mouvement étiré.

**Contre-tests — c'est la SEULE règle de la session qui les passe tous.**

| test | +15 % |
|---|---|
| référence | +3,4 % méd · 45/71 |
| 1re moitié chronologique | +3,9 % |
| 2e moitié (hors échantillon) | +2,6 % |
| en retirant les 3 meilleurs | +3,1 % |
| tokens nouveaux / établis | +2,4 % / +3,8 % |
| concentration | 28 tokens pour 71 déclenchements |

**Pourquoi une OMBRE et pas un déploiement.** Le backtest convertit des prix en LP par un
coefficient moyen de 0,41 — une mesure, pas une constante. Le gain annoncé (+5 à +8 % du PnL des
gagnants, soit ~0,26 pt de LP par trade) est du même ordre que l'incertitude de ce coefficient.
Et la règle touche le TRAIL, qui produit **93 %** du PnL : baton passerait de +15,8 % à +2,6 %.
L'ombre enregistre le **LP réel** au moment où l'objectif est touché, puis compare à la sortie
réelle. Deux LP mesurés au lieu d'un prix converti.

**À lire dans les logs** : `🎯 [OMBRE]` à l'armement, `🎯 [OMBRE +25%]` au bilan de fermeture.
Juger vers 30-40 déclenchements.

### Ce que la session du 13-14/09 a DÉFINITIVEMENT écarté

Vingt et une règles de sortie testées sur les perdants. **Aucune ne survit.** La cause est mesurée :

| variable, au moment où la position sort de la range | perdants | gagnants | AUC |
|---|---|---|---|
| heures depuis l'ouverture | 5,0 | 2,5 | 0,67 |
| heures sans nouveau plus-haut | 4,3 | 2,3 | 0,65 |
| largeur de Bollinger | 9,4 % | 11,3 % | 0,37 |
| **MACD histo / ligne** | −2,5 | −2,9 | **0,52** |
| **écart EMA9 / 21 / 34 / 50** | — | — | **0,51** |
| **pente EMA34** | — | — | **0,46** |

**Le MACD et toutes les EMA ont un pouvoir discriminant NUL** (AUC ≈ 0,50). Au moment où une
position sort de sa range, perdants et gagnants ont le même profil technique — logique, puisque
la tendance était déjà cassée à l'entrée : c'est le signal d'achat. Seules des variables
**temporelles** et la **volatilité** séparent, et faiblement (AUC 0,65-0,67).

En bougies 1 h les EMA gagnent un peu de pouvoir (AUC 0,60-0,64) mais l'échantillon tombe à
9 perdants : une position du bot dure 73 min en médiane, un MACD(12,26,9) demande 35 bougies.
**EP tient des jours, le bot des heures** — son indicateur HTF n'a pas la place d'exister ici.

Ne pas rouvrir ces pistes sans 60+ perdants : MACD (toutes variantes), EMA (16 variantes),
SuperTrend en sortie (0 déclenchement), chopRate en continu (0 déclenchement), RSI14/RSI2 en
sortie de range, bougie close, trail sur rebond, plancher RSI2, coupe temporelle.

---

## 11. 14/09 — Sortie en 15 min pour TOUS les tokens (déployé)

**Ce qui change.** `pcs` — la série de bougies qui sert à la sortie (prix, RSI2, RSI14) — passait en
5 min pour les tokens non établis et en 15 min pour les établis. Désormais **15 min pour tous**.

**Pourquoi.** Le raisonnement du 08/08 pour les établis (*« RSI(2) 5m explose sur un micro-wiggle →
sort à LP ~0 % avant le vrai bounce »*) vaut aussi pour les nouveaux. Mesuré sur le cache de
bougies, 56 sorties RSI2 de tokens **non établis** :

| | médian | moyen | mieux |
|---|---|---|---|
| rejouer la règle en 15 min | **+4,9 %** | +7,2 % | 38/56 |

**Le groupe témoin valide la méthode.** Sur les 80 sorties de tokens **établis**, déjà en 15 min,
l'écart simulé est de **+0,4 %** — zéro. La simulation reproduit donc l'existant, et l'effet
n'apparaît que là où le timeframe change réellement.

**Et ce n'est pas « sortir plus tard ».** Placebos :

| | médian |
|---|---|
| signal RSI2 15 min | **+4,9 %** |
| attendre le même délai médian (1 bougie) sans indicateur | **−0,6 %** |
| délai tiré au hasard (50 tirages) | **0,0 %** |

Le décalage médian n'est que d'**une bougie**. Ce n'est donc pas l'attente qui paie, c'est le
signal qui choisit le moment.

**Contre-tests, tous positifs :** 1re moitié +6,0 % · 2e moitié hors échantillon +4,9 % ·
sans les 3 meilleurs +4,6 % · sans les 5 meilleurs +4,0 % · 22 tokens distincts pour 56 cas.

**Ce que coûtait l'ancien réglage :** 0,367 SOL sur 12 jours, soit **≈ 1 SOL par mois**.
Cas typiques — EMBERCAT sorti à +3,6 % après 60 min (15 min : +31 % plus haut) · MARKET à 0,0 %
après 25 min (+28 %) · SOLCAT à +0,7 % après 41 min (+27 %).

**Coût technique : nul, voire négatif.** `cs` venait déjà de `candles15` et `candlesTF` met en
cache par timeframe — la modification supprime des appels 5 min au lieu d'en ajouter. `candles5`
devient du code mort, laissé en place volontairement.

### Autres pistes mesurées ce jour et NON retenues

**Bloquer la ré-entrée après une sortie « ennui »** (RSI2 < 3 % de LP et > 3 h) — la seconde moitié
de la phrase d'EP, *« and is not reopened »*. Passe tous les contre-tests en points de LP
(hors échantillon +0,38 pt, robuste aux outliers), mais **l'effet direct en SOL est négatif** :
−0,370 SOL de gagnants bloqués (50 trades) contre +0,225 SOL de perdants évités (3 trades),
soit **−0,145 SOL**. Tout le bénéfice reposerait sur les 389 h de slot libérées (≈ 275 trades
supplémentaires, +2,4 SOL) — une hypothèse de remplissage non mesurée. À reprendre si la capacité
devient démontrablement le goulot.

**Allonger le délai de ré-entrée ou exiger un prix supérieur** — réfuté, et l'inverse est vrai :
ré-entrée en moins de 35 min +5,21 % contre +2,46 % au-delà de 12 h ; ré-entrée à plus de 10 %
*au-dessus* de la sortie précédente : +2,96 % et 7 % de perdants, le pire segment.

**Première entrée contre ré-entrée** — les **premières** entrées sont 3× plus risquées :
9,3 % de perdants et +1,29 % de LP moyen, contre 2,8 % et ~+4 % pour les ré-entrées. Un token
déjà tradé plusieurs fois est un choppeur prouvé. Même population que le filtre `cr == null`.

**Filtre d'amplitude des rebonds à l'entrée** (porte BOREDOM d'EP) — identifie bien la population
ennuyeuse (trades > 3 h à < 3 % de LP : rebonds de 25,0 % contre 41,9 % pour les gagnants rapides)
mais **inutilisable comme filtre** : à un seuil de 25 % il bloque 1 perdant, 32 trades ennuyeux et
**19 gagnants rapides**, et il s'inverse entre les deux moitiés chronologiques (+4,55 % puis +0,13 %).

---

## 12. 14/09 — LA CAPACITÉ EST LE GOULOT (correction de la section 11)

**Ce que j'avais écrit une heure plus tôt est FAUX.** La section 11 écarte le blocage de ré-entrée
au motif que le bénéfice « reposerait sur une hypothèse de remplissage non mesurée ». Elle l'est
maintenant, et le résultat est l'inverse.

**L'erreur.** Le compteur `blockCount['max-pos']` surveille `MAX_POSITIONS = 10`, le plafond
**papier**. Le vrai plafond est `MAX_LIVE_POSITIONS = Math.min(7, …)`, appliqué ligne 2118, et il
**n'a aucun compteur** — seulement une ligne de log :

```
⏸️ LIVE: 7/7 position(s) réelle(s) déjà ouverte(s) — X en papier seulement
```

Lire `max-pos` (200 cumulés contre 195 000 « pas-au-creux ») donnait donc « la capacité n'est pas
le goulot ». C'était une mesure du mauvais plafond.

**La vraie mesure**, en comptant ces lignes dans les logs persistés :

| jour | occurrences | tokens distincts refusés | heures saturées |
|---|---|---|---|
| 2026-09-11 | 1471 | 28 | 13 / 24 |
| 2026-09-12 | 1688 | 28 | 17 / 24 |
| 2026-09-13 | 1402 | 20 | **22 / 24** |

**≈ 25 opportunités pleinement qualifiées refusées par jour**, pour 19 à 40 entrées réalisées.
**Le bot en refuse à peu près autant qu'il en prend.**

Ces candidats ont passé les quinze filtres d'entrée. Ce ne sont pas des rejets sur critère, ce sont
des entrées validées que le bot ouvre en papier et ne peut pas exécuter au réel.

**Conséquence : tout raisonnement en « heures de slot libérées » redevient valide**, et les deux
règles écartées en section 11 changent de statut :

| règle | effet direct | slot libéré | valeur si les slots se remplissent |
|---|---|---|---|
| blocage de ré-entrée après sortie « ennui » | −0,145 SOL | 389 h | ≈ +2,4 SOL |
| filtre `cr == null` | −0,08 SOL | 579 h | ≈ +3,6 SOL |

**Troisième levier, le plus direct : `MAX_LIVE_POSITIONS`**, codé en dur à 7 par un `Math.min(7, …)`.
Contrepartie : les positions font ~0,28 SOL sur un wallet d'environ 2,7 SOL, soit ~72 % déjà
déployé. Plus de slots impose des positions plus petites, et l'aller-retour à 0,0046 SOL passe de
1,6 % à 2,1 % de la position si elle tombe à 0,22 SOL.

**À faire avant toute décision :** vérifier que les candidats refusés ne sont pas systématiquement
moins bons que ceux retenus (le bot prend le PREMIER qualifié, pas le meilleur — cf. la note du
12/09 sur la sélection par rotation). Si les refusés valent les retenus, les trois leviers sont
additifs.

---

## 13. 14/09 — Verrou 48 h après une sortie molle (déployé)

**Le manque.** Le bot avait bien la porte BOREDOM d'EP — la sortie RSI2 en petit profit *est*
« closes at the first small profit ». Ce qui manquait, c'est la fin de la phrase : **« and is not
reopened »**. Il rouvrait le même token 30 minutes plus tard.

**Mesuré sur 412 trades.** Une ré-entrée dont la sortie précédente était molle — RSI2, plus de 3 h,
moins de 3 % de LP :

| | SOL net / trade | LP moyen | durée médiane |
|---|---|---|---|
| ré-entrée après sortie molle | **−0,0018** | +1,42 % | 136 min |
| ré-entrée quelconque | **+0,0050** | +4,08 % | 83 min |

Et 69 % de ces ré-entrées ressortent elles aussi en RSI2 (+1,68 % de LP moyen), 30 % redeviennent
elles-mêmes un token mou.

**Un cooldown plus long ne répare rien** — mesuré : < 35 min +3,23 % · 35 min-2 h +3,38 % ·
**2-6 h −2,84 %** · 6-24 h +2,37 %. Le problème n'est pas *quand* on rentre, c'est que le token ne
produit pas. D'où un verrou, pas un délai.

**48 h plutôt que définitif.** Sur 12 jours les deux bloquent exactement les mêmes 54 cas — aucun
ne revient au-delà de 48 h — donc c'est le « not reopened » d'EP en pratique. Mais il se purge
seul : un verrou à vie retirerait ~50 tokens par mois d'un univers qui n'en compte que ~40 au watch.
Réglable par **`MOU_LOCK_H`** sans redéploiement ; à 6 h on capte encore 89 % du bénéfice
(348 h de slot sur 390) avec un TRAIL de moins sacrifié.

| verrou | bloqués | slot libéré | SOL direct | TRAIL sacrifiés |
|---|---|---|---|---|
| 6 h | 45 | 348 h | +0,1021 | 13 |
| 12 h | 49 | 381 h | +0,0956 | 13 |
| **48 h** | **54** | **390 h** | **+0,0987** | **14** |
| définitif | 54 | 390 h | +0,0987 | 14 |

**Pourquoi ça vaut le coup — la capacité est le goulot** (cf. section 12) : ~25 candidats
pleinement qualifiés refusés par jour, et le plafond de 7 **n'est pas négociable** — à 8 positions
les 429 Helius reviennent (contrainte RPC, pas capitalistique). La seule façon d'augmenter le débit
est donc de raccourcir les positions improductives.

390 h sur 12 jours = **+19 % de capacité**, soit ≈ +0,86 SOL/mois, plus +0,25 en direct.

**Le coût :** 14 sorties TRAIL à +5,91 % qu'on n'aura pas sur ces tokens. Mais les candidats
refusés valent les retenus — plus-haut médian **+13,8 % en 6 h** contre **+10,3 %** réalisés sur
les trades pris — donc un slot rendu est un trade moyen gagné, pas un trade perdu.

**À surveiller :** la ligne `🔒 … sortie MOLLE (… min pour …% de LP) → verrouillé 48 h`.
Si le nombre de trades par jour chute nettement, baisser `MOU_LOCK_H` à 6.

---

## 14. 14/09 — Un chop NON MESURABLE ne passe plus (déployé)

**Le trou.** `chopOk = cr == null || cr >= 0.40` laissait entrer tout token dont le chop-rate est
**incalculable**. `chopRate` rend `null` faute de trois creux résolus (+8 % / −30 %) — ce qui
n'arrive jamais sur un gros établi qui bouge doucement, ses seuils étant calibrés pour des small
caps volatils. Le message d'entrée affichait « chop 0 % » (`(null * 100).toFixed(0)`), indiscernable
d'un vrai dumper. C'est désormais journalisé comme **`chop-NON-MESURABLE`**.

**Le profil de ces entrées**, mesuré sur 42 cas :

| | non mesurable | mesuré |
|---|---|---|
| LP moyen | **+1,43 %** | +3,98 % |
| durée médiane | **212 min** | 75 min |
| fee/TVL à l'entrée | 6,7 % | 17,7 % |
| MC à l'entrée | 10 616 K | 2 421 K |
| âge du token | 626 h | 151 h |

Leur LP moyen est **sous le coût d'un aller-retour** (0,0046 SOL ≈ 1,6 % de la position) : ces
trades perdent de l'argent en sortant gagnants.

**Contre-tests, tous positifs :** le portefeuille gardé s'améliore partout — global +3,98 vs +3,72 ·
1re moitié +4,83 vs +4,63 · hors échantillon +3,14 vs +2,81 · sans les 3 meilleurs bloqués
+3,98 vs +3,67. Sur la seconde moitié les bloqués sont carrément négatifs (−0,45 %).

**Ce qui a fait basculer la décision.** Le 14/09 au matin je l'avais écarté : son effet direct en SOL
(+0,198/mois) basculait à −0,151 sans un seul perdant évité. Mais c'était avant la section 12 — la
capacité est le goulot, ~25 candidats qualifiés refusés par jour, plafond de 7 non négociable
(429 Helius à 8). Les **579 h de slot** rendues valent ≈ **+1,3 SOL/mois**, ce qui domine largement
l'effet direct.

**Cas d'école, le jour même :** BTC entrée à 18:53 avec « chop 0 % », 348,9 h d'âge, MC 7,26 M,
taxe 3 %. Après 44 min : LP 0,00 %, pic 0,00 %, et **0,01 mSOL/h de fees** — il lui faudrait 460 h
pour payer son aller-retour, contre 3 h pour KNOTS. Cinq fois plus lente que ZCAT, le pire cas
mesuré jusque-là.

**Réversible sans redéploiement :** `CHOP_INCONNU_OK=1` rétablit l'ancien comportement.
**À surveiller :** le compteur `chop-NON-MESURABLE` dans `/status`, et le nombre d'entrées par jour.

## 15. 16/09 — STAGNATION : 6 h sans nouveau plus-haut (déployé)

**La porte qui manquait.** Rien n'arrêtait une position entre 0 % et −75 % de LP : le TRAIL exige
+6 % de pic, le RSI2 exige un signal qui ne vient pas toujours (Tulip est morte à −66,8 % sans
jamais en produire un, ni en 5 min ni en 15 min), et le CUT PLANCHER n'agit qu'à −75 %.

**La règle :** si le trail ne s'est **jamais armé** (pic LP < 6 %) et que le prix n'a pas fait de
nouveau plus-haut depuis 6 h sur les bougies 15 m → fermeture. Un nouveau plus-haut remet le
compteur à zéro. C'est la 3ᵉ porte d'EP (BOREDOM) exprimée en prix.

**Mesuré** sur 455 trades fermés rejoués sur bougies 15 m :

| | |
|---|---|
| perdants attrapés | **18 sur 27** → +0,73 SOL |
| gagnants coupés | 24 sur 288 → −0,22 SOL |
| pertes effacées | **41 %** |
| gains sacrifiés | **3,2 %** |
| rapport | **5 pour 1** · PnL +14 à +21 % |
| placebo apparié (400 tirages) | **0 tirage** ne fait aussi bien |

**La porte `!armed` fait tout le travail.** Les 18 perdants attrapés n'ont JAMAIS dépassé +6 % de
pic, et le plus gros gagnant touché fait +5,3 % de LP. Sans cette porte, la règle coupait aussi
6 gagnants armés à −16,7 % chacun (SOLCAT +12,1 %, TripleT +10,8 %). Au-dessus de +6 %, c'est le
TRAIL qui commande.

**Balayage du seuil** — plateau de 2 h à 6 h, effondrement après :

```
  2 h +0,5896 (84 décl.)   3 h +0,6397 (65)   4 h +0,5964 (56)   5 h +0,4648 (48)
  6 h +0,5088 (42)   7 h +0,2976   8 h +0,2020   10 h +0,0303 ← SOUS le meilleur tirage au hasard
```

Le creux à 5 h, sous ses deux voisins, donne le bruit : ±0,08 SOL. 4 h attrape 2 perdants de plus
en coupant 12 gagnants de plus — NET identique, surface d'erreur doublée. **6 h retenu.**
`STAGNATION_H` réglable sur Railway ; **ne jamais monter au-dessus de 6**.

### PIÈGE DE MÉTHODE — le contrefactuel doit être ancré sur le PIC

La première version de ce backtest annonçait **+1,52 SOL et 66,7 % des pertes effacées**. Faux.
Elle extrapolait à rebours depuis la SORTIE avec la pente prix→LP, sur des écarts de prix de 90 % :
elle fabriquait du LP qui n'a jamais existé — **fone annoncé à +19,6 % de LP alors que son
`peakGainPct` vaut +0,4 %**, soit au-dessus du maximum jamais atteint. Six trades sur dix-huit
dans ce cas. Corrigé en partant du pic (LP **mesuré**) et en n'extrapolant que sur la chute qui
suit : 66,7 % → **41 %**, PnL +39 % → **+21 %**. La conclusion tenait, le montant non.
`lvHist` ne sauve pas la mise : tampon glissant de 40 lectures ≈ 6 minutes avant la fermeture.

### TESTÉ ET REJETÉ le 16/09 — ne pas rouvrir

**Filtrer sur le MACD** (ne couper que ceux dont l'histogramme s'enfonce) : **13 des 18 perdants
ont un MACD qui REMONTE** au moment du signal. Sur un token effondré, l'histogramme remonte parce
que la chute décélère, pas parce que le prix repart. Filtrer trierait à l'envers — NET +0,0944
contre +0,5088. Cohérent avec l'AUC 0,46-0,53 du 14/09.

**Laisser 2 h de grâce aux « verts »** : coûte 0,166 SOL sur les perdants pour 0,042 récupéré sur
les gagnants. Dégradation **monotone** — 2 h +0,2899, 4 h +0,1108, 6 h +0,0844.

**« 3 sommets consécutifs plus bas »** (le « rebonds de plus en plus faibles » d'EP) fonctionne
aussi (NET +1,1315 en version non corrigée) mais **34 de ses 38 déclenchements sont les mêmes
trades** que la règle des 6 h. L'ajouter attrape les mêmes 18 perdants et touche 4 gagnants de
plus : A ou B donne +1,3817 contre +1,3953 pour A seule. Redondante, écartée.

## 16. 16/09 — Le 7ᵉ slot prend le reliquat (déployé)

**Problème.** Les pertes de la mi-septembre ont réduit le wallet : la 7ᵉ position n'était plus
finançable en taille pleine, et la règle « MISE PLEINE OU RIEN » du 05/09 laissait donc le slot
vide en permanence — alors que ~25 candidats qualifiés sont refusés chaque jour (cf. section 12).

**Changement.** Les 6 premières positions gardent la mise pleine ou rien. **Seule la dernière**
accepte ce qui reste (`dernierSlot` passé depuis `bonus-bot.js` : `liveOpenCount === MAX_LIVE_POSITIONS - 1`).

**Le plancher est mesuré, pas choisi.** Sur 455 trades, LP moyen 3,39 %, aller-retour 0,0046 SOL :

```
  0,10 SOL → -1,21 mSOL (50 % de trades rentables)      0,15 SOL → +0,48 mSOL (60 %)
  0,12 SOL → -0,53 mSOL (55 %)                          0,28 SOL → +4,89 mSOL (70 %)
  seuil de rentabilité : 0,1357 SOL
```

`MIN_POSITION_SOL` par défaut **0,13**, réglable sur Railway. En dessous, le slot vide vaut mieux
qu'une position qui perd en moyenne. Log à surveiller : `🔻 DERNIER SLOT: mise réduite à …`.

## 17. 16/09 — BUG CORRIGÉ : l'ombre « objectif de prix » cassait le scan (221 fois)

**Ce que j'ai cassé le 14/09.** L'ombre `🎯 [OMBRE]` (section 10, commit `b62b08c`) a été insérée
dans la boucle de scan **avant** la déclaration `let realGain` qui se trouve ~20 lignes plus bas.
Lire `realGain` en zone morte temporelle lève :

```
⚠️ scan tick (survécu): ReferenceError: Cannot access 'realGain' before initialization
    at scan (/app/bonus-bot.js:1579:44)
```

**Le garde-fou du scan attrape l'exception et ABANDONNE LE TICK ENTIER.** Donc à chaque
déclenchement, aucune position n'était évaluée ce tour-là — trail des positions armées compris.

**Mesuré dans les logs persistés : 221 occurrences entre le 14/09 13:57 et le 16/09 19:24.**
La condition étant `gain >= 0.15`, ça ne cassait que quand une position dépassait **+15 % de prix** —
exactement les moments où le trail compte le plus. C'est aussi ce qui explique l'intermittence :
invisible tant qu'aucune position ne montait fort.

**Correction :** le bloc est descendu juste après `pos.peakGain = Math.max(…, realGain)`, où `gain`
et `realGain` ont tous deux leur valeur définitive. `px` était déjà déclaré (ligne 1563), il n'était
pas en cause.

**Leçon de méthode :** toute ombre ajoutée dans la boucle de scan doit être placée APRÈS les
variables qu'elle lit, et son ajout doit être **vérifié dans les logs pendant 24 h**. Celle-ci a
tourné deux jours en cassant un tick sur N sans que personne ne regarde `grep -i error`.

## 18. 16/09 — TRANCHÉ : on n'améliore pas la coupe 6 h en attrapant un rebond

Une **soixantaine de variantes** testées le 16/09 pour tenter de sortir sur un petit rebond local
plutôt qu'à sec. **Aucune ne survit à son contrôle.** Ne pas rouvrir.

**Famille A — attendre un rebond APRÈS le seuil des 6 h.** Toutes perdantes, sans exception, quel
que soit le déclencheur (RSI2 50/60/70/80, bougie verte, clôture > précédente, 2 vertes, EMA9,
+3 %/+5 % sur le creux local) et quelle que soit la laisse (30 min, 1 h, 2 h). La meilleure fait
−0,08 SOL contre la coupe sèche. **Attendre après le signal perd toujours** — cohérent avec le test
MACD (2 h de grâce = −0,166 sur les perdants pour +0,042 sur les gagnants, dégradation monotone).

**Famille B — déclencher dans une fenêtre 4-6 h, coupe dure à 6 h.** Semble gagner (+0,12 à +0,13
contre la coupe à 6 h) mais c'est un **piège de population** : la famille fait feu 55 fois au lieu
de 42 parce qu'elle déclenche dès 4 h. Contre la vraie référence — **coupe sèche à 4 h, +0,6023** —
il ne reste que +0,0379 pour l'EMA9 et +0,0308 pour le RSI2>70, soit sous le bruit (±0,08).

**Le contrôle qui tranche : mélanger la série du signal.**

| contrôle | résultat |
|---|---|
| EMA9 mélangée au hasard | médiane **0,6075** vs 0,6402 pour la vraie · **27 tirages sur 200 la battent** (p = 0,14) |
| RSI2 mélangé | max 0,7792 vs 0,7810 pour la vraie · à égalité |

**Ce qui bouge le chiffre est le SEUIL, pas le signal.** Monotonie, tous déclencheurs confondus :
dès 2 h +0,7455 · dès 3 h +0,7706 · dès 4 h +0,6402 · dès 5 h +0,5416. Plus tôt = mieux,
indépendamment de ce qu'on teste — donc le « signal » ne fait que déplacer la date.

**Autres pistes closes le même jour :**
- **Plus-haut glissant** (8 h à 48 h) au lieu du plus-haut depuis l'entrée : **résultats identiques
  au centième**. C'est mathématique — au moment où le compteur atteint 6 h, le plus-haut depuis
  l'entrée EST le plus-haut des 6 dernières heures. Les deux ne divergeraient qu'après la fermeture.
- **Filtre MACD** : trie à l'envers (cf. section 15).
- **« 3 sommets consécutifs plus bas »** : redondante à 34/38 (cf. section 15).

### Le cas KNOTS (16/09) — effet de rattrapage, pas un défaut

Le bot a journalisé `STAGNATION 23.0h` sur KNOTS et `20.8h` sur TripleT alors qu'en régime normal
il doit **toujours** écrire ~6,0 h. Ces deux positions stagnaient déjà depuis deux jours quand la
règle est arrivée : elles ont été rattrapées au redémarrage. Vérifié sur bougies fraîches — le
plus-haut de KNOTS datait du 14/09 21:45, soit **46 h** avant la fermeture, et le prix était encore
**22,5 % en dessous**. La règle aurait dû fermer le 15/09 à 03:45, quarante heures avant le rebond.

**CONTRÔLE À FAIRE : les prochaines lignes `STAGNATION` doivent afficher ~6,0 h.** Au-delà, il y a
un vrai problème.

### La seule mesure qui vaudra quelque chose

Arrêter de chercher dans le backtest — 18 perdants, on ne fait plus que sélectionner du bruit.
À la place : pour chaque sortie `STAGNATION` réelle, regarder **ce que le prix a fait dans les 6 à
24 h suivantes**. Si les tokens coupés remontent, la règle a tort. Dix déclenchements suffisent.

## 19. 16/09 — FILTRE DE CHUTE sur la sortie STAGNATION (déployé)

**Ce que la règle nue faisait de mal.** Sur les 51 trades qui dépassent 6 h (30 gagnants,
21 perdants — noter au passage que **81 % des perdants dépassent 6 h contre 19 % des gagnants** :
un trade qui vit plus de 6 h est 3 fois plus souvent perdant), elle coupait **24 des 30 gagnants**
pour 18 des 21 perdants. Et sur le **premier tiers de l'historique**, période calme, elle
n'attrapait **aucun perdant** et coupait 11 gagnants : elle ne faisait que coûter.

**Ce qui sépare.** Mesure du pouvoir discriminant au moment du signal, 18 perdants contre
24 gagnants coupés :

| variable | AUC | perdants | gagnants |
|---|---|---|---|
| **chute sous le plus-haut** | **0,155** | **−32,9 %** | **−13,8 %** |
| pente des 6 dernières h | 0,213 | −25,8 % | −11,7 % |
| volatilité ATR14 | 0,764 | 8,7 % | 4,6 % |
| MC à l'entrée | 0,257 | 5,9 M | 21,2 M |
| pic LP atteint | 0,391 | 1,0 % | 2,0 % |
| bougies rouges sur 24 | 0,563 | 14 | 14 |
| âge de la position | 0,503 | 6,8 h | 6,8 h |

**Le gagnant coupé à tort n'est pas tombé.** Mécanisme clair, pas un artefact de calendrier.

**La règle :** ne fermer que si `realGain <= -STAGNATION_LP` (défaut **0,13**, réglable, 0 désactive).

**Exprimé en LP, pas en chute de prix, et c'est important :** les deux sont mathématiquement
équivalents (chute −20 % ≡ LP −14,2 %, pente 0,710) et donnent le même résultat (0,5598 contre
0,5612), mais `realGain` est **lu en direct sur la chaîne**. Aucune dépendance aux bougies, dont on
a vu le 16/09 qu'elles peuvent raccourcir sans prévenir quand les clés Birdeye s'épuisent.

**Effet mesuré :**

```
                         SANS filtre          AVEC filtre
  perdants touchés     18/21  +0,7387       17/21  +0,7037
  gagnants touchés     24/30  -0,2237       10/30  -0,1439
  plus gros gagnant touché   +5,3 % de LP          +2,9 % de LP
  NET                        0,5150                0,5598
```

Le NET ne gagne que +0,045, sous le bruit — **on l'achète pour la réduction de surface**, pas pour
la performance. Et le filtre est positif ou neutre sur **7 découpes sur 8** (période, régime de
marché, established, durée ; seule exception durée ≥ 12 h à −0,027). Il corrige exactement la
faiblesse de la règle : jours haussiers 15 gagnants coupés → 6, premier tiers 11 → 5.

### CONTRE-HYPOTHÈSES TESTÉES

**« Déclencher moins souvent suffit, peu importe lesquels. »** Tirage au hasard de 27 déclenchements
parmi les 42 de la règle nue, **2000 tirages** : médiane 0,3365, 90e centile 0,4976, max 0,7059.
**76 tirages sur 2000 font aussi bien → p = 0,038.** Le filtre choisit bien. (C'est le contrôle qui
avait tué le RSI et l'EMA9 en section 18.)

**« 20 % est un point de chance. »** Plateau large : −10 % 0,5414 · −12 % 0,5432 · −15 % 0,5318 ·
−18 % 0,5253 · **−20 % 0,5598** · −22 % 0,5458 · −25 % 0,5114 · −30 % 0,4464.

**Réserve honnête :** p = 0,038 passe mais n'écrase rien, et la première moitié chronologique de la
règle reste faible. Ce qui emporte la décision est la combinaison : mécanisme évident + plateau
large + surface d'erreur réduite de 40 %.

## 20. 17/09 — La vélocité de frais devient persistante (déployé)

**Le manque.** `_feeVel` était calculé et affiché dans la ligne `📊` depuis le 14/09, mais
**jamais enregistré**. Il n'existait que dans le tampon de logs, effacé à chaque déploiement.
Le seul champ de frais dans un trade est `feeTvl`, une métrique de **pool à l'entrée** — pas la
productivité de la position. Conséquence : aucune règle de frais n'était backtestable.

**Le cas qui l'a montré** (17/09) — deux fermetures STAGNATION à des LP voisins :

```
  wifout    LP -17,4 %   23,05 mSOL de frais   3,45 mSOL/h   paie son aller-retour en  1 h
  TripleT   LP -28,3 %    8,43 mSOL            0,09 mSOL/h   paie son aller-retour en 49 h
```

Le bot ne faisait **aucune différence entre les deux**, et l'information disparaissait à la
fermeture. Or c'est exactement la distinction que fait la porte BOREDOM d'EP : *« a position that
is not earning its keep in fees »*.

**Ce qui est déployé.** Trois choses :

1. **Une série écrite à chaque scan** — `pos._feeHist`, échantillonnée toutes les 10 min (le scan
   tourne toutes les 10 s), plafonnée à 200 points ≈ 33 h. Elle survit aux redéploiements :
   `save()` sérialise l'état entier sans filtre, et la ligne de nettoyage au démarrage (383) ne
   touche pas `_feeHist`.
2. **`_feeVel1h`** — la vélocité sur la **dernière heure glissante**, affichée dans la ligne `📊`
   à côté de la moyenne. C'est elle qui répond à « gagne-t-elle ENCORE sa vie ? » : une position
   qui a bien payé six heures puis s'est éteinte garde une belle moyenne alors qu'elle est morte.
3. **Quatre champs persistés dans le trade** : `feesSol`, `feeVel` (vie entière), `feeVel1h`,
   `feeHours` (heures pour rembourser un aller-retour de 0,0046 SOL).

**Le chiffre est fiable** : le bot ne réclame les frais qu'à la fermeture (`shouldClaimAndClose`),
donc `_fees` est bien le total de la vie de la position et non un solde partiel.

### Première mesure, à confirmer — NE PAS en faire une règle pour l'instant

Extraction manuelle des logs, **21 fermetures** avec une lecture de vélocité :

| | n | vélocité médiane | frais médians |
|---|---|---|---|
| gagnants | 9 | **3,17 mSOL/h** | 26,81 mSOL |
| perdants | 12 | **1,73 mSOL/h** | 16,71 mSOL |

**AUC 0,759** — de loin la variable la plus discriminante mesurée jusqu'ici (MACD et EMA : 0,46-0,53).
Par tranche : sous 0,5 mSOL/h, 100 % de perdants ; au-dessus de 3 mSOL/h, 17 %.

**Deux réserves qui interdisent d'agir.** n = 21. Et surtout un **risque de causalité inversée** :
un gagnant sort en TRAIL après un mouvement qui génère beaucoup de frais, un perdant reste assis
pendant que les siens s'éteignent — la vélocité pourrait être la **conséquence** de l'issue plutôt
que son prédicteur. Il faut 100+ trades avec les champs persistés pour trancher.

**Rappel d'une conclusion du 14/09 qui reste valable** : « hors range par le bas » **est** la
vélocité de frais nulle (100 % token, plus aucun frais encaissé), et c'est un test **exact** que le
bot fait déjà — un seuil sur la vélocité n'en est qu'un proxy bruité.

### Question ouverte posée par le user le 17/09

Faut-il **épargner de la sortie STAGNATION les positions qui paient bien** ? Trois des cinq
premières fermetures STAGNATION portaient sur des positions remboursant leur aller-retour en 1 à
3 h (wifout 3,45 mSOL/h était dans le décile haut de la journée). À rejuger quand les champs
persistés auront produit 30 à 40 déclenchements.

### Complément du 18/09 — la liquidité de la pool est enregistrée elle aussi

**La piste** (user, 18/09) : les gens ont-ils retiré leur liquidité avant que ça tourne mal ?
Mesure sur les 5 premières fermetures STAGNATION, liquidité **actuelle** DexScreener :

```
  token      LP coupe   feeTvl entrée │ liquidité    vol 24 h    vol/TVL   issue
  ELON        -33,9 %      26,4 %     │   203 793   7 051 916     34,6    a CONTINUÉ à chuter (-12 % à 6 h)
  ALLINU      -13,1 %      18,9 %     │   553 624   2 100 870      3,8    est REPARTI (+26 % à 6 h)
  wifout      -17,4 %      23,2 %     │   154 365   2 768 565     17,9    trop récent
  KNOTS        +0,7 %      14,4 %     │ 1 086 998   1 195 900      1,1    trop récent
  TripleT     -28,3 %       6,5 %     │   536 842     353 745      0,7    plus de bougies (token mort)
```

Ce n'est pas « la liquidité a fui », c'est plus précis : **ELON brassait 34 fois sa propre liquidité
en 24 h dans une pool de 200 k$**. Et c'est ce qui explique pourquoi la vélocité de frais ne séparait
pas ALLINU (1,68 mSOL/h, reparti) d'ELON (1,84 mSOL/h, effondré) : ELON générait bien des frais,
mais par un **churn violent dans une pool trop mince**.

**Aucun historique de TVL n'existe** — ni chez nous, ni chez DexScreener, ni chez GeckoTerminal, qui
ne donnent que la liquidité courante. D'où l'ajout : `tvlEntry` / `vol24hEntry` posés à l'ouverture
depuis `w.metPools` (donnée déjà en mémoire, coût nul), `tvlExit` / `vol24hExit` lus à la fermeture
par **un** appel `dexInfo`, plus les dérivés `tvlVarPct`, `volTvlEntry`, `volTvlExit`.

**Zéro appel Helius ajouté** : DexScreener est une API HTTP publique, sans rapport avec le RPC Solana.
Le seul coût est un appel DexScreener par fermeture, ~15/jour, et il est **non bloquant** (try/catch) —
une mesure ne doit jamais pouvoir faire échouer une fermeture.

### Contrainte de méthode découverte le 18/09

**GeckoTerminal ne renvoie que 200 bougies de 15 min, soit 50 h.** Le trajet du prix APRÈS une coupe
n'est donc reconstituable que pendant deux jours. Cette mesure doit être relancée tous les 2-3 jours,
pas en fin de mois. Premier relevé : ALLINU +26 % à 6 h (coupé trop tôt), ELON −12 % à 6 h (coupe
justifiée) — un partout sur deux cas exploitables.

### Complément du 18/09 (2) — la liquidité est échantillonnée EN COURS DE VIE

Deux points (entrée/sortie) ne suffisaient pas : une TVL qui s'effondre au milieu de la vie de la
position puis remonte restait invisible, alors que c'est le moment intéressant — les LP qui retirent
avant ou pendant un dump.

**Échantillonnage toutes les 10 min par position ouverte**, stocké dans `pos._tvlHist` (200 points,
~33 h, survit aux redéploiements). Dérivés : `pos._tvl`, `pos._volTvl`, et surtout **`_tvlVar1h`**,
la variation de liquidité sur l'heure glissante. Persistés à la fermeture : `tvlMin`, `tvlMax`,
`volTvlMax`, `tvlPoints`.

**Le point d'implémentation qui compte : l'appel est en `fire-and-forget` DÉLIBÉRÉ.** Pas de `await`,
et `.catch()` qui avale l'échec. La boucle de scan évalue le trail des positions armées — elle ne
doit jamais attendre un appel HTTP. `dexInfo` a un `timeout: 10000`, donc aucune promesse ne
s'accumule.

**Coût : 7 positions × 6/h = 42 appels DexScreener par heure**, sur un plafond de 300 **par minute**
— soit 0,7 % du quota. **Zéro appel Helius** : DexScreener n'a rien à voir avec le RPC Solana, c'est
une API HTTP publique que le bot interroge déjà à chaque découverte.

La ligne `📊` affiche désormais `💧203k v/t34.6 1h-12%` à côté de `💰`.

## 21. 18/09 — POINT SUR LES OMBRES : trois questions tranchées par les données réelles

### ⚠️ LA LEÇON QUI COMPTE PLUS QUE LES TROIS OMBRES

**Trois backtests appuyés sur la fonction de transfert prix→LP ont été démentis par les données
réelles, tous dans le MÊME sens : le modèle surévalue systématiquement les sorties précoces.**

| question | ce que disait le backtest | ce que disent les données réelles |
|---|---|---|
| plancher RSI2 à −20 % | **+0,2740 SOL** (03/09) | **−0,3568 SOL** sur 117 trades |
| objectif de prix +15 % | **+90 pt de LP** (14/09) | **−79,9 pt** sur 23 comparaisons |
| objectif de prix +25 % | **+67 pt de LP** (14/09) | **−15,9 pt** sur 12 comparaisons |
| contrefactuel STAGNATION | +1,52 SOL (1re version) | +0,93 SOL après ancrage sur le pic |

**Règle à appliquer désormais :** tout backtest qui recommande de **sortir plus tôt** et qui repose
sur une conversion prix→LP doit être considéré comme **faux jusqu'à preuve par ombre réelle**. La
raison est structurelle : la fonction ignore les frais encaissés pendant l'attente, et 16,2 % des
trades ont prix↓ avec LP↑ (cf. section transfert). Le coût de cette erreur a été trois déploiements
évités de justesse, et une journée entière de tests le 16/09.

### 1. Plancher RSI2 — TRANCHÉ, il reste à 0

117 trades où le plancher a refusé une sortie RSI2 (`rsiFloorLp` contre `lpPct`, deux vraies valeurs,
aucun modèle) :

```
  sortir au signal aurait été MEILLEUR :  18  (15 %)
  sortir au signal aurait été PIRE     :  99  (85 %)
  LP médian au signal -3,43 %  ·  LP médian réel +0,85 %  ·  bilan -0,3568 SOL
```

L'arbitrage en clair : les 8 plus gros écarts en faveur du signal (PURPS +45 pt, OTC +41,7, EMBER
+36,9…) valent ~+0,81 SOL sur les catastrophes, mais les 99 cas ordinaires coûtent ~−1,17 SOL.
**Garder la position gagne de 0,36 SOL.** Le revert du 29/08 après BULLSHIT avait raison.

### 2. Objectif de prix (ombre 🎯) — TRANCHÉ, le trail gagne

```
  objectif +15 %   23 cas   l'objectif gagne 5 fois (22 %)   somme -79,9 pt
  objectif +25 %   12 cas   l'objectif gagne 5 fois (42 %)   somme -15,9 pt
```

Pires cas : wifout objectif 2,2 % contre réel 17,1 % (**le trail gagne 14,9 pt**), biketyson 5,5 %
contre 15,1 % (+9,6 pt). Le trail laisse courir, et c'est ce qu'il faut. **Ombre à retirer.**
Note : elle n'a produit de données qu'après le 16/09 21:30 — le bug de zone morte (section 17) l'a
rendue muette du 14 au 16/09, en plus de casser un tick de scan sur N.

### 3. Âge de l'ATH à l'entrée — TRANCHÉ sur 1 029 trades, aucun pouvoir prédictif

```
  <2h    n=126   77 % de gagnants   +4,4 %
  2-5h   n=129   74 %               +4,3 %
  5-12h  n=165   76 %               +6,6 %
  >12h   n=609   77 %               +4,4 %
```

Plat. **Et ça RÉFUTE la note du 24/08** qui donnait « ATH frais <3 h = meilleur cohort (+7,7 %),
stale >10 h = net −42 % (vrai levier) » : sur 609 trades, les stale >12 h font +4,4 % avec 77 % de
gagnants. L'ancienne conclusion venait d'un échantillon trop petit. Question fermée.

### Ombres encore en collecte (non jugeables)

`clusters` 4023 · `atrEntry` 6346 · `downtrend` 4362 · `rebondRSI80` 1236 · `profil` 1078 ·
`dip25` 999 · `feesSeuil` 476 · `patternKO` 338 · `athEpuise` 193 (validé le 02/09, ne pas lever).

### Confirmés par le volume, rien à faire

**downtrend vs range** (951 trades) : downtrend 79 % de gagnants et +6,6 % contre range 76 % et
+4,5 %. Le downtrend est MEILLEUR — ne jamais le gater, c'est définitif.
**Taille** : petits MC 78 % / +5,5 % contre gros MC≥3M 76 % / +4,2 %. Écart faible.
**Stacking par profondeur de dip** : gradient monotone spectaculaire (97 % → 80 % → 37 % → 13 % de
gagnants) mais **circulaire** — une position qui a plongé de 30 % finit mal par construction. Aucune
valeur prédictive à l'entrée.

## 22. 18/09 — OMBRE « force du dernier rebond » (n'agit pas)

**Origine.** Observation du user en regardant le graphe de HUHCAT : *« les rebonds sont de moins en
moins forts, le token est mort »*.

**Mesuré sur 741 trades** ayant 24 h d'historique avant l'entrée. On prend les 3 derniers sommets
locaux, on mesure l'amplitude creux→sommet des 2 derniers rebonds, et on regarde leur ratio :

```
  ratio du dernier rebond      n     SOL/trade   gagnants
    moins de 50 %            160      0,00355      43 %
    50 à 80 %                141      0,00338      49 %
    ──────────────────────────────────────────────────── marche à 80 %
    80 à 100 %                72      0,00692      61 %
    100 à 150 %              123      0,00644      58 %
    plus de 150 %            245      0,00665      59 %
```

**C'est une MARCHE à 80 %, pas une pente** — d'où une AUC faible (0,524) alors que l'effet est net :
le ratio ne classe pas les trades, il les sépare en deux paquets. Contrôles passés : positif sur les
**deux** moitiés chronologiques (+0,00116 et +0,00287) et survit au retrait des 3 meilleurs (0,00616
contre 0,00414). C'est le premier filtre d'entrée de la semaine à passer la batterie.

**Ce que ça n'est PAS — mesure du 18/09 qui a coûté un test et vaut d'être retenue :**

```
  dernier rebond < 80 %    1931 obs   573 dumps à -20 % dans les 6 h   29,7 %
  dernier rebond ≥ 80 %    2694 obs   778 dumps                         28,9 %
```

**Un rebond faible n'annonce AUCUN dump** (rapport 1,03). Et le chiffre de fond est le plus important
de la semaine : **à tout instant d'une position, il y a ~29 % de chance d'un dump de -20 % dans les
6 heures**, quel que soit l'état du prix. C'est ce qui explique que rien ne prédise — ni les entrées
(dump depth 0,44-0,58, MACD 0,46-0,53, âge ATH plat sur 1 029 trades), ni les sorties (70 variantes
testées le 16/09, toutes rejetées). Les dumps ne sont pas annoncés.

**Et ça explique pourquoi le TRAIL est ce qui marche** (+4,90 SOL, 117 % du PnL) : il ne prédit rien,
il constate un pic et réagit quand ça retombe d'un point, à 72 % de la hauteur de bougie. Quand le
futur n'est pas prévisible, la bonne architecture est de réagir vite, pas d'anticiper. Chaque ajout
d'anticipation a coûté — plancher RSI2, objectif de prix, SuperTrend en sortie, STAGNATION.

**Déployé en OMBRE UNIQUEMENT** (`🔇` / `🔊 [OMBRE rebond]`), champ `rebondRatio` persisté dans le
trade. Ne bloque rien. À juger vers le 02/10 en comparant les deux populations sur issues réelles.

## 23. 18-19/09 — LE PnL AFFICHÉ N'EST PAS LE PnL DU WALLET

**Le user : « je ne vois pas mon solde monter ».** Il avait raison.

```
  pnlSolLive = closeValueSol − openValueSol        (bonus-bot.js, close)
```

C'est la variation de valeur **interne à la position LP**. Les swaps d'entrée et de sortie, la taxe
de transfert et le slippage se produisent **entre le wallet et la position** — hors mesure. Le
commentaire du code l'assume : *« insensible au bruit wallet »*. Ce bruit, c'est l'argent du user.

**Mesure à la main du 18/09**, méthode fiable (liquide + positions au COÛT + rent, même nombre de
positions) :

```
  13/09  :  2,7655 SOL
  18/09  :  2,4515 SOL     →  -0,314 SOL en 6 jours
  pendant que le bot annonçait  +1,07 SOL sur la même période
```

**Écart ≈ 1,39 SOL sur ~190 trades, soit ~0,007 SOL de coûts invisibles par trade** — contre
+0,0056 SOL de gain affiché par trade. **À 17 trades/jour, les frais d'exécution mangent tout l'edge.**

**Le per-trade est inutilisable** : `proceedsSol` et `depositedSol` sont mesurés autour d'un
événement, donc pollués par les 6 autres positions (±0,14 à 0,20 SOL constatés le 11/09, soit la
taille d'une ouverture). Un **total à date** y est insensible.

**Déployé : instantané horaire du wallet** dans `state.walletHist` (720 points = 30 jours), ligne
`🏦 WALLET:` dans les logs avec l'écart depuis le premier point. `solBalance` exporté depuis
`bonus-live.js`. Coût : 1 appel RPC par heure.

### Ce que ça change sur la stratégie — et ça réconcilie tout

Avec ~0,007 SOL de coût réel par trade :

```
  tout prendre (actuel)          0,00563 − 0,007  ≈  -0,0014/trade   NÉGATIF
  whitelist « 3 trades +0,05 »   0,00731 − 0,007  ≈  +0,0003/trade   à l'équilibre
```

**Trader moins, sur des tokens prouvés, devient la seule voie rentable.** Et c'est exactement ce
qu'EP décrit : *« manual whitelist curation IS the alpha »*, ses 10 meilleurs tokens = 73 % de son
profit. Mesuré en marche avant sur 870 trades :

| règle d'admission | trades | SOL/trade | gagnants | catastrophes |
|---|---|---|---|---|
| tout prendre (actuel) | 870 | 0,00563 | 57 % | 3,1 % |
| 1 trade passé positif | 668 | 0,00590 | 58 % | 2,8 % |
| 2 trades + 0,02 SOL | 438 | 0,00638 | 69 % | 3,7 % |
| **3 trades + 0,05 SOL** | **303** | **0,00731** | **79 %** | 3,6 % |

Le volume tombe à ~5 trades/jour pour 7 places : la whitelist ne remplit pas le book. C'est le
compromis à trancher quand l'instantané wallet aura confirmé le coût réel.

**Note :** bannir les mauvais tokens ÉCHOUE (-0,85 SOL, la catastrophe arrive en premier et le token
redevient bon ensuite). Ne garder que les **prouvés** est l'opération inverse, et elle marche.

**Déployé en OMBRE** : `🏅 [OMBRE whitelist]`, champ `tokenProuve` = `{ n, sol, prouve }` persisté.
