# Archive : capture directe sur une TV LG (abandonnée)

**EN** — First approach of this project, before Couchcast: capture the HDMI input of a *rooted* LG webOS TV (PicCap / hyperion-webos) and stream it. Abandoned: it requires rooting the TV, the 100 Mbit/s Ethernet port can't carry raw frames, there is no audio capture API, and most models top out at 1080p30. Kept for reference only: not maintained, not built.

**FR** — Première piste du projet, avant Couchcast : capturer l'entrée HDMI d'une TV LG webOS *rootée* (PicCap / hyperion-webos) et la diffuser. Abandonnée : elle demande de rooter la TV, le port Ethernet à 100 Mbit/s ne fait pas passer les images brutes, aucune API ne permet de capturer le son, et la plupart des modèles plafonnent à 1080p30. Gardée pour référence : ni maintenue, ni compilée.

- `FEASIBILITY.md` : étude de faisabilité (FR).
- `receiver/` : récepteur Node.js qui se fait passer pour un serveur Hyperion pour recevoir les images brutes de PicCap.
