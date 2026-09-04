import SHOP_CONFIG from '../config/shop-config.js'

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const CART_STORAGE_KEY = 'djc_shop_cart_v1'
const WRONG_PROMO_MESSAGES = [
  '❌ Raté. Même les Creepers n’explosent pas ce code promo.',
  '❌ Ce code promo vient probablement d’une timeline alternative.',
  '❌ Beau essai, mais non 😅',
  '❌ Le code promo a regardé ta demande et a dit non.',
  '❌ 404 : réduction introuvable dans cette dimension.'
]

const state = {
  cart: readCart(),
  promoCode: '',
  customer: null,
  relay: null,
  paymentProof: null,
  ticket: null,
  checkoutStep: 1,
  objectUrl: null
}

let localSequence = 0

function makeElement(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function money(value) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: SHOP_CONFIG.currency }).format(Number(value) || 0)
}

function dateLabel(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Date indisponible'
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function normalizeText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength)
}

function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.map(item => ({
      productId: String(item.productId || ''),
      quantity: Math.min(SHOP_CONFIG.limits.maxQuantityPerProduct, Math.max(1, Number.parseInt(item.quantity, 10) || 1))
    })).filter(item => SHOP_CONFIG.products.some(product => product.id === item.productId))
  } catch (error) {
    return []
  }
}

function saveCart() {
  try {
    // Seuls des identifiants de catalogue et des quantités sont conservés.
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cart))
  } catch (error) {}
}

function productById(productId) {
  return SHOP_CONFIG.products.find(product => product.id === productId)
}

function cartEntries() {
  return state.cart.map(line => ({ line, product: productById(line.productId) })).filter(entry => entry.product)
}

function itemCount() {
  return state.cart.reduce((total, line) => total + line.quantity, 0)
}

function testPromoDefinition() {
  return Object.values(SHOP_CONFIG.promoCodes).find(promo => promo.testOnly && promo.type === 'test-checkout')
}

function isTestMode() {
  const entries = cartEntries()
  const promo = testPromoDefinition()
  return Boolean(promo && state.promoCode === promo.code && entries.length > 0 && entries.every(({ product }) => product.testProduct))
}

function calculateTotals() {
  const entries = cartEntries()
  const subtotal = entries.reduce((total, { line, product }) => total + product.price * line.quantity, 0)
  const discount = isTestMode() ? subtotal : 0
  const quotedShipping = state.relay ? Number(state.relay.price) || SHOP_CONFIG.shipping.defaultPrice : 0
  // Une commande de test ne doit jamais demander un paiement réel. Le tarif du relais
  // reste visible dans la fiche du point, mais est neutralisé dans son total de test.
  const shipping = isTestMode() ? 0 : quotedShipping
  return { subtotal, discount, quotedShipping, shipping, total: Math.max(0, subtotal - discount + shipping) }
}

function setMessage(element, message, type = '') {
  if (!element) return
  element.textContent = message
  element.className = `shop-message${type ? ` ${type}` : ''}`
}

function setInvalidFields(form) {
  $$('input, select, textarea', form).forEach(field => {
    if (field.type === 'checkbox' || field.type === 'hidden') return
    field.setAttribute('aria-invalid', String(!field.checkValidity()))
  })
}

function focusInvalid(form) {
  const invalid = $(':invalid', form)
  if (invalid) invalid.focus()
}

