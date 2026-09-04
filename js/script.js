const $ = selector => document.querySelector(selector)
const $$ = selector => document.querySelectorAll(selector)

function initMenu() {
  const btn = $('.menu-btn')
  const nav = $('.navlinks')
  if (!btn || !nav) return
  btn.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open')
    btn.setAttribute('aria-expanded', String(isOpen))
  })
}

function setActiveNav() {
  const path = location.pathname.split('/').pop() || 'index.html'
  $$('.navlinks a').forEach(link => {
    if (link.getAttribute('href') === path) link.setAttribute('aria-current', 'page')
  })
}

function euro(value) {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(value)
  } catch (error) {
    return `${value} €`
  }
}

function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch (error) { return fallback }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch (error) {}
}

function initDonations() {
  const form = $('#don-form')
  if (!form) return
  const list = $('#don-list')
  const boostList = $('#boost-list')
  const info = $('#rule-info')
  if (info) info.textContent = 'Seuls les montants arrondis à l’euro sont pris en compte.'

  const dons = lsGet('djc_dons', [])
  const boosts = lsGet('djc_boosts', [])

  function render() {
    if (list) {
      list.innerHTML = ''
      if (!dons.length) list.innerHTML = '<tr><td colspan="3" class="muted">Aucun don enregistré pour le moment.</td></tr>'
      dons.slice().reverse().forEach(donation => {
        const row = document.createElement('tr')
        const nameCell = document.createElement('td')
        nameCell.textContent = String(donation.name || 'Anonyme').slice(0, 80)
        const dateCell = document.createElement('td')
        dateCell.textContent = new Date(donation.date).toLocaleDateString('fr-FR')
        const amountCell = document.createElement('td')
        const amount = document.createElement('strong')
        amount.textContent = euro(donation.amount)
        amountCell.appendChild(amount)
        row.append(nameCell, dateCell, amountCell)
        list.appendChild(row)
      })
    }

    if (boostList) {
      boostList.innerHTML = ''
      if (!boosts.length) boostList.innerHTML = '<tr><td colspan="2" class="muted">Aucun boost enregistré.</td></tr>'
      boosts.slice().reverse().forEach(boost => {
        const row = document.createElement('tr')
        const nameCell = document.createElement('td')
        nameCell.textContent = String(boost.name || 'Anonyme').slice(0, 80)
        const dateCell = document.createElement('td')
        dateCell.textContent = new Date(boost.date).toLocaleDateString('fr-FR')
        row.append(nameCell, dateCell)
        boostList.appendChild(row)
      })
    }
  }

  render()
  form.addEventListener('submit', event => {
    event.preventDefault()
    const name = form.name.value.trim() || 'Anonyme'
    const raw = parseFloat(String(form.amount.value).replace(',', '.'))
    if (Number.isNaN(raw) || raw <= 0) return alert('Montant invalide.')
    const rounded = Math.round(raw)
    if (rounded < 1) return alert('Le montant arrondi doit être au moins égal à 1 €.')
    dons.push({ name, amount: rounded, date: Date.now() })
    lsSet('djc_dons', dons)
    form.reset()
    render()
  })

  const boostForm = $('#boost-form')
  if (!boostForm) return
  boostForm.addEventListener('submit', event => {
    event.preventDefault()
    const name = boostForm.booster.value.trim()
    if (!name) return alert('Nom/pseudo requis.')
    boosts.push({ name, date: Date.now() })
    lsSet('djc_boosts', boosts)
    boostForm.reset()
    render()
  })
}

function initEventCountdown() {
  const element = $('#event-countdown')
  if (!element || !element.dataset.date) return
  const target = new Date(element.dataset.date)
  function tick() {
    const difference = target - new Date()
    if (difference <= 0) {
      element.textContent = 'En cours / terminé'
      return
    }
    const days = Math.floor(difference / 86400000)
    const hours = Math.floor((difference % 86400000) / 3600000)
    const minutes = Math.floor((difference % 3600000) / 60000)
    const seconds = Math.floor((difference % 60000) / 1000)
    element.textContent = `${days}j ${hours}h ${minutes}m ${seconds}s`
  }
  tick()
  setInterval(tick, 1000)
}

const YOUTUBE_MAIN_HANDLE = '@DJCreeperYTB'
const YOUTUBE_MUSIC_CHANNEL = 'UCb25KcHfT249totZpGQ342A'
const YOUTUBE_PROXY = 'https://api.allorigins.win/raw?url='
const RSS_TO_JSON = 'https://api.rss2json.com/v1/api.json?rss_url='

function videoIdFrom(value) {
  if (!value) return ''
  const match = String(value).match(/(?:youtu\.be\/|v=|embed\/|shorts\/|watch\?v=)([\w-]{6,})/)
  return match ? match[1] : String(value).match(/[\w-]{11}/)?.[0] || ''
}

