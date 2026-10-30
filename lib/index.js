/**
 * dsh-model-avail 的宿主半侧。
 *
 * 为运行中的 Harness 已注册的每个 LLM 提供商维护一份带缓存的「逐模型可用性」表，
 * 并通过一个小巧的 HTTP 前缀对外提供，让浏览器半侧无需触碰客户端内部实现即可重排模型选择器。
 *
 * 一个模型只有在请求真正跑通时才算「能用」：选择器渲染的模型目录（`listModels`
 * 加 `resolveModelInfo`）只能证明该提供商回应了元数据调用，而上游已下线、没有凭据
 * 或已超额度的模型同样会出现在目录里。所以探针发送运行时允许的最小真实回合——一条
 * 用户消息、一个输出 token——再依据终结的 `finish` 分块判定结果。
 *
 * @module dsh-model-avail/lib/index
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 注册到 cordis 的插件名。 */
export const name = 'model-avail'

/**
 * 本插件读取的服务。`webServer` 提供浏览器半侧轮询的 HTTP 前缀；`llm` 是探针
 * 实际派发请求所用的在线提供商注册表。
 */
export const inject = ['webServer', 'llm']

/** 本插件占用的 HTTP 前缀。刻意取得足够长，避免与其他插件撞路。 */
const ROUTE_PREFIX = '/dsh-model-avail'

/** 一条判定在被下一轮探测替换前，可以信任多久。 */
const TTL_MS = 6 * 60 * 60 * 1000

/** 单个模型的探测预算。一个挂掉的端点不能拖住整轮探测。 */
const PROBE_TIMEOUT_MS = 20_000

/** 同时在飞的探测数。取得足够小，尽量不惊动用户配额。 */
const CONCURRENCY = 3

/** 每个提供商最多探测多少个模型，避免超大目录把队列撑爆。 */
const MAX_MODELS_PER_PROVIDER = 60

/**
 * 单轮探测的数量上限。大目录会跨多轮覆盖，而不是一次全部打出；只有本轮确实
 * 推进过，下一轮才会被安排，所以一个长期被限流的提供商不会无限空转。
 */
const MAX_PROBES_PER_CYCLE = 80

/** 单轮预算用尽后，继续下一轮前的等待时间。 */
const CONTINUE_MS = 30_000

/** 每个探针发送的那个一 token 提示词。 */
const PING_TEXT = 'ping'

/**
 * 表示「该模型按当前配置永远无法完成回合」的错误码／文案，而不是「稍后再试」。
 * 其余情况一律记为 `unknown`，这样一次瞬时的 429 或网络抖动不会把可用的模型藏起来。
 */
const DEFINITIVE_FAILURE = /INVALID_CREDENTIAL|INVALID_CATALOG|INVALID_MODEL|MODEL_NOT_FOUND|MODEL_UNAVAILABLE|NOT_FOUND|UNAUTHORIZED|FORBIDDEN|QUOTA_EXCEEDED|ACCOUNT_QUOTA|no api key|api key|unauthori[sz]ed|forbidden|not found|does not exist|invalid model|\b40[134]\b/iu

/** 持久化判定缓存文件的绝对路径。 */
function statePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-model-avail', 'state.json')
}

/** 为可用性表里的一个确切路由生成键。 */
function keyOf(provider, model) {
  return `${provider}\u0000${model}`
}

/** 读取持久化缓存；文件缺失或读不出来就当作空表。 */
function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    const models = parsed?.models
    return typeof models === 'object' && models !== null ? models : {}
  } catch {
    return {}
  }
}

/** 原子写入判定表；失败按设计静默忽略。 */
function writeCache(models) {
  try {
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ at: Date.now(), models }), 'utf8')
    renameSync(temp, file)
  } catch {
    /* 缓存丢了最多多跑一轮探测 */
  }
}

/** 生成一条存储用的判定。 */
function verdict(state, extra = {}) {
  return {
    state,
    at: Date.now(),
    ...extra,
  }
}

/**
 * 把一次失败的探测归类为「粘性不可用」或「可重试的未知」。
 * @param failure - 流返回的终结失败负载，或抛出的错误。
 * @returns 选择器可以据以动作的判定。
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
 * 用尽可能小的真实请求探测一个确切的提供商／模型路由。
 * @param ctx - 携带 `llm` 服务的宿主上下文。
 * @param provider - 提供商 id。
 * @param model - 属于该提供商的模型 id。
 * @param signal - 整轮探测的取消信号。
 * @returns 该路由的判定；永不抛出。
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
      // 已经看到一个可见 token，就足以证明它活着；后面不必再付钱。
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

/** 以最多 `limit` 个并发，把 `worker` 跑遍 `items`。 */
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
 * 安装可用性服务。
 * @param ctx - 插件 fiber 的 cordis 上下文。
 */