function renderProducts() {
  const target = $('#shop-products')
  if (!target) return
  target.replaceChildren()
  SHOP_CONFIG.products.forEach(product => {
    const card = makeElement('article', 'card shop-product-card')
    const images = Array.isArray(product.images) && product.images.length ? product.images : product.image ? [product.image] : []
    const gallery = makeElement('div', 'shop-product-gallery')
    const art = makeElement('div', 'shop-product-art')
    if (images.length) {
      const image = document.createElement('img')
      image.src = images[0]
      image.alt = `${product.name} · vue 1`
      image.loading = 'lazy'
      image.dataset.galleryMain = product.id
      art.append(image)
      gallery.append(art)
      if (images.length > 1) {
        const thumbnails = makeElement('div', 'shop-product-thumbnails')
        images.slice(0, 3).forEach((source, index) => {
          const thumbnail = makeElement('button', `shop-product-thumbnail${index === 0 ? ' is-selected' : ''}`)
          thumbnail.type = 'button'
          thumbnail.dataset.galleryImage = source
          thumbnail.dataset.galleryProduct = product.id
          thumbnail.setAttribute('aria-label', `Afficher ${product.name}, vue ${index + 1}`)
          thumbnail.setAttribute('aria-pressed', String(index === 0))
          const thumbnailImage = document.createElement('img')
          thumbnailImage.src = source
          thumbnailImage.alt = ''
          thumbnailImage.loading = 'lazy'
          thumbnail.append(thumbnailImage)
          thumbnails.append(thumbnail)
        })
        gallery.append(thumbnails)
      }
    } else {
      art.append(makeElement('span', '', product.testProduct ? 'TEST' : product.type.toUpperCase()))
      gallery.append(art)
    }
    card.append(gallery)

    const topline = makeElement('div', 'shop-product-topline')
    topline.append(makeElement('h3', '', product.name))
    if (product.badge) topline.append(makeElement('span', 'shop-product-badge', product.badge))
    card.append(topline)
    card.append(makeElement('p', '', product.description))

    const meta = makeElement('div', 'shop-product-meta')
    meta.append(makeElement('span', '', product.preorder ? 'Précommande' : 'Disponible pour test'))
    if (product.weight) meta.append(makeElement('span', '', `${product.weight} g`))
    card.append(meta)

    const priceLine = makeElement('div', 'shop-price-line')
    priceLine.append(makeElement('span', 'shop-price', money(product.price)))
    const addButton = makeElement('button', 'btn', product.available ? 'AJOUTER AU PANIER' : 'INDISPONIBLE')
    addButton.type = 'button'
    addButton.disabled = !product.available
    addButton.dataset.addProduct = product.id
    priceLine.append(addButton)
    card.append(priceLine)
    target.append(card)
  })
}

function renderCart() {
  const linesTarget = $('#cart-lines')
  if (!linesTarget) return
  linesTarget.replaceChildren()
  const entries = cartEntries()
  if (!entries.length) {
    linesTarget.append(makeElement('p', 'cart-empty', 'Ton panier est vide. Ajoute le produit de test pour parcourir le checkout.'))
  }

  entries.forEach(({ line, product }) => {
    const cartLine = makeElement('div', 'cart-line')
    const details = makeElement('div')
    details.append(makeElement('div', 'cart-line-name', product.name))
    details.append(makeElement('div', 'cart-line-price', `${money(product.price)} · ${money(product.price * line.quantity)}`))
    const actions = makeElement('div', 'cart-line-actions')
    const decrease = makeElement('button', 'cart-quantity-btn', '−')
    decrease.type = 'button'
    decrease.dataset.cartAction = 'decrease'
    decrease.dataset.productId = product.id
    decrease.disabled = line.quantity <= 1
    decrease.setAttribute('aria-label', `Diminuer la quantité de ${product.name}`)
    const quantity = makeElement('span', 'cart-quantity', String(line.quantity))
    quantity.setAttribute('aria-label', `Quantité : ${line.quantity}`)
    const increase = makeElement('button', 'cart-quantity-btn', '+')
    increase.type = 'button'
    increase.dataset.cartAction = 'increase'
    increase.dataset.productId = product.id
    increase.disabled = line.quantity >= SHOP_CONFIG.limits.maxQuantityPerProduct
    increase.setAttribute('aria-label', `Augmenter la quantité de ${product.name}`)
    const remove = makeElement('button', 'cart-remove-btn', 'Supprimer')
    remove.type = 'button'
    remove.dataset.cartAction = 'remove'
    remove.dataset.productId = product.id
    remove.setAttribute('aria-label', `Supprimer ${product.name} du panier`)
    actions.append(decrease, quantity, increase, remove)
    details.append(actions)
    cartLine.append(details)
    cartLine.append(makeElement('strong', '', money(product.price * line.quantity)))
    linesTarget.append(cartLine)
  })

  const totals = calculateTotals()
  const count = itemCount()
  const topCount = $('#shop-cart-count-top')
  const cartCount = $('#shop-cart-count')
  if (topCount) {
    topCount.textContent = String(count)
    topCount.setAttribute('aria-label', `${count} article${count > 1 ? 's' : ''}`)
  }
  if (cartCount) cartCount.textContent = String(count)
  const subtotal = $('#cart-subtotal')
  const discount = $('#cart-discount')
  const shipping = $('#cart-shipping')
  const total = $('#cart-total')
  if (subtotal) subtotal.textContent = money(totals.subtotal)
  if (discount) discount.textContent = totals.discount ? `− ${money(totals.discount)}` : '—'
  if (shipping) shipping.textContent = state.relay ? (isTestMode() ? `${money(totals.quotedShipping)} · test` : money(totals.shipping)) : 'À l’étape livraison'
  if (total) total.textContent = money(totals.total)
  const start = $('#checkout-start')
  if (start) start.disabled = !entries.length
  renderTestMode()
}

function renderTestMode() {
  const active = isTestMode()
  const topBanner = $('#test-mode-banner')
  const cartBanner = $('#cart-test-mode')
  if (topBanner) topBanner.hidden = !active
  if (cartBanner) cartBanner.hidden = !active
}

