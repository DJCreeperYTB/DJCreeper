/**
 * Configuration publique et partageable du Shop DJCreeper.
 *
 * Ce fichier ne doit contenir aucun secret. Le Worker importe la même
 * configuration pour recalculer les montants côté serveur.
 */
export const SHOP_CONFIG = Object.freeze({
  currency: 'EUR',
  storeStatus: Object.freeze({
    mode: 'preorder-preparation',
    label: 'Statut de la boutique',
    title: 'Fabrication à la demande',
    text: 'Les vrais CD seront ajoutés progressivement, avec leurs prix, poids et disponibilités depuis la configuration centrale.'
  }),
  preorderNotice: Object.freeze({
    badge: 'BIENTÔT',
    title: 'Précommandes de CD bientôt disponibles',
    text: 'Les éditions physiques des Singles, EP et Albums de DJCreeper seront bientôt disponibles en précommande. Chaque CD sera fabriqué à la demande.'
  }),
  api: Object.freeze({
    baseUrl: 'https://djcreeper-shop-api.djcreeper-musique.workers.dev',
    allowLocalFallback: false,
    turnstileSiteKey: ''
  }),
  googleAuth: Object.freeze({
    enabled: true,
    // Le Client ID est public, mais ne doit pas être inventé. À renseigner
    // après création de l'application OAuth Google.
    clientId: '971849303504-rkb7p85jjodtgtkd27r435amfrq92r85.apps.googleusercontent.com'
  }),
  paypal: Object.freeze({
    url: 'https://paypal.me/djcreeperytb',
    accountCreationUrl: 'https://www.paypal.com/fr/cshelp/article/comment-ouvrir-un-compte-paypal%C2%A0--help315'
  }),
  loyalty: Object.freeze({
    enabled: true,
    pointsPerCent: 1,
    pointsPerEuroDiscount: 1000,
    maxCartPercentage: 30,
    shippingEarnsPoints: false,
    shippingCanBePaidWithPoints: false
  }),
  shipping: Object.freeze({
    provider: 'mondial-relay',
    mode: 'demo',
    defaultPrice: 4.90,
    currency: 'EUR',
    // Les vrais tarifs et l’API Mondial Relay seront branchés ici plus tard.
    demoPoints: Object.freeze([
      Object.freeze({
        id: 'DEMO-75001-01',
        name: 'Point Relais Démo · Safe Zone Café',
        address: '12 rue de la Démonstration',
        city: 'Paris',
        postalCode: '75001',
        price: 4.90,
        demo: true
      }),
      Object.freeze({
        id: 'DEMO-69002-02',
        name: 'Locker Démo · Creeper Station',
        address: '8 place des Pixels',
        city: 'Lyon',
        postalCode: '69002',
        price: 5.40,
        demo: true
      }),
      Object.freeze({
        id: 'DEMO-33000-03',
        name: 'Point Relais Démo · Studio Vert',
        address: '25 avenue du Signal',
        city: 'Bordeaux',
        postalCode: '33000',
        price: 4.90,
        demo: true
      })
    ])
  }),
  promoCodes: Object.freeze({
    MPD226: Object.freeze({
      code: 'MPD226',
      type: 'test-checkout',
      productIds: Object.freeze(['test-cd']),
      testOnly: true
    })
  }),
  upload: Object.freeze({
    maxBytes: 5 * 1024 * 1024,
    quotaBytes: 500 * 1024 * 1024,
    acceptedTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
    acceptedExtensions: Object.freeze(['png', 'jpg', 'jpeg', 'webp'])
  }),
  limits: Object.freeze({
    maxQuantityPerProduct: 10,
    maxMessageLength: 2000,
    maxSubjectLength: 160,
    maxNameLength: 80,
    maxEmailLength: 254
  }),
  products: Object.freeze([
    Object.freeze({
      id: 'test-cd',
      name: 'Test',
      type: 'test',
      price: 100000,
      weight: 0,
      image: 'assets/CD-TEST-1.png',
      images: Object.freeze(['assets/CD-TEST-1.png', 'assets/CD-TEST-2.png', 'assets/CD-TEST-3.png']),
      description: 'Produit utilisé uniquement pour tester le fonctionnement de la boutique.',
      available: true,
      preorder: false,
      testProduct: true,
      badge: 'PRODUIT DE TEST'
    })
  ])
})

export default SHOP_CONFIG
