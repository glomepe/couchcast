# Couchcast

**Regardez, clippez, enregistrez et diffusez en live votre PS5 depuis n'importe quel navigateur de la maison : sans boîtier de capture et sans modifier la console.**

[English version](README.md)

> [!WARNING]
> **Ce projet a été « vibe codé ».** Il a été écrit en quelques sessions avec un assistant IA et testé sur une seule configuration (Mac Apple Silicon + PS5 en Wi-Fi). Il n'a pas de vraie suite de tests automatisés. Il fonctionne sur cette configuration, peut-être pas sur la vôtre. Lisez le code avant de lui faire confiance et attendez-vous à quelques angles morts.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Fonctionnement](#fonctionnement)
- [Téléchargement](#téléchargement)
- [Prérequis](#prérequis)
- [Compiler depuis les sources](#compiler-depuis-les-sources)
- [Premier lancement : l'appairage](#premier-lancement--lappairage)
- [Raccourcis clavier](#raccourcis-clavier)
- [Réduire la latence](#réduire-la-latence)
- [Sécurité et vie privée](#sécurité-et-vie-privée)
- [Limites connues](#limites-connues)
- [Remerciements](#remerciements)
- [Licence et marques](#licence-et-marques)

Couchcast parle le protocole **Remote Play** de la PS5 (via la bibliothèque de [chiaki-ng](https://github.com/streetpea/chiaki-ng)). Il transmet la vidéo H.264 et le son Opus de la console **tels quels** en WebRTC, sans réencodage : la latence ajoutée est de quelques millisecondes et le Mac ne travaille presque pas.

## Fonctionnalités

- **Lecteur basse latence.** 1080p60 dans n'importe quel navigateur Chromium ou dans l'app de bureau, avec environ 2 ms de tampon navigateur en plus du ping réseau.
- **Replay et clips.** Les dernières minutes restent en mémoire. <kbd>C</kbd> (ou <kbd>⌃⌥C</kbd> depuis n'importe où) sauvegarde les 30 dernières secondes ; des clips de 15 s à 5 min sont possibles.
- **Enregistrement sans perte** : le flux de la PS5 est copié tel quel sur le disque.
- **Exports verticaux 9:16** pour TikTok, Reels et Shorts : *fond flou* ou *recadré* (position réglable), encodés par VideoToolbox.
- **Live** vers Twitch, YouTube, TikTok LIVE ou tout serveur RTMP, en horizontal ou en vertical, vers plusieurs destinations à la fois.
- **Bibliothèque** avec miniatures, lecture, téléchargement, export vertical et ouverture dans le Finder.
- **Télécommande sur téléphone** : démarrer la session, enregistrer et clipper sans quitter la TV des yeux.
- **Source OBS** : une adresse « propre » (image + son, sans interface) à ajouter comme source navigateur.
- **App de bureau macOS et Windows** : icône dans la barre des menus ou des tâches, raccourcis globaux, notifications, anti-veille.
- Interface **français / anglais**, au choix dans l'app.

## Fonctionnement

```
PS5 ──Remote Play (H.264 + Opus)──► couchcast-bridge (C, lib chiaki-ng)
                                         │ tube binaire
                                         ▼
                              couchcast-server (Go, Pion WebRTC) ──WebRTC──► navigateur / app
                                         │
                                         ├─ mémoire de replay (RAM) ─► clips (MP4, remux ffmpeg)
                                         ├─ enregistreur ─► Matroska ─► MP4
                                         └─ sorties live ─► ffmpeg (VideoToolbox) ─► RTMP
```

| Chemin | Rôle |
|---|---|
| `gateway/bridge/` | Programme C : découverte, réveil, appairage et flux, avec chiaki-ng (compilé depuis les sources, patché pour le mode spectateur). |
| `gateway/server/` | Serveur Go : API HTTP, WebRTC (Pion), mémoire de replay, écriture Matroska, traitements ffmpeg, lives, récupération de l'identifiant PSN. |
| `gateway/web/` | Interface React (Vite) : lecteur, réglages, bibliothèque, télécommande, assistant d'appairage. |
| `desktop/` | Coque Electron : lance le serveur, barre des menus, raccourcis globaux. |

## Téléchargement

Récupérez la dernière version sur la **[page des Releases](https://github.com/glomepe/couchcast/releases/latest)** :

| Système | Fichier |
|---|---|
| macOS (Apple Silicon, M1 et suivants) | [`Couchcast-mac-arm64.dmg`](https://github.com/glomepe/couchcast/releases/latest/download/Couchcast-mac-arm64.dmg) |
| Windows 10/11 (x64) | [`Couchcast-win-x64.exe`](https://github.com/glomepe/couchcast/releases/latest/download/Couchcast-win-x64.exe) (installateur) ou [`.zip`](https://github.com/glomepe/couchcast/releases/latest/download/Couchcast-win-x64.zip) (portable) |

ffmpeg et toutes les bibliothèques sont inclus. Il n'y a rien d'autre à installer.

### Ouvrir l'app la première fois

L'app **n'est pas signée** par Apple ni par Microsoft (ces certificats sont payants), donc le système vous avertit la première fois :

- **macOS.** Ouvrez le `.dmg` et glissez *Couchcast* dans *Applications*. Lancez-la une fois : macOS refuse. Allez alors dans **Réglages Système › Confidentialité et sécurité**, descendez jusqu'au message concernant Couchcast et cliquez sur **Ouvrir quand même**. Si macOS affirme que l'app « est endommagée », lancez une fois dans le Terminal :
  ```sh
  xattr -dr com.apple.quarantine /Applications/Couchcast.app
  ```
- **Windows.** Si SmartScreen affiche « Windows a protégé votre ordinateur », cliquez sur **Informations complémentaires › Exécuter quand même**. Autorisez Couchcast sur les **réseaux privés** quand le pare-feu le demande : c'est ce qui permet à la PS5, au téléphone et à OBS de le joindre.

## Prérequis

- **macOS sur Apple Silicon** ou **Windows 10/11 x64**. L'usage et les tests se font sur macOS ; la version Windows est compilée par la CI mais a encore très peu servi en conditions réelles.
- Une **PS5** avec la lecture à distance activée (*Paramètres › Système › Lecture à distance*).
- Un **second compte PSN**, connecté sur la PS5 (voir plus bas).
- Pour les exports verticaux et les lives réencodés, Couchcast utilise l'encodeur matériel disponible : VideoToolbox sur Mac ; NVENC, Quick Sync ou AMF sous Windows. À défaut, il se rabat sur x264, sur le processeur.

## Compiler depuis les sources

**macOS** : il faut [Homebrew](https://brew.sh), Node.js 22+ et les outils en ligne de commande Xcode.

```sh
git clone https://github.com/glomepe/couchcast && cd couchcast
desktop/build-app.sh --install    # compile tout et copie Couchcast.app dans /Applications
```

**Windows** : il faut [MSYS2](https://www.msys2.org), [Go](https://go.dev/dl/) et [Node.js 22+](https://nodejs.org). Dans un terminal **MSYS2 UCRT64** lancé avec le PATH de Windows (`MSYS2_PATH_TYPE=inherit`) :

```sh
git clone https://github.com/glomepe/couchcast && cd couchcast
gateway/build.sh && cd desktop && npm ci && ./package.sh    # installateur dans desktop/dist/
```

**Serveur seul** (sans l'app de bureau, avec n'importe quel navigateur) : `cd gateway && ./build.sh && ./run.sh`, puis `http://<ip-de-l-ordinateur>:8765/`. ffmpeg doit alors être installé et dans le PATH (`brew install ffmpeg` / `winget install ffmpeg`).

Les versions téléchargeables sont produites par le workflow [Build & release](.github/workflows/release.yml) : poussez un tag `v*`, ou lancez-le à la main depuis l'onglet *Actions*.

## Premier lancement : l'appairage

1. **Utilisez un second compte PSN.** La PS5 coupe une session Remote Play dès qu'une manette connectée au *même compte* se réveille sur la console. Pour continuer à jouer sur la TV pendant la diffusion, associez Couchcast à un autre compte (gratuit) ajouté comme utilisateur sur la PS5, et jouez avec votre compte principal.
2. **Identifiant de compte PSN.** Cliquez sur *Ouvrir la connexion Sony* et connectez-vous **sur le site de Sony** avec ce second compte. Collez ensuite dans l'assistant l'adresse de la page vide « redirect ». Couchcast ne reçoit qu'un code à usage unique, qu'il échange contre l'identifiant numérique du compte, avec les mêmes identifiants client Remote Play publics que chiaki-ng.
3. **Associer la console.** Sur la PS5, connecté avec le second compte : *Paramètres › Système › Lecture à distance › Associer un appareil*, puis saisissez le code à 8 chiffres.

Les clés d'appairage et les clés de stream sont stockées localement dans `~/Library/Application Support/Couchcast/config.json` (droits 600).

## Raccourcis clavier

| Dans la fenêtre | | Partout (app de bureau) | |
|---|---|---|---|
| Lancer le flux | <kbd>Espace</kbd> | Clip 30 s | <kbd>⌃⌥C</kbd> |
| Clip 30 s / 2 min | <kbd>C</kbd> / <kbd>⇧C</kbd> | Clip 2 min | <kbd>⌃⌥⇧C</kbd> |
| Enregistrer | <kbd>R</kbd> | Enregistrer / arrêter | <kbd>⌃⌥R</kbd> |
| Plein écran / son | <kbd>F</kbd> / <kbd>M</kbd> | Afficher la fenêtre | <kbd>⌃⌥S</kbd> |
| Stats / réglages / bibliothèque | <kbd>T</kbd> / <kbd>,</kbd> / <kbd>L</kbd> | | |
| Arrêter la session | <kbd>⇧X</kbd> | | |
| Tous les raccourcis | <kbd>?</kbd> | | |

## Réduire la latence

L'app et le navigateur n'ajoutent presque rien : environ 2 ms de tampon et environ 1 ms de décodage, mesurés. Deux réglages le permettent : l'extension RTP `playout-delay` à 0 (affichage immédiat, comme en cloud gaming) et des flux audio et vidéo séparés, pour que Chrome ne retarde pas l'image afin de la synchroniser avec le son. Ce qui reste, c'est votre **réseau local**, dont le ping est affiché en direct.

1. **Branchez la PS5 en câble sur la box.** C'est de loin le plus efficace : on passe d'environ 7 ms en Wi-Fi, avec des pointes, à moins de 1 ms.
2. Mettez le Mac en Ethernet, ou en Wi-Fi 5/6 GHz près de la box.
3. Pendant le jeu, `sudo ifconfig awdl0 down` empêche AirDrop/Handoff de faire sauter le Wi-Fi sur d'autres canaux. `up` pour réactiver, ou redémarrez.
4. En Wi-Fi, gardez un débit autour de 15–20 Mbit/s.

## Sécurité et vie privée

- **Il n'y a aucune authentification.** Toute personne sur votre réseau local qui ouvre `http://<mac>:8765` peut voir la console, lancer un live et, si *Piloter la PS5* est activé, envoyer des commandes de manette. Utilisez Couchcast uniquement sur un réseau de confiance.
- Votre mot de passe PSN n'est saisi que sur le site de Sony. Couchcast ne le voit jamais.
- Les clés de stream ne sont jamais renvoyées à l'interface ; seuls les 4 derniers caractères sont affichés.

## Limites connues

- **1080p maximum** : c'est la limite du protocole Remote Play. Pas de HDR (le flux est en H.264 SDR pour rester compatible avec les navigateurs).
- Les applis protégées par DRM (Netflix…) ne sont pas transmises par Remote Play.
- Certains messages d'erreur du serveur n'existent qu'en français.
- Usage et tests au quotidien sous macOS 26 / M4 Pro. La version Windows compile dans la CI mais a encore peu servi en conditions réelles.

## Remerciements

- [chiaki-ng](https://github.com/streetpea/chiaki-ng) (AGPL-3.0) fait tout le vrai travail Remote Play. Merci à ses auteurs et au projet Chiaki d'origine.
- [Pion WebRTC](https://github.com/pion/webrtc) (MIT), icônes [lucide](https://lucide.dev) (ISC), polices Bricolage Grotesque, IBM Plex Sans et JetBrains Mono (SIL OFL), [Electron](https://www.electronjs.org) (MIT), [ffmpeg](https://ffmpeg.org).

## Licence et marques

Couchcast est distribué sous licence **GNU AGPL-3.0** (voir [LICENSE](LICENSE)), parce qu'il est lié à chiaki-ng.

Couchcast est un projet indépendant, **ni affilié, ni approuvé, ni sponsorisé par Sony Interactive Entertainment**. « PlayStation », « PS5 », « DualSense » et « Remote Play » sont des marques de Sony Interactive Entertainment Inc., citées uniquement pour décrire la compatibilité. Utilisation à vos risques.
