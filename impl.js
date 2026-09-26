/**
 * zcode-import — Host implementation.
 *
 * Reads a local ZCode installation's conversation archive (`<root>/cli/db/db.sqlite`,
 * opened read-only) and imports whole workspaces or individual conversations
 * into this DSH profile as real, durable DSH sessions:
 *
 *   - a workspace record through `ctx.workspaceRegistry` (created on demand),
 *   - one session artifact through `ctx.sessionPersistence` (header + events),
 *   - the session joined to the workspace through `Workspace.attachSession`.
 *
 * This module is reached through a cache-busted dynamic import from `index.js`,
 * so replacing it and reloading brings new code in without a harness restart.
 */
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

/** Route actions this handler answers. */
export const ACTIONS = ['status', 'workspaces', 'sessions', 'import', 'job', '__reload']

/** In-memory import jobs, keyed by job id. Pruned when they age out. */
const jobs = new Map()
const JOB_TTL_MS = 30 * 60 * 1000

let loadedToken
let libs

/**
 * Session format version this harness writes, once an import has learned it.
 *
 * Older and newer DSH disagree about both the header version and the shape of a
 * `tool/result` message, and each refuses the other's shape with
 * `encodeCurrent requires Session format vN`. `create` validates before it
 * writes or registers anything, so that refusal doubles as the probe: the
 * import re-converts for vN and retries once, then remembers N for the process.
 * Until then the converter's own default is used.
 */
let formatVersion

/** The refusal that names the version the running harness accepts. */
const SESSION_FORMAT_REFUSAL = /encodeCurrent requires Session format v(\d+)/

/**
 * Import the pure helpers under the caller's cache-busting token.
 *
 * `index.js` hands a fresh token after a reload; the token is threaded into
 * every specifier so the helper modules are re-read too, instead of being
 * served from the process-wide ESM cache.
 */
async function loadLibs(token) {
  if (loadedToken === token && libs !== undefined) return libs
  const [source, convert] = await Promise.all([
    import(new URL(`./lib/zcode-source.js?v=${token}`, import.meta.url).href),
    import(new URL(`./lib/convert.js?v=${token}`, import.meta.url).href),
  ])
  libs = {
    openArchive: source.openArchive,
    describeRoot: source.describeRoot,
    DEFAULT_ZCODE_ROOT: source.DEFAULT_ZCODE_ROOT,
    convertConversation: convert.convertConversation,
    headerFor: convert.headerFor,
    DEFAULT_FORMAT_VERSION: convert.DEFAULT_FORMAT_VERSION,
  }
  formatVersion ??= convert.DEFAULT_FORMAT_VERSION
  loadedToken = token
  return libs
}

/**
 * Stable DSH session id derived from a ZCode session id, so re-importing the
 * same conversation is refused as an existing session instead of duplicating it.
 */
export function dshSessionIdFor(zcodeSessionId) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    String(zcodeSessionId ?? ''),
  )
  return match ? `session-${match[1].toLowerCase()}` : `session-${randomUUID()}`
}

