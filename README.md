# DJCreeper — site et boutique

Le site reste statique et conserve ses pages existantes. Le Shop ajoute une architecture de précommande de CD, un panier, un checkout et un support client. Les vrais Singles, EP et Albums ne sont pas encore publiés : le catalogue contient volontairement un seul produit de test.

## Architecture

- `shop.html` : boutique, panier, checkout, Mondial Relay de démonstration et formulaire de support.
- `config/shop-config.js` : configuration centrale publique partagée par le frontend et le Worker. Elle contient les produits, prix, poids, disponibilité, promo de test, livraison, PayPal et fidélité. Elle ne doit contenir aucun secret ni statut opérationnel vendeur.
- `js/shop.js` : logique isolée du Shop. Le panier utilise uniquement `localStorage` pour des références produit et des quantités. Les données client, tickets et captures restent en mémoire dans le mode local.
- `css/shop.css` : composants visuels propres au Shop, construits avec les variables et cartes du site existant.
- `worker/src/index.js` : API Cloudflare Workers optionnelle, avec validation serveur, sanitation, limitation de débit, Turnstile optionnel, jetons d’accès privés pour les tickets et stockage D1/R2.
- `worker/src/worker-config.js` : configuration côté Worker du statut vendeur ; elle n’est pas chargée par `shop.html`.
- `worker/src/mondial-relay-adapter.js` : adaptateur isolé pour les points relais, en mode démonstration aujourd’hui et prêt pour l’API officielle plus tard.
- `worker/schema.sql` : tables D1 pour commandes, tickets, historique, compteurs et quota R2.
- `worker/wrangler.toml` : bindings D1/R2/KV de production ; `PUBLIC_ORIGIN` reste temporairement local jusqu’à réception du domaine Pages.

Le navigateur ne communique jamais avec un PC vendeur. La cible est :

```text
Client → Cloudflare Pages → Cloudflare Worker → D1 / R2 / KV
Application vendeur → connexions sortantes vers Cloudflare
```

## Lancer le site en local

Le mode local du Shop est actif tant que `api.baseUrl` est vide. Il permet de tester tout le parcours sans paiement réel ni backend :

```text
python -m http.server 8787
```

Puis ouvrir `http://localhost:8787/shop.html`. Un serveur HTTP est nécessaire pour les imports JavaScript ES modules ; ouvrir directement le fichier HTML peut bloquer ces imports dans le navigateur.

Scénario de test :

1. Ajouter `Test` à `100 000,00 €` au panier.
2. Appliquer un mauvais code pour voir un message drôle, puis appliquer `MPD226`.
3. Cliquer sur `VALIDER MON PANIER`.
4. Remplir nom, prénom, e-mail et consentement.
5. Choisir un relais de démonstration, puis vérifier le récapitulatif.
6. Passer l’étape paiement avec le bouton de mode test. Une capture PNG/JPG/JPEG/WEBP de 5 Mo maximum peut être jointe facultativement.
7. Vérifier le numéro de commande, le ticket `DJC-xxxxxx`, les messages automatiques et l’envoi d’un nouveau message.

Dans le mode local, les tickets sont volontairement limités à la session courante. Le panier survit à un rafraîchissement ; aucune information personnelle ou capture de paiement n’est enregistrée dans `localStorage`.

Le Worker bloque chaque preuve au-delà de 5 Mo et réserve atomiquement ses octets dans `storage_usage` avant l’écriture R2. Le plafond applicatif du bucket est de 500 MiB (`524 288 000` octets). Le bucket doit être écrit uniquement par ce Worker ; si des objets y existent déjà, leur taille doit être réconciliée dans `storage_usage` avant l’ouverture des commandes.

## Produits et prix

Les produits sont ajoutés dans `config/shop-config.js`, sans modifier `shop.html`. Chaque fiche comprend notamment :

```js
{
  id: 'single-exemple',
  name: 'Nom du Single',
  type: 'single',
  price: 6,
  weight: 80,
  image: 'assets/shop/single-exemple-1.jpg',
  images: [
    'assets/shop/single-exemple-1.jpg',
    'assets/shop/single-exemple-2.jpg',
    'assets/shop/single-exemple-3.jpg'
  ],
  description: 'Description courte.',
  available: true,
  preorder: true,
  testProduct: false,
  badge: 'PRÉCOMMANDE'
}
```

- Single normal : `6`.
- EP normal : `9`.
- Album normal : `13`.
- `weight` est exprimé en grammes et est prêt à servir au futur calcul de poids.
- `available: false` masque l’ajout au panier.
- `preorder: true` permet d’identifier une précommande.
- `images` contient jusqu’à trois vues du CD ; la première est utilisée comme image principale et les autres comme miniatures.
- Aucun vrai produit CD n’est actuellement ajouté.

