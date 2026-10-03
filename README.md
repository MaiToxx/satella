# Satella — Contrôle RGB & Macros

Application de bureau pour gérer l'éclairage du clavier **SURMEN GS98** et de la
souris **Risophy PC365A**, avec un éditeur de macros avancé.

## Installer et lancer

Version distribuée : installe `Satella-Setup-X.Y.Z.exe` (releases GitHub du
dépôt MaiToxx/satella). Les **mises à jour** sont vérifiées au lancement puis
toutes les 6 heures ; leurs nouveautés se lisent avant de télécharger, et
l'installation peut être automatique (Paramètres). Après une mise à jour, un
écran « Quoi de neuf » s'affiche une fois.

Développement : `npm install` puis `npm start` dans ce dossier (Node.js requis).
Une seule instance de Satella tourne par dossier de données : pour lancer la
version de développement à côté de la version installée, donne-lui son propre
dossier (`SATELLA_USER_DATA=./donnees-dev npm start`, ou sous Windows
`set SATELLA_USER_DATA=donnees-dev && npm start`).

Tests :
- `npm test` : tests unitaires (aucun matériel ni module natif nécessaire) ;
- `npm run test:e2e` : l'application lancée pour de vrai et pilotée comme par un
  utilisateur (macros, profils, import/export, effets...), dans un dossier de
  données temporaire ; sous Linux sans écran : `xvfb-run -a npm run test:e2e`.

Publier une version (après avoir mis à jour les notes de version dans
[build/release-notes.md](build/release-notes.md), reprises dans la release
GitHub) et augmenté `version` dans package.json, au choix :
- GitHub > onglet Actions > Release > « Run workflow » sur `main` : GitHub
  Actions construit l'installeur, le publie et crée l'étiquette vX.Y.Z
  ([.github/workflows/release.yml](.github/workflows/release.yml)) ;
- ou pousser l'étiquette correspondante (`git tag v1.5.0 && git push origin v1.5.0`),
  qui lance le même workflow ;
- ou à la main : `npx electron-builder --win --publish always` (variable GH_TOKEN requise).

Pour corriger après coup le texte d'une release : modifier
`build/release-notes.md` sur `main`, puis onglet Actions > Notes de version >
« Run workflow ».

Satella ne tourne qu'en un seul exemplaire : relancer l'application
(raccourci, démarrage de Windows) réaffiche simplement la fenêtre existante.

## Fonctionnalités

### Éclairage
- **Vue clavier interactive** (page Clavier) : disposition QWERTY 98 touches du GS98.
  Clique sur une touche, glisse pour une sélection rectangle, Ctrl+clic pour
  ajouter/retirer, ou active le **mode pinceau** pour colorer touche par touche.
  Annuler / rétablir (Ctrl+Z / Ctrl+Y), couleurs récentes et préréglages
  (déplacements + flèches, rangées arc-en-ciel, dégradé, pavé numérique).
- **Vue souris** (page Souris) : 5 zones cliquables (molette, logo, bandes).
- **Effets natifs** (exécutés par le clavier, persistants) : Statique,
  Respiration, Vague (4 directions), Arc-en-ciel, Réactif à la frappe,
  Étincelles, Éteint. Vitesse et luminosité réglables.
- **Effets logiciels** (calculés par Satella et diffusés en continu via le mode
  « dynamique » du clavier, sans écriture en flash) : Onde de choc à la frappe,
  Feu, Pluie, Balayage, Tourbillon, Disco, Dégradé bicolore, **Jauge système**
  (F1-F12 = processeur, rangée des chiffres = mémoire vive), **Visualiseur
  audio** (le son joué par Windows anime le clavier, une colonne par bande de
  fréquence), **Ambiance écran** (le clavier reprend les couleurs de l'écran
  principal, zone par zone) et **Carte de chaleur** (chaque touche du bleu au
  rouge selon son utilisation, d'après les statistiques de frappe).
- **Calque** : des touches fixes par-dessus n'importe quel effet (par exemple
  ZQSD en blanc sur une vague). Avec un effet animé, Satella calcule l'effet
  elle-même et le diffuse au clavier.
- **Extinction** : bouton dans la barre latérale ou la zone de notification,
  automatique après inactivité, ou au verrouillage de la session (Windows + L).
- **Mode nuit** : sur une plage horaire (ex. 23:00 – 07:00), les LED
  s'éteignent ou baissent à la luminosité choisie, puis reviennent seules
  (« rallumer » l'emporte jusqu'à la fin de la plage).
