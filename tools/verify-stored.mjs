/**
 * Verify PERSISTED DSH session artifacts, exactly as the runtime reads them:
 * walk the concatenated zstd frames of a `session.v<N>.jsonl.zstd` generation,
 * decode every physical row through the format catalog of that generation's
 * version, restore, and summarize the result.
 *
 * One session directory may hold several generations side by side — a migrated
 * session keeps its old file next to the current one — and the highest version
 * present is what the runtime reads.
 *
 * Usage: node tools/verify-stored.mjs "<sessions root>" [sessionIdPrefix]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { loadSessionFormatCatalog } from './resolve-catalog.mjs'

const catalogModule = await loadSessionFormatCatalog()

/** Generation files are named for the Session format version they store. */
const ARTIFACT = /^session\.v(\d+)\.jsonl\.zstd$/

/**
 * Catalog that validates one stored generation.
 *
 * The installed catalog reads the current format, and the historical catalog
 * reads the released v3 format that older harnesses wrote. The installed
 * catalog can also migrate an older generation, but only with the historical
 * child evidence its own persistence layer collects; this offline tool has no
 * such evidence, so it reads each generation with the catalog that owns it.
 */
function catalogFor(version) {
  if (version === catalogModule.sessionFormatCatalog.currentVersion) return catalogModule.sessionFormatCatalog
  if (version === catalogModule.historicalSessionFormatCatalog.currentVersion) return catalogModule.historicalSessionFormatCatalog
  return undefined
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decompress a concatenated-frame jsonl.zstd artifact into its text rows. */
function readArtifact(path) {
  const buffer = readFileSync(path)
  const offsets = []
  let cursor = 0
  while (cursor < buffer.length - 4) {
    const at = buffer.indexOf(MAGIC, cursor)
    if (at < 0) break
    offsets.push(at)
    cursor = at + 4
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const frame = buffer.subarray(offsets[index], index + 1 < offsets.length ? offsets[index + 1] : buffer.length)
    text += zstdDecompressSync(frame).toString('utf8')
  }
  return text.split('\n').filter((line) => line.length > 0)
}

/** Newest stored generation of one session directory, or undefined for none. */
function newestGeneration(sessionDir) {
  let newest
  for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const match = ARTIFACT.exec(entry.name)
    if (match === null) continue
    const version = Number(match[1])
    if (newest === undefined || version > newest.version) {
      newest = { version, name: entry.name, path: join(sessionDir, entry.name) }
    }
  }
  return newest
}

const root = process.argv[2]
const prefix = process.argv[3] ?? 'session-'
const projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
let checked = 0
let failed = 0
let skipped = 0

for (const project of projects) {
  const projectDir = join(root, project.name)
  for (const session of readdirSync(projectDir, { withFileTypes: true })) {
    if (!session.isDirectory() || !session.name.startsWith(prefix)) continue
    const generation = newestGeneration(join(projectDir, session.name))
    if (generation === undefined) continue
    const catalog = catalogFor(generation.version)
    if (catalog === undefined) {
      skipped += 1
      console.log(`SKIP ${session.name}: no format catalog for stored v${generation.version} (${generation.name})`)
      continue
    }
    checked += 1
    try {
      const rows = readArtifact(generation.path).map((line) => JSON.parse(line))
      const [headerRow, ...eventRows] = rows
      const restore = catalog.createRestore(headerRow, {
        recovery: 'strict',
        validation: 'current',
      })
      for (const row of eventRows) restore.decodeRow(row)
      const artifact = restore.finish()
      const counts = {}
      for (const event of artifact.events) counts[event.type] = (counts[event.type] ?? 0) + 1
      console.log(
        `OK   ${session.name} v${generation.version} cwd=${artifact.header.cwd} preset=${JSON.stringify(
          artifact.header.agentPreset ?? '',
        )} events=${artifact.events.length} frames=${rows.length} ${JSON.stringify(counts)}`,
      )
    } catch (error) {
      failed += 1
      console.log(`FAIL ${session.name} v${generation.version}: ${error?.message ?? error}`)
    }
  }
}

console.log(`checked=${checked} failed=${failed} skipped=${skipped}`)
process.exit(failed > 0 ? 1 : 0)
