/**
 * Locate the installed DSH format catalog for the verification tools.
 *
 * The catalog is a DSH-internal package, so it is not a dependency of this
 * plugin. Resolution therefore walks the places a DSH installation actually
 * lives, in order:
 *
 *   1. a plain import — works when the script runs from a directory whose
 *      `node_modules` already contains `@deepseek-ai/dsh-session-format-catalog`
 *      (e.g. a DSH profile directory);
 *   2. `DSH_CHECKOUT` — an explicit path to the DSH installation, when set;
 *   3. the global npm root — where `npm i -g @deepseek-ai/dsh` puts it.
 *
 * @returns the catalog module namespace.
 * @throws when no installation provides it, with the paths that were tried.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const PACKAGE = '@deepseek-ai/dsh-session-format-catalog'

/** `npm prefix -g`, without depending on a shell-specific executable lookup. */
function globalNpmRoot() {
  for (const shell of [false, true]) {
    try {
      const prefix = execFileSync('npm', ['prefix', '-g'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell,
      })
      const trimmed = prefix.trim()
      if (trimmed.length > 0) return join(trimmed, 'node_modules')
    } catch {
      /* try the next strategy */
    }
  }
  return undefined
}

/** Conventional global `node_modules` directories, without invoking npm. */
function conventionalRoots() {
  const roots = []
  if (typeof process.env.APPDATA === 'string' && process.env.APPDATA.length > 0) {
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules'))
  }
  if (typeof process.env.PREFIX === 'string' && process.env.PREFIX.length > 0) {
    roots.push(join(process.env.PREFIX, 'lib', 'node_modules'))
  }
  roots.push(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  roots.push('/usr/local/lib/node_modules')
  roots.push('/usr/lib/node_modules')
  return roots
}

/** Candidate `node_modules` directories that may hold the DSH packages. */
function candidateRoots() {
  const roots = []
  if (typeof process.env.DSH_CHECKOUT === 'string' && process.env.DSH_CHECKOUT.length > 0) {
    roots.push(join(process.env.DSH_CHECKOUT, 'node_modules'))
    roots.push(join(process.env.DSH_CHECKOUT, 'packages'))
  }
  const global = globalNpmRoot()
  if (global !== undefined) roots.push(global)
  roots.push(...conventionalRoots())
  // Each candidate root, plus the DSH package's own nested node_modules.
  return [...roots, ...roots.map((root) => join(root, '@deepseek-ai', 'dsh', 'node_modules'))]
}

export async function loadSessionFormatCatalog() {
  try {
    return await import(PACKAGE)
  } catch {
    /* not resolvable from here — fall through to explicit locations */
  }

  const tried = []
  for (const root of candidateRoots()) {
    const manifest = join(root, ...PACKAGE.split('/'), 'package.json')
    tried.push(manifest)
    if (!existsSync(manifest)) continue
    const require = createRequire(pathToFileURL(join(dirname(manifest), 'noop.js')).href)
    const entry = require.resolve(PACKAGE)
    return import(pathToFileURL(entry).href)
  }

  throw new Error(
    `无法定位 ${PACKAGE}。请设置 DSH_CHECKOUT 指向 DSH 安装目录，或从 DSH profile 目录运行本脚本。已尝试：\n  ` +
      tried.join('\n  '),
  )
}
