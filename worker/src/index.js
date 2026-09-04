import SHOP_CONFIG from '../../config/shop-config.js'
import { canonicalRelay } from './mondial-relay-adapter.js'

const memoryTickets = new Map()
const memoryCounters = { ticket: 0, order: 0 }
const memoryRateLimits = new Map()
const ALLOWED_CATEGORIES = new Set(['Question avant achat', 'Commande', 'Paiement', 'Livraison', 'Produit', 'Problème technique', 'Autre'])
const MAX_JSON_BYTES = 10 * 1024 * 1024

function configuredOrigins(env) {
  return String(env.PUBLIC_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean)
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  const allowed = configuredOrigins(env)
  return !allowed.length || allowed.includes(origin)
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin')
  const headers = {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  }
  if (origin && originAllowed(request, env)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(request, env) })
}

function fail(message, status, request, env) {
  return json({ error: message }, status, request, env)
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength)
}

function validEmail(value) {
  const email = cleanText(value, SHOP_CONFIG.limits.maxEmailLength).toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0)
  if (contentLength > MAX_JSON_BYTES) throw new Error('Requête trop volumineuse.')
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error('Requête trop volumineuse.')
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch (error) { throw new Error('JSON invalide.') }
}

async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function rateLimit(request, env, scope, limit, windowMs) {
  const address = request.headers.get('CF-Connecting-IP') || 'anonymous'
  const key = `${scope}:${await hash(address)}`
  const now = Date.now()
  if (env.RATE_LIMIT_KV) {
    const current = await env.RATE_LIMIT_KV.get(key, 'json')
    if (current && current.expiresAt > now && current.count >= limit) return false
    const next = current && current.expiresAt > now ? { count: current.count + 1, expiresAt: current.expiresAt } : { count: 1, expiresAt: now + windowMs }
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(next), { expirationTtl: Math.ceil(windowMs / 1000) })
    return true
  }
  const current = memoryRateLimits.get(key)
  if (!current || current.expiresAt <= now) {
    memoryRateLimits.set(key, { count: 1, expiresAt: now + windowMs })
    return true
  }
  if (current.count >= limit) return false
  current.count += 1
  return true
}

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET_KEY) return true
  if (!token) return false
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token })
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
  if (!response.ok) return false
  const result = await response.json()
  return Boolean(result.success)
}

function testPromoApplies(code, items) {
  const normalized = cleanText(code, 32).toUpperCase()
  const promo = SHOP_CONFIG.promoCodes[normalized]
  return Boolean(promo && promo.testOnly && items.length && items.every(item => promo.productIds.includes(item.productId) && productById(item.productId)?.testProduct))
}

function productById(id) {
  return SHOP_CONFIG.products.find(product => product.id === id)
}

function decodeProof(proof) {
  if (!proof) return null
  if (typeof proof !== 'object' || typeof proof.dataUrl !== 'string') throw new Error('Capture de paiement invalide.')
  const match = proof.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/)
  if (!match) throw new Error('Format de capture refusé.')
  const mimeType = match[1]
  const binary = atob(match[2])
  if (binary.length > SHOP_CONFIG.upload.maxBytes) throw new Error('Capture trop volumineuse.')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const isPng = mimeType === 'image/png' && bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])
  const isJpeg = mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const isWebp = mimeType === 'image/webp' && bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  if (!isPng && !isJpeg && !isWebp) throw new Error('Signature de fichier image invalide.')
  return { bytes, mimeType, size: binary.length, fileName: cleanText(proof.filename, 120) || 'capture-image' }
}

async function storeProof(env, ticketNumber, proof) {
  if (!proof) return null
  if (env.DB && !env.PAYMENT_PROOFS) throw new Error('Le stockage des preuves de paiement n’est pas configuré.')
  if (env.PAYMENT_PROOFS && !env.DB) throw new Error('Le quota R2 nécessite le stockage D1.')
  if (!env.PAYMENT_PROOFS) return { fileName: proof.fileName, mimeType: proof.mimeType, size: proof.size }
  const extension = proof.mimeType === 'image/png' ? 'png' : proof.mimeType === 'image/webp' ? 'webp' : 'jpg'
  const key = `payment-proofs/${ticketNumber}/${crypto.randomUUID()}.${extension}`
  const reserved = await reserveProofQuota(env, proof.size)
  try {
    await env.PAYMENT_PROOFS.put(key, proof.bytes, { httpMetadata: { contentType: proof.mimeType } })
  } catch (error) {
    if (reserved) await releaseProofQuota(env, proof.size)
    throw new Error('Impossible de stocker la preuve de paiement.')
  }
  return { fileName: proof.fileName, mimeType: proof.mimeType, size: proof.size, storageKey: key }
}