Pour ajouter un Single, un EP ou un Album, ajouter un objet à `SHOP_CONFIG.products` avec un nouvel `id`, puis vérifier son texte, son image, son poids et sa disponibilité. Le Worker recalculera le montant depuis cette même configuration : le prix transmis par le navigateur ne fait pas autorité.

Les tarifs de livraison sont centralisés dans `SHOP_CONFIG.shipping`. La fidélité est préparée mais désactivée :

```js
loyalty: { enabled: false, pointsPerEuro: 10, eurosPerHundredPoints: 1, maxCartPercentage: 30 }
```

## Promo de test

`MPD226` est déclaré dans `SHOP_CONFIG.promoCodes` avec `testOnly: true` et une liste de produits autorisés contenant uniquement `test-cd`. Il ne peut donc pas réduire automatiquement un futur CD. Toute autre saisie affiche l’un des messages d’erreur humoristiques. Le Worker applique la même restriction côté serveur.

## Checkout, PayPal et preuve de paiement

Le checkout comporte les étapes Panier, Informations, Livraison, Paiement et Confirmation. Le bouton PayPal ouvre uniquement `https://paypal.me/djcreeperytb` dans un nouvel onglet. Le site ne demande jamais d’identifiant PayPal ni d’information bancaire. Le lien de création de compte PayPal est également externe.

Pour une vraie commande, le client indique son retour depuis PayPal et joint une capture autorisée de 5 Mo maximum. La capture n’est jamais une preuve automatique : le paiement reste `À VÉRIFIER` et le ticket reste soumis à une vérification manuelle.

## Mondial Relay

`SHOP_CONFIG.shipping` contient actuellement trois points fictifs avec l’identifiant, le nom, l’adresse, la ville, le code postal et le tarif. L’interface les marque `Donnée de démonstration` et l’adaptateur ne contacte aucune API officielle.

Pour brancher Mondial Relay plus tard :

1. Compléter l’adaptateur côté Worker (`worker/src/mondial-relay-adapter.js`) pour appeler l’API officielle depuis le serveur.
2. Mettre les identifiants requis dans des secrets Cloudflare, jamais dans `config/shop-config.js` ou un fichier public.
3. Remplacer la recherche de démonstration par l’appel de l’adaptateur, puis renvoyer au frontend uniquement les points nécessaires.
4. Recalculer et valider le tarif côté Worker ; ne jamais faire confiance au prix envoyé par le navigateur.

## Tickets et sécurité

Une commande crée un ticket lié à la commande. Une demande support sans commande peut aussi créer un ticket avec e-mail, sujet, catégorie et message. Les messages automatiques sont séparés visuellement des messages client. Les numéros seuls ne permettent pas de lire un ticket : le Worker rend un jeton d’accès opaque à la création et exige ce jeton pour envoyer un message.

Le Worker prévoit :

- validation et sanitation côté serveur ;
- validation stricte des produits, quantités, promo, relais, e-mail et consentement ;
- vérification de taille, type MIME et signature PNG/JPEG/WEBP pour les captures ;
- nom de stockage R2 généré par le serveur ;
- rate limiting pour commandes, tickets et messages via KV, avec repli mémoire en développement ;
- Turnstile activable avec `TURNSTILE_SECRET_KEY` ;
- clé publique Turnstile prévue dans `SHOP_CONFIG.api.turnstileSiteKey` lorsqu’un widget sera ajouté ;
- absence de route publique de lecture d’un ticket par numéro seul ;
- aucun secret, token privé, IP, port, nom d’ordinateur ou adresse locale dans le frontend.

## Panel vendeur privé et e-mails

Le panel est volontairement séparé du dépôt public, dans `C:\Users\DJCre\Documents\code\DJCreeper Admin Panel`. Il contient `admin.html`, `admin.js`, `admin.css` et `admin-config.js`. Il permet de filtrer les tickets, consulter leur fiche, répondre au client, vérifier une preuve R2 et modifier l’état du ticket ou de la commande.

Le statut « Vendeur disponible / Vendeur occupé / Aucun vendeur disponible » est réservé au panel. Il n’est plus chargé par `shop.html`. Les informations d’état de commande sont également réservées au panel vendeur.

L’adaptateur `worker/src/email-adapter.js` est prêt pour les e-mails transactionnels via Resend : création d’un ticket, réponse vendeur et chaque changement d’état d’une commande. Les e-mails sont envoyés en tâche différée ; un échec d’e-mail ne supprime pas une commande déjà enregistrée. Sans fournisseur configuré, aucune tentative d’envoi n’est effectuée.