function updateCheckoutReview(target) {
  if (!target) return
  target.replaceChildren()
  cartEntries().forEach(({ line, product }) => {
    const row = makeElement('div', 'cart-summary-row')
    row.append(makeElement('span', '', `${product.name} × ${line.quantity}`), makeElement('strong', '', money(product.price * line.quantity)))
    target.append(row)
  })
  appendSummaryRows(target)
}

function appendSummaryRows(target) {
  const totals = calculateTotals()
  const rows = [
    ['Sous-total', money(totals.subtotal)],
    ['Réductions', totals.discount ? `− ${money(totals.discount)}` : '—'],
    ['Livraison', state.relay ? (isTestMode() ? `${money(totals.quotedShipping)} · neutralisée en mode test` : money(totals.shipping)) : 'À choisir']
  ]
  rows.forEach(([label, value]) => {
    const row = makeElement('div', 'cart-summary-row')
    row.append(makeElement('span', '', label), makeElement('strong', '', value))
    target.append(row)
  })
  const totalRow = makeElement('div', 'cart-summary-row total')
  totalRow.append(makeElement('span', '', 'TOTAL À PAYER'), makeElement('strong', '', money(totals.total)))
  target.append(totalRow)
}

function applyPromo(code) {
  const normalized = normalizeText(code, 32).toUpperCase()
  const feedback = $('#promo-feedback')
  const entries = cartEntries()
  state.promoCode = ''
  if (!normalized) {
    setMessage(feedback, 'Entre un code promo pour le tester.', 'error')
    renderCart()
    return
  }
  const promo = SHOP_CONFIG.promoCodes[normalized]
  const appliesToTestOnly = promo?.testOnly && entries.length > 0 && entries.every(({ product }) => promo.productIds.includes(product.id) && product.testProduct)
  if (!promo || !appliesToTestOnly) {
    const message = WRONG_PROMO_MESSAGES[Math.floor(Math.random() * WRONG_PROMO_MESSAGES.length)]
    setMessage(feedback, message, 'error')
    renderCart()
    return
  }
  state.promoCode = normalized
  setMessage(feedback, 'Mode commande de test activé. Le produit Test ne sera pas facturé.', 'success')
  renderCart()
}

function renderStoreConfiguration() {
  const notice = SHOP_CONFIG.preorderNotice
  const status = SHOP_CONFIG.storeStatus
  if ($('#shop-title')) $('#shop-title').textContent = notice.title
  if ($('#shop-preorder-text')) $('#shop-preorder-text').textContent = notice.text
  if ($('#shop-status-label')) $('#shop-status-label').textContent = status.label
  if ($('#shop-status-title')) $('#shop-status-title').textContent = status.title
  if ($('#shop-status-text')) $('#shop-status-text').textContent = status.text
  if ($('#shop-preorder-alert')) $('#shop-preorder-alert').textContent = `${notice.title}. Le produit visible ci-dessous est uniquement un produit de test.`
}

function updateCart(productId, action) {
  const line = state.cart.find(item => item.productId === productId)
  if (!line) return
  if (action === 'remove') state.cart = state.cart.filter(item => item.productId !== productId)
  if (action === 'increase') line.quantity = Math.min(SHOP_CONFIG.limits.maxQuantityPerProduct, line.quantity + 1)
  if (action === 'decrease' && line.quantity > 1) line.quantity -= 1
  if (state.promoCode && !isTestMode()) {
    state.promoCode = ''
    setMessage($('#promo-feedback'), 'Le panier a changé : le code de test a été retiré.', 'info')
  }
  saveCart()
  renderCart()
}

function goToStep(step) {
  const nextStep = Math.min(5, Math.max(1, Number(step)))
  state.checkoutStep = nextStep
  $$('[data-checkout-panel]').forEach(panel => { panel.hidden = panel.dataset.checkoutPanel !== String(nextStep) })
  $$('.checkout-step').forEach(item => {
    const itemStep = Number(item.dataset.step)
    item.classList.toggle('is-current', itemStep === nextStep)
    item.classList.toggle('is-complete', itemStep < nextStep)
    item.setAttribute('aria-current', itemStep === nextStep ? 'step' : 'false')
  })
  if (nextStep === 1) updateCheckoutReview($('#checkout-cart-review'))
  if (nextStep === 3) renderRelays()
  if (nextStep === 4) renderPayment()
}

