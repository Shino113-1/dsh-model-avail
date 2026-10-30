import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/**
 * 像 Harness 的 loader 那样加载浏览器 bundle，但换成桩 `window`，
 * 让模块主体能在 node 下跑起来。
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

/** 构造浏览器半侧消费的宿主 state 响应体。 */
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
  // createSnapshotStore 交出的正是 { value, status, error }，与真实实现一致。
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
  // 服务已在，但目录没有 —— 就像冷启动的页面，它稍后才出现。
  assert.equal(state.value.groups[0].name, 'Alpha')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(state.value.groups[0].name, 'Alpha', 'no decoration before the store exists')
  service.catalog = { store }
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.equal(state.value.groups[0].name, 'Alpha · 1/1')
})

test('the picker roster is reported to the host once per change', async (t) => {
  const groups = [
    { id: 'alpha', name: 'Alpha', models: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }] },
    { id: 'beta', name: 'Beta', models: [{ id: 'b1', name: 'B1' }] },
  ]
  const state = { value: { groups } }
  const store = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    update: (mutator) => mutator(state),
  }
  const posted = []
  const realFetch = globalThis.fetch
  const realInfo = console.info
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') posted.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => hostState([]) }
  }
  console.info = () => {}
  let teardown = null
  t.after(() => {
    globalThis.fetch = realFetch
    console.info = realInfo
    teardown?.()
  })

  client.apply({
    effect(run) {
      teardown = run()
      return teardown
    },
    inject: (_deps, callback) => callback({ modelDirectories: { catalog: { store } } }),
  })
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.equal(posted.length, 1, 'one roster post after the store is attached')
  assert.equal(posted[0].url, '/dsh-model-avail/roster')
  assert.deepEqual(posted[0].body, {
    providers: [
      { id: 'alpha', name: 'Alpha', models: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }] },
      { id: 'beta', name: 'Beta', models: [{ id: 'b1', name: 'B1' }] },
    ],
  })

  // 同一份名单再装饰一次，不能重复上报。
  state.value = { groups: client.decorate(groups, null) }
  store.subscribe = () => () => {}
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(posted.length, 1, 'unchanged rosters are not re-posted')
})

test('model names in the picker are painted by availability', (t) => {
  const providerSelector = '.dsh-reasoning-model__provider'
  const nameSelector = '.dsh-reasoning-model__provider-name'
  const optionSelector = '.dsh-reasoning-model__option-name'
  /** 一个模型名节点，记住被标上的可用性属性。 */
  const option = (textContent) => {
    const attributes = {}
    return {
      textContent,
      getAttribute: (key) => attributes[key],
      setAttribute: (key, value) => {
        attributes[key] = value
      },
      attribute: (key) => attributes[key],
    }
  }
  const provider = (heading, options) => ({
    querySelector: (selector) => (selector === nameSelector ? { textContent: heading } : null),
    querySelectorAll: (selector) => (selector === optionSelector ? options : []),
  })
  const live = option('A1')
  const dead = option('A2 (不可用)')
  const unprobed = option('A3')
  const stranger = option('Z9')
  const alpha = provider('Alpha · 1/3', [live, dead, unprobed])
  const unknown = provider('Not reported', [stranger])
  const realDocument = globalThis.document
  globalThis.document = {
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelectorAll: (selector) => (selector === providerSelector ? [alpha, unknown] : []),
  }
  t.after(() => {
    globalThis.document = realDocument
  })

  const result = client.paintDocument(
    hostState([
      {
        id: 'alpha',
        name: 'Alpha',
        usable: 1,
        total: 3,
        models: [
          { id: 'a1', name: 'A1', state: 'available' },
          { id: 'a2', name: 'A2', state: 'unavailable' },
          { id: 'a3', name: 'A3', state: 'unknown' },
        ],
      },
    ]),
  )

  assert.equal(result.painted, 3)
  assert.deepEqual(result.byState, { available: 1, unavailable: 1, unknown: 1 })
  assert.equal(live.attribute('data-model-avail'), 'available')
  assert.equal(dead.attribute('data-model-avail'), 'unavailable')
  assert.equal(unprobed.attribute('data-model-avail'), 'unknown')
  assert.equal(stranger.attribute('data-model-avail'), undefined, 'unknown providers are left alone')
})