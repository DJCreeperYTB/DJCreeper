// Configuration réservée au Worker. Ce fichier ne doit jamais être importé par
// les pages publiques. Il ne contient pas de secret : les secrets vont dans
// `wrangler secret put`.
const WORKER_CONFIG = Object.freeze({
  sellerStatus: Object.freeze({
    mode: 'available',
    labels: Object.freeze({
      available: 'Vendeur disponible',
      busy: 'Vendeur occupé',
      unavailable: 'Aucun vendeur disponible'
    })
  })
})

export default WORKER_CONFIG
