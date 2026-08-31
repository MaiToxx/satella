# Satella — Contrôle RGB & Macros

Application de bureau pour gérer l'éclairage du clavier **SURMEN GS98** et de la
souris **Risophy PC365A**, avec un éditeur de macros avancé.

## Installer et lancer

Version distribuée : installe `Satella-Setup-X.Y.Z.exe` (releases GitHub du
dépôt MaiToxx/satella). Les **mises à jour sont automatiques** : le bouton
« Vérifier les mises à jour » (page Accueil) télécharge la nouvelle version
et l'installe au redémarrage de l'app.

Développement : `npm install` puis `npm start` dans ce dossier (Node.js requis).
Publier une version : bump de `version` dans package.json, puis
`npx electron-builder --win --publish always` (variable GH_TOKEN requise).

## Fonctionnalités

### Éclairage
- **Vue clavier interactive** (page Clavier) : disposition QWERTY 98 touches du GS98.
  Clique sur une touche, glisse pour une sélection rectangle, Ctrl+clic pour
  ajouter/retirer, ou active le **mode pinceau** pour colorer touche par touche.
- **Vue souris** (page Souris) : 5 zones cliquables (molette, logo, bandes).
- **Effets natifs** (exécutés par le clavier, persistants) : Statique,
  Respiration, Vague (4 directions), Arc-en-ciel, Réactif à la frappe,
  Étincelles, Éteint. Vitesse et luminosité réglables.
- **Effets logiciels** (calculés par Satella et diffusés en continu, sans
  écriture en flash) : Onde de choc à la frappe, Feu, Pluie, Balayage,
  Tourbillon, Disco, Dégradé bicolore.
- **Calibration** : la carte touche/LED du GS98 est calibrée d'usine dans
  l'app ; le bouton « Calibrer la carte des touches » (page Clavier) permet
  de la refaire sur un autre exemplaire (une touche s'allume, on la presse).
- **Aperçu en temps réel** dans l'application, même sans matériel connecté.

### Macros (page Macros)
- **Étapes** : touche (avec modificateurs), appui/relâchement séparés, texte libre
  (Unicode), délais, clics/mouvements/molette souris, **boucles imbriquées**,
  exécution d'une autre macro.
- **Enregistreur** : capture clavier + souris en temps réel, converti en étapes
  éditables (les appuis brefs sont fusionnés en « frappes »).
- **Déclencheurs globaux** : raccourci clavier système (ex. `Ctrl+Alt+1`) qui
  fonctionne dans n'importe quelle application. Re-déclencher stoppe une macro
  en boucle infinie.
- **Paramètres** : nombre de répétitions ou boucle infinie, délai entre
  répétitions, vitesse de lecture ×0.25 à ×4, pause fine après chaque étape.

### Profils (page Profils)
Un profil = éclairage complet + toutes les macros. Sauvegarde, chargement,
suppression.

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
5 s). Le badge de la barre latérale affiche « USB direct ✔ (n/2) ».

> Les protocoles de ces puces OEM ont été documentés par la communauté
> open source (projet OpenRGB, GPL) ; Satella en est une implémentation
> indépendante et autonome, sans aucun logiciel tiers.

**Pourquoi pas d'animation fluide envoyée en continu ?** Le clavier sauvegarde
chaque écriture en mémoire flash : un flux à 30 img/s l'userait prématurément.
Satella programme donc l'effet natif équivalent une seule fois — l'aperçu dans
l'application, lui, reste animé.

## Notes

- L'effet « Réactif » et l'enregistreur de macros utilisent une écoute globale
  du clavier (uiohook) — uniquement locale, rien n'est envoyé sur le réseau.
- Les données (macros, profils, éclairage) sont stockées dans
  `%APPDATA%/satella-rgb/satella-data/`.

## Architecture

```
main.js                  Processus principal Electron (assemblage + IPC)
preload.js               Pont sécurisé UI <-> principal
src/shared/layout.js     Disposition GS98 + zones PC365A
src/led/engine.js        Moteur d'effets (30 img/s)
src/led/hid.js           Détection USB/HID (diagnostic)
src/macros/engine.js     Déclencheurs, lecture, enregistreur
src/macros/input.js      Injection SendInput (koffi/user32)
src/macros/keys.js       Table des touches VK
ui/                      Interface (HTML/CSS/JS)
```
