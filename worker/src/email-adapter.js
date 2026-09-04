// Adaptateur d’e-mails transactionnels côté Worker.
// La clé API n’est jamais lue depuis un fichier public : elle vient de
// `EMAIL_API_KEY`, enregistré avec `wrangler secret put EMAIL_API_KEY`.

export async function sendTransactionalEmail(env, { to, subject, text, idempotencyKey }) {
  if (String(env.EMAIL_PROVIDER || '').toLowerCase() !== 'resend') return { sent: false, skipped: true }
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) throw new Error('Configuration e-mail incomplète.')
  const body = { from: env.EMAIL_FROM, to: [to], subject, text }
  if (env.EMAIL_REPLY_TO) body.reply_to = env.EMAIL_REPLY_TO
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'User-Agent': 'DJCreeper-Shop-Worker/1.0'
    },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`Fournisseur e-mail indisponible (${response.status}).`)
  return { sent: true }
}

export function queueTransactionalEmail(ctx, env, message) {
  if (!ctx?.waitUntil || !message?.to) return
  ctx.waitUntil(sendTransactionalEmail(env, message).catch(error => {
    // L’échec d’un e-mail ne doit jamais annuler une commande ou un ticket déjà enregistré.
    console.error('Transactional email failed', error?.message || 'unknown error')
  }))
}