function openCheckout() {
  if (!cartEntries().length) {
    setMessage($('#promo-feedback'), 'Ajoute d’abord un article au panier.', 'error')
    $('#shop-cart')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  const checkout = $('#checkout')
  if (!checkout) return
  checkout.hidden = false
  updateCheckoutReview($('#checkout-cart-review'))
  goToStep(2)
  checkout.scrollIntoView({ behavior: 'smooth', block: 'start' })
  $('#customer-last-name')?.focus()
}

function renderRelays() {
  const results = $('#relay-results')
  if (!results) return
  const search = normalizeText($('#relay-search')?.value, 80).toLowerCase()
  const points = SHOP_CONFIG.shipping.demoPoints.filter(point => {
    if (!search) return true
    return [point.name, point.address, point.city, point.postalCode, point.id].join(' ').toLowerCase().includes(search)
  })
  results.replaceChildren()
  if (!points.length) {
    results.append(makeElement('p', 'cart-empty', 'Aucun point de démonstration ne correspond à cette recherche.'))
  }
  points.forEach(point => {
    const card = makeElement('article', `relay-card${state.relay?.id === point.id ? ' is-selected' : ''}`)
    const info = makeElement('div')
    info.append(makeElement('h4', '', point.name))
    info.append(makeElement('p', '', `${point.address} · ${point.postalCode} ${point.city}`))
    info.append(makeElement('span', 'relay-demo-tag', 'Donnée de démonstration'))
    const button = makeElement('button', 'btn secondary', state.relay?.id === point.id ? 'POINT SÉLECTIONNÉ' : 'SÉLECTIONNER')
    button.type = 'button'
    button.dataset.relayId = point.id
    button.setAttribute('aria-pressed', String(state.relay?.id === point.id))
    card.append(info, button)
    results.append(card)
  })
  renderSelectedRelay()
}

function renderSelectedRelay() {
  const target = $('#relay-selected')
  if (!target) return
  target.replaceChildren()
  if (!state.relay) {
    target.hidden = true
    return
  }
  target.hidden = false
  target.append(makeElement('strong', '', `Point sélectionné : ${state.relay.name}`))
  target.append(makeElement('p', '', `${state.relay.address} · ${state.relay.postalCode} ${state.relay.city} · ID ${state.relay.id} · Tarif : ${money(state.relay.price)}`))
}

function renderPayment() {
  const summary = $('#payment-summary')
  if (summary) {
    summary.replaceChildren()
    cartEntries().forEach(({ line, product }) => {
      const row = makeElement('div', 'cart-summary-row')
      row.append(makeElement('span', '', `${product.name} × ${line.quantity}`), makeElement('strong', '', money(isTestMode() ? 0 : product.price * line.quantity)))
      summary.append(row)
    })
    appendSummaryRows(summary)
  }
  const testArea = $('#test-payment-area')
  const realArea = $('#real-payment-area')
  const proof = $('#payment-proof')
  const realSubmit = $('#real-order-submit')
  const test = isTestMode()
  if (testArea) testArea.hidden = !test
  if (realArea) realArea.hidden = test
  if (proof) proof.hidden = test ? false : true
  if (realSubmit) realSubmit.hidden = true
  const proofMeta = $('#payment-proof-meta')
  if (proofMeta) proofMeta.textContent = test ? 'Facultatif en mode test. Une capture éventuelle sera seulement marquée « paiement à vérifier ».' : 'La capture sera seulement marquée « paiement à vérifier » et contrôlée manuellement.'
}

function validateCustomer() {
  const form = $('#customer-form')
  const feedback = $('#customer-feedback')
  if (!form) return false
  setInvalidFields(form)
  if (!form.checkValidity()) {
    setMessage(feedback, 'Vérifie les champs obligatoires et le format de l’e-mail.', 'error')
    focusInvalid(form)
    return false
  }
  state.customer = {
    lastName: normalizeText(form.elements.lastName.value, SHOP_CONFIG.limits.maxNameLength),
    firstName: normalizeText(form.elements.firstName.value, SHOP_CONFIG.limits.maxNameLength),
    email: normalizeText(form.elements.email.value, SHOP_CONFIG.limits.maxEmailLength).toLowerCase(),
    phone: normalizeText(form.elements.phone.value, 30)
  }
  setMessage(feedback, '')
  return true
}

function createToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function nextLocalNumber(prefix = 'DJC') {
  localSequence += 1
  return `${prefix}-${String(localSequence).padStart(6, '0')}`
}

function automaticHistory(ticketNumber) {
  return [
    { author: 'support', automated: true, createdAt: new Date().toISOString(), body: `Bonjour !\n\nTa demande a bien été reçue.\n\nUn vendeur va la consulter dès que possible.\n\nTicket : #${ticketNumber}` },
    { author: 'support', automated: true, createdAt: new Date().toISOString(), body: 'Ta demande est bien enregistrée. Un vendeur la consultera dès que possible.' }
  ]
}

function localTicket(payload, withOrder) {
  const ticketNumber = nextLocalNumber()
  const orderNumber = withOrder ? nextLocalNumber('CMD') : ''
  const totals = payload.totals || { subtotal: 0, discount: 0, shipping: 0, total: 0 }
  const ticket = {
    ticketNumber,
    orderNumber,
    customer: payload.customer,
    orderStatus: withOrder ? 'EN PRÉPARATION' : '',
    subject: payload.subject || (withOrder ? 'Commande CD DJCreeper' : 'Demande support'),
    category: payload.category || 'Commande',
    products: withOrder ? cartEntries().map(({ line, product }) => ({ id: product.id, name: product.name, quantity: line.quantity, price: product.price })) : [],
    totals: { subtotal: totals.subtotal, discount: totals.discount, shipping: totals.shipping, total: totals.total },
    relay: payload.relay || null,
    createdAt: new Date().toISOString(),
    paymentProof: payload.payment?.proof ? { fileName: payload.payment.proof.filename, mimeType: payload.payment.proof.mimeType, size: payload.payment.proof.size } : null,
    paymentStatus: withOrder ? 'À VÉRIFIER' : 'NON CONCERNÉ',
    status: 'NOUVEAU',
    history: automaticHistory(ticketNumber),
    accessToken: createToken()
  }
  if (!withOrder && payload.message) ticket.history.push({ author: 'client', automated: false, createdAt: new Date().toISOString(), body: payload.message })
  return ticket
}

function apiBase() {
  return String(SHOP_CONFIG.api.baseUrl || '').replace(/\/$/, '')
}

async function apiRequest(path, body) {
  const base = apiBase()
  if (!base) throw new Error('API Cloudflare non configurée')
  const response = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    credentials: 'omit'
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Erreur API ${response.status}`)
  return data
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result || '')))
    reader.addEventListener('error', () => reject(new Error('Lecture de la capture impossible.')))
    reader.readAsDataURL(file)
  })
}

async function proofPayload() {
  if (!state.paymentProof?.file) return null
  const file = state.paymentProof.file
  return { filename: normalizeText(file.name, 120), mimeType: file.type, size: file.size, dataUrl: await readFileAsDataUrl(file) }
}

async function orderPayload() {
  const totals = calculateTotals()
  return {
    customer: state.customer,
    items: cartEntries().map(({ line, product }) => ({ productId: product.id, quantity: line.quantity })),
    promoCode: isTestMode() ? state.promoCode : '',
    relay: state.relay,
    totals,
    payment: { method: isTestMode() ? 'TEST' : 'PAYPAL', status: 'À VÉRIFIER', proof: await proofPayload() },
    consent: true
  }
}

async function createOrder() {
  const payload = await orderPayload()
  if (apiBase()) {
    try {
      const result = await apiRequest('/orders', payload)
      return { ticket: { ...result.ticket, accessToken: result.ticketAccessToken }, remote: true }
    } catch (error) {
      throw error
    }
  }
  if (!SHOP_CONFIG.api.allowLocalFallback) throw new Error('Le service de commande n’est pas encore configuré.')
  return { ticket: localTicket(payload, true), remote: false }
}

function showTicket(ticket) {
  state.ticket = ticket
  const view = $('#ticket-view')
  if (!view) return
  view.hidden = false
  $('#ticket-number').textContent = `#${ticket.ticketNumber}`
  const accessCard = $('#ticket-access-card')
  if (accessCard) accessCard.hidden = !ticket.accessToken
  if ($('#ticket-access-token')) $('#ticket-access-token').textContent = ticket.accessToken || ''
  $('#ticket-customer').textContent = ticket.customer ? [ticket.customer.firstName, ticket.customer.lastName].filter(Boolean).join(' ') + (ticket.customer.email ? ` · ${ticket.customer.email}` : '') : '—'
  $('#ticket-order-number').textContent = ticket.orderNumber || 'Sans commande'
  $('#ticket-order-status').textContent = ticket.orderStatus || 'Non concerné'
  $('#ticket-created-at').textContent = dateLabel(ticket.createdAt)
  $('#ticket-payment-status').textContent = ticket.paymentStatus || 'À VÉRIFIER'
  $('#ticket-total').textContent = ticket.orderNumber ? money(ticket.totals?.total) : '—'
  $('#ticket-relay').textContent = ticket.relay ? `${ticket.relay.name} · ${ticket.relay.address}, ${ticket.relay.postalCode} ${ticket.relay.city} · ID ${ticket.relay.id} · ${money(ticket.relay.price)}` : 'Non concerné'
  $('#ticket-products').textContent = ticket.products?.length ? ticket.products.map(product => `${product.name} × ${product.quantity}`).join(' · ') : 'Aucun produit'
  $('#ticket-subtotal').textContent = ticket.orderNumber ? money(ticket.totals?.subtotal) : '—'
  $('#ticket-discount').textContent = ticket.orderNumber ? (ticket.totals?.discount ? `− ${money(ticket.totals.discount)}` : '—') : '—'
  $('#ticket-shipping').textContent = ticket.orderNumber ? money(ticket.totals?.shipping) : '—'
  $('#ticket-proof').textContent = ticket.paymentProof ? `${ticket.paymentProof.fileName || 'Capture reçue'} · à vérifier` : 'Aucune'
  const status = $('#ticket-status')
  status.textContent = ticket.status || 'NOUVEAU'
  status.setAttribute('aria-label', `Statut : ${ticket.status || 'NOUVEAU'}`)
  renderHistory()
}

function renderHistory() {
  const historyTarget = $('#ticket-history')
  if (!historyTarget || !state.ticket) return
  historyTarget.replaceChildren()
  ;(state.ticket.history || []).forEach(message => {
    const item = makeElement('article', `ticket-message${message.automated ? ' is-automated' : ''}${message.author === 'client' ? ' is-human' : ''}${message.author === 'vendor' ? ' is-vendor' : ''}`)
    const meta = makeElement('div', 'ticket-message-meta')
    meta.append(makeElement('span', '', message.automated ? 'Message automatique' : message.author === 'vendor' ? 'Vendeur' : 'Toi'), makeElement('time', '', dateLabel(message.createdAt)))
    item.append(meta, makeElement('p', 'ticket-message-body', message.body))
    historyTarget.append(item)
  })
  historyTarget.scrollTop = historyTarget.scrollHeight
}

function renderConfirmation(result) {
  const box = $('#order-confirmation')
  if (!box) return
  box.replaceChildren()
  box.append(makeElement('h3', '', 'Demande enregistrée'))
  box.append(makeElement('p', '', 'Merci ! Ta demande a été enregistrée. Le paiement va maintenant être vérifié manuellement par un vendeur.'))
  const ids = makeElement('div')
  ids.append(makeElement('span', 'confirmation-id', `Commande : ${result.ticket.orderNumber}`), document.createTextNode(' '), makeElement('span', 'confirmation-id', `Ticket : #${result.ticket.ticketNumber}`))
  box.append(ids)
  if (result.ticket.accessToken) {
    const access = makeElement('p', 'ticket-private-note', 'Clé d’accès privée à conserver pour retrouver ce ticket :')
    access.append(document.createElement('br'), makeElement('code', 'confirmation-id', result.ticket.accessToken))
    box.append(access)
  }
  if (!result.remote) box.append(makeElement('p', 'field-help', 'Mode local : ce ticket de démonstration reste disponible dans cette session. Le Worker Cloudflare le rendra persistant après configuration.'))
}

async function submitOrder() {
  if (!isTestMode() && !state.paymentProof) {
    setMessage($('#paypal-feedback'), 'Ajoute la capture du paiement demandée avant d’enregistrer la commande.', 'error')
    $('#payment-proof-file')?.focus()
    return
  }
  const submitButtons = [$('#test-payment-submit'), $('#real-order-submit')].filter(Boolean)
  submitButtons.forEach(button => { button.disabled = true })
  try {
    const result = await createOrder()
    renderConfirmation(result)
    showTicket(result.ticket)
    goToStep(5)
    $('#ticket-view')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'La commande n’a pas pu être enregistrée.'
    setMessage($('#paypal-feedback'), message, 'error')
    setMessage($('#customer-feedback'), message, 'error')
  } finally {
    submitButtons.forEach(button => { button.disabled = false })
  }
}

async function createSupportTicket(payload) {
  if (apiBase()) {
    try {
      const result = await apiRequest('/support/tickets', payload)
      return { ticket: { ...result.ticket, accessToken: result.ticketAccessToken }, remote: true }
    } catch (error) {
      throw error
    }
  }
  if (!SHOP_CONFIG.api.allowLocalFallback) throw new Error('Le service client n’est pas encore configuré.')
  return { ticket: localTicket(payload, false), remote: false }
}

async function submitSupport(event) {
  event.preventDefault()
  const form = event.currentTarget
  const feedback = $('#support-feedback')
  setInvalidFields(form)
  if (!form.checkValidity()) {
    setMessage(feedback, 'Renseigne un e-mail valide, un sujet, une catégorie et un message.', 'error')
    focusInvalid(form)
    return
  }
  const button = $('button[type="submit"]', form)
  if (button) button.disabled = true
  const payload = {
    customer: { email: normalizeText(form.elements.email.value, SHOP_CONFIG.limits.maxEmailLength) },
    email: normalizeText(form.elements.email.value, SHOP_CONFIG.limits.maxEmailLength).toLowerCase(),
    subject: normalizeText(form.elements.subject.value, SHOP_CONFIG.limits.maxSubjectLength),
    category: normalizeText(form.elements.category.value, 60),
    message: normalizeText(form.elements.message.value, SHOP_CONFIG.limits.maxMessageLength),
    consent: true
  }
  try {
    const result = await createSupportTicket(payload)
    form.reset()
    setMessage(feedback, 'Ticket créé. La conversation est disponible ci-dessous.', 'success')
    showTicket(result.ticket)
    $('#ticket-view')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (error) {
    setMessage(feedback, error instanceof Error ? error.message : 'Le ticket n’a pas pu être créé.', 'error')
  } finally {
    if (button) button.disabled = false
  }
}

async function submitTicketMessage(event) {
  event.preventDefault()
  if (!state.ticket) return
  const form = event.currentTarget
  const textarea = form.elements.message
  const message = normalizeText(textarea.value, SHOP_CONFIG.limits.maxMessageLength)
  if (!message) {
    textarea.setAttribute('aria-invalid', 'true')
    textarea.focus()
    return
  }
  textarea.removeAttribute('aria-invalid')
  const button = $('button[type="submit"]', form)
  if (button) button.disabled = true
  try {
    let response
    if (apiBase() && state.ticket.accessToken) {
      response = await apiRequest('/tickets/messages', { ticketNumber: state.ticket.ticketNumber, accessToken: state.ticket.accessToken, message })
    } else {
      state.ticket.history = state.ticket.history || []
      state.ticket.history.push({ author: 'client', automated: false, createdAt: new Date().toISOString(), body: message })
      state.ticket.status = 'EN ATTENTE VENDEUR'
      response = { ticket: state.ticket }
    }
    if (response.ticket) showTicket({ ...state.ticket, ...response.ticket })
    form.reset()
  } catch (error) {
    setMessage($('#paypal-feedback'), error instanceof Error ? error.message : 'Le message n’a pas pu être envoyé.', 'error')
  } finally {
    if (button) button.disabled = false
  }
}

function validateProofFile(file) {
  if (!file) return 'Aucun fichier sélectionné.'
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  if (!SHOP_CONFIG.upload.acceptedTypes.includes(file.type) || !SHOP_CONFIG.upload.acceptedExtensions.includes(extension)) return 'Format refusé. Utilise PNG, JPG, JPEG ou WEBP.'
  if (file.size > SHOP_CONFIG.upload.maxBytes) return 'Fichier trop volumineux. La limite est de 5 Mo.'
  return ''
}

function onProofChange(event) {
  const file = event.target.files?.[0]
  const meta = $('#payment-proof-meta')
  const preview = $('#payment-proof-preview')
  const error = validateProofFile(file)
  state.paymentProof = null
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl)
  state.objectUrl = null
  if (error) {
    event.target.value = ''
    if (preview) preview.hidden = true
    if (meta) meta.textContent = error
    setMessage($('#paypal-feedback'), error, 'error')
    return
  }
  state.paymentProof = { file }
  state.objectUrl = URL.createObjectURL(file)
  if (preview) {
    preview.src = state.objectUrl
    preview.hidden = false
  }
  if (meta) meta.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} Mo · capture reçue pour vérification manuelle.`
  setMessage($('#paypal-feedback'), '')
}

function renderRecoveryAvailability() {
  const recovery = $('#ticket-recovery')
  if (recovery) recovery.hidden = !apiBase()
}

async function recoverTicket(event) {
  event.preventDefault()
  const form = event.currentTarget
  const feedback = $('#ticket-recovery-feedback')
  const ticketNumber = normalizeText(form.elements.ticketNumber.value, 40)
  const accessToken = normalizeText(form.elements.accessToken.value, 128)
  if (!ticketNumber || !accessToken) {
    setMessage(feedback, 'Le numéro et la clé d’accès sont nécessaires.', 'error')
    return
  }
  const button = $('button[type="submit"]', form)
  if (button) button.disabled = true
  try {
    const result = await apiRequest('/tickets/view', { ticketNumber, accessToken })
    showTicket({ ...result.ticket, accessToken })
    setMessage(feedback, 'Ticket retrouvé dans la session.', 'success')
  } catch (error) {
    setMessage(feedback, error instanceof Error ? error.message : 'Ticket introuvable.', 'error')
  } finally {
    if (button) button.disabled = false
  }
}

function bindEvents() {
  $('#open-cart')?.addEventListener('click', () => {
    $('#shop-cart')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    $('#cart-title')?.focus()
  })
  $('#shop-products')?.addEventListener('click', event => {
    const galleryButton = event.target.closest('[data-gallery-image]')
    if (galleryButton) {
      const card = galleryButton.closest('.shop-product-card')
      const mainImage = card?.querySelector('[data-gallery-main]')
      if (mainImage) {
        const index = [...card.querySelectorAll('[data-gallery-image]')].indexOf(galleryButton)
        mainImage.src = galleryButton.dataset.galleryImage
        mainImage.alt = `${productById(galleryButton.dataset.galleryProduct)?.name || 'Produit'} · vue ${index + 1}`
        card.querySelectorAll('[data-gallery-image]').forEach(button => {
          const selected = button === galleryButton
          button.classList.toggle('is-selected', selected)
          button.setAttribute('aria-pressed', String(selected))
        })
      }
      return
    }
    const button = event.target.closest('[data-add-product]')
    if (!button) return
    const productId = button.dataset.addProduct
    const line = state.cart.find(item => item.productId === productId)
    if (line) line.quantity = Math.min(SHOP_CONFIG.limits.maxQuantityPerProduct, line.quantity + 1)
    else state.cart.push({ productId, quantity: 1 })
    saveCart()
    renderCart()
    setMessage($('#promo-feedback'), 'Produit ajouté au panier.', 'success')
  })
  $('#cart-lines')?.addEventListener('click', event => {
    const button = event.target.closest('[data-cart-action]')
    if (button) updateCart(button.dataset.productId, button.dataset.cartAction)
  })
  $('#promo-form')?.addEventListener('submit', event => {
    event.preventDefault()
    applyPromo(event.currentTarget.elements.promoCode.value)
  })
  $('#checkout-start')?.addEventListener('click', openCheckout)
  $$('[data-go-step]').forEach(button => button.addEventListener('click', () => goToStep(button.dataset.goStep)))
  $('#customer-form')?.addEventListener('submit', event => {
    event.preventDefault()
    if (validateCustomer()) goToStep(3)
  })
  $('#relay-search')?.addEventListener('input', renderRelays)
  $('#relay-search-clear')?.addEventListener('click', () => { $('#relay-search').value = ''; renderRelays(); $('#relay-search').focus() })
  $('#relay-results')?.addEventListener('click', event => {
    const button = event.target.closest('[data-relay-id]')
    if (!button) return
    const point = SHOP_CONFIG.shipping.demoPoints.find(item => item.id === button.dataset.relayId)
    if (!point) return
    state.relay = { ...point }
    setMessage($('#relay-feedback'), 'Point Relais sélectionné. Vérifie le récapitulatif avant de continuer.', 'success')
    renderRelays()
    renderCart()
  })
  $('#relay-next')?.addEventListener('click', () => {
    if (!state.relay) {
      setMessage($('#relay-feedback'), 'Sélectionne un Point Relais ou un Locker pour continuer.', 'error')
      return
    }
    goToStep(4)
  })
  $('#paypal-payment')?.addEventListener('click', () => {
    $('#paypal-return-question').hidden = false
    setMessage($('#paypal-feedback'), 'PayPal est ouvert dans un nouvel onglet. À ton retour, indique si le paiement a été effectué.', 'info')
  })
  $('#paypal-paid')?.addEventListener('click', () => {
    $('#payment-proof').hidden = false
    $('#real-order-submit').hidden = false
    setMessage($('#paypal-feedback'), 'Merci. Ajoute une capture si tu en as une, puis enregistre la commande.', 'info')
  })
  $('#paypal-not-paid')?.addEventListener('click', () => setMessage($('#paypal-feedback'), 'Pas de souci. Le paiement pourra être effectué plus tard depuis cette étape.', 'info'))
  $('#payment-proof-file')?.addEventListener('change', onProofChange)
  $('#test-payment-submit')?.addEventListener('click', submitOrder)
  $('#real-order-submit')?.addEventListener('click', submitOrder)
  $('#support-form')?.addEventListener('submit', submitSupport)
  $('#ticket-message-form')?.addEventListener('submit', submitTicketMessage)
  $('#ticket-recovery-form')?.addEventListener('submit', recoverTicket)
  $('#copy-ticket-access')?.addEventListener('click', async event => {
    const token = $('#ticket-access-token')?.textContent || ''
    try {
      await navigator.clipboard.writeText(token)
      event.currentTarget.textContent = 'Clé copiée'
    } catch (error) {
      setMessage($('#ticket-recovery-feedback'), 'Copie automatique indisponible : sélectionne la clé manuellement.', 'info')
    }
  })
}

function init() {
  if (!$('#shop-products')) return
  renderStoreConfiguration()
  renderProducts()
  renderCart()
  bindEvents()
  renderRecoveryAvailability()
  goToStep(1)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true })
else init()
