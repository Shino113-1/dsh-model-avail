import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'dsh-model-avail-'))
process.env.DSH_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const { apply, inject } = await import('../lib/index.js')

/** Build a host context with just the services this plugin touches. */
function fakeContext({ providers, models, stream }) {
  const registered = []
  const disposers = []
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      disposers.push({ label, dispose })
      return () => dispose?.()
    },
    on() {
      return () => {}
    },
    llm: {
      listProviders: () => providers.map((provider) => ({ ...provider })),
      listModels: async (providerId) => {
        const entry = models[providerId]
        if (entry instanceof Error) throw entry
        return entry.map((model) => ({ ...model }))
      },
      stream,
    },
    webServer: {
      register(spec) {
        registered.push(spec)
        return () => {}
      },
    },
  }
  return { ctx, registered, disposers }
}

/** Drive one route request and collect the JSON body. */
async function request(spec, method, url, body) {
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  const res = {
    destroyed: false,
    writableEnded: false,
    status: 0,
    payload: '',
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = text
      this.writableEnded = true
    },
  }
  await spec.handler(req, res)
  return { status: res.status, body: res.payload === '' ? null : JSON.parse(res.payload) }
}

/** Poll the state route until the probe cycle settles. */
async function settled(spec) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { body } = await request(spec, 'GET', '/dsh-model-avail/state')
    if (body.probing === false) return body
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('probe cycle never settled')
}

test('host half registers one prefix route and declares its services', () => {
  const { ctx, registered } = fakeContext({ providers: [], models: {}, stream: async function* () {} })
  apply(ctx)
  assert.deepEqual(inject, ['webServer', 'llm'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/dsh-model-avail')
})

test('a model that cannot serve a turn is reported unavailable', async () => {
  const { ctx, registered } = fakeContext({
    providers: [{ id: 'p1', name: 'Provider One' }],
    models: { p1: [{ id: 'good', name: 'Good' }, { id: 'bad', name: 'Bad' }] },
    stream: async function* (options) {
      if (options.model === 'good') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'no api key' } } }
    },
  })
  apply(ctx)
  const spec = registered[0]
  await request(spec, 'GET', '/dsh-model-avail/state?refresh=1&force=1')
  const state = await settled(spec)
  assert.equal(state.providers.length, 1)
  const provider = state.providers[0]
  assert.equal(provider.id, 'p1')
  assert.equal(provider.usable, 1)
  assert.equal(provider.total, 2)
  const byId = new Map(provider.models.map((model) => [model.id, model]))
  assert.equal(byId.get('good').state, 'available')
  assert.equal(byId.get('bad').state, 'unavailable')
})

test('a transient failure stays unknown instead of hiding the model', async () => {
  const { ctx, registered } = fakeContext({
    providers: [{ id: 'p2', name: 'Provider Two' }],
    models: { p2: [{ id: 'flaky', name: 'Flaky' }] },
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: '429 too many requests' } } }
    },
  })
  apply(ctx)
  const spec = registered[0]
  await request(spec, 'GET', '/dsh-model-avail/state?refresh=1&force=1')
  const state = await settled(spec)
  assert.equal(state.providers[0].models[0].state, 'unknown')
})

test('reprobing one route writes the verdict immediately', async () => {
  const { ctx, registered } = fakeContext({
    providers: [{ id: 'p3', name: 'Provider Three' }],
    models: { p3: [{ id: 'm', name: 'M' }] },
    stream: async function* () {
      yield { type: 'text-delta', text: 'pong' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  apply(ctx)
  const spec = registered[0]
  const { status, body } = await request(spec, 'POST', '/dsh-model-avail/probe', { provider: 'p3', model: 'm' })
  assert.equal(status, 200)
  assert.equal(body.verdict.state, 'available')
})

test('a malformed probe request is rejected without touching the provider', async () => {
  const { ctx, registered } = fakeContext({ providers: [], models: {}, stream: async function* () {} })
  apply(ctx)
  const { status } = await request(registered[0], 'POST', '/dsh-model-avail/probe', { provider: 'p3' })
  assert.equal(status, 400)
})