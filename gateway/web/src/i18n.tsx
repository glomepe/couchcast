import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// Traductions de l'interface. Le français sert de référence : toute clé ajoutée ici
// doit exister en anglais (vérifié par TypeScript).
const fr = {
  // États
  'state.unpaired': 'Non associée',
  'state.idle': 'Prête',
  'state.waking': 'Réveil…',
  'state.connecting': 'Connexion…',
  'state.pin': 'Code requis',
  'state.streaming': 'En direct',
  'state.error': 'Erreur',

  // Barre d'outils
  'bar.sound.on': 'Activer le son',
  'bar.sound.off': 'Couper le son',
  'bar.gamepad': 'Manette',
  'bar.gamepad.none': 'Aucune manette détectée',
  'bar.stats': 'Statistiques',
  'bar.library': 'Bibliothèque',
  'bar.settings': 'Réglages',
  'bar.fullscreen': 'Plein écran',
  'bar.stop': 'Arrêter la session',
  'bar.shortcuts': 'Raccourcis clavier',
  'rec.start': 'Enregistrer',
  'rec.stop': 'Arrêter l’enregistrement',
  'clip.button': 'Clip {s}',
  'clip.last': 'Dernières {d}',
  'clip.memory': '{s} s en mémoire',
  'clip.disabled': 'Replay désactivé (Réglages › Clips)',

  // Écran d'accueil du lecteur
  'splash.launch': 'Lancer le flux',
  'splash.hint': 'La PS5 est réveillée automatiquement si elle est en mode repos.',
  'splash.waking': 'Réveil de la PS5…',
  'splash.connecting': 'Ouverture de la session Remote Play…',
  'splash.player': 'Connexion du lecteur…',
  'splash.waiting': 'En attente du flux…',
  'splash.show': 'Afficher le flux',
  'pin.title': 'Code de connexion',
  'pin.text': 'Le profil PS5 est protégé par un code de connexion. Saisissez-le pour continuer.',
  'pin.wrong': 'Code incorrect',
  'common.validate': 'Valider',
  'common.cancel': 'Annuler',
  'common.save': 'Enregistrer',
  'common.apply': 'Appliquer',
  'common.saved': 'Enregistré.',
  'common.delete': 'Supprimer',
  'common.edit': 'Modifier',
  'common.copy': 'Copier',
  'common.copied': 'Copié',
  'common.close': 'Fermer',
  'common.back': 'Retour',

  // Tiroir de réglages
  'tab.stream': 'Flux',
  'tab.image': 'Image',
  'image.intro':
    'Le Remote Play transmet une image 1080p SDR compressée par la PS5 : elle paraît plus douce et plus terne que sur la TV (4K, HDR, traitement de la TV). Ces réglages la corrigent à l’affichage, par la carte graphique, sans latence ; ils n’affectent pas les clips, enregistrements ni lives.',
  'image.presets': 'Préréglages',
  'image.neutral': 'Neutre',
  'image.vivid': 'Éclatant',
  'image.cinema': 'Cinéma',
  'image.brightness': 'Luminosité',
  'image.contrast': 'Contraste',
  'image.saturation': 'Saturation',
  'image.sharpness': 'Netteté',
  'image.reset': 'Réinitialiser',
  'image.gamma': 'Ombres',
  'image.calibrate': 'Calibrer l’image',
  'image.calibrateHint': 'Comme dans les jeux : une mire par réglage, on ajuste jusqu’à voir juste ce qu’il faut.',
  'image.hdrNote': 'Flux HDR détecté : les réglages d’image sont suspendus (ils fausseraient les couleurs du HDR). Ils reviennent automatiquement en SDR.',
  'cal.blacks': 'Niveau des noirs',
  'cal.blacksHint': 'Réglez jusqu’à ce que le logo de gauche soit à peine visible et celui de droite bien visible.',
  'cal.whites': 'Niveau des blancs',
  'cal.whitesHint': 'Réglez jusqu’à ce que le logo de gauche soit à peine visible sur le fond blanc.',
  'cal.colors': 'Couleurs',
  'cal.colorsHint': 'Augmentez jusqu’à des couleurs franches, mais arrêtez-vous avant que les tons chair ne virent à l’orange.',
  'cal.sharpness': 'Netteté',
  'cal.sharpnessHint': 'Le jeu, agrandi. Augmentez jusqu’à ce que les contours soient nets ; arrêtez avant l’apparition d’un liseré clair autour des objets.',
  'cal.keys': '← → pour ajuster · Entrée pour continuer · Échap pour annuler',
  'cal.next': 'Suivant',
  'cal.done': 'Terminer',
  'image.quality':
    'Pour une image plus fine à la source : débit plus élevé (onglet Flux, 30–40 Mbit/s) et PS5 en Ethernet.',
  'sc.image': 'Réglages d’image',
  'tab.clips': 'Clips',
  'tab.live': 'Live',
  'tab.links': 'Liens',
  'tab.app': 'App',
  'stream.resolution': 'Résolution',
  'stream.fps': 'Images par seconde',
  'stream.bitrate': 'Débit',
  'stream.auto': 'Automatique',
  'stream.bitrateHint': 'En Wi-Fi, 15 Mbit/s est un bon compromis. Montez si l’image bave, baissez si elle saccade.',
  'stream.smoothing': 'Fluidité',
  'stream.smoothing.latencyLabel': 'Réactif',
  'stream.smoothing.balancedLabel': 'Équilibré',
  'stream.smoothing.smoothLabel': 'Fluide',
  'stream.smoothing.latency': 'Aucun tampon : latence minimale, mais la moindre irrégularité du Wi-Fi se voit (micro-saccades).',
  'stream.smoothing.balanced': 'Tampon adaptatif de 0 à 20 ms : absorbe la gigue courante du Wi-Fi ; une grosse coupure donne un à-coup isolé. Recommandé.',
  'stream.smoothing.smooth': '20 à 60 ms de tampon : le plus régulier, même avec un Wi-Fi capricieux. Idéal pour regarder ou streamer.',
  'stats.cadence': 'Cadence (à-coups)',
  'stream.codec': 'Codec',
  'stream.codecHint':
    'H.265 : image nettement plus fine au même débit. HDR : couleurs et contraste proches de la TV, sur un écran HDR. Le H.264 reste lisible par tous les navigateurs.',
  'stream.codecUnsupported': 'Ce navigateur ne sait pas décoder le H.265 en WebRTC : utilisez l’app Couchcast, Chrome ou Edge récents.',
  'stream.hdrUnsupported': 'Cet écran n’est pas HDR : l’image HDR y paraîtra terne.',
  'stream.control': 'Piloter la PS5 depuis le navigateur',
  'stream.controlHint':
    'Désactivé (mode spectateur) : aucune manette n’est annoncée à la PS5. Activé : une manette branchée sur l’ordinateur du spectateur pilote la console.',
  'stream.restart': 'Appliqué : la session redémarre.',
  'stream.console': 'Console',
  'stream.unpair': 'Dissocier la console',
  'stream.standby': 'Mettre en repos',
  'stream.standbyConfirm': 'Mettre la PS5 en mode repos ? La partie en cours sera suspendue (ou fermée si le jeu ne le gère pas).',
  'stream.wakeHint':
    'Réveil à distance : sur la PS5, Paramètres › Système › Économie d’énergie › Fonctions disponibles en mode repos › activez « Rester connecté à Internet » et « Permettre de mettre la PS5 sous tension depuis le réseau ».',
  'stream.unpairConfirm': 'Dissocier cette console ? Il faudra refaire l’appairage avec un nouveau code.',
  'clips.memory': 'Mémoire de replay',
  'clips.off': 'Désactivée',
  'clips.memoryHint': '{s} s en mémoire ({mb} Mo de RAM). Une image clé est demandée toutes les 20 s : un clip démarre au plus 20 s avant le moment demandé.',
  'clips.vertical': 'Créer aussi la version verticale de chaque clip',
  'clips.keepAlive': 'Garder la session ouverte sans spectateur',
  'clips.keepAliveHint': 'Replay permanent : clips depuis le téléphone ou les raccourcis globaux, fenêtre fermée.',
  'clips.layout': 'Format vertical (9:16)',
  'clips.blur': 'Fond flou',
  'clips.crop': 'Recadré',
  'clips.position': 'Position du recadrage',
  'clips.previewCrop': 'Zone gardée en plein écran vertical',
  'clips.previewBlur': 'Toute l’image, centrée sur un fond flouté',
  'live.empty': 'Aucune destination. Ajoutez Twitch, YouTube, TikTok…',
  'live.add': 'Ajouter une destination',
  'live.go': 'Go live',
  'live.stop': 'Couper',
  'live.needStream': 'Lancez d’abord le flux',
  'live.onAir': 'En direct',
  'live.connecting': 'Connexion…',
  'live.platform': 'Plateforme',
  'live.name': 'Nom',
  'live.server': 'Serveur',
  'live.key': 'Clé de stream',
  'live.keyUnchanged': 'inchangée',
  'live.horizontal': 'Horizontal 16:9',
  'live.vertical': 'Vertical 9:16',
  'live.copy': 'Copie directe du flux PS5 (aucun traitement, débit = celui de l’onglet Flux)',
  'live.bitrate': 'Débit vidéo envoyé',
  'live.copyMode': 'copie directe',
  'live.encodeHint': 'Réencodage par la puce du Mac (VideoToolbox) : quasiment aucune charge. Twitch plafonne vers 6 Mbit/s, YouTube accepte 9 Mbit/s et plus.',
  'live.help.twitch': 'Clé : Tableau de bord créateur › Paramètres › Stream.',
  'live.help.youtube': 'Clé : YouTube Studio › Passer au direct › Flux.',
  'live.help.tiktok': 'Serveur et clé : TikTok LIVE Studio / LIVE Center (compte éligible au live).',
  'live.help.custom': 'Kick, Facebook, Restream, un serveur maison…',
  'live.custom': 'RTMP personnalisé',
  'links.obs': 'Source OBS',
  'links.obsHint': 'OBS › Source › Navigateur, 1920×1080, cochez « Contrôler l’audio via OBS ». Image et son, sans interface.',
  'links.remote': 'Télécommande',
  'links.remoteHint': 'À ouvrir sur le téléphone (même Wi-Fi) : clips et REC sans quitter la partie.',
  'links.library': 'Bibliothèque',
  'links.libraryHint': 'Clips, enregistrements et exports verticaux.',
  'app.language': 'Langue',
  'app.shortcuts': 'Raccourcis clavier',
  'app.about': 'Couchcast · projet open source non affilié à Sony Interactive Entertainment.',

  // Statistiques
  'stats.profile': 'Profil',
  'stats.received': 'Reçu de la PS5',
  'stats.lost': 'Images perdues',
  'stats.ping': 'Ping PS5',
  'stats.buffer': 'Tampon',
  'stats.decode': 'Décodage',
  'stats.pipeline': 'Réception → image',
  'stats.displayed': 'Affiché',
  'stats.viewers': 'Spectateurs',
  'stats.uptime': 'Durée',
  'stats.audio': 'Audio',
  'stats.rtt': 'RTT navigateur',
  'stats.dropped': 'Paquets perdus / images sautées',
  'stats.frame': 'Taille image (moy. / max)',
  'stats.audioBuffer': 'Tampon audio',
  'lat.title': 'Latence estimée (hors PS5)',
  'lat.network': 'Réseau PS5 → Mac',
  'lat.app': 'Couchcast (réception → image)',
  'lat.display': 'Écran ({hz} Hz)',
  'lat.total': 'Total mesurable',
  'lat.ps5': '+ encodage PS5, non mesurable (~5–10 ms)',
  'tips.title': 'Diagnostic latence',
  'tips.ok': 'Rien à signaler : réseau, décodage et affichage sont au mieux.',
  'tips.ethernet': 'Ping de {ms} ms : la PS5 (ou le Mac) passe sans doute par le Wi-Fi. En câble Ethernet, on descend sous 1 ms.',
  'tips.jitter': 'Ping irrégulier (±{ms} ms). Sur Mac, AirDrop/Handoff font sauter le Wi-Fi de canal : « sudo ifconfig awdl0 down » pendant le jeu.',
  'tips.bitrate': 'Images de {kb} Ko en moyenne à {mbps} Mbit/s : en Wi-Fi, chaque image met plus longtemps à arriver. Essayez 15–20 Mbit/s.',
  'tips.loss': '{n} images perdues entre la PS5 et le Mac : signe d’un Wi-Fi saturé. Baissez le débit ou passez en câble.',
  'tips.audioDevice': 'Votre sortie audio ajoute {ms} ms à elle seule (haut-parleurs d’écran, Bluetooth…) : le son arrive après l’image. Les haut-parleurs du Mac ou un casque filaire descendent sous 20 ms.',
  'stats.audioLag': 'Son en retard de',
  'tips.refresh': 'Écran à {hz} Hz : un écran 120 Hz affiche chaque image jusqu’à ~4 ms plus tôt.',
  'tips.keyframes': 'Images clés : toutes les 20 s avec le replay, 2 s pendant un live, aucune sinon (moins de pics de latence).',

  // Raccourcis
  'sc.title': 'Raccourcis clavier',
  'sc.inApp': 'Dans la fenêtre',
  'sc.global': 'Partout (app de bureau)',
  'sc.launch': 'Lancer le flux',
  'sc.fullscreen': 'Plein écran',
  'sc.mute': 'Son on/off',
  'sc.clip30': 'Clip des 30 dernières secondes',
  'sc.clip120': 'Clip des 2 dernières minutes',
  'sc.record': 'Démarrer / arrêter l’enregistrement',
  'sc.stats': 'Statistiques',
  'sc.settings': 'Réglages',
  'sc.library': 'Bibliothèque',
  'sc.gamepad': 'Manette on/off',
  'sc.stop': 'Arrêter la session',
  'sc.help': 'Cette aide',
  'sc.close': 'Fermer le panneau',
  'sc.show': 'Afficher la fenêtre',

  // ffmpeg absent
  'ffmpeg.missing': 'ffmpeg est introuvable : clips, enregistrements et lives ne fonctionneront pas.',
  'ffmpeg.install': 'Installez-le puis relancez Couchcast :',

  // Notifications
  'toast.running': '{label} : traitement…',
  'toast.clip': 'Clip sauvegardé',
  'toast.recording': 'Enregistrement sauvegardé',
  'toast.vertical': 'Version verticale prête',
  'toast.see': 'Voir',

  // Bibliothèque
  'lib.title': 'Bibliothèque',
  'lib.player': 'Lecteur',
  'lib.all': 'Tout',
  'lib.clips': 'Clips',
  'lib.recordings': 'Enregistrements',
  'lib.verticals': 'Verticaux',
  'lib.kind.clip': 'Clip',
  'lib.kind.recording': 'Enregistrement',
  'lib.kind.vertical': 'Vertical',
  'lib.folder': 'Dossier',
  'lib.empty': 'Rien pour l’instant. Pendant le flux : C pour un clip de 30 s, R pour enregistrer.',
  'lib.download': 'Télécharger',
  'lib.vertical': 'Vertical',
  'lib.verticalBlur': 'Image entière + fond flou',
  'lib.verticalCrop': 'Recadré ({p} %)',
  'lib.finder': 'Afficher dans le Finder',
  'lib.deleteConfirm': 'Supprimer {name} ? Le fichier sera définitivement effacé.',

  // Télécommande
  'remote.start': 'Démarrer la session',
  'remote.memory': '{s} s en mémoire sur {max} s',
  'remote.noReplay': 'Replay désactivé : activez-le dans Réglages › Clips.',
  'remote.lives': '{n} live en cours',
  'remote.last': 'Dernier : {label}',
  'remote.keepAlive': 'Astuce : cochez « Garder la session ouverte » (Réglages › Clips), sinon la session se ferme 60 s après la fermeture du dernier lecteur.',
  'remote.clip': 'Clip',

  // Assistant d'appairage
  'setup.subtitle': 'Associez Couchcast à votre PS5. À faire une seule fois.',
  'setup.step.account': 'Compte PSN',
  'setup.step.console': 'Console',
  'setup.account.title': 'Identifiant de compte PSN',
  'setup.account.text':
    'La PS5 n’accepte que les appareils liés à un compte PSN. Utilisez un compte secondaire : la PS5 coupe le Remote Play dès que la manette du même compte se réveille sur la console. Connectez-vous sur la page de Sony : vous arriverez sur une page presque vide intitulée « redirect ». Copiez son adresse complète et collez-la ici.',
  'setup.account.open': 'Ouvrir la connexion Sony',
  'setup.account.url': 'Adresse de la page « redirect »',
  'setup.account.checking': 'Vérification…',
  'setup.account.manual': 'J’ai déjà mon identifiant (base64)',
  'setup.account.use': 'Utiliser',
  'setup.account.privacy':
    'Votre mot de passe n’est saisi que sur le site de Sony. Couchcast reçoit seulement un code à usage unique, échangé contre votre identifiant de compte (un nombre, pas un secret de connexion).',
  'setup.console.title': 'Associer la PS5',
  'setup.console.searching': 'Recherche des consoles sur le réseau…',
  'setup.console.none': 'Aucune PS5 trouvée. Est-elle allumée (ou en mode repos) et sur le même réseau ?',
  'setup.console.ready': 'allumée',
  'setup.console.standby': 'en veille',
  'setup.console.rescan': 'Relancer la recherche',
  'setup.console.howto':
    'Sur la PS5, connecté avec ce même compte : Paramètres › Système › Lecture à distance › Associer un appareil. Saisissez le code à 8 chiffres affiché (il expire au bout de quelques minutes).',
  'setup.console.pair': 'Associer',
  'setup.console.pairing': 'Association…',
  'setup.console.changeAccount': 'Changer d’identifiant PSN',
} as const;

