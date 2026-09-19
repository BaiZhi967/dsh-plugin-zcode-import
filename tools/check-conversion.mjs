/**
 * Offline self-test for the ZCode → DSH converter.
 *
 * Reads real ZCode conversations, converts them, and validates the produced
 * artifact by encoding it to physical rows and restoring it through the SAME
 * format catalog the DSH persistence backend uses on read.
 *
 * Usage: node tools/check-conversion.mjs [sessionLimit]
 */
import { openArchive, DEFAULT_ZCODE_ROOT } from '../lib/zcode-source.js'
import { convertConversation, headerFor, newSessionId } from '../lib/convert.js'
import { loadSessionFormatCatalog } from './resolve-catalog.mjs'

const { sessionFormatCatalog } = await loadSessionFormatCatalog()

/** Encode to physical rows, then restore exactly as the persistence backend does. */
function roundTrip(header, events) {
  const headerRow = sessionFormatCatalog.encodeCurrentHeader(header, 0)
  const rows = events.map((event) => sessionFormatCatalog.encodeCurrentEvent(event))
  const restore = sessionFormatCatalog.createRestore(headerRow, {
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

let checked = 0
let failed = 0
let totalEvents = 0
let empty = 0

for (const workspace of workspaces) {
  if (checked >= limit) break
  const sessions = archive.sessions(workspace.directory)
  for (const session of sessions) {
    if (checked >= limit) break
    checked += 1
    const conversation = archive.conversation(session.id)
    const { events, turns, steps } = convertConversation(
      { meta: session, messages: conversation },
      { title: session.title },
    )
    if (events.length === 0) {
      empty += 1
      continue
    }
    totalEvents += events.length
    try {
      const restored = roundTrip(headerFor(session, newSessionId()), events)
      if (restored.events.length !== events.length) {
        throw new Error(`restored ${restored.events.length} events, expected ${events.length}`)
      }
    } catch (error) {
      failed += 1
      console.log(`FAIL ${session.id} (${session.title?.slice(0, 40)})`)
      console.log(`  ${error?.message ?? error}`)
      if (failed >= 5) break
    }
    if (checked <= 3) {
      console.log(
        `OK   ${session.id} events=${events.length} turns=${turns} steps=${steps} types=${[...new Set(events.map((e) => e.type))].join(',')}`,
      )
    }
  }
}

console.log(
  `checked=${checked} failed=${failed} empty=${empty} events=${totalEvents} avg=${Math.round(totalEvents / Math.max(1, checked - empty))}`,
)
archive.close()
process.exit(failed > 0 ? 1 : 0)
