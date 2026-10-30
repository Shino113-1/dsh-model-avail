import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/**
 * Load the browser bundle the way the Harness loader does, but with a stub
 * `window` so the module body can run under node.
 */
function loadClient() {
  let definition = null
  const window = {
    __ModuleLoader__: {
      load: (spec) => {
        definition = spec
      },
    },
  }
  const source = readFileSync(CLIENT, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window)
  assert.ok(definition !== null, 'client bundle did not call __ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-model-avail')
  const exports = definition.factory(() => {
    throw new Error('client bundle must not require anything at load time')
  })
  return exports
}

const client = loadClient()

/** Build the host state body the browser half consumes. */
function hostState(providers) {
  return {
    updatedAt: 1,
    probing: false,
    progress: { done: 0, total: 0 },
    providers,
  }
}

test('provider with more live models is sorted first', () => {
  const availability = client.indexSnapshot(
    hostState([
      { id: 'alpha', usable: 1, total: 2, models: [{ id: 'a1', state: 'available' }, { id: 'a2', state: 'unavailable' }] },
      { id: 'beta', usable: 3, total: 3, models: [{ id: 'b1', state: 'available' }] },
    ]),
  )
  const groups = [
    { id: 'alpha', name: 'Alpha', models: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }] },
    { id: 'beta', name: 'Beta', models: [{ id: 'b1', name: 'B1' }] },
  ]
  const decorated = client.decorate(groups, availability)
  assert.deepEqual(decorated.map((group) => group.id), ['beta', 'alpha'])
  assert.equal(decorated[0].name, 'Beta · 3/3')
  assert.equal(decorated[1].name, 'Alpha · 1/2')
})

test('dead models sink below live ones and carry a label', () => {
  const availability = client.indexSnapshot(
    hostState([{ id: 'alpha', usable: 1, total: 2, models: [{ id: 'a1', state: 'unavailable' }, { id: 'a2', state: 'available' }] }]),
  )
  const groups = [{ id: 'alpha', name: 'Alpha', models: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }] }]
  const decorated = client.decorate(groups, availability)
  assert.deepEqual(decorated[0].models.map((model) => model.id), ['a2', 'a1'])
  assert.match(decorated[0].models[1].name, /^A1 \((?:不可用|unavailable)\)$/u)
})

test('decoration is a fixed point, so applying it twice changes nothing', () => {
  const availability = client.indexSnapshot(
    hostState([{ id: 'alpha', usable: 1, total: 2, models: [{ id: 'a1', state: 'unavailable' }, { id: 'a2', state: 'available' }] }]),
  )
  const groups = [{ id: 'alpha', name: 'Alpha', models: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }] }]
  const once = client.decorate(groups, availability)
  const twice = client.decorate(once, availability)
  assert.deepEqual(twice, once)
})

test('providers without a verdict keep their order behind ranked ones', () => {
  const availability = client.indexSnapshot(hostState([{ id: 'beta', usable: 0, total: 1, models: [{ id: 'b1', state: 'unknown' }] }]))
  const groups = [
    { id: 'gamma', name: 'Gamma', models: [{ id: 'g1', name: 'G1' }] },
    { id: 'beta', name: 'Beta', models: [{ id: 'b1', name: 'B1' }] },
  ]
  const decorated = client.decorate(groups, availability)
  assert.deepEqual(decorated.map((group) => group.id), ['beta', 'gamma'])
  assert.equal(decorated[1].name, 'Gamma')
})

test('an empty or missing snapshot leaves the groups untouched', () => {
  const groups = [{ id: 'alpha', name: 'Alpha', models: [] }]
  assert.deepEqual(client.decorate(groups, null), [{ id: 'alpha', name: 'Alpha', models: [] }])
})

test('apply attaches once the catalog store shows up late', async (t) => {
  const groups = [{ id: 'alpha', name: 'Alpha', models: [{ id: 'a1', name: 'A1' }] }]
  // createSnapshotStore hands out { value, status, error }, exactly like the real one.
  const state = { value: { groups } }
  const store = {
    getSnapshot() {
      return state
    },
    subscribe(listener) {
      this.listener = listener
      return () => {
        this.listener = null
      }
    },
    update(mutator) {
      mutator(state)
    },
  }
  const service = {}
  let teardown = null
  const ctx = {
    effect(run) {
      teardown = run()
      return teardown
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['modelDirectories'])
      callback({ modelDirectories: service })
    },
  }
  const realFetch = globalThis.fetch
  const realInfo = console.info
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => hostState([
      { id: 'alpha', usable: 1, total: 1, models: [{ id: 'a1', state: 'available' }] },
    ]),
  })
  console.info = () => {}
  t.after(() => {
    globalThis.fetch = realFetch
    console.info = realInfo
    teardown?.()
  })

  client.apply(ctx)
  // The service exists but its catalog does, as in a cold page, only later.
  assert.equal(state.value.groups[0].name, 'Alpha')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(state.value.groups[0].name, 'Alpha', 'no decoration before the store exists')
  service.catalog = { store }
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.equal(state.value.groups[0].name, 'Alpha · 1/1')
})