const $ = s=>document.querySelector(s)
const $$ = s=>document.querySelectorAll(s)

function initMenu(){
  const btn = $('.menu-btn')
  const nav = $('.navlinks')
  if(!btn||!nav) return
  btn.addEventListener('click',()=>nav.classList.toggle('open'))
}

function setActiveNav(){
  const path = location.pathname.split('/').pop()||'index.html'
  $$('.navlinks a').forEach(a=>{
    const href = a.getAttribute('href')
    if(href===path) a.setAttribute('aria-current','page')
  })
}

function euro(n){
  try{ return new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(n)}catch(e){return n+'€'}
}

function lsGet(k,fb){
  try{ return JSON.parse(localStorage.getItem(k)) ?? fb }catch(e){ return fb }
}
function lsSet(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)) }catch(e){} }

function initDonations(){
  const form = $('#don-form')
  if(!form) return
  const list = $('#don-list')
  const boostList = $('#boost-list')
  const info = $('#rule-info')
  info.textContent = 'Seuls les montants arrondis à l’euro sont pris en compte. Les montants intermédiaires sont arrondis à l’euro le plus proche.'

  const dons = lsGet('djc_dons',[])
  const boosts = lsGet('djc_boosts',[])

  function render(){
    list.innerHTML = ''
    if(dons.length===0){ list.innerHTML = '<tr><td colspan="3" class="muted">Aucun don enregistré pour le moment.</td></tr>' }
    dons.slice().reverse().forEach(d=>{
      const tr = document.createElement('tr')
      tr.innerHTML = `<td>${d.name}</td><td>${new Date(d.date).toLocaleDateString('fr-FR')}</td><td><strong>${euro(d.amount)}</strong></td>`
      list.appendChild(tr)
    })

    boostList.innerHTML = ''
    if(boosts.length===0){ boostList.innerHTML = '<tr><td colspan="2" class="muted">Aucun boost enregistré.</td></tr>' }
    boosts.slice().reverse().forEach(b=>{
      const tr = document.createElement('tr')
      tr.innerHTML = `<td>${b.name}</td><td>${new Date(b.date).toLocaleDateString('fr-FR')}</td>`
      boostList.appendChild(tr)
    })
  }

  render()

  form.addEventListener('submit',e=>{
    e.preventDefault()
    const name = form.name.value.trim()||'Anonyme'
    const raw = parseFloat(String(form.amount.value).replace(',','.'))
    if(isNaN(raw) || raw<=0){ alert('Montant invalide.'); return }
    const rounded = Math.round(raw)
    if(rounded<1){ alert('Le montant arrondi doit être au moins 1€.'); return }
    dons.push({name,amount:rounded,date:Date.now()})
    lsSet('djc_dons',dons)
    form.reset()
    render()
  })

  const boostForm = $('#boost-form')
  boostForm.addEventListener('submit',e=>{
    e.preventDefault()
    const name = boostForm.booster.value.trim()
    if(!name){ alert('Nom/pseudo requis.') ;return }
    boosts.push({name,date:Date.now()})
    lsSet('djc_boosts',boosts)
    boostForm.reset()
    render()
  })
}

function initEventCountdown(){
  const el = $('#event-countdown')
  const host = $('#event-host')
  if(!el) return
  const dateStr = el.dataset.date
  if(!dateStr) return
  const target = new Date(dateStr)
  function tick(){
    const now = new Date()
    const diff = target-now
    if(diff<=0){ el.textContent = 'En cours / Terminé'; return }
    const d = Math.floor(diff/86400000)
    const h = Math.floor((diff%86400000)/3600000)
    const m = Math.floor((diff%3600000)/60000)
    const s = Math.floor((diff%60000)/1000)
    el.textContent = `${d}j ${h}h ${m}m ${s}s`
  }
  tick()
  setInterval(tick,1000)
}

window.addEventListener('DOMContentLoaded',()=>{
  initMenu()
  setActiveNav()
  initDonations()
  initEventCountdown()
})