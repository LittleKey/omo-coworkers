import test from 'node:test'
import assert from 'node:assert/strict'
import { publicModels, setupCatalogPublisher } from '../openchamber/plugin/catalog-publisher.mjs'

const envelope = data => ({ location: { directory: '/never-directory' }, data })
const model = { providerID: 'magpie/custom', id: 'agy/model/name', modelID: 'alias',
  variants: [{ id: 'z', settings: { token: 'never-token' } }, { id: 'a' }, { id: 'z' }],
  credentials: { apiKey: 'never-key' } }
const turn = () => new Promise(resolve => setImmediate(resolve))

test('official Location.response(Model.Info[]) projects only public variant ids', () => {
  assert.deepEqual(publicModels(envelope([model, { providerID: 'a', modelID: 'fallback' }])), [
    { providerID: 'a', id: 'fallback', variants: [] },
    { providerID: 'magpie/custom', id: 'agy/model/name', variants: ['a', 'z'] },
  ])
  for (const input of [[model], { data: [model] }, envelope([null]),
    envelope([model, model]), envelope(Array(4097).fill(model)),
    ...[null, {}, ['high'], [{ id: '' }], Array(129).fill({ id: 'x' })]
      .map(variants => envelope([{ ...model, variants }]))]) {
    assert.throws(() => publicModels(input), /INVALID_CATALOG/)
  }
})

test('failures are bounded and private; later ticks recover and disposal cancels', async () => {
  const warnings = [], tasks = [], emitted = [], cancelled = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  let mode = 'fetch', disposals = 0
  try {
    const publisher = await setupCatalogPublisher({
      model: { async list() {
        if (mode === 'fetch') throw new Error('never-token /never-directory')
        if (mode === 'schema') return envelope([{ ...model, variants: ['bad'] }])
        return envelope([model])
      } },
      rpc: { async register() { return {
        events: { async emit(name, snapshot) {
          if (mode === 'emit') throw new Error('never-key')
          emitted.push(snapshot)
        } }, dispose() { disposals++ },
      } } },
    }, { schedule(fn) { tasks.push(fn); return fn }, cancel(fn) { cancelled.push(fn) } })
    await turn()
    for (const next of ['fetch', 'fetch', 'schema', 'schema', 'emit', 'emit', 'ok']) {
      mode = next
      await tasks.shift()()
    }
    assert.deepEqual(warnings.flat(), [
      '[omo-coworkers.catalog] FETCH_FAILED',
      '[omo-coworkers.catalog] SCHEMA_INVALID',
      '[omo-coworkers.catalog] EMIT_FAILED',
    ])
    assert.equal(emitted.length, 1)
    assert.equal(JSON.stringify([warnings, emitted]).includes('never-'), false)
    publisher.dispose()
    publisher.dispose()
    assert.equal(disposals, 1)
    assert.equal(cancelled.length, 1)
    await tasks.shift()()
    assert.equal(emitted.length, 1)
  } finally { console.warn = original }
})

test('registration rejection, hanging registration and late disposal do not block setup', async () => {
  const original = console.warn, warnings = [], tasks = []
  console.warn = value => warnings.push(value)
  try {
    const rejected = await setupCatalogPublisher({
      model: { list() { assert.fail('unexpected fetch') } },
      rpc: { register() { return Promise.reject(new Error('never-token')) } },
    }, { schedule(fn) { tasks.push(fn) } })
    await turn()
    assert.deepEqual(warnings, ['[omo-coworkers.catalog] REGISTRATION_FAILED'])
    rejected.dispose()
    let resolve, disposed = 0
    const pending = await setupCatalogPublisher({
      model: { list() { assert.fail('unexpected fetch') } },
      rpc: { register() { return new Promise(done => { resolve = done }) } },
    }, { schedule(fn) { tasks.push(fn) } })
    await turn()
    pending.dispose()
    resolve({ dispose() { disposed++ } })
    await turn()
    assert.equal(disposed, 1)
    assert.equal(tasks.length, 0)
  } finally { console.warn = original }
})