export function apply(ctx) {
  const models = readCache()
  const providers = new Map()
  /**
   * 浏览器上报的名单。选择器可能提供宿主适配器目录枚举不到的路由（在设置里
   * 配置的路由根本不会出现在那里），所以「屏幕上有什么」以浏览器为准，宿主
   * 只负责判定这些路由里哪些真的能应答。
   */
  const reported = new Map()
  const state = { probing: false, updatedAt: 0, startedAt: 0, done: 0, total: 0, generation: 0 }
  let cycle = null
  let continuation = null

  /** 已存储的判定仍在信任窗口内时为真。 */
  const fresh = (entry) => typeof entry?.at === 'number' && Date.now() - entry.at < TTL_MS

  /** 浏览器半侧需要的全部信息，返回脱离内部状态的快照。 */
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
   * 从在线注册表刷新提供商／模型名单。元数据调用抛错的提供商也会被保留为失败项，
   * 这样选择器仍能知道它们为什么缺席。
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
    // 与选择器声称正在渲染的名单取并集：对某些路由来说适配器目录是空的，
    // 但它们其实答得很好。
    for (const [id, entry] of reported) {
      const existing = next.get(id)
      if (existing === undefined) {
        next.set(id, {
          id,
          name: entry.name,
          error: null,
          models: entry.models.slice(0, MAX_MODELS_PER_PROVIDER),
        })
        continue
      }
      const seen = new Set(existing.models.map((model) => model.model))
      for (const model of entry.models) {
        if (seen.has(model.model)) continue
        seen.add(model.model)
        existing.models.push(model)
      }
      if (existing.models.length > MAX_MODELS_PER_PROVIDER) {
        existing.models = existing.models.slice(0, MAX_MODELS_PER_PROVIDER)
      }
      if (existing.models.length > 0) existing.error = null
    }
    providers.clear()
    for (const [id, entry] of next) providers.set(id, entry)
  }

  /**
   * 探测每个判定已过期的模型。并发调用共享同一轮探测，所以客户端轮询再密集
   * 也不会把请求数翻倍。
   * @param options.force - 即使判定仍然新鲜也重新探测。
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
      // 只有本轮既还有剩余工作、又确实判定了某些东西时才继续：否则一个完全
      // 被限流的提供商会一直空转下去。
      if (outcome.pending > 0 && outcome.resolved > 0) {
        clearTimeout(continuation)
        continuation = setTimeout(() => {
          ensureProbes({ force }).catch(() => {})
        }, CONTINUE_MS)
      }
    }).catch(() => {})
    return cycle
  }

  /** 绕过缓存，只重新探测一条路由。 */
  async function reprobe(provider, model) {
    const result = await probeOne(ctx, provider, model, new AbortController().signal)
    models[keyOf(provider, model)] = result
    writeCache(models)
    return result
  }

  ctx.effect(
    () => {
      let second = null
      const timer = setTimeout(() => {
        ensureProbes()
          .catch(() => {})
          .finally(() => {
            // 启动之后才注册的适配器会让第一份名单很稀疏；补跑第二轮把它们捞回来，
            // 而不是干等缓存过期。
            const sparse = [...providers.values()].some((provider) => provider.models.length === 0)
            if (!sparse) return
            second = setTimeout(() => {
              ensureProbes().catch(() => {})
            }, 25_000)
          })
      }, 4000)
      return () => {
        clearTimeout(timer)
        clearTimeout(second)
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
          if (req.method === 'POST' && path === '/roster') {
            const body = await readJson(req)
            const list = Array.isArray(body?.providers) ? body.providers : []
            const next = new Map()
            for (const provider of list) {
              if (typeof provider?.id !== 'string' || provider.id === '') continue
              const entries = (Array.isArray(provider.models) ? provider.models : [])
                .filter((model) => typeof model?.id === 'string' && model.id !== '')
                .map((model) => ({
                  model: model.id,
                  name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
                }))
              next.set(provider.id, {
                name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
                models: entries,
              })
            }
            reported.clear()
            for (const [id, entry] of next) reported.set(id, entry)
            if (next.size > 0) {
              // 正在跑的轮次会忽略新来的模型，所以在它后面再排一轮，而不是和它抢。
              if (cycle === null) ensureProbes().catch(() => {})
              else cycle.finally(() => ensureProbes().catch(() => {}))
            }
            send(200, { reported: next.size })
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

/** 读取 JSON 请求体；空体或畸形体一律读作 null。 */
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