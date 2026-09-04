import SHOP_CONFIG from '../../config/shop-config.js'
import { canonicalRelay } from './mondial-relay-adapter.js'
import WORKER_CONFIG from './worker-config.js'
import { queueTransactionalEmail } from './email-adapter.js'

const memoryTickets = new Map()
const memoryCounters = { ticket: 0, order: 0 }
const memoryRateLimits = new Map()
const memoryGoogleChallenges = new Map()
const ALLOWED_CATEGORIES = new Set(['Question avant achat', 'Commande', 'Paiement', 'Livraison', 'Produit', 'Problème technique', 'Autre'])
const ALLOWED_TICKET_STATUSES = new Set(['NOUVEAU', 'EN COURS', 'EN ATTENTE CLIENT', 'EN ATTENTE VENDEUR', 'RÉSOLU'])
const ALLOWED_PAYMENT_STATUSES = new Set(['À VÉRIFIER', 'PAYÉ', 'REFUSÉ'])
const ALLOWED_ORDER_STATUSES = new Set(['EN PRÉPARATION', 'PRÊTE À EXPÉDIER', 'EXPÉDIÉE', 'EN TRANSIT', 'LIVRÉE', 'ANNULÉE'])
const MAX_JSON_BYTES = 10 * 1024 * 1024
let accessCertificatesCache = { issuer: '', expiresAt: 0, keys: [] }
let googleCertificatesCache = { expiresAt: 0, keys: [] }

