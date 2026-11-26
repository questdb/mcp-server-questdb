#!/usr/bin/env node
// Pulls the files the bridge shares with the Web Console from the console repo:
//   src/consts/shared-definitions.json — the tool catalog
//   src/agentProtocol.ts               — the agent mode wire protocol
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const repo = process.env.UPSTREAM_REPO ?? "questdb/ui"
const ref = process.env.UPSTREAM_REF ?? "main"

const SHARED_FILES = [
  {
    upstreamPath:
      process.env.UPSTREAM_PATH ?? "src/consts/shared-definitions.json",
    target: resolve(here, "../consts/shared-definitions.json"),
    url: process.env.UPSTREAM_URL,
  },
  {
    upstreamPath: "src/utils/localAgent/protocol.ts",
    target: resolve(here, "../agentProtocol.ts"),
    url: process.env.UPSTREAM_PROTOCOL_URL,
  },
]

const sha256 = (s) => createHash("sha256").update(s).digest("hex")

const sync = async ({ upstreamPath, target, url: override }) => {
  const url =
    override ??
    `https://raw.githubusercontent.com/${repo}/${ref}/${upstreamPath}`
  const res = await fetch(url)
  if (!res.ok) {
    console.error(`sync-tools: fetch failed: ${url} → HTTP ${res.status}`)
    process.exit(1)
  }
  const upstreamText = await res.text()

  let priorText = ""
  try {
    priorText = await readFile(target, "utf8")
  } catch (err) {
    if (err.code !== "ENOENT") throw err
  }

  const before = priorText ? sha256(priorText) : "(absent)"
  const after = sha256(upstreamText)
  if (before === after) {
    console.log(
      `sync-tools: ${upstreamPath} already matches ${url} (sha256 ${after.slice(0, 12)}…)`,
    )
    return
  }

  await writeFile(target, upstreamText)
  console.log(`sync-tools: updated ${target}`)
  console.log(`  source: ${url}`)
  console.log(`  before: ${before}`)
  console.log(`  after:  ${after}`)
  console.log(`  bytes:  ${upstreamText.length}`)
}

for (const file of SHARED_FILES) await sync(file)
