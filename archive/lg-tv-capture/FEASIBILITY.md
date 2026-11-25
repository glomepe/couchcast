# LG Remote Screen — étude de faisabilité

*25/11/2026 — d'après la lecture du code de PicCap 0.5.3, hyperion-webos, tv-native-apis et webos-jetkvm (commit du 24/11/2026). Rien n'a encore été mesuré sur une vraie TV.*

## TL;DR

1. **La capture fonctionne déjà** (hyperion-webos via `libvtcapture` / `libdile_vt`, et l'entrée HDMI n'est pas bloquée par le DRM d'après PicCap). Il faut **rooter** la TV.
2. **Les frames brutes ne passent pas par le réseau au-delà d'une résolution d'environ 480p.** Le port Ethernet des TV LG est en **100 Mbit/s**. En NV12, le 720p30 brut demande 332 Mbit/s (348 Mbit/s mesurés avec le prototype) et le 1080p60 demande 1,5 Gbit/s. **Il faut donc compresser sur la TV.**
3. **Il existe un encodeur H.264 matériel accessible, et quelqu'un l'a déjà exploité.** [webos-jetkvm](https://github.com/sundermann/webos-jetkvm) (GPL-2.0, maintenu, dernier commit du 24/11/2026) fait **capture → encodage H.264 matériel → WebRTC → navigateur**, en 1080p30 par défaut. C'est presque exactement le projet « LG Remote Screen ». **Il faut partir de webos-jetkvm, pas de PicCap.**
4. **L'audio n'est géré nulle part.** Toutes les API audio connues (`DILE_AUDIO_DIRECT`, `lgnc_directaudio`, NDL) servent à la *lecture*, pas à la capture. C'est le vrai point inconnu.

## 1. Ce que font PicCap et hyperion-webos

PicCap n'est qu'une interface (application webOS en JS). Tout le travail est fait par **hyperion-webos**, un service natif en C :

```
backend de capture (.so chargé par dlopen) ─► unicapture (synchro vsync, fusion UI+vidéo, conversion libyuv)
                                          ─► hyperion_client (FlatBuffers sur TCP:19400) ─► serveur Hyperion.ng
```

| Backend | Rôle | webOS | Fonctionnement |
|---|---|---|---|
| `libvtcapture` | vidéo | 5.x+ (TV 4K de 2020 et après) | `vtCapture_*` (lib LG de haut niveau). Le buffer est en NV12 et mappé directement (zéro copie). On détecte une nouvelle frame quand `start_addr0` change, en interrogeant toutes les 1 ms. `props.frm` = fps demandé (60 par défaut). Il faut des droits luna (rôle `com.webos.service.capture`). |
| `libdile_vt` | vidéo | 3.x+ | `DILE_VT_*` + `mmap` de `/dev/mem`. Formats NV12, NV16 ou RGB selon la TV. FPS = **60 / diviseur** (on ne peut pas choisir librement). Par défaut, la frame est « gelée » pendant la lecture (le quirk `0x2` supprime ce gel et augmente le FPS). |
| `libhalgal` / `libgm` | interface (OSD) | 5.x+ / 3.x+ | ARGB, à fusionner par-dessus la vidéo. |

Points importants pour notre projet :

- **Résolution** : c'est le *scaler matériel* de la TV qui la fixe (`props.reg.w/h`, `DILE_VT_SetVideoFrameOutputDeviceOutputRegion`). Réduire la résolution ne coûte donc rien au CPU. PicCap envoie du 320×180 par défaut (pour de l'Ambilight). Rien n'empêche, dans le code, de demander du 1280×720 ou du 1920×1080. La limite réelle dépend de la TV (`maxResolution`, affiché dans les logs DILE_VT).
- **Emplacement de capture** (*dump location*) : `DISPLAY_OUTPUT` par défaut, ou `SCALER_INPUT/OUTPUT`, `BLENDED_OUTPUT`… selon les quirks. Ça détermine si l'OSD et le traitement d'image (PQ) apparaissent dans la capture.
- **Pas d'encodage** : l'envoi est fait en RGB ou NV12 brut, de façon synchrone (`writev` bloquant). Un réseau lent ralentit donc directement la capture.
- **Problèmes connus** : les options « AI Picture Pro », « AI Brightness », « AI Game Optimizer », etc. utilisent le même circuit de capture et provoquent des coupures. Il faut les désactiver.
- **Contenus protégés** : pas de capture des applis DRM (Netflix…). D'après le README de PicCap, l'entrée HDMI n'est pas concernée. **À vérifier avec la PS5**, qui active le HDCP. Si on obtient un écran noir : PS5 › Paramètres › Système › HDMI › désactiver « Activer HDCP ».

## 2. Le débit réseau, contrainte principale

Débit brut NV12 (12 bits par pixel). En RGB, il faut doubler :

| Résolution | 30 FPS | 60 FPS | Passe en 100 Mbit/s ? |
|---|---|---|---|
| 320×180 | 21 Mbit/s | 41 Mbit/s | oui |
| 480×270 | 47 Mbit/s | 93 Mbit/s | oui à 30 FPS |
| 640×360 | 83 Mbit/s | 166 Mbit/s | limite à 30 FPS |
| 1280×720 | 332 Mbit/s | 664 Mbit/s | **non** |
| 1920×1080 | 747 Mbit/s | 1,5 Gbit/s | **non** |

Le port Ethernet intégré des OLED LG est limité à 100 Mbit/s (environ 94 utiles). Un adaptateur USB 3 → Gigabit dépasse 700 Mbit/s d'après les forums Plex/Emby, ce qui rendrait possible le 720p30 brut, mais sûrement pas le 1080p60. Le Wi-Fi de la TV est à mesurer.

**Conclusion** : le flux brut convient pour *valider la capture* (c'est le rôle du prototype). Pour l'usage réel, il faut encoder sur la TV. Un flux H.264 1080p60 de jeu tient en 15 à 30 Mbit/s.

## 3. Encodage

| Option | Faisabilité | Remarques |
|---|---|---|
| **H.264 matériel via Nyx `Venc`** (`nyx::getVenc()`, `ScreenCapture`, `Vscaler`) | **Déjà réalisé** par webos-jetkvm | L'affichage est routé vers l'encodeur à travers un scaler auxiliaire libre (`setConnectionInfo(..., kEncoderOutput)`). Le résultat sort directement en H.264 Annex-B, sans passer par le CPU. ABI ARM32. |
| **`HAL_VENC_*`** (encodeur LG « historique ») | Déjà réalisé (TV O22, par ex. C2) | Variante pour les TV où Nyx n'expose pas l'encodeur. |
| **Encodeur Realtek du scaler** | Déjà réalisé (commit du 24/11/2026) | Supporte **30 et 60 FPS** (`kRealtekFrameRate60`), d'après le code. |
| H.265 matériel | Inconnu | Aucune trace dans le code étudié. Les navigateurs ne le décodent de toute façon pas bien en WebRTC. **On reste en H.264.** |
| MJPEG logiciel (libjpeg-turbo) | Plan B | L'exemple `tv-native-apis/samples/vtcapture` le fait déjà (`… \| ffplay -f mjpeg -`). Environ 100 Kio par frame en 720p, donc ~25 Mbit/s à 30 FPS. Le coût CPU sur les cœurs ARM de la TV reste à mesurer. Le navigateur l'affiche sans décodeur particulier. |
| x264 logiciel | Peu réaliste | 1080p60 impossible sur le CPU d'une TV. 720p30 en `ultrafast`, peut-être, mais en saturant le CPU. |

webos-jetkvm propose des débits de 1 à 30 Mbit/s (8 Mbit/s par défaut) et des préréglages 360p/540p/720p/1080p (30 FPS par défaut). Une seule personne peut regarder à la fois. Son interface web vient de JetKVM et est **testée sous Firefox uniquement**.

## 4. Transport WebRTC

webos-jetkvm utilise **libdatachannel** (MPL-2.0) compilé pour ARM32, avec cpp-httplib pour la signalisation. Il faut le reprendre tel quel. Pour une faible latence :

- ne pas mettre de B-frames, utiliser un GOP court et `resetGop` quand un client se connecte (déjà fait) ;
- le navigateur doit utiliser un `playoutDelayHint` ou `jitterBufferTarget` à 0 ;
- passer en Ethernet filaire de préférence.

Estimation, **non mesurée** : encodage matériel (~1 à 2 frames) + réseau local (quelques ms) + tampon WebRTC et décodage (~30 à 60 ms) ≈ **60 à 120 ms** au total. C'est jouable pour regarder, et limite pour jouer à des jeux nerveux.

## 5. Audio

Aucun des projets étudiés ne capture l'audio. Les API présentes dans `tv-native-apis` (`DILE_AUDIO_DIRECT_*`, `LGNC_ADEC_*`, `NDL_DirectAudio*`) servent toutes à **envoyer** du son vers la TV. Pistes, toutes à explorer en root :

1. `arecord -l` / `cat /proc/asound/cards` : regarder si un périphérique de capture ALSA ou un loopback existe ;
2. chercher dans les bibliothèques du firmware des symboles du type `*AUDIO*CAPTURE*`, `*ADC*`, `*PCM*Dump*` ;
3. contournement matériel : sortie optique ou casque de la TV → carte son USB du PC.

## 6. Compatibilité entre versions de webOS

- La capture vidéo existe de webOS 3.4 à 2026. Le backend dépend de la génération (`libdile_vt` jusqu'à webOS 4, `libvtcapture` à partir de webOS 5). Des *quirks* gèrent les cas particuliers.
- L'encodeur matériel est exposé différemment selon la puce (Nyx, HAL LG O22, Realtek). webos-jetkvm essaie déjà ces variantes l'une après l'autre.
- Tout repose sur de l'**ABI rétro-ingénierée** : une mise à jour du firmware peut tout casser. Il faut garder les mises à jour automatiques désactivées une fois la TV rootée.
- Pour connaître sa TV (en root) :
  ```sh
  grep -h -E '"(hardware_id|core_os_release|product_id|webos_manufacturing_version|board_type)"' /var/run/nyx/*
  ```

## 7. Feuille de route proposée

| Étape | Objectif | Critère de validation |
|---|---|---|
| **0. Prérequis** | Rooter la TV ([cani.rootmy.tv](https://cani.rootmy.tv)), installer Homebrew Channel, relever modèle et version de webOS | SSH root OK |
| **1. Capture brute** (prototype `prototype/receiver`) | PicCap → récepteur sur le PC, avec la PS5 en HDMI | Image visible, sans écran noir HDCP. FPS mesuré en 320×180 et 480×270 (à 30 et 60 FPS) |
| **2. Encodeur matériel** | Installer l'IPK webos-jetkvm, tester en 720p puis en 1080p | Flux H.264 reçu dans Firefox. Noter le FPS réel et la latence (chronomètre filmé à côté de la TV) |
| **3. LG Remote Screen v0** | Forker webos-jetkvm. Garder ses backends capture et encodeur ainsi que libdatachannel. Remplacer l'interface JetKVM (orientée KVM, Firefox uniquement) par une interface **React** : lecteur plein écran, réglages résolution / FPS / débit, statistiques WebRTC. Supprimer la partie clavier/souris si elle n'est pas utile | 1080p30 stable dans Chrome et Firefox |
| **4. 60 FPS** | Activer le 60 FPS là où l'encodeur l'accepte (Realtek, puis tester Nyx) | 1080p60 ou 720p60 mesuré |
| **5. Audio** | Mener les recherches de la section 5 | Décision : faisable, ou contournement matériel |

**Licence** : forker webos-jetkvm implique une licence **GPL-2.0** pour LG Remote Screen. Pas de problème pour un usage personnel ou open source.

## Sources

- PicCap : https://github.com/TBSniller/piccap
- hyperion-webos : https://github.com/webosbrew/hyperion-webos (et le sous-module `tv-native-apis`)
- webos-jetkvm : https://github.com/sundermann/webos-jetkvm
- Limite Ethernet 100 Mbit/s des TV LG : https://forums.plex.tv/t/highly-recommend-this-usb-to-gigabit-adapter-for-your-lg-tv/668697 , https://emby.media/community/topic/85990-increasing-the-lg-100mbitsec-ethernet-limit-success
