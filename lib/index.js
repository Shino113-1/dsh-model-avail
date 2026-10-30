/**
 * Host half of dsh-model-avail.
 *
 * Keeps a cached, per-model availability map for every LLM provider the running
 * Harness has registered, and serves it over a small HTTP prefix so the browser
 * half can reorder the model picker without touching private client internals.
 *
 * A provider's models only "work" when a request actually completes: the model
 * catalog the picker renders (`listModels` + `resolveModelInfo`) only proves the
 * provider answered a metadata call, which says nothing about a model that was
 * retired upstream, has no credential, or is over quota. The probe therefore
 * sends the smallest real turn the runtime allows — one user message, one output
 * token — and classifies the terminal `finish` chunk.
 *
 * @module dsh-model-avail/lib/index
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plugin name registered with cordis. */
export const name = 'model-avail'

/**
 * Services this plugin reads. `webServer` carries the HTTP prefix the browser
 * half polls; `llm` is the live provider registry the probes dispatch through.
 */
export const inject = ['webServer', 'llm']

/** HTTP prefix owned by this plugin. Deliberately long to avoid collisions. */
const ROUTE_PREFIX = '/dsh-model-avail'

/** How long one verdict stays trusted before the next probe cycle replaces it. */
const TTL_MS = 6 * 60 * 60 * 1000

/** Per-model probe budget. A dead endpoint must not stall the whole cycle. */
const PROBE_TIMEOUT_MS = 20_000

/** Probes in flight at once. Small enough to stay invisible to the user's quota. */
const CONCURRENCY = 3

/** Upper bound on models probed per provider, so a huge catalog cannot flood. */
const MAX_MODELS_PER_PROVIDER = 60

/**
 * Upper bound on probes in one cycle. A large catalog is covered across cycles
 * instead of in one burst; the next cycle is scheduled only if this one made
 * progress, so a permanently throttled provider cannot spin forever.
 */
const MAX_PROBES_PER_CYCLE = 80

/** Delay before continuing a cycle that ran out of its per-cycle budget. */
const CONTINUE_MS = 30_000

/** The one-token prompt every probe sends. */
const PING_TEXT = 'ping'

/**
 * Failure codes/messages that mean "this model can never serve a turn as
 * configured" rather than "try again later". Anything else is reported as
 * `unknown` so a transient 429 or a flaky network never hides a working model.
 */
const DEFINITIVE_FAILURE = /INVALID_CREDENTIAL|INVALID_CATALOG|INVALID_MODEL|MODEL_NOT_FOUND|MODEL_UNAVAILABLE|NOT_FOUND|UNAUTHORIZED|FORBIDDEN|QUOTA_EXCEEDED|ACCOUNT_QUOTA|no api key|api key|unauthori[sz]ed|forbidden|not found|does not exist|invalid model|\b40[134]\b/iu

/** Absolute path of the persisted verdict cache. */
function statePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-model-avail', 'state.json')
}

/** Key one exact route in the availability map. */
function keyOf(provider, model) {
  return `${provider}\u0000${model}`
}

/** Read the persisted cache; a missing or unreadable file is simply empty. */
function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    const models = parsed?.models
    return typeof models === 'object' && models !== null ? models : {}
  } catch {
    return {}
  }
}

/** Persist the verdict map atomically; failures are silent by design. */
function writeCache(models) {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ at: Date.now(), models }), 'utf8')
    renameSync(temp, file)
  } catch {
    /* a lost cache only costs one extra probe cycle */
  }
}

/** Shape one stored verdict. */
function verdict(state, extra = {}) {
  return {
    state,
    at: Date.now(),
    ...extra,
  }
}

/**
 * Classify one failed probe into a sticky `unavailable` or a retryable `unknown`.
 * @param failure - terminal failure payload from the stream, or a thrown error.
 * @returns the verdict a picker can act on.
 */