function parseRssXml(xml) {
  const documentXml = new DOMParser().parseFromString(xml, 'application/xml')
  if (documentXml.querySelector('parsererror')) throw new Error('Flux RSS invalide')
  return [...documentXml.querySelectorAll('entry')].map(entry => {
    const get = name => entry.getElementsByTagName(name)[0]?.textContent?.trim() || ''
    const link = entry.querySelector('link[rel="alternate"]')?.getAttribute('href') || get('link')
    return {
      title: get('title'),
      link,
      id: videoIdFrom(get('videoId')) || videoIdFrom(link) || videoIdFrom(get('id')),
      published: get('published') || get('updated')
    }
  }).filter(item => item.id)
}

function parseRssJson(data) {
  if (!data || data.status === 'error' || !Array.isArray(data.items)) throw new Error('Réponse RSS indisponible')
  return data.items.map(item => ({
    title: item.title || '',
    link: item.link || '',
    id: videoIdFrom(item.link) || videoIdFrom(item.guid) || videoIdFrom(item.enclosure?.link),
    published: item.pubDate || item.published || item.created || ''
  })).filter(item => item.id)
}

async function fetchText(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}

async function resolveChannelId(handle) {
  const pageUrl = `https://www.youtube.com/${handle.replace(/^@?/, '@')}`
  const html = await fetchText(`${YOUTUBE_PROXY}${encodeURIComponent(pageUrl)}`)
  const matches = [
    html.match(/"channelId":"(UC[\w-]+)"/),
    html.match(/"externalId":"(UC[\w-]+)"/),
    html.match(/channel_id=(UC[\w-]+)/)
  ]
  const id = matches.find(Boolean)?.[1]
  if (!id) throw new Error('ID de chaîne introuvable')
  return id
}

async function fetchChannelFeed(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`
  const attempts = [
    async () => parseRssJson(JSON.parse(await fetchText(`${RSS_TO_JSON}${encodeURIComponent(feedUrl)}`))),
    async () => parseRssXml(await fetchText(`${YOUTUBE_PROXY}${encodeURIComponent(feedUrl)}`))
  ]
  for (const attempt of attempts) {
    try {
      const items = await attempt()
      if (items.length) return items
    } catch (error) {}
  }
  throw new Error('Flux YouTube indisponible')
}

function formatFeedDate(value) {
  if (!value) return 'Date indisponible'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Date indisponible'
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

function isLiveItem(item) {
  return /\b(live|direct|stream|rediffusion|replay)\b/i.test(item.title)
}

function applyFeedItem(card, item) {
  const id = item.id
  const thumbnail = card.querySelector('[data-feed-thumbnail]')
  const title = card.querySelector('[data-feed-title]')
  const date = card.querySelector('[data-feed-date]')
  const links = card.querySelectorAll('[data-feed-link]')
  if (thumbnail) {
    thumbnail.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    thumbnail.alt = `Aperçu : ${item.title || 'contenu YouTube'}`
  }
  if (title) title.textContent = item.title || 'Nouveau contenu'
  if (date) date.textContent = formatFeedDate(item.published)
  links.forEach(link => { link.href = `https://www.youtube.com/watch?v=${id}` })
  card.dataset.feedState = 'ready'
}

async function initYouTubeFeeds() {
  const cards = [...$$('[data-feed-role]')]
  if (!cards.length) return
  const status = $('#content-sync')
  const channelCache = new Map()

  async function getFeed(card) {
    const key = card.dataset.channelId || card.dataset.channelHandle || 'unknown'
    if (!channelCache.has(key)) {
      channelCache.set(key, (async () => {
        const channelId = card.dataset.channelId || await resolveChannelId(card.dataset.channelHandle)
        return fetchChannelFeed(channelId)
      })())
    }
    return channelCache.get(key)
  }

  await Promise.all(cards.map(async card => {
    try {
      const items = await getFeed(card)
      const item = card.dataset.feedRole === 'live'
        ? items.find(isLiveItem)
        : card.dataset.feedRole === 'video'
          ? items.find(item => !isLiveItem(item))
          : items[0]
      if (item) applyFeedItem(card, item)
      else card.dataset.feedState = 'fallback'
    } catch (error) {
      card.dataset.feedState = 'fallback'
    }
  }))

  if (status) {
    const failed = cards.some(card => card.dataset.feedState !== 'ready')
    status.textContent = failed ? 'Flux en direct · repli local disponible' : 'Flux synchronisé automatiquement'
    status.classList.add(failed ? 'is-error' : 'is-ready')
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initMenu()
  setActiveNav()
  initDonations()
  initEventCountdown()
  initYouTubeFeeds()
})
