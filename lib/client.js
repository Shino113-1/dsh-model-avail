/**
 * dsh-model-avail 的浏览器半侧。
 *
 * 模型选择器渲染的是 `modelDirectories.catalog.store.value.groups`，并在渲染前
 * 把两个内置提供商钉在最前面，其余保持宿主发来的顺序。所以只要改写这一份快照，
 * 选择器就会跟着变：
 *
 *   - 按「真正应答过探针的模型数」重新排列各提供商组，
 *   - 组内已知不可用的模型下沉到后面，
 *   - 就地给不可用模型和每个提供商标上统计，
 *   - 再按可用性给选择器里的模型名上色（可用绿色、不可用红色、未验证灰色）。
 *
 * 文本装饰是个不动点：它先剥掉自己的标记，所以重复应用得到的快照完全一致，
 * store 更新也随之停下。颜色只画在 DOM 属性上，不进入快照。
 *
 * @module dsh-model-avail/lib/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-avail',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 提供判定表的宿主路由。 */
    const STATE_URL = '/dsh-model-avail/state'

    /** 接收选择器实际渲染名单的宿主路由。 */
    const ROSTER_URL = '/dsh-model-avail/roster'

    /** 浏览器多久检查一次有没有更新的判定表。 */
    const POLL_MS = 15_000

    /** 两次尝试访问模型目录 store 之间的间隔。 */
    const STORE_WAIT_MS = 250

    /** 目录 store 迟迟不出现时，最多尝试多少次后放弃。 */
    const STORE_WAIT_TRIES = 240

    /** 提供商名与其统计之间的分隔符。 */
    const GROUP_SEP = ' · '

    /** 盖在探测失败模型名后的后缀。 */
    const UNAVAILABLE_SUFFIX = / \((?:不可用|unavailable)\)$/u

    /** 本插件盖在提供商标题后的统计后缀。 */
    const GROUP_SUFFIX = / · \d+\/\d+$/u

    /** 选择器里单个提供商的容器。 */
    const PICKER_PROVIDER = '.dsh-reasoning-model__provider'

    /** 提供商标题的文本节点。 */
    const PICKER_PROVIDER_NAME = '.dsh-reasoning-model__provider-name'

    /** 单个模型名的文本节点。 */
    const PICKER_OPTION_NAME = '.dsh-reasoning-model__option-name'

    /** 注入的样式表元素 id。 */
    const PAINT_STYLE_ID = 'dsh-model-avail-paint'

    /** 标在模型名节点上的可用性属性。 */
    const PAINT_ATTR = 'data-model-avail'

    /** 三种判定对应的颜色。 */
    const PAINT_CSS = [
      '[data-model-avail="available"]{color:#2ea043 !important}',
      '[data-model-avail="unavailable"]{color:#d1242f !important}',
      '[data-model-avail="unknown"]{color:var(--dsw-alias-label-tertiary,#7d8592) !important}',
    ].join('')

    /** 探测失败模型的本地化标签。 */
    function unavailableLabel() {
      const language = typeof navigator === 'object' ? navigator.language : 'en'
      return String(language ?? '').toLowerCase().startsWith('zh') ? '不可用' : 'unavailable'
    }

    /** 从提供商标题上剥掉本插件自己的装饰。 */
    function stripGroupName(name) {
      return typeof name === 'string' ? name.replace(GROUP_SUFFIX, '') : name
    }

    /** 从模型名上剥掉本插件自己的装饰。 */
    function stripModelName(name) {
      return typeof name === 'string' ? name.replace(UNAVAILABLE_SUFFIX, '') : name
    }

    /**
     * 把宿主快照索引成按提供商、模型 id 查询的结构。
     * @param snapshot - 宿主 state 路由的响应体。
     * @returns `{ version, providers }`，providers 由 id 映射到统计与逐模型判定。
     */
    function indexSnapshot(snapshot) {
      const providers = new Map()
      const list = Array.isArray(snapshot?.providers) ? snapshot.providers : []
      for (const provider of list) {
        if (typeof provider?.id !== 'string') continue
        const models = new Map()
        for (const model of Array.isArray(provider.models) ? provider.models : []) {
          if (typeof model?.id !== 'string') continue
          models.set(model.id, { state: model.state ?? 'unknown', message: model.message ?? null })
        }
        providers.set(provider.id, {
          usable: typeof provider.usable === 'number' ? provider.usable : 0,
          total: typeof provider.total === 'number' ? provider.total : models.size,
          models,
        })
      }
      return { version: `${snapshot?.updatedAt ?? 0}:${snapshot?.probing === true ? 1 : 0}:${snapshot?.progress?.done ?? 0}`, providers }
    }

    /**
     * 把宿主快照索引成「显示名 → 模型显示名 → 判定」，供 DOM 上色使用。
     * 选择器是按显示名渲染的，路由 id 只是兜底别名。
     * @param snapshot - 宿主 state 路由的响应体。
     */
    function labelIndex(snapshot) {
      const index = new Map()
      const list = Array.isArray(snapshot?.providers) ? snapshot.providers : []
      for (const provider of list) {
        if (typeof provider?.id !== 'string') continue
        const models = new Map()
        for (const model of Array.isArray(provider.models) ? provider.models : []) {
          if (typeof model?.name !== 'string') continue
          models.set(model.name.toLowerCase(), model.state ?? 'unknown')
        }
        const entry = { id: provider.id, models }
        if (typeof provider.name === 'string' && provider.name !== '') index.set(provider.name.toLowerCase(), entry)
        index.set(provider.id.toLowerCase(), entry)
      }
      return index
    }

    /** 给模型行排序用：死掉的条目沉到活的下面。 */
    function rank(entry) {
      if (entry === undefined) return 1
      if (entry.state === 'available') return 0
      if (entry.state === 'unavailable') return 2
      return 1
    }

    /**
     * 带着可用性重建各提供商组。入参对象永不被修改：每个组和模型都会先克隆再改标签。
     * @param groups - 目录快照里的提供商组。
     * @param availability - {@link indexSnapshot} 建出的索引，未知时为 null。
     * @returns 已排序的装饰后分组。
     */
    function decorate(groups, availability) {
      const rows = groups.map((group, position) => {
        const tally = availability?.providers.get(group.id)
        const models = Array.isArray(group.models) ? group.models : []
        const decorated = models.map((model, order) => {
          const entry = tally?.models.get(model.id)
          const name = stripModelName(model.name)
          const dead = entry?.state === 'unavailable'
          return {
            position: order,
            rank: rank(entry),
            value: {
              ...model,
              name: dead ? `${name} (${unavailableLabel()})` : name,
            },
          }
        })
        decorated.sort((left, right) => left.rank - right.rank || left.position - right.position)
        const usable = tally?.usable ?? 0
        const total = tally?.total ?? models.length
        return {
          position,
          usable,
          total,
          known: tally !== undefined,
          value: {
            ...group,
            name: tally === undefined ? stripGroupName(group.name) : `${stripGroupName(group.name)}${GROUP_SEP}${usable}/${total}`,
            models: decorated.map((row) => row.value),
          },
        }
      })
      // 本插件一无所知的提供商保持相对顺序，并排在已排名的后面，这样一轮尚未
      // 跑完的探测也不会把宿主给的列表打乱。
      rows.sort((left, right) => {
        if (left.known !== right.known) return left.known ? -1 : 1
        if (left.usable !== right.usable) return right.usable - left.usable
        if (left.total !== right.total) return right.total - left.total
        return left.position - right.position
      })
      return rows.map((row) => row.value)
    }

    /** 以剥掉本插件装饰的形式给出同一批分组。 */
    function strip(groups) {
      return groups.map((group) => ({
        ...group,
        name: stripGroupName(group.name),
        models: (Array.isArray(group.models) ? group.models : []).map((model) => ({
          ...model,
          name: stripModelName(model.name),
        })),
      }))
    }

    /** 两份快照的无装饰内容一致时，它们可以互换。 */
    function sameContent(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    /**
     * 与顺序无关的名单签名，这样没变化的选择器不会每个 store tick 都重发一次。
     * @param groups - 已剥掉本插件标签的提供商组。
     */
    function rosterKey(groups) {
      return JSON.stringify(
        groups
          .map((group) => [
            String(group.id ?? ''),
            (Array.isArray(group.models) ? group.models : []).map((model) => String(model.id ?? '')).sort(),
          ])
          .sort((left, right) => left[0].localeCompare(right[0])),
      )
    }

    /**
     * 按宿主路由期待的格式描述名单。
     * @param groups - 目录快照里已剥掉装饰的提供商组。
     */
    function rosterBody(groups) {
      return {
        providers: groups.map((group) => ({
          id: group.id,
          name: group.name,
          models: (Array.isArray(group.models) ? group.models : []).map((model) => ({ id: model.id, name: model.name })),
        })),
      }
    }

    /** 把颜色样式表装进页面；已经装过就直接复用。 */
    function ensurePaintStyle() {
      if (typeof document === 'undefined' || document.head === null) return null
      const existing = document.getElementById(PAINT_STYLE_ID)
      if (existing !== null) return existing
      const style = document.createElement('style')
      style.id = PAINT_STYLE_ID
      style.textContent = PAINT_CSS
      document.head.appendChild(style)
      return style
    }

    /**
     * 按可用性给选择器里的模型名上色。
     * @param snapshot - 宿主 state 路由的响应体，或 null。
     * @returns 上了色的模型名节点数。
     */
    function paintDocument(snapshot) {
      const empty = { painted: 0, byState: { available: 0, unavailable: 0, unknown: 0 } }
      if (typeof document === 'undefined') return empty
      const index = labelIndex(snapshot)
      const byState = { available: 0, unavailable: 0, unknown: 0 }
      let painted = 0
      for (const section of document.querySelectorAll(PICKER_PROVIDER)) {
        const heading = section.querySelector(PICKER_PROVIDER_NAME)?.textContent ?? ''
        const entry = index.get(String(stripGroupName(heading)).trim().toLowerCase())
        if (entry === undefined) continue
        for (const option of section.querySelectorAll(PICKER_OPTION_NAME)) {
          const label = String(stripModelName(option.textContent ?? '')).trim().toLowerCase()
          const state = entry.models.get(label)
          if (state === undefined) continue
          if (option.getAttribute(PAINT_ATTR) !== state) option.setAttribute(PAINT_ATTR, state)
          painted += 1
          byState[state] = (byState[state] ?? 0) + 1
        }
      }
      return { painted, byState }
    }

    /**
     * 在本插件加载期间持续装饰同一个目录 store。
     * @param ctx - 插件 fiber 的客户端上下文。
     */
    function apply(ctx) {
      ctx.inject(['modelDirectories'], (scope) => {
        ctx.effect(() => {
          let attachTimer = null
          let detach = null

          /** 等目录 store 出现后再挂载；它可能晚于这次 inject 就绪。 */
          const attach = (attempt) => {
            const store = scope.modelDirectories?.catalog?.store
            if (typeof store?.getSnapshot === 'function' && typeof store?.subscribe === 'function') {
              detach = decorateStore(store)
              return
            }
            if (attempt >= STORE_WAIT_TRIES) {
              console.warn('[model-avail] model catalog store never appeared; the picker stays unannotated')
              return
            }
            attachTimer = setTimeout(() => attach(attempt + 1), STORE_WAIT_MS)
          }

          attach(0)
          return () => {
            clearTimeout(attachTimer)
            detach?.()
          }
        }, 'dsh-model-avail: decorate model catalog')
      })
    }

    /**
     * 在本插件加载期间持续装饰同一个 store。
     * @param store - 模型选择服务的目录 store。
     * @returns 关闭订阅、定时器与观察器并清除颜色的清理函数。
     */
    function decorateStore(store) {
      let availability = null
      let snapshot = null
      let version = ''
      let postedKey = ''

      /** 装饰会改变快照时就就地改写它。 */
      const decorateCurrent = () => {
        const value = store.getSnapshot()?.value
        const groups = value?.groups
        if (!Array.isArray(groups) || groups.length === 0) return
        const next = decorate(strip(groups), availability)
        if (sameContent(next, groups)) return
        store.update((draft) => {
          if (draft?.value === null || draft?.value === undefined) return
          draft.value = { ...draft.value, groups: next }
        })
      }

      /**
       * 告诉宿主屏幕上出现了哪些提供商和模型。宿主能枚举的适配器目录往往比
       * 选择器窄，没有这一步，浏览器就会去问宿主根本没列过的路由。
       */
      const reportRoster = (groups) => {
        const bare = strip(groups)
        const key = rosterKey(bare)
        if (key === postedKey) return
        postedKey = key
        fetch(ROSTER_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(rosterBody(bare)),
        })
          .then((response) => {
            if (!response.ok) postedKey = ''
          })
          .catch(() => {
            postedKey = ''
          })
      }

      /** 上报名单，然后保持快照处于装饰状态。 */
      const sync = () => {
        const groups = store.getSnapshot()?.value?.groups
        if (!Array.isArray(groups) || groups.length === 0) return
        reportRoster(groups)
        decorateCurrent()
      }

      const unsubscribe = store.subscribe(sync)
      let timer = setTimeout(sync, 0)

      // 颜色只作用于 DOM。选择器一打开、或者新的一轮判定到达，都要重画一次，
      // 所以这里既观察节点变化，也在每次更新判定表后主动画一遍。
      const style = ensurePaintStyle()
      let paintTimer = null
      let reportedPaints = -1
      const repaint = () => {
        if (snapshot === null) return
        ensurePaintStyle()
        const painted = paintDocument(snapshot)
        // 页面上真的出现了模型名时才打一行，方便在 DevTools 里确认上色发生过。
        if (painted.painted > 0 && painted.painted !== reportedPaints) {
          reportedPaints = painted.painted
          // 顺手把浏览器算出来的颜色也带上：属性写上了但样式没生效这种事，一眼就能看出来。
          const sample = (stateName) => {
            if (typeof getComputedStyle !== 'function') return '?'
            const node = document.querySelector(`[${PAINT_ATTR}="${stateName}"]`)
            return node === null ? '?' : getComputedStyle(node).color
          }
          console.info(
            `[model-avail] painted ${painted.painted} model names by availability`
            + ` (可用 ${painted.byState.available}、不可用 ${painted.byState.unavailable}、待验证 ${painted.byState.unknown})`
            + `; 可用色 ${sample('available')}、不可用色 ${sample('unavailable')}`,
          )
        }
      }
      const observer = typeof MutationObserver === 'function' && typeof document === 'object'
        ? new MutationObserver(() => {
            if (paintTimer !== null) return
            paintTimer = setTimeout(() => {
              paintTimer = null
              repaint()
            }, 120)
          })
        : null
      observer?.observe(document.body, { childList: true, subtree: true })

      /** 拉一次宿主判定表，然后装饰、上色并安排下一次。 */
      const poll = async () => {
        try {
          const response = await fetch(STATE_URL, { headers: { accept: 'application/json' } })
          if (response.ok) {
            snapshot = await response.json()
            availability = indexSnapshot(snapshot)
            if (availability.version !== version) {
              version = availability.version
              decorateCurrent()
              repaint()
              const groups = store.getSnapshot()?.value?.groups
              if (Array.isArray(groups)) {
                console.info(
                  `[model-avail] ${groups.length} providers decorated;`
                  + ` top: ${groups.slice(0, 3).map((group) => group.name).join(', ')}`,
                )
              }
            }
          }
        } catch {
          /* 宿主半侧可能还在启动或已经退出；下一个 tick 会重试 */
        }
        timer = setTimeout(poll, POLL_MS)
      }
      // 立刻拉一次：否则每次刷新页面后，选择器会整整一个轮询周期都还是未装饰的样子。
      void poll()
      return () => {
        clearTimeout(timer)
        clearTimeout(paintTimer)
        observer?.disconnect()
        unsubscribe?.()
        style?.remove()
        if (typeof document !== 'undefined') {
          for (const node of document.querySelectorAll(`[${PAINT_ATTR}]`)) node.removeAttribute(PAINT_ATTR)
        }
      }
    }

    exports.apply = apply
    exports.inject = ['modelDirectories']
    exports.decorate = decorate
    exports.indexSnapshot = indexSnapshot
    exports.labelIndex = labelIndex
    exports.paintDocument = paintDocument
    return module.exports
  },
})