async function reserveProofQuota(env, byteLength) {
  const quota = SHOP_CONFIG.upload.quotaBytes
  const result = await env.DB.prepare('UPDATE storage_usage SET used_bytes = used_bytes + ? WHERE id = 1 AND used_bytes + ? <= quota_bytes AND quota_bytes = ?').bind(byteLength, byteLength, quota).run()
  if (Number(result.meta?.changes || 0) !== 1) throw new Error('Quota R2 dépassé.')
  return true
}

async function releaseProofQuota(env, byteLength) {
  await env.DB.prepare('UPDATE storage_usage SET used_bytes = MAX(0, used_bytes - ?) WHERE id = 1').bind(byteLength).run()
}

function validateCustomer(customer, requireNames = true) {
  if (!customer || typeof customer !== 'object') throw new Error('Informations client manquantes.')
  const result = {
    firstName: cleanText(customer.firstName, SHOP_CONFIG.limits.maxNameLength),
    lastName: cleanText(customer.lastName, SHOP_CONFIG.limits.maxNameLength),
    email: validEmail(customer.email),
    phone: cleanText(customer.phone, 30)
  }
  if (!result.email || (requireNames && (!result.firstName || !result.lastName))) throw new Error('Informations client invalides.')
  return result
}

function calculateOrder(payload) {
  if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('Panier vide.')
  const items = payload.items.map(raw => {
    const productId = cleanText(raw?.productId, 80)
    const product = productById(productId)
    const quantity = Number.parseInt(raw?.quantity, 10)
    if (!product || !product.available || !Number.isInteger(quantity) || quantity < 1 || quantity > SHOP_CONFIG.limits.maxQuantityPerProduct) throw new Error('Produit ou quantité invalide.')
    return { id: product.id, name: product.name, quantity, price: product.price, weight: product.weight }
  })
  const subtotal = items.reduce((total, item) => total + item.price * item.quantity, 0)
  const testMode = testPromoApplies(payload.promoCode, items.map(item => ({ productId: item.id })))
  const suppliedPromo = cleanText(payload.promoCode, 32).toUpperCase()
  if (suppliedPromo && !testMode) throw new Error('Code promo invalide pour ce panier.')
  const relay = canonicalRelay(payload.relay)
  if (!relay) throw new Error('Point Relais invalide.')
  const quotedShipping = relay ? relay.price : 0
  const discount = testMode ? subtotal : 0
  const shipping = testMode ? 0 : quotedShipping
  return {
    items,
    relay,
    testMode,
    promoCode: testMode ? suppliedPromo : '',
    subtotal,
    discount,
    quotedShipping,
    shipping,
    total: Math.max(0, subtotal - discount + shipping)
  }
}

async function nextNumber(env, type) {
  if (!env.DB) {
    memoryCounters[type] += 1
    return memoryCounters[type]
  }
  try {
    const row = await env.DB.prepare('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value').bind(type).first()
    return Number(row.value)
  } catch (error) {
    await env.DB.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)').bind(type).run()
    await env.DB.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').bind(type).run()
    const row = await env.DB.prepare('SELECT value FROM counters WHERE name = ?').bind(type).first()
    return Number(row.value)
  }
}

function automaticHistory(ticketNumber, sellerMode) {
  const available = sellerMode === 'available'
  return [
    { author: 'support', automated: true, createdAt: new Date().toISOString(), body: `Bonjour !\n\nTa demande a bien été reçue.\n\nUn vendeur va la consulter dès que possible.\n\nTicket : #${ticketNumber}` },
    { author: 'support', automated: true, createdAt: new Date().toISOString(), body: available ? 'Un vendeur est actuellement disponible. Ta demande devrait être traitée rapidement.' : 'Aucun vendeur n’est disponible pour le moment.\n\nPas d’inquiétude : ta demande est bien enregistrée et sera traitée dès qu’un vendeur sera de retour.' }
  ]
}