type Key = keyof typeof fr;

const en: Record<Key, string> = {
  'state.unpaired': 'Not paired',
  'state.idle': 'Ready',
  'state.waking': 'Waking…',
  'state.connecting': 'Connecting…',
  'state.pin': 'PIN required',
  'state.streaming': 'Live',
  'state.error': 'Error',

  'bar.sound.on': 'Unmute',
  'bar.sound.off': 'Mute',
  'bar.gamepad': 'Gamepad',
  'bar.gamepad.none': 'No gamepad detected',
  'bar.stats': 'Statistics',
  'bar.library': 'Library',
  'bar.settings': 'Settings',
  'bar.fullscreen': 'Fullscreen',
  'bar.stop': 'Stop session',
  'bar.shortcuts': 'Keyboard shortcuts',
  'rec.start': 'Record',
  'rec.stop': 'Stop recording',
  'clip.button': 'Clip {s}',
  'clip.last': 'Last {d}',
  'clip.memory': '{s} s buffered',
  'clip.disabled': 'Replay disabled (Settings › Clips)',

  'splash.launch': 'Start stream',
  'splash.hint': 'The PS5 is woken up automatically if it is in rest mode.',
  'splash.waking': 'Waking the PS5…',
  'splash.connecting': 'Opening the Remote Play session…',
  'splash.player': 'Connecting the player…',
  'splash.waiting': 'Waiting for the stream…',
  'splash.show': 'Show stream',
  'pin.title': 'Login passcode',
  'pin.text': 'This PS5 profile is protected by a login passcode. Enter it to continue.',
  'pin.wrong': 'Wrong passcode',
  'common.validate': 'Confirm',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.apply': 'Apply',
  'common.saved': 'Saved.',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.close': 'Close',
  'common.back': 'Back',

  'tab.stream': 'Stream',
  'tab.image': 'Picture',
  'image.intro':
    'Remote Play sends a 1080p SDR picture compressed by the PS5: it looks softer and duller than on the TV (4K, HDR, TV processing). These settings correct it on display, on the GPU, with no added latency. They do not affect clips, recordings or live streams.',
  'image.presets': 'Presets',
  'image.neutral': 'Neutral',
  'image.vivid': 'Vivid',
  'image.cinema': 'Cinema',
  'image.brightness': 'Brightness',
  'image.contrast': 'Contrast',
  'image.saturation': 'Saturation',
  'image.sharpness': 'Sharpness',
  'image.reset': 'Reset',
  'image.gamma': 'Shadows',
  'image.calibrate': 'Calibrate picture',
  'image.calibrateHint': 'Like in games: one test pattern per setting, adjust until you see just what you should.',
  'image.hdrNote': 'HDR stream detected: picture settings are paused (they would distort HDR colours). They come back automatically in SDR.',
  'cal.blacks': 'Black level',
  'cal.blacksHint': 'Adjust until the left logo is barely visible and the right one clearly visible.',
  'cal.whites': 'White level',
  'cal.whitesHint': 'Adjust until the left logo is barely visible on the white background.',
  'cal.colors': 'Colour',
  'cal.colorsHint': 'Raise until colours look rich, but stop before skin tones turn orange.',
  'cal.sharpness': 'Sharpness',
  'cal.sharpnessHint': 'The game, magnified. Raise until edges look crisp; stop before a bright halo appears around objects.',
  'cal.keys': '← → to adjust · Enter to continue · Esc to cancel',
  'cal.next': 'Next',
  'cal.done': 'Done',
  'image.quality': 'For a sharper source picture: raise the bitrate (Stream tab, 30–40 Mbit/s) and put the PS5 on Ethernet.',
  'sc.image': 'Picture settings',
  'tab.clips': 'Clips',
  'tab.live': 'Live',
  'tab.links': 'Links',
  'tab.app': 'App',
  'stream.resolution': 'Resolution',
  'stream.fps': 'Frame rate',
  'stream.bitrate': 'Bitrate',
  'stream.auto': 'Automatic',
  'stream.bitrateHint': 'Over Wi-Fi, 15 Mbit/s is a good trade-off. Go higher if the picture smears, lower if it stutters.',
  'stream.smoothing': 'Smoothness',
  'stream.smoothing.latencyLabel': 'Responsive',
  'stream.smoothing.balancedLabel': 'Balanced',
  'stream.smoothing.smoothLabel': 'Smooth',
  'stream.smoothing.latency': 'No buffer: lowest latency, but any Wi-Fi irregularity shows as micro-stutter.',
  'stream.smoothing.balanced': 'Adaptive 0–20 ms buffer: absorbs everyday Wi-Fi jitter; a big dropout shows as a single hitch. Recommended.',
  'stream.smoothing.smooth': '20–60 ms of buffer: the steadiest, even on flaky Wi-Fi. Best for watching or streaming.',
  'stats.cadence': 'Cadence (hitches)',
  'stream.codec': 'Codec',
  'stream.codecHint':
    'H.265: a noticeably sharper picture at the same bitrate. HDR: colours and contrast close to the TV, on an HDR display. H.264 still plays in every browser.',
  'stream.codecUnsupported': 'This browser cannot decode H.265 over WebRTC: use the Couchcast app, or a recent Chrome or Edge.',
  'stream.hdrUnsupported': 'This display is not HDR: the HDR picture will look dull.',
  'stream.control': 'Control the PS5 from the browser',
  'stream.controlHint':
    'Off (spectator mode): no controller is announced to the PS5. On: a gamepad plugged into the viewer’s computer controls the console.',
  'stream.restart': 'Applied: the session is restarting.',
  'stream.console': 'Console',
  'stream.unpair': 'Unpair console',
  'stream.standby': 'Rest mode',
  'stream.standbyConfirm': 'Put the PS5 in rest mode? The current game will be suspended (or closed if it does not support it).',
  'stream.wakeHint':
    'Remote wake-up: on the PS5, Settings › System › Power Saving › Features Available in Rest Mode › turn on “Stay Connected to the Internet” and “Enable Turning On PS5 from Network”.',
  'stream.unpairConfirm': 'Unpair this console? You will need a new pairing code.',
  'clips.memory': 'Replay buffer',
  'clips.off': 'Off',
  'clips.memoryHint': '{s} s buffered ({mb} MB of RAM). A keyframe is requested every 20 s: a clip starts at most 20 s before the requested moment.',
  'clips.vertical': 'Also create a vertical version of every clip',
  'clips.keepAlive': 'Keep the session open without viewers',
  'clips.keepAliveHint': 'Always-on replay: clip from your phone or global shortcuts with the window closed.',
  'clips.layout': 'Vertical format (9:16)',
  'clips.blur': 'Blurred background',
  'clips.crop': 'Cropped',
  'clips.position': 'Crop position',
  'clips.previewCrop': 'Area kept in full-screen vertical',
  'clips.previewBlur': 'The whole picture, centred on a blurred background',
  'live.empty': 'No destination yet. Add Twitch, YouTube, TikTok…',
  'live.add': 'Add a destination',
  'live.go': 'Go live',
  'live.stop': 'End',
  'live.needStream': 'Start the stream first',
  'live.onAir': 'On air',
  'live.connecting': 'Connecting…',
  'live.platform': 'Platform',
  'live.name': 'Name',
  'live.server': 'Server',
  'live.key': 'Stream key',
  'live.keyUnchanged': 'unchanged',
  'live.horizontal': 'Landscape 16:9',
  'live.vertical': 'Vertical 9:16',
  'live.copy': 'Pass the PS5 stream through untouched (no processing, bitrate = Stream tab)',
  'live.bitrate': 'Outgoing video bitrate',
  'live.copyMode': 'passthrough',
  'live.encodeHint': 'Re-encoded by the Mac’s media engine (VideoToolbox): almost no load. Twitch caps around 6 Mbit/s, YouTube takes 9 Mbit/s and more.',
  'live.help.twitch': 'Key: Creator Dashboard › Settings › Stream.',
  'live.help.youtube': 'Key: YouTube Studio › Go live › Stream.',
  'live.help.tiktok': 'Server and key: TikTok LIVE Studio / LIVE Center (live-eligible account).',
  'live.help.custom': 'Kick, Facebook, Restream, your own server…',
  'live.custom': 'Custom RTMP',
  'links.obs': 'OBS source',
  'links.obsHint': 'OBS › Source › Browser, 1920×1080, tick “Control audio via OBS”. Picture and sound, no UI.',
  'links.remote': 'Remote',
  'links.remoteHint': 'Open it on your phone (same Wi-Fi): clips and REC without leaving the game.',
  'links.library': 'Library',
  'links.libraryHint': 'Clips, recordings and vertical exports.',
  'app.language': 'Language',
  'app.shortcuts': 'Keyboard shortcuts',
  'app.about': 'Couchcast · open-source project, not affiliated with Sony Interactive Entertainment.',

  'stats.profile': 'Profile',
  'stats.received': 'From PS5',
  'stats.lost': 'Lost frames',
  'stats.ping': 'PS5 ping',
  'stats.buffer': 'Buffer',
  'stats.decode': 'Decode',
  'stats.pipeline': 'Receive → frame',
  'stats.displayed': 'Displayed',
  'stats.viewers': 'Viewers',
  'stats.uptime': 'Uptime',
  'stats.audio': 'Audio',
  'stats.rtt': 'Browser RTT',
  'stats.dropped': 'Lost packets / dropped frames',
  'stats.frame': 'Frame size (avg / max)',
  'stats.audioBuffer': 'Audio buffer',
  'lat.title': 'Estimated latency (excl. PS5)',
  'lat.network': 'Network PS5 → computer',
  'lat.app': 'Couchcast (receive → frame)',
  'lat.display': 'Display ({hz} Hz)',
  'lat.total': 'Measurable total',
  'lat.ps5': '+ PS5 encoding, not measurable (~5–10 ms)',
  'tips.title': 'Latency check',
  'tips.ok': 'All good: network, decoding and display are as fast as they get.',
  'tips.ethernet': '{ms} ms ping: the PS5 (or this computer) is probably on Wi-Fi. A wired connection gets it under 1 ms.',
  'tips.jitter': 'Unstable ping (±{ms} ms). On a Mac, AirDrop/Handoff make Wi-Fi hop channels: “sudo ifconfig awdl0 down” while playing.',
  'tips.bitrate': '{kb} KB frames on average at {mbps} Mbit/s: over Wi-Fi each frame takes longer to arrive. Try 15–20 Mbit/s.',
  'tips.loss': '{n} frames lost between the PS5 and the computer: a sign of busy Wi-Fi. Lower the bitrate or go wired.',
  'tips.audioDevice': 'Your audio output alone adds {ms} ms (display speakers, Bluetooth…): sound lands after the picture. The Mac’s speakers or wired headphones stay under 20 ms.',
  'stats.audioLag': 'Sound behind picture by',
  'tips.refresh': '{hz} Hz display: a 120 Hz screen shows each frame up to ~4 ms sooner.',
  'tips.keyframes': 'Keyframes: every 20 s with replay, every 2 s while live, none otherwise (fewer latency spikes).',

  'sc.title': 'Keyboard shortcuts',
  'sc.inApp': 'In the window',
  'sc.global': 'Anywhere (desktop app)',
  'sc.launch': 'Start stream',
  'sc.fullscreen': 'Fullscreen',
  'sc.mute': 'Sound on/off',
  'sc.clip30': 'Clip the last 30 seconds',
  'sc.clip120': 'Clip the last 2 minutes',
  'sc.record': 'Start / stop recording',
  'sc.stats': 'Statistics',
  'sc.settings': 'Settings',
  'sc.library': 'Library',
  'sc.gamepad': 'Gamepad on/off',
  'sc.stop': 'Stop session',
  'sc.help': 'This help',
  'sc.close': 'Close panel',
  'sc.show': 'Show window',

  'ffmpeg.missing': 'ffmpeg was not found: clips, recordings and live streams will not work.',
  'ffmpeg.install': 'Install it, then restart Couchcast:',

  'toast.running': '{label}: processing…',
  'toast.clip': 'Clip saved',
  'toast.recording': 'Recording saved',
  'toast.vertical': 'Vertical version ready',
  'toast.see': 'Open',

  'lib.title': 'Library',
  'lib.player': 'Player',
  'lib.all': 'All',
  'lib.clips': 'Clips',
  'lib.recordings': 'Recordings',
  'lib.verticals': 'Vertical',
  'lib.kind.clip': 'Clip',
  'lib.kind.recording': 'Recording',
  'lib.kind.vertical': 'Vertical',
  'lib.folder': 'Folder',
  'lib.empty': 'Nothing yet. While streaming: C for a 30 s clip, R to record.',
  'lib.download': 'Download',
  'lib.vertical': 'Vertical',
  'lib.verticalBlur': 'Whole picture + blurred background',
  'lib.verticalCrop': 'Cropped ({p} %)',
  'lib.finder': 'Show in Finder',
  'lib.deleteConfirm': 'Delete {name}? The file will be permanently erased.',

  'remote.start': 'Start session',
  'remote.memory': '{s} s buffered out of {max} s',
  'remote.noReplay': 'Replay disabled: enable it in Settings › Clips.',
  'remote.lives': '{n} live stream(s) running',
  'remote.last': 'Last: {label}',
  'remote.keepAlive': 'Tip: tick “Keep the session open” (Settings › Clips), otherwise the session closes 60 s after the last player is closed.',
  'remote.clip': 'Clip',

  'setup.subtitle': 'Pair Couchcast with your PS5. You only do this once.',
  'setup.step.account': 'PSN account',
  'setup.step.console': 'Console',
  'setup.account.title': 'PSN account ID',
  'setup.account.text':
    'The PS5 only accepts devices linked to a PSN account. Use a secondary account: the PS5 ends Remote Play as soon as a controller signed in to the same account wakes up on the console. Sign in on Sony’s page: you will land on an almost empty page titled “redirect”. Copy its full address and paste it here.',
  'setup.account.open': 'Open Sony sign-in',
  'setup.account.url': 'Address of the “redirect” page',
  'setup.account.checking': 'Checking…',
  'setup.account.manual': 'I already have my account ID (base64)',
  'setup.account.use': 'Use',
  'setup.account.privacy':
    'Your password is only ever typed on Sony’s website. Couchcast only receives a one-time code, exchanged for your account ID (a number, not a sign-in secret).',
  'setup.console.title': 'Pair the PS5',
  'setup.console.searching': 'Looking for consoles on the network…',
  'setup.console.none': 'No PS5 found. Is it on (or in rest mode) and on the same network?',
  'setup.console.ready': 'on',
  'setup.console.standby': 'rest mode',
  'setup.console.rescan': 'Search again',
  'setup.console.howto':
    'On the PS5, signed in with that same account: Settings › System › Remote Play › Pair Device. Enter the 8-digit code shown (it expires after a few minutes).',
  'setup.console.pair': 'Pair',
  'setup.console.pairing': 'Pairing…',
  'setup.console.changeAccount': 'Use another PSN account ID',
};