function classifyFailure(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : ''
  const message = typeof failure?.message === 'string' ? failure.message : String(failure ?? '')
  if (code === 'ABORTED') return verdict('unknown', { code, message: 'probe timed out' })
  const text = `${code} ${message}`
  const state = DEFINITIVE_FAILURE.test(text) ? 'unavailable' : 'unknown'
  return verdict(state, { code: code || null, message: message.slice(0, 300) })
}

/**
 * Probe one exact provider/model route with the smallest possible real request.
 * @param ctx - host context carrying the `llm` service.
 * @param provider - provider id.
 * @param model - model id owned by that provider.
 * @param signal - cycle cancellation.
 * @returns the verdict for this route; never throws.
 */
async function probeOne(ctx, provider, model, signal) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), PROBE_TIMEOUT_MS)
  const relay = () => controller.abort(signal?.reason)
  if (signal?.aborted === true) return verdict('unknown', { code: 'ABORTED', message: 'cycle cancelled' })
  signal?.addEventListener('abort', relay, { once: true })
  let settled = null
  try {
    const stream = ctx.llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: PING_TEXT }] }],
      maxTokens: 1,
      signal: controller.signal,
      purpose: 'model-availability-probe',
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'finish') {
        const reason = chunk.reason
        if (reason?.kind === 'error') settled = classifyFailure(reason.failure)
        else if (reason?.kind === 'aborted') settled = verdict('unknown', { code: 'ABORTED', message: 'probe aborted' })
        else settled = verdict('available')
        break
      }
      // A visible token is already proof of life; stop paying for the rest.
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') {
        settled = verdict('available')
        break
      }
    }
    if (settled === null) settled = verdict('unknown', { code: 'EMPTY_STREAM', message: 'stream ended without a finish chunk' })
  } catch (error) {
    settled = classifyFailure({ code: error?.code, message: error?.message ?? String(error) })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
  }
  settled.latencyMs = Date.now() - started
  return settled
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) return
      await worker(next)
    }
  })
  await Promise.all(workers)
}

/**
 * Install the availability service.
 * @param ctx - cordis context of the plugin fiber.
 */
