/**
 * Browser half of dsh-model-avail.
 *
 * The model picker renders `modelDirectories.catalog.store.value.groups` after
 * pinning two built-in providers in front of the rest. Everything else keeps
 * the order the host sent, so reordering that one snapshot reorders the picker:
 *
 *   - groups are re-sorted by how many of their models actually answered a probe,
 *   - models inside a group are pushed down once they are known to be dead,
 *   - dead models and the per-provider tally are labelled in place.
 *
 * The decoration is a fixed point: it strips its own labels first, so applying it
 * twice produces the identical snapshot and the store update stops.
 *
 * @module dsh-model-avail/lib/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-avail',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** Host route serving the cached verdict map. */
    const STATE_URL = '/dsh-model-avail/state'

    /** Host route accepting the roster the picker actually renders. */
    const ROSTER_URL = '/dsh-model-avail/roster'

    /** How often the browser checks for a newer verdict map. */
    const POLL_MS = 15_000

    /** Delay between attempts to reach the model catalog store. */
    const STORE_WAIT_MS = 250

    /** Attempts before giving up on a catalog store that never showed up. */
    const STORE_WAIT_TRIES = 240

    /** Separator between a provider name and its tally. */
    const GROUP_SEP = ' · '

    /** Suffix stamped onto a model that failed its probe. */
    const UNAVAILABLE_SUFFIX = / \((?:不可用|unavailable)\)$/u

    /** Suffix stamped onto a provider heading by this plugin. */
    const GROUP_SUFFIX = / · \d+\/\d+$/u

    /** Localised label for a model whose probe failed. */
    function unavailableLabel() {
      const language = typeof navigator === 'object' ? navigator.language : 'en'
      return String(language ?? '').toLowerCase().startsWith('zh') ? '不可用' : 'unavailable'
    }

    /** Remove this plugin's own decorations from a provider heading. */
    function stripGroupName(name) {
      return typeof name === 'string' ? name.replace(GROUP_SUFFIX, '') : name
    }

    /** Remove this plugin's own decorations from a model name. */
    function stripModelName(name) {
      return typeof name === 'string' ? name.replace(UNAVAILABLE_SUFFIX, '') : name
    }

    /**
     * Index a host snapshot for lookup by provider and model id.
     * @param snapshot - response body of the host state route.
     * @returns `{ version, providers }` where providers maps id to tally and models.
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

    /** Rank a model row so dead entries sink below live ones. */
    function rank(entry) {
      if (entry === undefined) return 1
      if (entry.state === 'available') return 0
      if (entry.state === 'unavailable') return 2
      return 1
    }

    /**
     * Rebuild the provider groups with availability applied. Input objects are
     * never mutated: every group and model is cloned before it is relabelled.
     * @param groups - provider groups from the catalog snapshot.
     * @param availability - index built by {@link indexSnapshot}, or null when unknown.
     * @returns the decorated groups, already sorted.
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
      // Providers this plugin knows nothing about keep their relative order and
      // stay behind the ranked ones, so a half-finished cycle never scrambles
      // the list the host produced.
      rows.sort((left, right) => {
        if (left.known !== right.known) return left.known ? -1 : 1
        if (left.usable !== right.usable) return right.usable - left.usable
        if (left.total !== right.total) return right.total - left.total
        return left.position - right.position
      })
      return rows.map((row) => row.value)
    }

    /** Present the same groups with this plugin's decorations stripped. */
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

    /** Two snapshots are interchangeable when their unsigned content matches. */
    function sameContent(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    /**
     * Order-insensitive signature of a roster, so an unchanged picker does not
     * re-post it on every store tick.
     * @param groups - provider groups with this plugin's labels already stripped.
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
     * Describe the roster in the shape the host route expects.
     * @param groups - stripped provider groups from the catalog snapshot.
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

    /**
     * Keep one catalog store decorated for as long as this plugin is loaded.
     * @param ctx - client context of the plugin fiber.
     */
    function apply(ctx) {
      ctx.inject(['modelDirectories'], (scope) => {
        ctx.effect(() => {
          let attachTimer = null
          let detach = null

          /** Attach once the catalog store exists; it can come up after this inject. */
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
     * Keep one store decorated for as long as this plugin is loaded.
     * @param store - the model catalog store of the model selection service.
     * @returns teardown closing the subscription and the poll timer.
     */
    function decorateStore(store) {
      let availability = null
      let version = ''
      let postedKey = ''

      /** Rewrite the snapshot in place when the decoration would change it. */
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
       * Tell the host which providers and models are on screen. The adapter
       * catalog the host can enumerate is often narrower than the picker, so
       * without this the browser would ask about routes the host never lists.
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

      /** Report the roster, then keep the snapshot decorated. */
      const sync = () => {
        const groups = store.getSnapshot()?.value?.groups
        if (!Array.isArray(groups) || groups.length === 0) return
        reportRoster(groups)
        decorateCurrent()
      }

      const unsubscribe = store.subscribe(sync)
      let timer = setTimeout(sync, 0)
      /** Pull the host verdict map once, then decorate and reschedule. */
      const poll = async () => {
        try {
          const response = await fetch(STATE_URL, { headers: { accept: 'application/json' } })
          if (response.ok) {
            const snapshot = await response.json()
            availability = indexSnapshot(snapshot)
            if (availability.version !== version) {
              version = availability.version
              decorateCurrent()
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
          /* the host half may be starting, or gone; the next tick retries */
        }
        timer = setTimeout(poll, POLL_MS)
      }
      // Poll immediately: a fresh page would otherwise show the undecorated
      // catalog for a full interval right after every reload.
      void poll()
      return () => {
        clearTimeout(timer)
        unsubscribe?.()
      }
    }

    exports.apply = apply
    exports.inject = ['modelDirectories']
    exports.decorate = decorate
    exports.indexSnapshot = indexSnapshot
    return module.exports
  },
})