function publicTicket(record) {
  const paymentProof = record.paymentProof ? { fileName: record.paymentProof.fileName, mimeType: record.paymentProof.mimeType, size: record.paymentProof.size } : null
  return {
    ticketNumber: record.ticketNumber,
    orderNumber: record.orderNumber || '',
    customer: record.customer,
    subject: record.subject,
    category: record.category,
    products: record.products || [],
    totals: record.totals || { subtotal: 0, discount: 0, shipping: 0, total: 0 },
    relay: record.relay || null,
    createdAt: record.createdAt,
    paymentProof,
    paymentStatus: record.paymentStatus || 'NON CONCERNÉ',
    status: record.status || 'NOUVEAU',
    history: record.history || []
  }
}

async function createOrderRecord(payload, env) {
  if (payload.consent !== true) throw new Error('Le consentement est obligatoire.')
  const customer = validateCustomer(payload.customer, true)
  const order = calculateOrder(payload)
  const payment = payload.payment || {}
  if (payment.method === 'TEST' && !order.testMode) throw new Error('Le paiement de test est réservé au produit Test.')
  if (payment.method !== 'TEST' && payment.method !== 'PAYPAL') throw new Error('Mode de paiement invalide.')
  const proof = decodeProof(payment.proof)
  const ticketNumber = `DJC-${String(await nextNumber(env, 'ticket')).padStart(6, '0')}`
  const orderNumber = `CMD-${String(await nextNumber(env, 'order')).padStart(6, '0')}`
  const paymentProof = await storeProof(env, ticketNumber, proof)
  const accessToken = randomToken()
  const accessTokenHash = await hash(accessToken)
  const createdAt = new Date().toISOString()
  const record = {
    id: crypto.randomUUID(),
    ticketNumber,
    orderNumber,
    customer,
    subject: 'Commande CD DJCreeper',
    category: 'Commande',
    products: order.items,
    totals: { subtotal: order.subtotal, discount: order.discount, shipping: order.shipping, total: order.total },
    relay: order.relay,
    paymentStatus: 'À VÉRIFIER',
    paymentMethod: payment.method,
    paymentProof,
    status: 'NOUVEAU',
    history: automaticHistory(ticketNumber, SHOP_CONFIG.sellerStatus.mode),
    createdAt,
    accessTokenHash
  }
  if (env.DB) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO orders (id, order_number, customer_json, items_json, subtotal_cents, discount_cents, shipping_cents, total_cents, relay_json, promo_code, payment_status, payment_method, proof_key, proof_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(record.id, record.orderNumber, JSON.stringify(customer), JSON.stringify(record.products), Math.round(order.subtotal * 100), Math.round(order.discount * 100), Math.round(order.shipping * 100), Math.round(order.total * 100), JSON.stringify(order.relay), order.promoCode, record.paymentStatus, record.paymentMethod, paymentProof?.storageKey || null, JSON.stringify(paymentProof), createdAt),
      env.DB.prepare('INSERT INTO tickets (id, ticket_number, order_id, customer_json, subject, category, items_json, subtotal_cents, discount_cents, shipping_cents, total_cents, relay_json, payment_status, proof_json, status, access_token_hash, history_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), record.ticketNumber, record.id, JSON.stringify(customer), record.subject, record.category, JSON.stringify(record.products), Math.round(order.subtotal * 100), Math.round(order.discount * 100), Math.round(order.shipping * 100), Math.round(order.total * 100), JSON.stringify(order.relay), record.paymentStatus, JSON.stringify(paymentProof), record.status, accessTokenHash, JSON.stringify(record.history), createdAt, createdAt)
    ])
  } else {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    memoryTickets.set(record.ticketNumber, record)
  }
  return { ticket: publicTicket(record), ticketAccessToken: accessToken }
}

