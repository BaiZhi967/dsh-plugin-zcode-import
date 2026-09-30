/**
 * Verify one PERSISTED DSH session artifact, exactly as the runtime reads it:
 * walk the concatenated zstd frames of the current `session.vN.jsonl.zstd`
 * generation (v4 on the harness this plugin targets), decode every
 * physical row through the installed format catalog, restore, and derive the
 * model-visible messages.
 *
 * Usage: node tools/verify-stored.mjs "<sessions root>" [sessionIdPrefix]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { loadSessionFormatCatalog } from './resolve-catalog.mjs'

const { sessionFormatCatalog } = await loadSessionFormatCatalog()

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

const root = process.argv[2]
const prefix = process.argv[3] ?? 'session-'
const projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
let checked = 0
let failed = 0

for (const project of projects) {
  const projectDir = join(root, project.name)
  for (const session of readdirSync(projectDir, { withFileTypes: true })) {
    if (!session.isDirectory() || !session.name.startsWith(prefix)) continue
    const sessionDir = join(projectDir, session.name)
    const artifactName = readdirSync(sessionDir)
      .filter((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name))
      .sort(
        (left, right) =>
          Number(/^session\.v(\d+)/.exec(left)[1]) - Number(/^session\.v(\d+)/.exec(right)[1]),
      )
      .at(-1)
    if (artifactName === undefined) continue
    const artifactPath = join(sessionDir, artifactName)
    checked += 1
    try {
      const rows = readArtifact(artifactPath).map((line) => JSON.parse(line))
      const [headerRow, ...eventRows] = rows
      const restore = sessionFormatCatalog.createRestore(headerRow, {
        recovery: 'strict',
        validation: 'current',
      })
      for (const row of eventRows) restore.decodeRow(row)
      const artifact = restore.finish()
      const counts = {}
      for (const event of artifact.events) counts[event.type] = (counts[event.type] ?? 0) + 1
      console.log(
        `OK   ${session.name} cwd=${artifact.header.cwd} title=${JSON.stringify(
          artifact.header.agentPreset ?? '',
        )} events=${artifact.events.length} frames=${rows.length} ${JSON.stringify(counts)}`,
      )
    } catch (error) {
      failed += 1
      console.log(`FAIL ${session.name}: ${error?.message ?? error}`)
    }
  }
}

console.log(`checked=${checked} failed=${failed}`)
process.exit(failed > 0 ? 1 : 0)
