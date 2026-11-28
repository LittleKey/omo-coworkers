import { createHash, randomUUID } from 'node:crypto'

export const CATALOG_RPC_ID = 'omo-coworkers.catalog.v1'
const text = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value)

// Never serialize provider records, credentials, settings, or arbitrary capabilities.
export function publicModels(input) {
  if (!Array.isArray(input) || input.length > 4096) throw new Error('INVALID_CATALOG')
  const seen = new Set()
  return input.map(model => {
    const id = model?.id ?? model?.modelID
    if (!text(model?.providerID) || !text(id)) throw new Error('INVALID_CATALOG')
    const key = JSON.stringify([model.providerID, id])
    if (seen.has(key)) throw new Error('INVALID_CATALOG')
    seen.add(key)
    const variants = Array.isArray(model.variants) ? model.variants :
      model.variants && typeof model.variants === 'object' ? Object.keys(model.variants) : []
    if (variants.length > 128 || !variants.every(text)) throw new Error('INVALID_CATALOG')
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
  if (!ctx.rpc?.register || !ctx.model?.list) return { dispose() {} }
  let registration, disposed = false, inFlight = false, sequence = 0, timer
  const tick = async () => {
    if (disposed || inFlight) return
    inFlight = true
    try {
      const models = publicModels(await ctx.model.list())
      const catalogRevision = createHash('sha256').update(JSON.stringify(models)).digest('hex')
      const snapshot = { version: 1, publisherInstanceId: instanceId,
        sequence: ++sequence, publishedAt: now(), catalogRevision, models }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) return
      if (!disposed) await registration.events.emit('snapshot', snapshot)
    } catch {
      // A failed fetch emits nothing, preserving the receiver's last good cache.
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
  }).catch(() => {})
  return { dispose() {
    if (disposed) return
    disposed = true
    if (timer !== undefined) cancel(timer)
    return registration?.dispose()
  } }
}
