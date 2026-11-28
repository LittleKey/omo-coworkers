import { createHash, randomUUID } from 'node:crypto'

export const CATALOG_RPC_ID = 'omo-coworkers.catalog.v1'
const text = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value)

// Never serialize provider records, credentials, settings, or arbitrary capabilities.
export function publicModels(input) {
  if (!input || Array.isArray(input) || typeof input.location?.directory !== 'string' ||
      !Array.isArray(input.data) || input.data.length > 4096) throw new Error('INVALID_CATALOG')
  const seen = new Set()
  return input.data.map(model => {
    const id = model?.id ?? model?.modelID
    if (!text(model?.providerID) || !text(id)) throw new Error('INVALID_CATALOG')
    const key = JSON.stringify([model.providerID, id])
    if (seen.has(key)) throw new Error('INVALID_CATALOG')
    seen.add(key)
    const entries = model.variants === undefined ? [] : model.variants
    if (!Array.isArray(entries) || entries.length > 128 ||
        !entries.every(variant => variant && typeof variant === 'object' &&
          !Array.isArray(variant) && text(variant.id))) throw new Error('INVALID_CATALOG')
    const variants = entries.map(variant => variant.id)
    return { providerID: model.providerID, id,
      ...(text(model.name) ? { name: model.name } : {}),
      variants: [...new Set(variants)].sort() }
  }).sort((a, b) => a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id))
}

export const snapshotSchema = {
  type: 'object', additionalProperties: false,
  required: ['version', 'publisherInstanceId', 'sequence', 'publishedAt', 'catalogRevision', 'models'],
  properties: {
    version: { const: 1 },
    publisherInstanceId: { type: 'string', maxLength: 128 },
    sequence: { type: 'integer', minimum: 1 },
    publishedAt: { type: 'integer', minimum: 0 },
    catalogRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    models: { type: 'array', maxItems: 4096, items: {
      type: 'object', additionalProperties: false, required: ['providerID', 'id', 'variants'],
      properties: {
        providerID: { type: 'string', minLength: 1, maxLength: 1024 },
        id: { type: 'string', minLength: 1, maxLength: 1024 },
        name: { type: 'string', minLength: 1, maxLength: 1024 },
        variants: { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 1024 } },
      },
    } },
  },
}

export async function setupCatalogPublisher(ctx, {
  now = Date.now, instanceId = randomUUID(),
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  // Finite, once-per-instance failure classes only; never log host errors or data.
  const reported = new Set()
  const diagnose = code => {
    if (reported.has(code)) return
    reported.add(code)
    try { console.warn(`[omo-coworkers.catalog] ${code}`) } catch {}
  }
  if (!ctx.rpc?.register || !ctx.model?.list) {
    diagnose('CAPABILITY_UNAVAILABLE')
    return { dispose() {} }
  }
  let registration, disposed = false, inFlight = false, sequence = 0, timer
  const tick = async () => {
    if (disposed || inFlight) return
    inFlight = true
    let failure = 'FETCH_FAILED'
    try {
      const response = await ctx.model.list()
      failure = 'SCHEMA_INVALID'
      const models = publicModels(response)
      const catalogRevision = createHash('sha256').update(JSON.stringify(models)).digest('hex')
      const snapshot = { version: 1, publisherInstanceId: instanceId,
        sequence: ++sequence, publishedAt: now(), catalogRevision, models }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) {
        diagnose('SCHEMA_INVALID')
        return
      }
      failure = 'EMIT_FAILED'
      if (!disposed) await registration.events.emit('snapshot', snapshot)
    } catch {
      // A failed fetch emits nothing, preserving the receiver's last good cache.
      diagnose(failure)
    } finally {
      inFlight = false
      if (!disposed) { timer = schedule(tick, 30_000); timer?.unref?.() }
    }
  }
  // Defer the first fetch until plugin setup has returned.
  // Registration must not hold base plugin setup hostage. Rejection is isolated;
  // a late registration after disposal is immediately torn down.
  Promise.resolve().then(() => ctx.rpc.register({
    id: CATALOG_RPC_ID, methods: {}, events: { snapshot: { schema: snapshotSchema } },
  }, {})).then(value => {
    registration = value
    if (disposed) return registration.dispose()
    timer = schedule(tick, 0)
    timer?.unref?.()
  }).catch(() => { diagnose('REGISTRATION_FAILED') })
  return { dispose() {
    if (disposed) return
    disposed = true
    if (timer !== undefined) cancel(timer)
    return registration?.dispose()
  } }
}
