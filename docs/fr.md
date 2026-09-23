# Intégration Yoto

Cette intégration remonte l'état de vos lecteurs **Yoto** dans Gladys :
batterie, charge, volume, carte en cours de lecture, luminosité ambiante,
température de l'appareil, signal Wi-Fi et présence en ligne.

## Ce que vous obtenez

Un appareil Gladys par lecteur Yoto du compte, avec neuf capteurs en lecture
seule. L'API publique Yoto expose la télémétrie des lecteurs mais pas les
commandes de lecture (play, pause, volume) : rien n'est donc pilotable depuis
Gladys, et les capteurs sont déclarés en lecture seule pour ne pas afficher de
bouton inopérant.

En plus des appareils : deux widgets de tableau de bord, trois déclencheurs et
deux actions de scène (voir plus bas).

## Prérequis

Gladys Assistant **5.1** ou plus récent.

Une application sur le portail développeur Yoto (gratuit) :

1. Ouvrez <https://dashboard.yoto.dev/> et créez une application de type
   **client public**.
2. Activez les scopes `family:devices:view`, `family:devices:control`,
   `family:library:view` et `offline_access`.
3. Notez le **Client ID**.

Yoto a abandonné le flux _device code_ : l'intégration utilise le flux
navigateur désormais recommandé (authorization code + PKCE). L'application doit
donc aussi autoriser l'URL de rappel Gladys dans ses **Allowed callback URLs**
— voir ci-dessous.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Collez le **Client ID Yoto** et enregistrez.
3. Cliquez une première fois sur **Connecter**, puis ouvrez les logs de
   l'intégration : la ligne `Yoto sign-in started, callback URL to allow on the