- **Témoins Verr. Maj / Verr. Num** : la touche s'allume tant que le
  verrouillage est actif, par-dessus n'importe quel effet (le GS98 n'a pas
  de voyants).
- **Minuteur** (Accueil ou zone de notification) : la rangée F1–F12 se vide
  du vert au rouge, puis le clavier clignote et une notification s'affiche.
- **Calibration** : la carte touche/LED du GS98 est calibrée d'usine dans
  l'app ; le bouton « Calibrer la carte des touches » (page Clavier) permet
  de la refaire sur un autre exemplaire (une touche s'allume, on la presse).
- **Aperçu en temps réel** dans l'application, même sans matériel connecté
  (calculé uniquement quand il est affiché).

### Macros (page Macros)
- **Étapes** : touche (avec modificateurs), appui/relâchement séparés, texte libre
  (Unicode ; les retours à la ligne deviennent des appuis sur Entrée), délais,
  clics/mouvements/molette souris (positions absolues valables sur tous les
  écrans), **boucles imbriquées sur plusieurs niveaux**, exécution d'une autre
  macro (les appels en cycle sont refusés), **Ouvrir** un programme, un fichier
  ou un lien, **Attendre une touche** (avec délai maximum facultatif).
- **Éditeur** : glisser-déposer des étapes (y compris dans une boucle),
  annuler/rétablir (Ctrl+Z / Ctrl+Y), Ctrl+S pour sauvegarder, double-clic pour
  modifier. « Tester » joue la version affichée, même non sauvegardée.
- **Enregistreur** : capture clavier + souris en temps réel, converti en étapes
  éditables (les appuis brefs sont fusionnés en « frappes ») ; option pour
  rejouer les clics à leur position d'origine.
- **Déclencheurs globaux** : raccourci clavier système (ex. `Ctrl+Alt+1`) qui
  fonctionne dans n'importe quelle application. Re-déclencher stoppe une macro
  en boucle infinie. Un raccourci refusé (doublon, déjà pris par une autre
  application) est signalé.
- **Paramètres** : nombre de répétitions ou boucle infinie, délai entre
  répétitions, vitesse de lecture ×0.25 à ×4, pause fine après chaque étape,
  **durée d'appui** (certains jeux ignorent un appui de 0 ms) et **variation
  aléatoire** des délais.
- **Sûreté** : une macro arrêtée relâche toujours les touches et boutons
  qu'elle maintenait. Les frappes envoient le scancode matériel, reconnu par
  les jeux (DirectInput, Raw Input).
- **Expansion de texte** : une abréviation (`;mail`) se remplace par son texte
  dans n'importe quelle application. Les caractères sont lus selon la
  disposition active (AZERTY, accents, AltGr, touches mortes).
- **Mode turbo** : un raccourci démarre ou coupe la répétition d'un clic ou
  d'une touche (1 à 50 par seconde).
- **Flash du clavier** (option) au démarrage et à l'arrêt des macros et turbos.

### Profils (page Profils)
Un profil = éclairage complet + toutes les macros. Le profil **actif** suit les
modifications : chaque changement d'éclairage ou de macro y est enregistré
automatiquement. Les profils peuvent être liés à des applications (bascule
automatique selon l'application au premier plan) ; des réglages faits hors de
tout profil sont mis de côté (« Réglages non sauvegardés ») avant d'être
remplacés.

**Import / export** : un profil s'exporte en fichier `.satella` à partager ;
« Tout sauvegarder » enregistre macros, profils, abréviations, turbos, réglages
et calibration. Un fichier importé est entièrement validé (types, bornes,
longueurs) et une sauvegarde des données actuelles est faite avant toute
restauration. Des étapes « Ouvrir » (programmes, liens) dans un fichier reçu ne
sont gardées qu'avec ton accord.

### Système
- **Zone de notification** : clic pour ouvrir ; menu avec choix du profil,
  extinction des LED, activation des macros et installation d'une mise à jour
  prête.
- **Raccourcis de l'application** (Paramètres) : éteindre / rallumer les LED,
  profil suivant, luminosité + / −, tout arrêter, minuteur ; actifs dans
  toutes les applications, même macros coupées. Les conflits avec une macro
  ou un turbo sont signalés.
- **Sauvegardes automatiques** : chaque jour où quelque chose a changé,
  copie complète dans `satella-data/sauvegardes/` (10 dernières gardées),
  restaurable depuis les Paramètres.
- **Statistiques de frappe** (option) : nombre d'appuis par touche, gardé sur
  ce PC et remis à zéro en un clic ; les frappes des macros et turbos ne
  comptent pas.
- **Optimiseur mémoire** (principe MemReduct), avec nettoyage automatique au
  plus toutes les 10 minutes, qui épargne l'application au premier plan.
- **Dépannage** (page Paramètres) : rapport de diagnostic copiable, accès aux
  journaux et aux données.

## Contrôle du matériel réel — pilotage USB direct intégré

Satella embarque son **propre pilote USB** ([src/led/direct.js](src/led/direct.js)),
sans aucun logiciel tiers :

- **Clavier SURMEN GS98** : puce EVision (`320F:505B`). Paquets HID de 64 octets
  avec somme de contrôle ; l'éclairage **touche par touche** passe par le mode
  « Custom » (126 LEDs adressables), et les effets animés utilisent les
  **18 effets natifs** du clavier (vague, respiration, réactif…). Les réglages
  sont mémorisés dans le clavier lui-même (ils persistent même PC éteint).
- **Souris Risophy PC365A** : puce Areson (`25A7:FA7B`). Rapport « feature » de
  17 octets ; couleur unique pour toute la souris (limite matérielle) + modes
  natifs (statique, respiration, vague arc-en-ciel…).

La détection est automatique, y compris au branchement à chaud (scan toutes les
5 s) et à la sortie de veille ; un périphérique rebranché reçoit aussitôt les
réglages en cours. La barre latérale indique l'état de chaque périphérique.

> Les protocoles de ces puces OEM ont été documentés par la communauté
> open source (projet OpenRGB, GPL) ; Satella en est une implémentation
> indépendante et autonome, sans aucun logiciel tiers.

**Effets natifs ou flux continu ?** Chaque changement de configuration est
écrit dans la mémoire flash du clavier : Satella n'y écrit donc qu'en cas de
changement réel (jamais deux fois le même état). Les animations calculées par
Satella passent, elles, par le mode « dynamique » du clavier (commande 0x12),
qui n'écrit rien en flash ; un thread dédié n'envoie que les blocs modifiés et
entretient le mode toutes les 300 ms. Les affichages passagers (témoins,
minuteur) empruntent ce même flux ; à leur disparition, une simple sortie du
mode dynamique rend au clavier l'effet déjà enregistré, sans réécriture.

## Notes

- L'effet « Réactif », l'onde de choc, l'expansion de texte, l'enregistreur,
  l'étape « Attendre une touche » et les statistiques de frappe utilisent une
  écoute globale du clavier (uiohook), active seulement quand l'une de ces
  fonctions sert — uniquement locale, rien n'est envoyé sur le réseau.
- Les données (macros, profils, éclairage) sont stockées dans
  `%APPDATA%/satella-rgb/satella-data/` (avec une copie `.bak` de la version
  précédente de chaque fichier, et les sauvegardes automatiques dans
  `sauvegardes/`), les journaux dans `%APPDATA%/satella-rgb/logs/`.

## Architecture

```
main.js                       Processus principal Electron (assemblage + IPC)
preload.js                    Pont sécurisé UI <-> principal
src/store.js                  Persistance JSON (cache, écriture atomique, .bak)
src/shared/layout.js          Disposition GS98 + zones PC365A
src/shared/sanitize.js        Validation des fichiers importés
src/led/engine.js             Moteur d'effets (30 img/s), calque, flash
src/led/direct.js             Pilote USB direct (EVision V2 + Areson)
src/led/stream-worker.js      Thread du flux temps réel vers le clavier
src/led/hid.js                Détection USB/HID (diagnostic)
src/macros/engine.js          Déclencheurs, lecture, enregistreur
src/macros/input.js           Injection SendInput (koffi/user32)
src/macros/keys.js            Table des touches VK
src/macros/snippets.js        Expansion de texte
src/system/keyboard-layout.js Caractères selon la disposition active
src/system/foreground.js      Application au premier plan (profils)
src/system/idle.js            Inactivité (extinction automatique)
src/system/schedule.js        Plages horaires (mode nuit)
src/system/locks.js           État Verr. Maj / Verr. Num (témoins)
src/system/memory.js          Optimiseur mémoire
src/system/logger.js          Journal fichier
ui/                           Interface (HTML/CSS/JS)
test/                         Tests unitaires (node --test)
test/e2e/                     Test de bout en bout de l'application (Playwright)
```
