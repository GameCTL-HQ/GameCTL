#!/usr/bin/env node
// Auto-generate public/yaml/index.json from YAML files in that folder.
// Future: can be extended to fetch from a GitHub repo and merge.

import { readdir, writeFile, mkdir, stat, readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (_) {
    // ignore
  }
}

function isYaml(name) {
  return /\.(ya?ml)$/i.test(name)
}

async function generate() {
  const projectRoot = path.resolve(__dirname, '..')
  const yamlDir = path.join(projectRoot, 'public', 'yaml')
  const indexPath = path.join(yamlDir, 'index.json')

  await ensureDir(yamlDir)

  let files = []
  try {
    const entries = await readdir(yamlDir, { withFileTypes: true })
    files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((n) => isYaml(n))
      .sort((a, b) => a.localeCompare(b))
  } catch (err) {
    console.error(`[yaml-index] Failed to read directory: ${yamlDir}`, err)
    process.exitCode = 1
    return
  }

  const payload = { files }
  const nextJson = JSON.stringify(payload, null, 2) + '\n'

  // Avoid rewriting if unchanged
  try {
    const curr = await readFile(indexPath, 'utf8')
    if (curr === nextJson) {
      console.log(`[yaml-index] Up-to-date (${files.length} file${files.length === 1 ? '' : 's'})`)
      return
    }
  } catch (_) {
    // index.json may not exist yet
  }

  await writeFile(indexPath, nextJson, 'utf8')
  console.log(`[yaml-index] Wrote index.json with ${files.length} file${files.length === 1 ? '' : 's'}`)
}

generate().catch((err) => {
  console.error('[yaml-index] Unexpected error', err)
  process.exitCode = 1
})