async function createSupportRecord(payload, env) {
  const email = validEmail(payload.email || payload.customer?.email)
  const subject = cleanText(payload.subject, SHOP_CONFIG.limits.maxSubjectLength)
  const category = cleanText(payload.category, 60)
  const message = cleanText(payload.message, SHOP_CONFIG.limits.maxMessageLength)
  if (!email || !subject || !ALLOWED_CATEGORIES.has(category) || !message) throw new Error('Informations de ticket invalides.')
  const ticketNumber = `DJC-${String(await nextNumber(env, 'ticket')).padStart(6, '0')}`
  const accessToken = randomToken()
  const accessTokenHash = await hash(accessToken)
  const createdAt = new Date().toISOString()
  const record = {
    id: crypto.randomUUID(),
    ticketNumber,
    orderNumber: '',
    customer: { email },
    subject,
    category,
    products: [],
    totals: { subtotal: 0, discount: 0, shipping: 0, total: 0 },
    relay: null,
    paymentStatus: 'NON CONCERNÉ',
    paymentProof: null,
    status: 'NOUVEAU',
    history: automaticHistory(ticketNumber, SHOP_CONFIG.sellerStatus.mode),
    createdAt,
    accessTokenHash
  }
  record.history.push({ author: 'client', automated: false, createdAt, body: message })
  if (env.DB) {
    await env.DB.prepare('INSERT INTO tickets (id, ticket_number, order_id, customer_json, subject, category, items_json, subtotal_cents, discount_cents, shipping_cents, total_cents, relay_json, payment_status, proof_json, status, access_token_hash, history_json, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, NULL, ?, ?, ?, ?, ?)').bind(record.id, record.ticketNumber, JSON.stringify(record.customer), record.subject, record.category, JSON.stringify([]), record.paymentStatus, record.status, accessTokenHash, JSON.stringify(record.history), createdAt, createdAt).run()
  } else {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    memoryTickets.set(record.ticketNumber, record)
  }
  return { ticket: publicTicket(record), ticketAccessToken: accessToken }
}

async function viewTicket(payload, env) {
  const ticketNumber = cleanText(payload.ticketNumber, 40)
  const accessToken = cleanText(payload.accessToken, 128)
  if (!ticketNumber || !accessToken) throw new Error('Ticket introuvable.')
  const accessTokenHash = await hash(accessToken)
  if (!env.DB) {
    const record = memoryTickets.get(ticketNumber)
    if (!record || record.accessTokenHash !== accessTokenHash) throw new Error('Ticket introuvable.')
    return { ticket: publicTicket(record) }
  }
  const row = await env.DB.prepare('SELECT t.*, o.order_number FROM tickets t LEFT JOIN orders o ON o.id = t.order_id WHERE t.ticket_number = ? AND t.access_token_hash = ?').bind(ticketNumber, accessTokenHash).first()
  if (!row) throw new Error('Ticket introuvable.')
  return { ticket: publicTicket(recordFromRow(row)) }
}

function recordFromRow(row) {
  const customer = JSON.parse(row.customer_json || '{}')
  const products = JSON.parse(row.items_json || '[]')
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    orderNumber: row.order_number || '',
    customer,
    subject: row.subject,
    category: row.category,
    products,
    totals: { subtotal: Number(row.subtotal_cents || 0) / 100, discount: Number(row.discount_cents || 0) / 100, shipping: Number(row.shipping_cents || 0) / 100, total: Number(row.total_cents || 0) / 100 },
    relay: JSON.parse(row.relay_json || 'null'),
    paymentStatus: row.payment_status,
    paymentProof: JSON.parse(row.proof_json || 'null'),
    status: row.status,
    history: JSON.parse(row.history_json || '[]'),
    createdAt: row.created_at,
    accessTokenHash: row.access_token_hash
  }
}