export type Lang = 'fr' | 'en';
const DICT: Record<Lang, Record<Key, string>> = { fr, en };
const STORAGE_KEY = 'couchcast.lang';

export type T = (key: Key, vars?: Record<string, string | number>) => string;

const I18nContext = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: T } | null>(null);

function initialLang(serverLang?: string): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'fr' || saved === 'en') return saved;
  } catch {
    /* stockage indisponible */
  }
  if (serverLang === 'fr' || serverLang === 'en') return serverLang;
  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function I18nProvider({ serverLang, children }: { serverLang?: string; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => initialLang(serverLang));

  // Langue choisie sur un autre appareil (ou dans l'app de bureau) : on suit le serveur
  // tant que ce navigateur n'a pas son propre choix.
  useEffect(() => {
    if ((serverLang === 'fr' || serverLang === 'en') && serverLang !== lang) {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(STORAGE_KEY);
      } catch {
        /* ignoré */
      }
      if (!saved) setLangState(serverLang);
    }
  }, [serverLang, lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignoré */
    }
    // Partagée avec l'app de bureau (menus, notifications).
    fetch('/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }).catch(() => {});
  }, []);

  const t = useCallback<T>(
    (key, vars) => {
      let s: string = DICT[lang][key] ?? fr[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('I18nProvider manquant');
  return ctx;
}
