/**
 * dsh-plugin-zcode-import — Host half (route carrier).
 *
 * Imports local ZCode conversations into this DSH profile: a workspace record
 * through `ctx.workspaceRegistry`, one durable session artifact per
 * conversation through `ctx.sessionPersistence`, and the session joined to its
 * workspace through `Workspace.attachSession`. The Web UI (Settings → 会话导入)
 * drives it over the named route registered below.
 *
 * This file only carries the route and forwards every request to `impl.js`
 * through a cache-busted dynamic import: a loaded ESM module stays cached for
 * the life of the process, so the indirection is what lets a replaced
 * implementation take effect (`/zcode-import/api/__reload`) without a harness
 * restart.
 *
 * Optional row config: `root` names the ZCode data directory when it is not
 * the conventional `<home>/.zcode` (the `ZCODE_HOME` environment variable is
 * honored as well).
 */

/** Route prefix owned by this plugin. */
const PREFIX = '/zcode-import/api'

/** Hard dependencies: the route carrier, session storage and workspace accounting. */
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry']

export function apply(ctx, config) {
  const web = ctx.webServer ?? ctx.get('webServer')
  if (!web || typeof web.register !== 'function') {
    ctx.logger?.warn?.('[zcode-import] webServer 不可用，插件未激活')
    return
  }

  const root =
    config !== null &&
    typeof config === 'object' &&
    typeof config.root === 'string' &&
    config.root.length > 0
      ? config.root
      : undefined

  let impl = null
  let loading = null
  let token = '1'

  function load(fresh) {
    if (fresh) {
      impl = null
      loading = null
      token = String(Date.now())
    }
    if (impl) return Promise.resolve(impl)
    if (!loading) {
      const url = new URL('./impl.js', import.meta.url)
      url.searchParams.set('v', token)
      loading = import(url.href).then(
        (mod) => {
          impl = mod
          loading = null
          return mod
        },
        (error) => {
          loading = null
          throw error
        },
      )
    }
    return loading
  }

  function fail(res, code, message) {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: 'host_loader', message } }))
    } catch {
      /* response already gone */
    }
  }

  ctx.effect(() =>
    web.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        const path = String(req.url ?? '').split('?')[0]
        const tail = path.replace(/^\/+/, '').split('/').filter(Boolean).pop() ?? ''
        if (tail === '__reload') {
          try {
            await load(true)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, value: { reloaded: true } }))
          } catch (error) {
            fail(res, 500, error?.message ?? String(error))
          }
          return
        }
        try {
          const mod = await load(false)
          if (!mod || typeof mod.handle !== 'function') {
            fail(res, 500, 'impl.js 未导出 handle(req, res, ctx, token, root)')
            return
          }
          await mod.handle(req, res, ctx, token, root)
        } catch (error) {
          fail(res, 500, error?.message ?? String(error))
        }
      },
    }),
  )

  ctx.logger?.info?.(`[zcode-import] host half ready (${PREFIX})`)
}
