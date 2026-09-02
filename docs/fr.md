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

## Prérequis

Une application sur le portail développeur Yoto (gratuit) :

1. Ouvrez <https://dashboard.yoto.dev/> et créez une application de type
   **client public** avec le **device code flow**.
2. Activez les scopes `family:devices:view`, `family:devices:control`,
   `family:library:view` et `offline_access`.
3. Notez le **Client ID**.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Collez le **Client ID Yoto** et enregistrez.
3. Cliquez sur **Connecter** : Yoto affiche une page avec un code à valider
   avec votre compte. Une fois validé, le badge de connexion passe au vert.
4. Les lecteurs apparaissent dans l'onglet **Découverte**, prêts à être
   ajoutés.

Réglages disponibles :

- **Intervalle de rafraîchissement** (`poll_frequency`) — de 30 à 3600
  secondes, 120 par défaut. C'est la fréquence à laquelle Gladys interroge
  chaque lecteur. L'API Yoto est une API cloud : restez au-dessus de 60
  secondes sauf besoin réel. Le changement est pris en compte immédiatement,
  sans recréer les appareils.
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

## Dépannage

- **« Aucun compte Yoto lié : cliquez sur Connecter »** — le Client ID est
  renseigné mais la liaison n'a pas encore été faite, ou elle a expiré.
- **« La liaison Yoto a expiré, reconnectez votre compte »** — le jeton a été
  révoqué (mot de passe changé, application supprimée côté Yoto). Cliquez de
  nouveau sur **Connecter**.
- **Le code n'a pas été validé à temps** — le code Yoto n'est valable que
  quelques minutes ; relancez la liaison.
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