async function appendTicketMessage(payload, env) {
  const ticketNumber = cleanText(payload.ticketNumber, 40)
  const accessToken = cleanText(payload.accessToken, 128)
  const message = cleanText(payload.message, SHOP_CONFIG.limits.maxMessageLength)
  if (!ticketNumber || !accessToken || !message) throw new Error('Message invalide.')
  const accessTokenHash = await hash(accessToken)
  if (!env.DB) {
    const record = memoryTickets.get(ticketNumber)
    if (!record || record.accessTokenHash !== accessTokenHash) throw new Error('Ticket introuvable.')
    record.history.push({ author: 'client', automated: false, createdAt: new Date().toISOString(), body: message })
    if (record.status === 'NOUVEAU') record.status = 'EN ATTENTE VENDEUR'
    return { ticket: publicTicket(record) }
  }
  const row = await env.DB.prepare('SELECT t.*, o.order_number FROM tickets t LEFT JOIN orders o ON o.id = t.order_id WHERE t.ticket_number = ? AND t.access_token_hash = ?').bind(ticketNumber, accessTokenHash).first()
  if (!row) throw new Error('Ticket introuvable.')
  const record = recordFromRow(row)
  record.history.push({ author: 'client', automated: false, createdAt: new Date().toISOString(), body: message })
  if (record.status === 'NOUVEAU') record.status = 'EN ATTENTE VENDEUR'
  const updatedAt = new Date().toISOString()
  await env.DB.prepare('UPDATE tickets SET history_json = ?, status = ?, updated_at = ? WHERE ticket_number = ? AND access_token_hash = ?').bind(JSON.stringify(record.history), record.status, updatedAt, ticketNumber, accessTokenHash).run()
  record.updatedAt = updatedAt
  return { ticket: publicTicket(record) }
}

async function handle(request, env) {
  if (!originAllowed(request, env)) return fail('Origine non autorisée.', 403, request, env)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) })
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'djcreeper-shop-api' }, 200, request, env)
  if (request.method === 'GET' && url.pathname === '/api/shop/catalog') return json({ products: SHOP_CONFIG.products, preorderNotice: SHOP_CONFIG.preorderNotice, storeStatus: SHOP_CONFIG.storeStatus, shipping: { provider: SHOP_CONFIG.shipping.provider, mode: SHOP_CONFIG.shipping.mode }, loyalty: SHOP_CONFIG.loyalty }, 200, request, env)
  if (request.method === 'GET' && url.pathname.startsWith('/api/tickets/')) return fail('Accès privé requis.', 404, request, env)
  if (request.method !== 'POST') return fail('Méthode non autorisée.', 405, request, env)
  if (url.pathname === '/api/orders') {
    if (!await rateLimit(request, env, 'orders', 5, 60 * 60 * 1000)) return fail('Trop de demandes. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    if (!await verifyTurnstile(request, env, payload.turnstileToken)) return fail('Vérification anti-spam requise.', 400, request, env)
    return json(await createOrderRecord(payload, env), 201, request, env)
  }
  if (url.pathname === '/api/support/tickets') {
    if (!await rateLimit(request, env, 'support', 5, 60 * 60 * 1000)) return fail('Trop de demandes. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    if (!await verifyTurnstile(request, env, payload.turnstileToken)) return fail('Vérification anti-spam requise.', 400, request, env)
    return json(await createSupportRecord(payload, env), 201, request, env)
  }
  if (url.pathname === '/api/tickets/view') {
    if (!await rateLimit(request, env, 'ticket-view', 20, 60 * 60 * 1000)) return fail('Trop de demandes. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    return json(await viewTicket(payload, env), 200, request, env)
  }
  if (url.pathname === '/api/tickets/messages') {
    if (!await rateLimit(request, env, 'messages', 20, 60 * 60 * 1000)) return fail('Trop de messages. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    return json(await appendTicketMessage(payload, env), 200, request, env)
  }
  return fail('Route introuvable.', 404, request, env)
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env)
    } catch (error) {
      const known = ['JSON invalide.', 'Requête trop volumineuse.', 'Capture trop volumineuse.', 'Format de capture refusé.', 'Signature de fichier image invalide.', 'Capture de paiement invalide.', 'Point Relais invalide.', 'Informations client invalides.', 'Panier vide.', 'Produit ou quantité invalide.', 'Code promo invalide pour ce panier.', 'Le consentement est obligatoire.', 'Le paiement de test est réservé au produit Test.', 'Mode de paiement invalide.', 'Message invalide.', 'Ticket introuvable.', 'Informations de ticket invalides.', 'Le stockage Cloudflare non configuré.', 'Le stockage des preuves de paiement n’est pas configuré.', 'Le quota R2 nécessite le stockage D1.', 'Quota R2 dépassé.', 'Impossible de stocker la preuve de paiement.']
      const message = known.includes(error?.message) ? error.message : 'Impossible de traiter la demande pour le moment.'
      const status = message === 'Ticket introuvable.' ? 404 : message === 'Quota R2 dépassé.' ? 507 : message.includes('trop volumineuse') ? 413 : 400
      return fail(message, status, request, env)
    }
  }
}