Yoto app: …` donne l'URL exacte à coller dans les **Allowed callback URLs**
   de votre application Yoto.
4. Cliquez de nouveau sur **Connecter** : identifiez-vous sur la page Yoto,
   Yoto redirige vers Gladys et le badge de connexion passe au vert.
5. Les lecteurs apparaissent dans l'onglet **Découverte**, prêts à être
   ajoutés.

Réglages disponibles :

- **Intervalle de rafraîchissement** (`poll_frequency`) — de 30 à 3600
  secondes, 120 par défaut. C'est la fréquence à laquelle chaque lecteur est
  lu. L'API Yoto est une API cloud : restez au-dessus de 60 secondes sauf
  besoin réel. Gladys planifie sur des cadences fixes (60 secondes au plus
  lent) : une valeur entre 30 et 59 secondes passe par la cadence 30 secondes,
  et au-delà de 60 secondes c'est l'intégration qui respecte l'intervalle. Le
  changement est pris en compte immédiatement, sans recréer les appareils.
- **Demander au lecteur de se rafraîchir avant lecture** — envoie une demande
  de statut au lecteur avant chaque interrogation, pour lire des valeurs
  fraîches plutôt que les dernières remontées. Décochez si votre application
  Yoto n'a pas le scope `family:devices:control`.

Les jetons d'accès sont conservés par Gladys en interne (jamais affichés dans
l'interface) : la liaison survit à un redémarrage ou à une mise à jour de
l'image.

## Actions

- **Tester la connexion** — interroge le compte Yoto et affiche le nombre de
  lecteurs trouvés, avec leurs noms.
- **Rafraîchir tous les lecteurs** — force une interrogation immédiate de tous
  les lecteurs, sans attendre le prochain cycle.

## Widgets du tableau de bord

Nécessite Gladys 5.1 ou plus récent. Ajoutez-les depuis l'éditeur du tableau
de bord :

- **Lecteurs Yoto** — tous les lecteurs du compte dans une seule carte : la
  carte en cours de lecture, le niveau de batterie (vert, orange sous 50 %,
  rouge sous 20 %, un ⚡ quand il est branché) et s'il est en ligne. Touchez
  une ligne pour le détail (volume, température, luminosité, Wi-Fi).
- **Lecteur Yoto** — un seul lecteur, choisi dans les réglages du widget :
  batterie, volume et température mis à jour en direct, la courbe de batterie
  des dernières 24 heures, et l'état de lecture, d'alimentation et de
  connexion.

Les deux ont un bouton **Rafraîchir** qui lit les lecteurs tout de suite. Les
widgets affichent la dernière lecture : ouvrir un tableau de bord n'interroge
jamais Yoto.

## Scènes

Nécessite Gladys 5.1 ou plus récent.

Déclencheurs (le filtre **Lecteur** est facultatif : vide = n'importe quel
lecteur) :

- **Une carte démarre sur un lecteur Yoto** — filtre facultatif sur le titre
  exact de la carte. Variables : nom du lecteur, titre de la carte,
  identifiant de la carte.
- **Un lecteur Yoto arrête la lecture** — variables : nom du lecteur, titre et
  identifiant de la carte qui jouait.
- **Batterie faible d'un lecteur Yoto (sous 20 %)** — se déclenche une fois
  quand la batterie passe sous 20 % alors que le lecteur n'est pas branché ;
  ne se redéclenche qu'après une charge (ou un retour au-dessus de 25 %).
  Variables : nom du lecteur, niveau de batterie.

Les événements sont détectés à chaque rafraîchissement (toutes les 120 s par
défaut) : un déclencheur peut donc arriver avec jusqu'à un intervalle de
retard. Rien ne se déclenche à la première lecture après un redémarrage.

Actions :

- **Lire un lecteur Yoto** — lit le lecteur maintenant et passe ses valeurs aux
  étapes suivantes : nom, en ligne, batterie, sur secteur, volume, en lecture,
  titre de la carte, température, signal Wi-Fi. Pratique pour une condition
  (« si la batterie est sous 30 %, envoyer un message ») ou un message
  (« {{player_name}} joue {{card_title}} »).
- **Rafraîchir tous les lecteurs Yoto** — lit tous les lecteurs maintenant ;
  renvoie le nombre de lecteurs lus.

Lancer une carte, mettre en pause ou changer le volume depuis Gladys n'est pas
possible : l'API publique Yoto ne propose pas ces commandes (elles passent par
un canal privé de Yoto).

## Dépannage

- **« Aucun compte Yoto lié : cliquez sur Connecter »** — le Client ID est
  renseigné mais la liaison n'a pas encore été faite, ou elle a expiré.
- **« La liaison Yoto a expiré, reconnectez votre compte »** — le jeton a été
  révoqué (mot de passe changé, application supprimée côté Yoto). Cliquez de
  nouveau sur **Connecter**.
- **Yoto répond « Callback URL mismatch »** — l'URL affichée par Yoto est celle
  de rappel Gladys : ajoutez-la dans les **Allowed callback URLs** de votre
  application Yoto, puis recliquez sur **Connecter**.
- **« Impossible de lancer la connexion Yoto : … »** — la raison exacte est dans
  le message et dans les logs. Un `unauthorized_client` sur l'endpoint device
  code signifie que l'application Yoto n'a pas ce grant : Yoto l'a abandonné,
  mettez Gladys à jour pour que le flux navigateur soit utilisé.
- **« Aucune connexion Yoto en cours »** — l'intégration a redémarré entre le
  clic sur **Connecter** et le retour de Yoto ; recliquez sur **Connecter**.
- **Valeurs figées ou manquantes** — un lecteur éteint ou hors ligne ne remonte
  plus rien : l'intégration publie alors le dernier état connu et le capteur
  « En ligne » passe à 0. Les capteurs absents d'un modèle (température sur un
  Yoto Mini par exemple) ne sont simplement pas publiés.
- **Erreur 401/403 dans les logs** — les scopes de votre application Yoto sont
  incomplets. Vérifiez-les sur le portail développeur, puis reconnectez le
  compte.

L'intégration journalise tout ce qu'elle fait : consultez les logs depuis
l'interface Gladys (ou `docker logs` sur l'hôte) avec `LOG_LEVEL=debug` pour le
détail complet.