export function apply(ctx) {
  const models = readCache()
  const providers = new Map()
  const state = { probing: false, updatedAt: 0, startedAt: 0, done: 0, total: 0, generation: 0 }
  let cycle = null
  let continuation = null

  /** True when a stored verdict is still inside the trust window. */
  const fresh = (entry) => typeof entry?.at === 'number' && Date.now() - entry.at < TTL_MS

  /** Detached snapshot of everything the browser half needs. */
  const snapshot = () => ({
    at: Date.now(),
    updatedAt: state.updatedAt,
    probing: state.probing,
    progress: { done: state.done, total: state.total },
    ttlMs: TTL_MS,
    providers: [...providers.values()].map((provider) => {
      const entries = provider.models.map((model) => {
        const found = models[keyOf(provider.id, model.model)]
        return {
          id: model.model,
          name: model.name,
          state: found?.state ?? 'unknown',
          code: found?.code ?? null,
          message: found?.message ?? null,
          at: found?.at ?? null,
          latencyMs: found?.latencyMs ?? null,
        }
      })
      const usable = entries.filter((entry) => entry.state === 'available').length
      return {
        id: provider.id,
        name: provider.name,
        error: provider.error,
        usable,
        total: entries.length,
        models: entries,
      }
    }),
  })

  /**
   * Refresh the provider/model roster from the live registry. Providers whose
   * metadata call throws are kept as failures so the picker can still be told
   * why they are missing.
   */
  async function refreshRoster() {
    const registered = ctx.llm.listProviders()
    const next = new Map()
    await Promise.all(
      registered.map(async (provider) => {
        try {
          const listed = await ctx.llm.listModels(provider.id)
          next.set(provider.id, {
            id: provider.id,
            name: provider.name ?? provider.id,
            error: null,
            models: listed.slice(0, MAX_MODELS_PER_PROVIDER).map((model) => ({ model: model.id, name: model.name })),
          })
        } catch (error) {
          next.set(provider.id, {
            id: provider.id,
            name: provider.name ?? provider.id,
            error: error instanceof Error ? error.message : String(error),
            models: [],
          })
        }
      }),
    )
    providers.clear()
    for (const [id, entry] of next) providers.set(id, entry)
  }

  /**
   * Probe every model whose verdict is stale. Concurrent calls share one cycle,
   * so a burst of client polls cannot multiply the request count.
   * @param options.force - re-probe even fresh verdicts.
   */
  function ensureProbes({ force = false } = {}) {
    if (cycle !== null) return cycle
    state.probing = true
    state.startedAt = Date.now()
    state.done = 0
    const generation = ++state.generation
    const controller = new AbortController()
    cycle = (async () => {
      try {
        await refreshRoster()
        const queue = []
        for (const provider of providers.values()) {
          for (const model of provider.models) {
            const entry = models[keyOf(provider.id, model.model)]
            if (!force && fresh(entry) && entry.state === 'available') continue
            if (!force && fresh(entry) && entry.state === 'unavailable') continue
            queue.push({ provider: provider.id, model: model.model })
          }
        }
        const budget = queue.slice(0, MAX_PROBES_PER_CYCLE)
        state.total = budget.length
        state.done = 0
        let resolved = 0
        await pool(budget, CONCURRENCY, async (item) => {
          if (generation !== state.generation) return
          const result = await probeOne(ctx, item.provider, item.model, controller.signal)
          models[keyOf(item.provider, item.model)] = result
          if (result.state !== 'unknown') resolved += 1
          state.done += 1
          if (state.done % 5 === 0) writeCache(models)
        })
        state.updatedAt = Date.now()
        writeCache(models)
        return { pending: queue.length - budget.length, resolved }
      } finally {
        state.probing = false
        cycle = null
      }
    })()
    cycle.then((outcome) => {
      // Keep going only when the cycle both had work left and actually decided
      // something: a wholly throttled provider would otherwise loop forever.
      if (outcome.pending > 0 && outcome.resolved > 0) {
        clearTimeout(continuation)
        continuation = setTimeout(() => {
          ensureProbes({ force }).catch(() => {})
        }, CONTINUE_MS)
      }
    }).catch(() => {})
    return cycle
  }

  /** Probe exactly one route again, bypassing the cache. */
  async function reprobe(provider, model) {
    const result = await probeOne(ctx, provider, model, new AbortController().signal)
    models[keyOf(provider, model)] = result
    writeCache(models)
    return result
  }

  ctx.effect(
    () => {
      const timer = setTimeout(() => {
        ensureProbes().catch(() => {})
      }, 4000)
      return () => {
        clearTimeout(timer)
        clearTimeout(continuation)
      }
    },
    'dsh-model-avail: first probe cycle',
  )

  ctx.effect(
    () => {
      const dispose = ctx.on('llm/adapters-updated', () => {
        ensureProbes({ force: false }).catch(() => {})
      })
      return dispose
    },
    'dsh-model-avail: follow adapter changes',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const send = (status, body) => {
          if (res.destroyed || res.writableEnded) return
          const text = JSON.stringify(body)
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(text)
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
          if (req.method === 'GET' && (path === '/state' || path === '/')) {
            if (url.searchParams.get('refresh') === '1') ensureProbes({ force: url.searchParams.get('force') === '1' }).catch(() => {})
            send(200, snapshot())
            return
          }
          if (req.method === 'POST' && path === '/probe') {
            const body = await readJson(req)
            const provider = typeof body?.provider === 'string' ? body.provider : ''
            const model = typeof body?.model === 'string' ? body.model : ''
            if (provider === '' || model === '') {
              send(400, { error: 'provider and model are required' })
              return
            }
            send(200, { provider, model, verdict: await reprobe(provider, model) })
            return
          }
          send(404, { error: `unknown route ${path}` })
        } catch (error) {
          send(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    'dsh-model-avail: availability route',
  )
}

/** Read a JSON request body; an empty or malformed body reads as null. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}