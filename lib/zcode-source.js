/**
 * Read-only access to a local ZCode installation's conversation store.
 *
 * ZCode keeps its durable conversation data in `<root>/cli/db/db.sqlite`
 * (`session`, `message`, `part` tables). This module exposes a small,
 * dependency-free reader on top of it so the import UI can browse
 * workspaces (ZCode groups sessions by `session.directory`) and individual
 * conversations without ever writing to that database.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Default ZCode data directory.
 *
 * `ZCODE_HOME` wins when set, so a non-standard installation needs no code
 * change; otherwise the conventional per-user location is used.
 */
export const DEFAULT_ZCODE_ROOT =
  process.env.ZCODE_HOME && process.env.ZCODE_HOME.length > 0
    ? process.env.ZCODE_HOME
    : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.zcode')

/** Resolve the sqlite database path for a ZCode root. */
export function databasePath(root = DEFAULT_ZCODE_ROOT) {
  const candidates = [
    join(root, 'cli', 'db', 'db.sqlite'),
    join(root, 'db', 'db.sqlite'),
    join(root, 'zcode.sqlite'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

/** Whether this ZCode root looks usable. */
export function describeRoot(root = DEFAULT_ZCODE_ROOT) {
  const database = databasePath(root)
  return { root, database, available: existsSync(database) }
}

let sqliteModule
async function loadSqlite() {
  if (!sqliteModule) sqliteModule = await import('node:sqlite')
  return sqliteModule
}

/**
 * Open the ZCode database read-only.
 *
 * The returned handle is reused for the lifetime of one operation and must be
 * closed by the caller; concurrent imports therefore never share a connection.
 */
export async function openArchive(root = DEFAULT_ZCODE_ROOT) {
  const database = databasePath(root)
  if (!existsSync(database)) {
    throw new Error(`找不到 ZCode 数据库：${database}`)
  }
  const { DatabaseSync } = await loadSqlite()
  const db = new DatabaseSync(database, { readOnly: true })
  return {
    database,
    root,
    close() {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    },
    /** ZCode workspaces == distinct session directories holding real user conversations. */
    workspaces({ includeSubagent = false } = {}) {
      const where = includeSubagent ? '' : "where task_type = 'interactive'"
      return db
        .prepare(
          `select directory,
                  count(*) as sessions,
                  max(time_updated) as updated,
                  min(time_created) as created
             from session
             ${where}
            group by directory
            order by updated desc`,
        )
        .all()
    },
    /** Every conversation of one workspace, newest first. */
    sessions(directory, { includeSubagent = false } = {}) {
      const clauses = ['directory = ?']
      if (!includeSubagent) clauses.push("task_type = 'interactive'")
      return db
        .prepare(
          `select id, title, directory, task_type, parent_id, time_created, time_updated,
                  (select count(*) from message m where m.session_id = session.id) as messages
             from session
            where ${clauses.join(' and ')}
            order by time_updated desc`,
        )
        .all(directory)
    },
    /** One session row, or undefined. */
    session(id) {
      return db.prepare('select * from session where id = ?').get(id)
    },
    /** Ordered messages with their ordered parts, ready for conversion. */
    conversation(id) {
      const messages = db
        .prepare(
          `select id, data, time_created, time_updated, sequence
             from message
            where session_id = ?
            order by coalesce(sequence, 0), time_created, id`,
        )
        .all(id)
      const partStatement = db.prepare(
        `select data from part
          where message_id = ?
          order by coalesce(sequence, 0), time_created, id`,
      )
      return messages.map((row) => ({
        id: row.id,
        meta: safeParse(row.data) ?? {},
        parts: partStatement.all(row.id).map((part) => safeParse(part.data) ?? {}),
      }))
    },
  }
}

function safeParse(text) {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
