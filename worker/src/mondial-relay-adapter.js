import SHOP_CONFIG from '../../config/shop-config.js'

/**
 * Adaptateur Mondial Relay.
 *
 * Le mode demo ne fait aucun appel réseau. Quand les identifiants officiels
 * seront disponibles, la branche `official` pourra appeler l’API depuis le
 * Worker sans exposer ses secrets au navigateur.
 */
export function canonicalRelay(relay) {
  if (!relay || SHOP_CONFIG.shipping.mode !== 'demo') return null
  const point = SHOP_CONFIG.shipping.demoPoints.find(item => item.id === String(relay.id || '').trim())
  if (!point) throw new Error('Point Relais invalide.')
  return { ...point }
}

export async function searchRelays(query, env) {
  const normalized = String(query || '').trim().toLowerCase()
  if (SHOP_CONFIG.shipping.mode === 'demo') {
    return SHOP_CONFIG.shipping.demoPoints.filter(point => !normalized || [point.name, point.address, point.city, point.postalCode, point.id].join(' ').toLowerCase().includes(normalized))
  }
  if (!env.MONDIAL_RELAY_API_URL) throw new Error('Adaptateur Mondial Relay officiel non configuré.')
  // TODO: appeler ici l’API officielle avec les secrets stockés dans les
  // variables privées du Worker, puis normaliser sa réponse vers ce format.
  throw new Error('Adaptateur Mondial Relay officiel non configuré.')
}