function configuredOrigins(env) {
  return [env.PUBLIC_ORIGIN, env.ADMIN_ORIGINS]
    .flatMap(value => String(value || '').split(','))
    .map(value => value.trim())
    .filter(Boolean)
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
    'Access-Control-Allow-Headers': 'content-type, x-csrf-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
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

function jsonWithCookies(data, status, request, env, cookies = []) {
  const headers = new Headers(corsHeaders(request, env))
  cookies.forEach(cookie => headers.append('Set-Cookie', cookie))
  return new Response(JSON.stringify(data), { status, headers })
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

function emailText(value, maxLength = 2000) {
  return cleanText(value, maxLength).replace(/\r/g, '')
}

function queueTicketCreatedEmail(ctx, env, record, accessToken) {
  const customerName = [record.customer?.firstName, record.customer?.lastName].filter(Boolean).join(' ') || 'Bonjour'
  const orderLine = record.orderNumber ? `Commande : ${record.orderNumber}\n` : ''
  queueTransactionalEmail(ctx, env, {
    to: record.customer.email,
    subject: `[DJCreeper] Ticket ${record.ticketNumber} enregistré`,
    text: `${customerName},\n\nTa demande a bien été enregistrée.\n\nTicket : ${record.ticketNumber}\n${orderLine}Conserve cette clé privée pour retrouver la conversation :\n${accessToken}\n\nLe paiement, s’il y en a un, reste à vérifier manuellement.\n\nDJCreeper`,
    idempotencyKey: `ticket-created-${record.ticketNumber}`
  })
}

function queueVendorReplyEmail(ctx, env, record, message) {
  queueTransactionalEmail(ctx, env, {
    to: record.customer?.email,
    subject: `[DJCreeper] Nouvelle réponse sur le ticket ${record.ticketNumber}`,
    text: `Bonjour,\n\nUn vendeur a répondu à ton ticket ${record.ticketNumber}.\n\nRéponse :\n${emailText(message)}\n\nUtilise le numéro du ticket et ta clé privée reçue à la création pour retrouver la conversation.\n\nDJCreeper`,
    idempotencyKey: `ticket-reply-${record.ticketNumber}-${Date.now()}`
  })
}

function queueOrderStatusEmail(ctx, env, record, orderStatus) {
  queueTransactionalEmail(ctx, env, {
    to: record.customer?.email,
    subject: `[DJCreeper] ${record.orderNumber} · ${orderStatus}`,
    text: `Bonjour,\n\nL’état de ta commande ${record.orderNumber} est maintenant :\n${orderStatus}\n\nTicket associé : ${record.ticketNumber}\n\nDJCreeper`,
    idempotencyKey: `order-status-${record.orderNumber}-${orderStatus}`
  })
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

function cookieValue(request, name) {
  const cookies = request.headers.get('Cookie') || ''
  const match = cookies.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : ''
}

function cookieHeader(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=None`
}

function googleClientId(env) {
  return String(env.GOOGLE_CLIENT_ID || SHOP_CONFIG.googleAuth?.clientId || '').trim()
}

function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || '',
    loyaltyPoints: Number(row.loyalty_points || 0),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  }
}

async function saveGoogleChallenge(env, challenge, nonce) {
  const expiresAt = Date.now() + 10 * 60 * 1000
  const key = `google-challenge:${await hash(challenge)}`
  const value = JSON.stringify({ nonce, expiresAt })
  if (env.RATE_LIMIT_KV) {
    await env.RATE_LIMIT_KV.put(key, value, { expirationTtl: 600 })
  } else {
    memoryGoogleChallenges.set(key, { nonce, expiresAt })
  }
}

async function takeGoogleChallenge(request, env, suppliedNonce) {
  const challenge = cookieValue(request, 'djc_google_challenge')
  if (!challenge || !suppliedNonce) return false
  const key = `google-challenge:${await hash(challenge)}`
  let stored = null
  if (env.RATE_LIMIT_KV) stored = await env.RATE_LIMIT_KV.get(key, 'json')
  else stored = memoryGoogleChallenges.get(key)
  if (env.RATE_LIMIT_KV) await env.RATE_LIMIT_KV.delete(key)
  else memoryGoogleChallenges.delete(key)
  return Boolean(stored && stored.expiresAt > Date.now() && stored.nonce === suppliedNonce)
}

async function verifyGoogleIdToken(credential, nonce, env) {
  const clientId = googleClientId(env)
  if (!clientId) throw new Error('Connexion Google non configurée.')
  const parts = String(credential || '').split('.')
  if (parts.length !== 3) throw new Error('Jeton Google invalide.')
  const header = decodeJwtPart(parts[0])
  const claims = decodeJwtPart(parts[1])
  const now = Math.floor(Date.now() / 1000)
  const issuer = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com'
  const audience = claims.aud === clientId
  if (header.alg !== 'RS256' || !header.kid || !issuer || !audience || (claims.azp && claims.azp !== clientId) || claims.nonce !== nonce || !claims.sub || !claims.email || claims.email_verified !== true || !Number(claims.exp) || Number(claims.exp) <= now || Number(claims.iat || 0) > now + 60) throw new Error('Jeton Google refusé.')

  let keys = googleCertificatesCache.keys
  if (googleCertificatesCache.expiresAt <= Date.now() || !keys.length) {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/certs', { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error('Validation Google indisponible.')
    const result = await response.json()
    keys = Array.isArray(result.keys) ? result.keys : []
    googleCertificatesCache = { expiresAt: Date.now() + 5 * 60 * 1000, keys }
  }
  const jwk = keys.find(key => key.kid === header.kid)
  if (!jwk) throw new Error('Jeton Google refusé.')
  const cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!valid) throw new Error('Jeton Google refusé.')
  return {
    googleSub: cleanText(claims.sub, 255),
    email: validEmail(claims.email),
    displayName: cleanText(claims.name || claims.email.split('@')[0], SHOP_CONFIG.limits.maxNameLength * 2),
    avatarUrl: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture.slice(0, 1000) : ''
  }
}

async function currentUser(request, env, requireCsrf = false) {
  if (!env.DB) return null
  const sessionToken = cookieValue(request, 'djc_session')
  if (!sessionToken) return null
  const tokenHash = await hash(sessionToken)
  const row = await env.DB.prepare('SELECT s.*, u.id AS user_id, u.google_sub, u.email, u.display_name, u.avatar_url, u.loyalty_points, u.created_at AS user_created_at, u.last_login_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(tokenHash).first()
  const expiresAt = Date.parse(row?.expires_at || '')
  if (!row || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null
  if (requireCsrf) {
    const csrf = request.headers.get('X-CSRF-Token') || ''
    if (!csrf || (await hash(csrf)) !== row.csrf_token_hash) throw new Error('Protection CSRF invalide.')
  }
  return {
    id: row.user_id,
    googleSub: row.google_sub,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || '',
    loyaltyPoints: Number(row.loyalty_points || 0),
    createdAt: row.user_created_at,
    lastLoginAt: row.last_login_at
  }
}

async function beginGoogleAuth(env) {
  if (!googleClientId(env) || !SHOP_CONFIG.googleAuth?.enabled) throw new Error('Connexion Google non configurée.')
  const challenge = randomToken()
  const nonce = randomToken()
  await saveGoogleChallenge(env, challenge, nonce)
  return { nonce, cookie: cookieHeader('djc_google_challenge', challenge, 600) }
}

async function finishGoogleAuth(request, payload, env) {
  if (!env.DB) throw new Error('Stockage Cloudflare non configuré.')
  const nonce = cleanText(payload?.nonce, 128)
  if (!await takeGoogleChallenge(request, env, nonce)) throw new Error('Session de connexion Google expirée.')
  const profile = await verifyGoogleIdToken(payload?.credential, nonce, env)
  if (!profile.email) throw new Error('Adresse e-mail Google invalide.')
  const now = new Date().toISOString()
  let user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(profile.googleSub).first()
  if (user) {
    await env.DB.prepare('UPDATE users SET email = ?, display_name = ?, avatar_url = ?, updated_at = ?, last_login_at = ? WHERE id = ?').bind(profile.email, profile.displayName, profile.avatarUrl || null, now, now, user.id).run()
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()
  } else {
    const id = crypto.randomUUID()
    try {
      await env.DB.prepare('INSERT INTO users (id, google_sub, email, display_name, avatar_url, loyalty_points, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)').bind(id, profile.googleSub, profile.email, profile.displayName, profile.avatarUrl || null, now, now, now).run()
      user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()
    } catch (error) {
      user = await env.DB.prepare('SELECT * FROM users WHERE google_sub = ?').bind(profile.googleSub).first()
      if (!user) throw error
    }
  }
  const sessionToken = randomToken()
  const csrfToken = randomToken()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const sessionNow = new Date().toISOString()
  await env.DB.prepare('INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), user.id, await hash(sessionToken), await hash(csrfToken), expiresAt, sessionNow, sessionNow).run()
  return { user: publicUser(user), csrfToken, cookie: cookieHeader('djc_session', sessionToken, 30 * 24 * 60 * 60) }
}

async function refreshCsrfToken(request, user, env) {
  if (!env.DB || !user) return ''
  const sessionToken = cookieValue(request, 'djc_session')
  if (!sessionToken) return ''
  const csrfToken = randomToken()
  const result = await env.DB.prepare('UPDATE sessions SET csrf_token_hash = ?, last_seen_at = ? WHERE token_hash = ? AND user_id = ?').bind(await hash(csrfToken), new Date().toISOString(), await hash(sessionToken), user.id).run()
  return Number(result.meta?.changes || 0) === 1 ? csrfToken : ''
}

async function optionalUser(request, env) {
  const hasSession = Boolean(cookieValue(request, 'djc_session'))
  return currentUser(request, env, hasSession)
}

async function accountOverview(user, env) {
  if (!user || !env.DB) throw new Error('Connexion requise.')
  const userRow = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()
  if (!userRow) throw new Error('Compte introuvable.')
  const orders = await env.DB.prepare('SELECT id, order_number, items_json, subtotal_cents, discount_cents, shipping_cents, total_cents, payment_status, order_status, loyalty_points_used, loyalty_points_earned, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(user.id).all()
  const tickets = await env.DB.prepare('SELECT ticket_number, order_id, subject, category, status, payment_status, created_at, updated_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(user.id).all()
  const transactions = await env.DB.prepare('SELECT type, points, reason, order_id, created_at FROM loyalty_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(user.id).all()
  return {
    user: publicUser(userRow),
    orders: (orders.results || []).map(row => ({
      orderNumber: row.order_number,
      products: JSON.parse(row.items_json || '[]'),
      totals: { subtotal: Number(row.subtotal_cents || 0) / 100, discount: Number(row.discount_cents || 0) / 100, shipping: Number(row.shipping_cents || 0) / 100, total: Number(row.total_cents || 0) / 100 },
      paymentStatus: row.payment_status,
      orderStatus: row.order_status,
      loyaltyPointsUsed: Number(row.loyalty_points_used || 0),
      loyaltyPointsEarned: Number(row.loyalty_points_earned || 0),
      createdAt: row.created_at
    })),
    tickets: (tickets.results || []).map(row => ({ ticketNumber: row.ticket_number, orderId: row.order_id || '', subject: row.subject, category: row.category, status: row.status, paymentStatus: row.payment_status, createdAt: row.created_at, updatedAt: row.updated_at })),
    loyaltyTransactions: (transactions.results || []).map(row => ({ type: row.type, points: Number(row.points || 0), reason: row.reason, orderId: row.order_id || '', createdAt: row.created_at }))
  }
}

function base64UrlBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)))
}

function accessIssuer(env) {
  return String(env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/\/$/, '')
}

async function verifyAdminAccess(request, env) {
  const issuer = accessIssuer(env)
  const audience = String(env.CF_ACCESS_AUDIENCE || '').trim()
  const assertion = request.headers.get('CF-Access-Jwt-Assertion')
  if (!issuer || !audience || !assertion) return null

  try {
    const parts = assertion.split('.')
    if (parts.length !== 3) return null
    const header = decodeJwtPart(parts[0])
    const payload = decodeJwtPart(parts[1])
    if (header.alg !== 'RS256' || !header.kid) return null
    const issuerMatches = payload.iss === issuer || payload.iss === `${issuer}/`
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    const now = Math.floor(Date.now() / 1000)
    if (!issuerMatches || !audiences.includes(audience) || !Number(payload.exp) || Number(payload.exp) <= now || (payload.nbf && Number(payload.nbf) > now + 30)) return null

    let keys = accessCertificatesCache.keys
    if (accessCertificatesCache.issuer !== issuer || accessCertificatesCache.expiresAt <= Date.now() || !keys.length) {
      const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { headers: { Accept: 'application/json' } })
      if (!response.ok) return null
      const result = await response.json()
      keys = Array.isArray(result.keys) ? result.keys : []
      accessCertificatesCache = { issuer, expiresAt: Date.now() + 5 * 60 * 1000, keys }
    }
    const jwk = keys.find(key => key.kid === header.kid)
    if (!jwk) return null
    const cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    if (!valid) return null

    const allowedEmails = String(env.ADMIN_ALLOWED_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    const email = cleanText(payload.email, SHOP_CONFIG.limits.maxEmailLength).toLowerCase()
    if (allowedEmails.length && (!email || !allowedEmails.includes(email))) return null
    return { email }
  } catch (error) {
    return null
  }
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

function cents(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number * 100 > Number.MAX_SAFE_INTEGER) throw new Error('Montant invalide.')
  return Math.round(number * 100)
}

function euros(centsValue) {
  return Number(centsValue || 0) / 100
}

function calculateOrder(payload, user) {
  if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('Panier vide.')
  const items = payload.items.map(raw => {
    const productId = cleanText(raw?.productId, 80)
    const product = productById(productId)
    const quantity = Number.parseInt(raw?.quantity, 10)
    if (!product || !product.available || !Number.isInteger(quantity) || quantity < 1 || quantity > SHOP_CONFIG.limits.maxQuantityPerProduct) throw new Error('Produit ou quantité invalide.')
    return { id: product.id, name: product.name, quantity, price: product.price, priceCents: cents(product.price), weight: product.weight }
  })
  const subtotalCents = items.reduce((total, item) => total + item.priceCents * item.quantity, 0)
  const testMode = testPromoApplies(payload.promoCode, items.map(item => ({ productId: item.id })))
  const suppliedPromo = cleanText(payload.promoCode, 32).toUpperCase()
  if (suppliedPromo && !testMode) throw new Error('Code promo invalide pour ce panier.')
  const relay = canonicalRelay(payload.relay)
  if (!relay) throw new Error('Point Relais invalide.')
  const quotedShippingCents = cents(relay.price)
  const promoDiscountCents = testMode ? subtotalCents : 0
  const productPayableBeforePointsCents = Math.max(0, subtotalCents - promoDiscountCents)
  let loyaltyPointsUsed = 0
  let loyaltyDiscountCents = 0
  const requestedPoints = Number.parseInt(payload.loyaltyPointsToUse, 10) || 0
  if (!testMode && requestedPoints) {
    if (!user || !SHOP_CONFIG.loyalty.enabled) throw new Error('Connexion requise pour utiliser des points.')
    const pointsPerEuroDiscount = Number(SHOP_CONFIG.loyalty.pointsPerEuroDiscount)
    const maxDiscountCents = Math.floor(productPayableBeforePointsCents * Number(SHOP_CONFIG.loyalty.maxCartPercentage) / 100)
    const maxPoints = Math.floor(maxDiscountCents * pointsPerEuroDiscount / 100)
    if (!Number.isInteger(requestedPoints) || requestedPoints < 0 || requestedPoints % 10 !== 0 || requestedPoints > Number(user.loyaltyPoints || 0) || requestedPoints > maxPoints) throw new Error('Nombre de points invalide ou supérieur à la limite autorisée.')
    loyaltyPointsUsed = requestedPoints
    loyaltyDiscountCents = Math.floor(requestedPoints * 100 / pointsPerEuroDiscount)
  }
  const discountCents = promoDiscountCents + loyaltyDiscountCents
  const shippingCents = testMode ? 0 : quotedShippingCents
  const eligibleProductCents = Math.max(0, productPayableBeforePointsCents - loyaltyDiscountCents)
  const pointsEarned = !testMode && user && SHOP_CONFIG.loyalty.enabled ? eligibleProductCents * Number(SHOP_CONFIG.loyalty.pointsPerCent) : 0
  return {
    items,
    relay,
    testMode,
    promoCode: testMode ? suppliedPromo : '',
    subtotalCents,
    promoDiscountCents,
    loyaltyPointsUsed,
    loyaltyDiscountCents,
    discountCents,
    quotedShippingCents,
    shippingCents,
    eligibleProductCents,
    pointsEarned,
    totalCents: Math.max(0, subtotalCents - discountCents + shippingCents)
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

function automaticHistory(ticketNumber) {
  return [
    { author: 'support', automated: true, createdAt: new Date().toISOString(), body: `Bonjour !\n\nTa demande a bien été reçue.\n\nUn vendeur va la consulter dès que possible.\n\nTicket : #${ticketNumber}` },
    { author: 'support', automated: true, createdAt: new Date().toISOString(), body: 'Ta demande est bien enregistrée. Un vendeur la consultera dès que possible.' }
  ]
}

function publicTicket(record) {
  const paymentProof = record.paymentProof ? { fileName: record.paymentProof.fileName, mimeType: record.paymentProof.mimeType, size: record.paymentProof.size } : null
  return {
    ticketNumber: record.ticketNumber,
    orderNumber: record.orderNumber || '',
    orderStatus: record.orderStatus || '',
    customer: record.customer,
    subject: record.subject,
    category: record.category,
    products: record.products || [],
    totals: record.totals || { subtotal: 0, discount: 0, shipping: 0, total: 0 },
    relay: record.relay || null,
    createdAt: record.createdAt,
    paymentProof,
    paymentStatus: record.paymentStatus || 'NON CONCERNÉ',
    loyalty: record.orderNumber ? {
      pointsUsed: Number(record.loyaltyPointsUsed || 0),
      pointsEarned: Number(record.loyaltyPointsEarned || 0),
      discount: Number(record.loyaltyDiscount || 0)
    } : null,
    status: record.status || 'NOUVEAU',
    history: record.history || [],
    updatedAt: record.updatedAt || record.createdAt
  }
}

async function createOrderRecord(payload, env, ctx, user) {
  if (payload.consent !== true) throw new Error('Le consentement est obligatoire.')
  const submittedCustomer = validateCustomer(payload.customer, true)
  const customer = user ? { ...submittedCustomer, email: user.email } : submittedCustomer
  const order = calculateOrder(payload, user)
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
    totals: { subtotal: euros(order.subtotalCents), discount: euros(order.discountCents), shipping: euros(order.shippingCents), total: euros(order.totalCents) },
    loyaltyPointsUsed: order.testMode ? 0 : order.loyaltyPointsUsed,
    loyaltyPointsEarned: 0,
    loyaltyDiscount: euros(order.loyaltyDiscountCents),
    loyaltyEligibleCents: order.testMode ? 0 : order.eligibleProductCents,
    userId: user?.id || '',
    relay: order.relay,
    orderStatus: 'EN PRÉPARATION',
    paymentStatus: 'À VÉRIFIER',
    paymentMethod: payment.method,
    paymentProof,
    status: 'NOUVEAU',
    history: automaticHistory(ticketNumber),
    createdAt,
    accessTokenHash
  }
  if (env.DB) {
    const statements = []
    if (user && record.loyaltyPointsUsed > 0 && !record.testMode) {
      statements.push(env.DB.prepare('INSERT INTO loyalty_transactions (id, transaction_key, user_id, order_id, type, points, reason, created_at) VALUES (?, ?, ?, ?, \'spent\', ?, ?, ?)').bind(crypto.randomUUID(), `spent:${record.id}`, user.id, record.id, -record.loyaltyPointsUsed, `Réduction fidélité ${record.orderNumber}`, createdAt))
    }
    statements.push(
      env.DB.prepare('INSERT INTO orders (id, order_number, user_id, customer_json, items_json, subtotal_cents, discount_cents, shipping_cents, total_cents, relay_json, promo_code, payment_status, payment_method, order_status, loyalty_points_used, loyalty_eligible_cents, loyalty_points_earned, loyalty_awarded_at, loyalty_refunded_at, proof_key, proof_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)').bind(record.id, record.orderNumber, record.userId || null, JSON.stringify(customer), JSON.stringify(record.products), order.subtotalCents, order.discountCents, order.shippingCents, order.totalCents, JSON.stringify(order.relay), order.promoCode, record.paymentStatus, record.paymentMethod, record.orderStatus, record.loyaltyPointsUsed, record.loyaltyEligibleCents, 0, paymentProof?.storageKey || null, JSON.stringify(paymentProof), createdAt),
      env.DB.prepare('INSERT INTO tickets (id, ticket_number, order_id, user_id, customer_json, subject, category, items_json, subtotal_cents, discount_cents, shipping_cents, total_cents, relay_json, payment_status, proof_json, status, access_token_hash, history_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), record.ticketNumber, record.id, record.userId || null, JSON.stringify(customer), record.subject, record.category, JSON.stringify(record.products), order.subtotalCents, order.discountCents, order.shippingCents, order.totalCents, JSON.stringify(order.relay), record.paymentStatus, JSON.stringify(paymentProof), record.status, accessTokenHash, JSON.stringify(record.history), createdAt, createdAt)
    )
    try {
      await env.DB.batch(statements)
    } catch (error) {
      // Une transaction D1 refusée (par exemple un solde de points devenu
      // insuffisant entre deux onglets) ne doit pas laisser une preuve R2
      // orpheline ni consommer le quota.
      if (paymentProof?.storageKey && env.PAYMENT_PROOFS) {
        try { await env.PAYMENT_PROOFS.delete(paymentProof.storageKey) } catch (cleanupError) {}
        try { await releaseProofQuota(env, paymentProof.size) } catch (cleanupError) {}
      }
      throw error
    }
  } else {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    memoryTickets.set(record.ticketNumber, record)
  }
  queueTicketCreatedEmail(ctx, env, record, accessToken)
  return { ticket: publicTicket(record), ticketAccessToken: accessToken }
}

async function createSupportRecord(payload, env, ctx, user) {
  const email = user?.email || validEmail(payload.email || payload.customer?.email)
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
    userId: user?.id || '',
    subject,
    category,
    products: [],
    totals: { subtotal: 0, discount: 0, shipping: 0, total: 0 },
    relay: null,
    paymentStatus: 'NON CONCERNÉ',
    paymentProof: null,
    status: 'NOUVEAU',
    history: automaticHistory(ticketNumber),
    createdAt,
    accessTokenHash
  }
  record.history.push({ author: 'client', automated: false, createdAt, body: message })
  if (env.DB) {
    await env.DB.prepare('INSERT INTO tickets (id, ticket_number, order_id, user_id, customer_json, subject, category, items_json, subtotal_cents, discount_cents, shipping_cents, total_cents, relay_json, payment_status, proof_json, status, access_token_hash, history_json, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, NULL, ?, ?, ?, ?, ?)').bind(record.id, record.ticketNumber, record.userId || null, JSON.stringify(record.customer), record.subject, record.category, JSON.stringify([]), record.paymentStatus, record.status, accessTokenHash, JSON.stringify(record.history), createdAt, createdAt).run()
  } else {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    memoryTickets.set(record.ticketNumber, record)
  }
  queueTicketCreatedEmail(ctx, env, record, accessToken)
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
  const row = await env.DB.prepare('SELECT t.*, o.order_number, o.order_status, o.user_id AS order_user_id, o.loyalty_points_used, o.loyalty_points_earned, o.loyalty_eligible_cents, o.discount_cents AS order_discount_cents FROM tickets t LEFT JOIN orders o ON o.id = t.order_id WHERE t.ticket_number = ? AND t.access_token_hash = ?').bind(ticketNumber, accessTokenHash).first()
  if (!row) throw new Error('Ticket introuvable.')
  return { ticket: publicTicket(recordFromRow(row)) }
}

function recordFromRow(row) {
  const customer = JSON.parse(row.customer_json || '{}')
  const products = JSON.parse(row.items_json || '[]')
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    orderId: row.order_id || '',
    userId: row.user_id || row.order_user_id || '',
    orderNumber: row.order_number || '',
    orderStatus: row.order_status || '',
    customer,
    subject: row.subject,
    category: row.category,
    products,
    totals: { subtotal: Number(row.subtotal_cents || 0) / 100, discount: Number(row.discount_cents || 0) / 100, shipping: Number(row.shipping_cents || 0) / 100, total: Number(row.total_cents || 0) / 100 },
    loyaltyPointsUsed: Number(row.loyalty_points_used || 0),
    loyaltyPointsEarned: Number(row.loyalty_points_earned || 0),
    loyaltyDiscount: Number(row.loyalty_points_used || 0) * 100 / Number(SHOP_CONFIG.loyalty.pointsPerEuroDiscount || 1000) / 100,
    relay: JSON.parse(row.relay_json || 'null'),
    paymentStatus: row.payment_status,
    paymentProof: JSON.parse(row.proof_json || 'null'),
    status: row.status,
    history: JSON.parse(row.history_json || '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  const row = await env.DB.prepare('SELECT t.*, o.order_number, o.order_status, o.user_id AS order_user_id, o.loyalty_points_used, o.loyalty_points_earned, o.loyalty_eligible_cents, o.discount_cents AS order_discount_cents FROM tickets t LEFT JOIN orders o ON o.id = t.order_id WHERE t.ticket_number = ? AND t.access_token_hash = ?').bind(ticketNumber, accessTokenHash).first()
  if (!row) throw new Error('Ticket introuvable.')
  const record = recordFromRow(row)
  record.history.push({ author: 'client', automated: false, createdAt: new Date().toISOString(), body: message })
  if (record.status === 'NOUVEAU') record.status = 'EN ATTENTE VENDEUR'
  const updatedAt = new Date().toISOString()
  await env.DB.prepare('UPDATE tickets SET history_json = ?, status = ?, updated_at = ? WHERE ticket_number = ? AND access_token_hash = ?').bind(JSON.stringify(record.history), record.status, updatedAt, ticketNumber, accessTokenHash).run()
  record.updatedAt = updatedAt
  return { ticket: publicTicket(record) }
}

function adminFilter(payload) {
  const status = cleanText(payload?.status, 40)
  const search = cleanText(payload?.search, 100)
  if (status && !ALLOWED_TICKET_STATUSES.has(status)) throw new Error('Statut de ticket invalide.')
  return { status, search }
}

async function adminTicketRow(ticketNumber, env) {
  if (!env.DB) return null
  return env.DB.prepare('SELECT t.*, o.order_number, o.order_status, o.user_id AS order_user_id, o.loyalty_points_used, o.loyalty_points_earned, o.loyalty_eligible_cents, o.loyalty_awarded_at, o.loyalty_refunded_at, o.discount_cents AS order_discount_cents FROM tickets t LEFT JOIN orders o ON o.id = t.order_id WHERE t.ticket_number = ?').bind(ticketNumber).first()
}

function matchesAdminSearch(record, search) {
  if (!search) return true
  const needle = search.toLowerCase()
  return [record.ticketNumber, record.orderNumber, record.subject, record.category, record.customer?.email, record.customer?.firstName, record.customer?.lastName]
    .some(value => String(value || '').toLowerCase().includes(needle))
}

async function listAdminTickets(payload, env) {
  const { status, search } = adminFilter(payload)
  if (!env.DB) {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    const tickets = [...memoryTickets.values()]
      .filter(record => (!status || record.status === status) && matchesAdminSearch(record, search))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    return { total: tickets.length, tickets: tickets.map(publicTicket) }
  }

  const clauses = []
  const bindings = []
  if (status) {
    clauses.push('t.status = ?')
    bindings.push(status)
  }
  if (search) {
    const pattern = `%${search}%`
    clauses.push('(t.ticket_number LIKE ? OR o.order_number LIKE ? OR t.subject LIKE ? OR t.category LIKE ? OR t.customer_json LIKE ?)')
    bindings.push(pattern, pattern, pattern, pattern, pattern)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM tickets t LEFT JOIN orders o ON o.id = t.order_id ${where}`).bind(...bindings).first()
  const rows = await env.DB.prepare(`SELECT t.*, o.order_number, o.order_status, o.user_id AS order_user_id, o.loyalty_points_used, o.loyalty_points_earned, o.loyalty_eligible_cents, o.loyalty_awarded_at, o.loyalty_refunded_at, o.discount_cents AS order_discount_cents FROM tickets t LEFT JOIN orders o ON o.id = t.order_id ${where} ORDER BY t.created_at DESC LIMIT 200`).bind(...bindings).all()
  return { total: Number(countRow?.total || 0), tickets: (rows.results || []).map(row => publicTicket(recordFromRow(row))) }
}

async function getAdminTicket(payload, env) {
  const ticketNumber = cleanText(payload?.ticketNumber, 40)
  if (!ticketNumber) throw new Error('Ticket introuvable.')
  if (!env.DB) {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    const record = memoryTickets.get(ticketNumber)
    if (!record) throw new Error('Ticket introuvable.')
    return { ticket: publicTicket(record) }
  }
  const row = await adminTicketRow(ticketNumber, env)
  if (!row) throw new Error('Ticket introuvable.')
  return { ticket: publicTicket(recordFromRow(row)) }
}

async function updateAdminStatus(payload, env) {
  const ticketNumber = cleanText(payload?.ticketNumber, 40)
  const status = cleanText(payload?.status, 40)
  if (!ticketNumber || !ALLOWED_TICKET_STATUSES.has(status)) throw new Error('Statut de ticket invalide.')
  if (!env.DB) {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    const record = memoryTickets.get(ticketNumber)
    if (!record) throw new Error('Ticket introuvable.')
    record.status = status
    record.updatedAt = new Date().toISOString()
    return { ticket: publicTicket(record) }
  }
  const updatedAt = new Date().toISOString()
  const result = await env.DB.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE ticket_number = ?').bind(status, updatedAt, ticketNumber).run()
  if (Number(result.meta?.changes || 0) !== 1) throw new Error('Ticket introuvable.')
  return getAdminTicket({ ticketNumber }, env)
}

async function updateAdminPaymentStatus(payload, env) {
  const ticketNumber = cleanText(payload?.ticketNumber, 40)
  const paymentStatus = cleanText(payload?.paymentStatus, 40)
  if (!ticketNumber || !ALLOWED_PAYMENT_STATUSES.has(paymentStatus)) throw new Error('Statut de paiement invalide.')
  if (!env.DB) {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    const record = memoryTickets.get(ticketNumber)
    if (!record) throw new Error('Ticket introuvable.')
    record.paymentStatus = paymentStatus
    record.updatedAt = new Date().toISOString()
    return { ticket: publicTicket(record) }
  }
  const row = await adminTicketRow(ticketNumber, env)
  if (!row) throw new Error('Ticket introuvable.')
  const updatedAt = new Date().toISOString()
  const statements = []
  if (row.order_id) {
    const shouldAward = paymentStatus === 'PAYÉ' && row.order_status !== 'ANNULÉE' && row.order_user_id && Number(row.loyalty_eligible_cents || 0) > 0 && !row.loyalty_awarded_at
    if (shouldAward) {
      const earned = Number(row.loyalty_eligible_cents || 0) * Number(SHOP_CONFIG.loyalty.pointsPerCent || 1)
      statements.push(env.DB.prepare('INSERT INTO loyalty_transactions (id, transaction_key, user_id, order_id, type, points, reason, created_at) VALUES (?, ?, ?, ?, \'earned\', ?, ?, ?)').bind(crypto.randomUUID(), `earned:${row.order_id}`, row.order_user_id, row.order_id, earned, `Achat ${row.order_number}`, updatedAt))
      statements.push(env.DB.prepare('UPDATE orders SET payment_status = ?, loyalty_points_earned = ?, loyalty_awarded_at = ? WHERE id = ? AND loyalty_awarded_at IS NULL').bind(paymentStatus, earned, updatedAt, row.order_id))
    } else {
      statements.push(env.DB.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').bind(paymentStatus, row.order_id))
    }
  }
  statements.push(env.DB.prepare('UPDATE tickets SET payment_status = ?, updated_at = ? WHERE ticket_number = ?').bind(paymentStatus, updatedAt, ticketNumber))
  await env.DB.batch(statements)
  return getAdminTicket({ ticketNumber }, env)
}

async function appendAdminMessage(payload, env, identity, ctx) {
  const ticketNumber = cleanText(payload?.ticketNumber, 40)
  const message = cleanText(payload?.message, SHOP_CONFIG.limits.maxMessageLength)
  if (!ticketNumber || !message) throw new Error('Message vendeur invalide.')
  // Ne pas exposer l’identité ou l’adresse du compte Access au client.
  const authorLabel = 'Vendeur'
  const createdAt = new Date().toISOString()
  if (!env.DB) {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    const record = memoryTickets.get(ticketNumber)
    if (!record) throw new Error('Ticket introuvable.')
    record.history.push({ author: 'vendor', automated: false, authorLabel, createdAt, body: message })
    if (record.status !== 'RÉSOLU') record.status = 'EN ATTENTE CLIENT'
    record.updatedAt = createdAt
    queueVendorReplyEmail(ctx, env, record, message)
    return { ticket: publicTicket(record) }
  }
  const row = await adminTicketRow(ticketNumber, env)
  if (!row) throw new Error('Ticket introuvable.')
  const record = recordFromRow(row)
  record.history.push({ author: 'vendor', automated: false, authorLabel, createdAt, body: message })
  const status = record.status === 'RÉSOLU' ? record.status : 'EN ATTENTE CLIENT'
  await env.DB.prepare('UPDATE tickets SET history_json = ?, status = ?, updated_at = ? WHERE ticket_number = ?').bind(JSON.stringify(record.history), status, createdAt, ticketNumber).run()
  record.status = status
  record.updatedAt = createdAt
  queueVendorReplyEmail(ctx, env, record, message)
  return { ticket: publicTicket(record) }
}

async function updateAdminOrderStatus(payload, env, ctx) {
  const ticketNumber = cleanText(payload?.ticketNumber, 40)
  const orderStatus = cleanText(payload?.orderStatus, 50)
  if (!ticketNumber || !ALLOWED_ORDER_STATUSES.has(orderStatus)) throw new Error('Statut de commande invalide.')
  if (!env.DB) {
    if (env.ALLOW_LOCAL_DEMO !== 'true') throw new Error('Stockage Cloudflare non configuré.')
    const record = memoryTickets.get(ticketNumber)
    if (!record?.orderNumber) throw new Error('Commande introuvable.')
    if (record.orderStatus !== orderStatus) {
      record.orderStatus = orderStatus
      record.updatedAt = new Date().toISOString()
      queueOrderStatusEmail(ctx, env, record, orderStatus)
    }
    return { ticket: publicTicket(record) }
  }
  const row = await adminTicketRow(ticketNumber, env)
  if (!row?.order_id) throw new Error('Commande introuvable.')
  const currentStatus = row.order_status || 'EN PRÉPARATION'
  const updatedAt = new Date().toISOString()
  const statements = []
  if (orderStatus === 'ANNULÉE' && !row.loyalty_refunded_at && row.order_user_id) {
    const pointsUsed = Number(row.loyalty_points_used || 0)
    const pointsEarned = Number(row.loyalty_points_earned || 0)
    if (pointsUsed > 0) statements.push(env.DB.prepare('INSERT INTO loyalty_transactions (id, transaction_key, user_id, order_id, type, points, reason, created_at) VALUES (?, ?, ?, ?, \'refund\', ?, ?, ?)').bind(crypto.randomUUID(), `refund-spent:${row.order_id}`, row.order_user_id, row.order_id, pointsUsed, `Remboursement des points utilisés ${row.order_number}`, updatedAt))
    if (pointsEarned > 0) statements.push(env.DB.prepare('INSERT INTO loyalty_transactions (id, transaction_key, user_id, order_id, type, points, reason, created_at) VALUES (?, ?, ?, ?, \'refund\', ?, ?, ?)').bind(crypto.randomUUID(), `refund-earned:${row.order_id}`, row.order_user_id, row.order_id, -pointsEarned, `Annulation de points gagnés ${row.order_number}`, updatedAt))
    statements.push(env.DB.prepare('UPDATE orders SET order_status = ?, loyalty_refunded_at = ? WHERE id = ? AND loyalty_refunded_at IS NULL').bind(orderStatus, updatedAt, row.order_id))
  } else {
    statements.push(env.DB.prepare('UPDATE orders SET order_status = ? WHERE id = ?').bind(orderStatus, row.order_id))
  }
  await env.DB.batch(statements)
  const record = recordFromRow({ ...row, order_status: orderStatus })
  record.updatedAt = updatedAt
  if (currentStatus !== orderStatus) queueOrderStatusEmail(ctx, env, record, orderStatus)
  return { ticket: publicTicket(record) }
}

async function getAdminProof(payload, env, request) {
  const ticketNumber = cleanText(payload?.ticketNumber, 40)
  if (!ticketNumber || !env.PAYMENT_PROOFS) throw new Error('Preuve de paiement introuvable.')
  const row = await adminTicketRow(ticketNumber, env)
  if (!row) throw new Error('Ticket introuvable.')
  const proof = JSON.parse(row.proof_json || 'null')
  if (!proof?.storageKey) throw new Error('Preuve de paiement introuvable.')
  const object = await env.PAYMENT_PROOFS.get(proof.storageKey)
  if (!object) throw new Error('Preuve de paiement introuvable.')
  const headers = corsHeaders(request, env)
  headers['Content-Type'] = proof.mimeType || object.httpMetadata?.contentType || 'application/octet-stream'
  headers['Content-Disposition'] = 'inline'
  headers['X-Content-Type-Options'] = 'nosniff'
  return new Response(object.body, { status: 200, headers })
}

async function handle(request, env, ctx) {
  if (!originAllowed(request, env)) return fail('Origine non autorisée.', 403, request, env)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) })
  const url = new URL(request.url)
  const isAdminRoute = url.pathname.startsWith('/api/admin/')
  let adminIdentity = null
  if (isAdminRoute) {
    if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUDIENCE) return fail('Cloudflare Access admin n’est pas configuré.', 503, request, env)
    adminIdentity = await verifyAdminAccess(request, env)
    if (!adminIdentity) return fail('Accès administrateur refusé.', 403, request, env)
  }
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'djcreeper-shop-api' }, 200, request, env)
  if (request.method === 'GET' && url.pathname === '/api/shop/catalog') return json({ products: SHOP_CONFIG.products, preorderNotice: SHOP_CONFIG.preorderNotice, storeStatus: SHOP_CONFIG.storeStatus, shipping: { provider: SHOP_CONFIG.shipping.provider, mode: SHOP_CONFIG.shipping.mode }, loyalty: SHOP_CONFIG.loyalty }, 200, request, env)
  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    if (!await rateLimit(request, env, 'auth-me', 60, 60 * 60 * 1000)) return fail('Trop de demandes de session. Réessaie plus tard.', 429, request, env)
    const user = await currentUser(request, env)
    if (!user) return json({ authenticated: false, user: null }, 200, request, env)
    const csrfToken = await refreshCsrfToken(request, user, env)
    return json({ authenticated: true, user: { ...user, googleSub: undefined }, csrfToken }, 200, request, env)
  }
  if (request.method === 'GET' && url.pathname === '/api/account') {
    if (!await rateLimit(request, env, 'account', 60, 60 * 60 * 1000)) return fail('Trop de demandes de compte. Réessaie plus tard.', 429, request, env)
    const user = await currentUser(request, env)
    if (!user) return fail('Connexion requise.', 401, request, env)
    return json(await accountOverview(user, env), 200, request, env)
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/tickets/')) return fail('Accès privé requis.', 404, request, env)
  if (request.method !== 'POST') return fail('Méthode non autorisée.', 405, request, env)
  if (url.pathname === '/api/auth/google/start') {
    if (!await rateLimit(request, env, 'auth-start', 10, 60 * 60 * 1000)) return fail('Trop de tentatives de connexion. Réessaie plus tard.', 429, request, env)
    const result = await beginGoogleAuth(env)
    return jsonWithCookies({ nonce: result.nonce, clientId: googleClientId(env) }, 200, request, env, [result.cookie])
  }
  if (url.pathname === '/api/auth/google') {
    if (!await rateLimit(request, env, 'auth-google', 10, 60 * 60 * 1000)) return fail('Trop de tentatives de connexion. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    const result = await finishGoogleAuth(request, payload, env)
    return jsonWithCookies({ authenticated: true, user: result.user, csrfToken: result.csrfToken }, 200, request, env, [cookieHeader('djc_google_challenge', '', 0), result.cookie])
  }
  if (url.pathname === '/api/auth/logout') {
    if (!await rateLimit(request, env, 'auth-logout', 20, 60 * 60 * 1000)) return fail('Trop de demandes. Réessaie plus tard.', 429, request, env)
    const user = await currentUser(request, env, Boolean(cookieValue(request, 'djc_session')))
    const sessionToken = cookieValue(request, 'djc_session')
    if (env.DB && sessionToken) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hash(sessionToken)).run()
    return jsonWithCookies({ authenticated: false }, 200, request, env, [cookieHeader('djc_session', '', 0), cookieHeader('djc_google_challenge', '', 0)])
  }
  if (url.pathname === '/api/admin/tickets/list') {
    const payload = await readJson(request)
    return json(await listAdminTickets(payload, env), 200, request, env)
  }
  if (url.pathname === '/api/admin/status') {
    return json({ sellerStatus: WORKER_CONFIG.sellerStatus, storeStatus: SHOP_CONFIG.storeStatus, emailConfigured: String(env.EMAIL_PROVIDER || '').toLowerCase() === 'resend' && Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM) }, 200, request, env)
  }
  if (url.pathname === '/api/admin/tickets/detail') {
    const payload = await readJson(request)
    return json(await getAdminTicket(payload, env), 200, request, env)
  }
  if (url.pathname === '/api/admin/tickets/status') {
    const payload = await readJson(request)
    return json(await updateAdminStatus(payload, env), 200, request, env)
  }
  if (url.pathname === '/api/admin/tickets/payment-status') {
    const payload = await readJson(request)
    return json(await updateAdminPaymentStatus(payload, env), 200, request, env)
  }
  if (url.pathname === '/api/admin/orders/status') {
    const payload = await readJson(request)
    return json(await updateAdminOrderStatus(payload, env, ctx), 200, request, env)
  }
  if (url.pathname === '/api/admin/tickets/messages') {
    if (!await rateLimit(request, env, 'admin-messages', 60, 60 * 60 * 1000)) return fail('Trop de messages vendeur. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    return json(await appendAdminMessage(payload, env, adminIdentity, ctx), 200, request, env)
  }
  if (url.pathname === '/api/admin/tickets/proof') {
    const payload = await readJson(request)
    return getAdminProof(payload, env, request)
  }
  if (url.pathname === '/api/orders') {
    if (!await rateLimit(request, env, 'orders', 5, 60 * 60 * 1000)) return fail('Trop de demandes. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    if (!await verifyTurnstile(request, env, payload.turnstileToken)) return fail('Vérification anti-spam requise.', 400, request, env)
    const user = await optionalUser(request, env)
    return json(await createOrderRecord(payload, env, ctx, user), 201, request, env)
  }
  if (url.pathname === '/api/support/tickets') {
    if (!await rateLimit(request, env, 'support', 5, 60 * 60 * 1000)) return fail('Trop de demandes. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    if (!await verifyTurnstile(request, env, payload.turnstileToken)) return fail('Vérification anti-spam requise.', 400, request, env)
    const user = await optionalUser(request, env)
    return json(await createSupportRecord(payload, env, ctx, user), 201, request, env)
  }
  if (url.pathname === '/api/tickets/view') {
    if (!await rateLimit(request, env, 'ticket-view', 20, 60 * 60 * 1000)) return fail('Trop de demandes. Réessaie plus tard.', 429, request, env)
    const payload = await readJson(request)
    return json(await viewTicket(payload, env), 200, request, env)
  }
  if (url.pathname === '/api/tickets/messages') {
    if (!await rateLimit(request, env, 'messages', 20, 60 * 60 * 1000)) return fail('Trop de messages. Réessaie plus tard.', 429, request, env)
    await optionalUser(request, env)
    const payload = await readJson(request)
    return json(await appendTicketMessage(payload, env), 200, request, env)
  }
  return fail('Route introuvable.', 404, request, env)
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx)
    } catch (error) {
      const known = ['JSON invalide.', 'Requête trop volumineuse.', 'Capture trop volumineuse.', 'Format de capture refusé.', 'Signature de fichier image invalide.', 'Capture de paiement invalide.', 'Point Relais invalide.', 'Informations client invalides.', 'Panier vide.', 'Produit ou quantité invalide.', 'Code promo invalide pour ce panier.', 'Le consentement est obligatoire.', 'Le paiement de test est réservé au produit Test.', 'Mode de paiement invalide.', 'Message invalide.', 'Message vendeur invalide.', 'Ticket introuvable.', 'Informations de ticket invalides.', 'Statut de ticket invalide.', 'Statut de paiement invalide.', 'Statut de commande invalide.', 'Commande introuvable.', 'Preuve de paiement introuvable.', 'Configuration e-mail incomplète.', 'Le stockage Cloudflare non configuré.', 'Le stockage des preuves de paiement n’est pas configuré.', 'Le quota R2 nécessite le stockage D1.', 'Quota R2 dépassé.', 'Impossible de stocker la preuve de paiement.']
      ;['Montant invalide.', 'Connexion Google non configurée.', 'Jeton Google invalide.', 'Jeton Google refusé.', 'Validation Google indisponible.', 'Adresse e-mail Google invalide.', 'Session de connexion Google expirée.', 'Connexion requise.', 'Compte introuvable.', 'Protection CSRF invalide.', 'Nombre de points invalide ou supérieur à la limite autorisée.'].forEach(message => { if (error?.message === message) known.push(message) })
      const message = known.includes(error?.message) ? error.message : 'Impossible de traiter la demande pour le moment.'
      const status = message === 'Ticket introuvable.' ? 404 : message === 'Quota R2 dépassé.' ? 507 : message.includes('trop volumineuse') ? 413 : 400
      return fail(message, status, request, env)
    }
  }
}