function directoryExists(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function workspaceTitle(path) {
  const name = basename(String(path).replace(/[\\/]+$/, ''))
  return name.length > 0 ? name : String(path)
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function ok(res, value) {
  send(res, 200, { ok: true, value })
}

function fail(res, status, code, message) {
  send(res, status, { ok: false, error: { code, message } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Answer one request of this plugin's named route.
 *
 * @param req - the HTTP request.
 * @param res - the HTTP response.
 * @param ctx - the owning plugin context (carries the injected services).
 * @param token - cache-busting token for this module generation.
 * @param root - optional ZCode data directory override from the plugin row config.
 */
export async function handle(req, res, ctx, token, root) {
  const helpers = await loadLibs(token)
  const archiveRoot =
    typeof root === 'string' && root.length > 0 ? root : helpers.DEFAULT_ZCODE_ROOT

  /** Open the archive for the duration of one operation. */
  async function withArchive(run) {
    const archive = await helpers.openArchive(archiveRoot)
    try {
      return await run(archive)
    } finally {
      archive.close()
    }
  }

  /**
   * Whether a DSH session with this id is already stored.
   *
   * `SessionPersistence.stat` resolves `undefined` for an unknown id (only
   * some backends reject), so both outcomes are treated as "not imported".
   */
  async function sessionIsImported(id) {
    try {
      const snapshot = await ctx.sessionPersistence.stat(id)
      return snapshot !== undefined && snapshot !== null
    } catch {
      return false
    }
  }

  async function status() {
    const described = helpers.describeRoot(archiveRoot)
    return {
      root: described.root,
      database: described.database,
      available: described.available,
    }
  }

  async function workspaces(query) {
    const includeSubagents = query.get('includeSubagents') === '1'
    const list = await withArchive((archive) =>
      archive.workspaces({ includeSubagent: includeSubagents }),
    )
    return {
      root: archiveRoot,
      workspaces: list.map((row) => ({
        path: row.directory,
        title: workspaceTitle(row.directory),
        sessions: row.sessions,
        updated: row.updated,
        created: row.created,
        exists: directoryExists(row.directory),
      })),
    }
  }

  async function sessions(query) {
    const path = query.get('path')
    if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
      throw new Error('缺少有效的工作区路径')
    }
    const includeSubagents = query.get('includeSubagents') === '1'
    const rows = await withArchive((archive) =>
      archive.sessions(path, { includeSubagent: includeSubagents }),
    )
    const value = []
    for (const row of rows) {
      const dshSessionId = dshSessionIdFor(row.id)
      value.push({
        id: row.id,
        dshSessionId,
        title: row.title,
        taskType: row.task_type,
        parentId: row.parent_id ?? null,
        messages: row.messages,
        created: row.time_created,
        updated: row.time_updated,
        imported: await sessionIsImported(dshSessionId),
      })
    }
    return { path, sessions: value }
  }

  /**
   * Import one ZCode conversation into a durable DSH session.
   *
   * The conversion is expressed in the Session format version of the target
   * harness (`formatVersion`): a first attempt against an unknown harness may
   * be refused with the version it actually writes, in which case the
   * conversation is converted again for that version and retried once. A
   * refused `create` has written nothing, so nothing is duplicated.
   */
  async function importOne(archive, workspace, row) {
    const conversation = archive.conversation(row.id)
    for (let attempt = 0; ; attempt += 1) {
      const { events, turns, steps } = helpers.convertConversation(
        { meta: row, messages: conversation },
        { title: row.title, formatVersion },
      )
      if (events.length === 0) {
        return { ok: false, skipped: true, reason: '没有可导入的对话内容' }
      }

      const sessionId = dshSessionIdFor(row.id)
      if (await sessionIsImported(sessionId)) {
        if (workspace) {
          try {
            await workspace.attachSession(sessionId)
          } catch {
            /* already accounted or cwd mismatch — the session is still stored */
          }
        }
        return { ok: true, sessionId, alreadyImported: true, events: events.length, turns, steps }
      }

      try {
        const handle = await ctx.sessionPersistence.create(
          helpers.headerFor(row, sessionId, formatVersion),
        )
        try {
          await handle.append(events)
          await handle.flush()
        } finally {
          await handle.close()
        }
        if (workspace) await workspace.attachSession(sessionId)
        return { ok: true, sessionId, events: events.length, turns, steps }
      } catch (error) {
        const required = SESSION_FORMAT_REFUSAL.exec(error?.message ?? '')
        if (required === null || attempt > 0) throw error
        formatVersion = Number(required[1])
      }
    }
  }

  function pruneJobs() {
    const cutoff = Date.now() - JOB_TTL_MS
    for (const [id, job] of jobs) {
      if (job.finishedAt !== undefined && job.finishedAt < cutoff) jobs.delete(id)
    }
  }

  /** Run one import as a pollable in-memory job. */
  function startJob(request) {
    const path = request?.path
    const requested = Array.isArray(request?.sessionIds)
      ? request.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
      : []
    const includeSubagents = request?.includeSubagents === true

    const job = {
      id: randomUUID(),
      path,
      state: 'running',
      total: 0,
      done: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      current: null,
      results: [],
      error: null,
      startedAt: Date.now(),
      finishedAt: undefined,
    }
    jobs.set(job.id, job)
    pruneJobs()

    void (async () => {
      let archive
      try {
        if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
          throw new Error('缺少有效的工作区路径')
        }
        archive = await helpers.openArchive(archiveRoot)

        const rows = archive.sessions(path, { includeSubagent: includeSubagents })
        const selected = requested.length > 0 ? rows.filter((row) => requested.includes(row.id)) : rows
        job.total = selected.length

        let workspace
        if (directoryExists(path)) {
          workspace = await ctx.workspaceRegistry.create(path, workspaceTitle(path))
        } else {
          job.results.push({
            sourceId: null,
            ok: false,
            skipped: true,
            reason: `目录不存在，会话已导入但不会出现在工作区列表：${path}`,
          })
        }

        for (const row of selected) {
          job.current = row.title ?? row.id
          try {
            const result = await importOne(archive, workspace, row)
            job.results.push({ sourceId: row.id, title: row.title, ...result })
            if (result.ok && result.alreadyImported !== true) job.imported += 1
            else job.skipped += 1
          } catch (error) {
            job.failed += 1
            job.results.push({
              sourceId: row.id,
              title: row.title,
              ok: false,
              reason: error?.message ?? String(error),
            })
          }
          job.done += 1
        }
        job.state = 'done'
      } catch (error) {
        job.state = 'error'
        job.error = error?.message ?? String(error)
      } finally {
        job.current = null
        job.finishedAt = Date.now()
        try {
          archive?.close()
        } catch {
          /* already closed */
        }
      }
    })()

    return { jobId: job.id }
  }

  const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
  const action = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean).pop() ?? ''
  try {
    switch (action) {
      case 'status':
        return ok(res, await status())
      case 'workspaces':
        return ok(res, await workspaces(url.searchParams))
      case 'sessions':
        return ok(res, await sessions(url.searchParams))
      case 'import':
        return ok(res, startJob(await readBody(req)))
      case 'job': {
        const id = url.searchParams.get('id')
        const job = id === null ? undefined : jobs.get(id)
        if (job === undefined) return fail(res, 404, 'not_found', '导入任务不存在或已过期')
        return ok(res, job)
      }
      default:
        return fail(res, 404, 'not_found', `未知接口：${action}`)
    }
  } catch (error) {
    return fail(res, 400, 'request_failed', error?.message ?? String(error))
  }
}
