/**
 * Offline self-test for the ZCode → DSH converter.
 *
 * Reads real ZCode conversations, converts them, and validates every produced
 * artifact by encoding it to physical rows and restoring it through the SAME
 * format catalogs the DSH persistence backend uses on read.
 *
 * Every Session format this plugin supports is checked for every conversation:
 * a shape that only the newest harness accepts is a regression, because the
 * plugin also has to import on harnesses that still write the older format.
 *
 * Usage: node tools/check-conversion.mjs [sessionLimit]
 */
import { openArchive, DEFAULT_ZCODE_ROOT } from '../lib/zcode-source.js'
import { convertConversation, headerFor, newSessionId } from '../lib/convert.js'
import { loadSessionFormatCatalog } from './resolve-catalog.mjs'

const catalogModule = await loadSessionFormatCatalog()

/**
 * Session formats to check, newest first.
 *
 * `sessionFormatCatalog` is the installed harness. `historicalSessionFormatCatalog`
 * is the released v3 reader — what older harnesses run — and it is also the only
 * catalog that validates a v3 artifact without historical child evidence.
 */
const TARGETS = [
  catalogModule.sessionFormatCatalog,
  catalogModule.historicalSessionFormatCatalog,
].map((catalog) => ({ label: `v${catalog.currentVersion}`, catalog, ok: 0, failed: 0 }))

/** Encode to physical rows, then restore exactly as the persistence backend does. */
function roundTrip(catalog, header, events) {
  const headerRow = catalog.encodeCurrentHeader(header, 0)
  const rows = events.map((event) => catalog.encodeCurrentEvent(event))
  const restore = catalog.createRestore(headerRow, {
    recovery: 'strict',
    validation: 'current',
  })
  for (const row of rows) restore.decodeRow(row)
  return restore.finish()
}

const limit = Number(process.argv[2] ?? 25)

const archive = await openArchive(DEFAULT_ZCODE_ROOT)
const workspaces = archive.workspaces()
console.log(`ZCode root: ${DEFAULT_ZCODE_ROOT}`)
console.log(`workspaces: ${workspaces.length}`)
console.log(`session formats: ${TARGETS.map((target) => target.label).join(', ')}`)

let checked = 0
let empty = 0
let totalEvents = 0

for (const workspace of workspaces) {
  if (checked >= limit) break
  const sessions = archive.sessions(workspace.directory)
  for (const session of sessions) {
    if (checked >= limit) break
    checked += 1
    const conversation = archive.conversation(session.id)
    let converted = 0
    for (const target of TARGETS) {
      const version = target.catalog.currentVersion
      const result = convertConversation(
        { meta: session, messages: conversation },
        { title: session.title, formatVersion: version },
      )
      if (result.events.length === 0) continue
      converted += 1
      totalEvents += result.events.length
      try {
        const restored = roundTrip(
          target.catalog,
          headerFor(session, newSessionId(), version),
          result.events,
        )
        if (restored.events.length !== result.events.length) {
          throw new Error(`restored ${restored.events.length} events, expected ${result.events.length}`)
        }
        target.ok += 1
      } catch (error) {
        target.failed += 1
        console.log(`FAIL ${target.label} ${session.id} (${session.title?.slice(0, 40)})`)
        console.log(`  ${error?.message ?? error}`)
      }
    }
    if (converted === 0) empty += 1
  }
}

for (const target of TARGETS) {
  console.log(`${target.label}: ok=${target.ok} failed=${target.failed}`)
}
console.log(`sessions=${checked} empty=${empty} events=${totalEvents}`)
archive.close()
process.exit(TARGETS.some((target) => target.failed > 0) ? 1 : 0)