Resend demande une clé API, un expéditeur provenant d’un domaine vérifié et un appel HTTPS vers son API ; la clé reste exclusivement dans un secret Wrangler. [Documentation officielle Resend pour Cloudflare Workers](https://resend.com/docs/send-with-cloudflare-workers) et [API d’envoi](https://resend.com/docs/api-reference/emails/send-email).

## Activer Cloudflare

Le backend n’est pas déployé dans ce dépôt. Pour le préparer :

1. Installer les dépendances dans `worker/` (`npm install`).
2. Créer une base D1 puis exécuter `worker/schema.sql` avec Wrangler.
   Si la base avait déjà reçu l’ancien schéma, exécuter une seule fois `worker/migrations/0002_order_status.sql` avant de déployer le Worker mis à jour.
3. Créer un bucket R2 privé pour `PAYMENT_PROOFS`.
4. Créer un namespace KV pour `RATE_LIMIT_KV`.
5. Les bindings de production sont déjà renseignés dans `worker/wrangler.toml`. Vérifier qu’ils correspondent bien aux ressources du compte avant la première exécution distante.
6. Remplacer `PUBLIC_ORIGIN` par le domaine Cloudflare Pages et passer `ALLOW_LOCAL_DEMO` à `false`.
7. Ajouter les secrets uniquement avec Wrangler, par exemple `wrangler secret put TURNSTILE_SECRET_KEY` si Turnstile est activé.
8. Pour les e-mails, définir les variables non secrètes `EMAIL_PROVIDER=resend`, `EMAIL_FROM="DJCreeper <support@ton-domaine.fr>"` et éventuellement `EMAIL_REPLY_TO`, puis enregistrer la clé avec `npx wrangler secret put EMAIL_API_KEY`.
9. Protéger `/admin.html` et `/api/admin/*` avec Cloudflare Access, puis renseigner `CF_ACCESS_TEAM_DOMAIN` et `CF_ACCESS_AUDIENCE` dans les variables du Worker. Ajouter éventuellement `npx wrangler secret put ADMIN_ALLOWED_EMAILS`.
10. Déployer le Worker, puis renseigner son URL publique dans `admin-config.js` et, pour le Shop public, dans `SHOP_CONFIG.api.baseUrl`.

Commandes recommandées depuis le dossier `worker/` :

```text
npm install
npx wrangler d1 execute djcreeper-shop --remote --file=schema.sql --config=wrangler.toml
# seulement pour une base déjà initialisée avant l’ajout du suivi de commande :
npx wrangler d1 execute djcreeper-shop --remote --file=migrations/0002_order_status.sql --config=wrangler.toml
npx wrangler r2 bucket list
npx wrangler kv namespace list
npx wrangler secret put EMAIL_API_KEY
npx wrangler secret put ADMIN_ALLOWED_EMAILS
```

Si le bucket n’existe pas encore, le créer une seule fois avec `npx wrangler r2 bucket create djcreeper-payment-proofs --config=wrangler.toml`. Ne pas exécuter le déploiement public tant que le domaine Pages n’est pas connu. Après réception de ce domaine, déployer avec `npx wrangler deploy --config=wrangler.toml --var PUBLIC_ORIGIN:https://TON-DOMAINE-PAGES` puis renseigner l’URL du Worker dans la configuration publique du Shop.

Pour lancer explicitement le Worker en mode mémoire local, utiliser `npx wrangler dev --var ALLOW_LOCAL_DEMO:true`. Cette option ne doit pas être utilisée en production ; les tickets doivent alors passer par D1.

Les identifiants D1, R2, KV et les secrets ne sont pas fournis dans Git. Tant que le Worker n’est pas configuré, le mode local permet de tester l’interface, mais il ne doit pas servir à traiter de vraies commandes.

## Fichiers modifiés et ajoutés

Modifiés : `events.html`, `index.html`, `shop.html`, `js/shop.js`, `css/shop.css`, `config/shop-config.js`, `worker/src/index.js`, `worker/schema.sql`, `worker/wrangler.toml`, `README.md`.

Ajoutés dans le dépôt du site : `worker/src/mondial-relay-adapter.js`, `worker/src/worker-config.js`, `worker/src/email-adapter.js`, `worker/migrations/0002_order_status.sql`, `worker/package.json`.

Ajoutés hors dépôt GitHub, dans `C:\Users\DJCre\Documents\code\DJCreeper Admin Panel` : `admin.html`, `admin.js`, `admin.css`, `admin-config.js`, `README.md`.
