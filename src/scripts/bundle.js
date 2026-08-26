// Build the standalone single-file bundle: everything (deps + the shared
// tool definitions JSON) inlined, so the result works with no node_modules or
// registry access. Generate the matching third-party notices from esbuild's
// metafile, then promote both artifacts together only after all work succeeds.
// Usage: node src/scripts/bundle.js [--out <dir>|--out=<dir>]
import { build } from "esbuild"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const packageFile = join(repoRoot, "package.json")
const definitionsFile = join(repoRoot, "src/consts/shared-definitions.json")
const pkg = JSON.parse(readFileSync(packageFile, "utf8"))
const version = pkg.version

const canonicalVersion = (value) =>
  typeof value === "string" &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)

if (!canonicalVersion(version)) {
  throw new Error(
    `package.json version must be canonical major.minor.patch: ${String(version)}`,
  )
}

let requestedOutDir
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  let value
  if (arg === "--out") {
    value = process.argv[++i]
    if (!value || value.startsWith("--")) {
      console.error("--out requires a directory")
      process.exit(2)
    }
  } else if (arg.startsWith("--out=")) {
    value = arg.slice("--out=".length)
    if (!value) {
      console.error("--out requires a directory")
      process.exit(2)
    }
  } else {
    console.error(`unknown argument: ${arg}`)
    process.exit(2)
  }
  if (requestedOutDir !== undefined) {
    console.error("--out may be specified only once")
    process.exit(2)
  }
  requestedOutDir = value
}

const outDir = requestedOutDir
  ? resolve(process.cwd(), requestedOutDir)
  : join(repoRoot, "out")
const bundleName = `mcp-server-questdb-${version}.mjs`
const outfile = join(outDir, bundleName)
const noticesFile = join(outDir, "THIRD_PARTY_NOTICES.txt")
const sharedDefinitions = JSON.parse(readFileSync(definitionsFile, "utf8"))

const legalHeader =
  `/*! @questdb/mcp-server-questdb v${version} — Apache-2.0.\n` +
  ` * Bundles third-party code; the required license notices are in\n` +
  ` * THIRD_PARTY_NOTICES.txt, distributed with this file at\n` +
  ` * https://github.com/questdb/mcp-server-questdb/releases */\n`

const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: [join(repoRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  metafile: true,
  write: false,
  define: {
    __BRIDGE_VERSION__: JSON.stringify(version),
    __BRIDGE_DISTRIBUTION__: '"standalone"',
    __BUNDLED_SHARED_DEFINITIONS__: JSON.stringify(sharedDefinitions),
  },
  // Prefer ESM entries: jsonc-parser's default (UMD) entry does runtime
  // relative requires that cannot resolve from a single-file bundle.
  mainFields: ["module", "main"],
  // Bundled CJS dependencies need a real require. Disable ws's optional native
  // accelerators so this shim never loads code from beside a downloaded bundle.
  banner: {
    js:
      legalHeader +
      'import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);' +
      'process.env.WS_NO_BUFFER_UTIL="1";process.env.WS_NO_UTF_8_VALIDATE="1";',
  },
  outfile,
})

// Every package root that contributed code to the bundle. Keying by resolved
// root preserves nested copies of the same package at different versions.
const packageRoots = new Map()
for (const input of Object.keys(result.metafile.inputs)) {
  const absoluteInput = resolve(repoRoot, input)
  const normalized = absoluteInput.replaceAll("\\", "/")
  const idx = normalized.lastIndexOf("/node_modules/")
  if (idx < 0) continue
  const moduleRoot = normalized.slice(0, idx + "/node_modules/".length)
  const parts = normalized.slice(idx + "/node_modules/".length).split("/")
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
  const root = join(moduleRoot, name)
  packageRoots.set(root, name)
}

const rule = "-".repeat(72)
const sections = []
const packages = [...packageRoots.entries()]
  .map(([root, name]) => {
    const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    return { root, name, meta }
  })
  .sort((a, b) =>
    `${a.name}@${a.meta.version}:${a.root}`.localeCompare(
      `${b.name}@${b.meta.version}:${b.root}`,
    ),
  )

// The bundle always inlines third-party code (ws, ajv, …). Zero packages means
// the resolver/layout changed (e.g. PnP, a symlinked workspace, or an esbuild
// metafile-path change) and the notices would ship empty — fail rather than
// publish a distributed artifact with no third-party attribution.
if (packages.length === 0) {
  throw new Error(
    "no third-party packages found in the esbuild metafile; refusing to " +
      "write an empty THIRD_PARTY_NOTICES.txt",
  )
}

for (const { root, name, meta } of packages) {
  // LICENSE/LICENCE/COPYING plus any NOTICE file. Ignore matching directories.
  const files = readdirSync(root)
    .filter((file) => /^(licen[cs]e|copying|notice)/i.test(file))
    .filter((file) => statSync(join(root, file)).isFile())
    .sort()
  const texts = files.map((file) =>
    readFileSync(join(root, file), "utf8").trim(),
  )
  const body =
    texts.length > 0
      ? texts.join("\n\n")
      : `(no license file shipped in the package; declared license: ${meta.license ?? "unknown"})`
  sections.push(
    `${rule}\n${name}@${meta.version} — ${meta.license ?? "unknown"}\n${rule}\n\n${body}\n`,
  )
}

const projectLicense = readFileSync(join(repoRoot, "LICENSE"), "utf8").trim()
const notices =
  `Third-party license notices for @questdb/mcp-server-questdb v${version}\n` +
  `(standalone bundle: ${bundleName})\n\n` +
  `This project is licensed under the Apache License 2.0:\n\n${rule}\n` +
  `@questdb/mcp-server-questdb — Apache-2.0\n${rule}\n\n${projectLicense}\n\n` +
  `The bundle also contains code from the following packages:\n\n` +
  sections.join("\n")

const bundleOutput = result.outputFiles.find((file) =>
  file.path.endsWith(bundleName),
)
if (!bundleOutput) throw new Error(`esbuild did not produce ${bundleName}`)

mkdirSync(outDir, { recursive: true })
for (const target of [outfile, noticesFile]) {
  if (existsSync(target) && !statSync(target).isFile()) {
    throw new Error(`refusing to replace non-file output: ${target}`)
  }
}

const stagingDir = mkdtempSync(join(outDir, ".bundle-staging-"))
const stagedBundle = join(stagingDir, bundleName)
const stagedNotices = join(stagingDir, "THIRD_PARTY_NOTICES.txt")
const backupBundle = join(stagingDir, `${bundleName}.previous`)
const backupNotices = join(stagingDir, "THIRD_PARTY_NOTICES.txt.previous")
let promotedBundle = false
let promotedNotices = false
let backedUpBundle = false
let backedUpNotices = false

try {
  writeFileSync(stagedBundle, bundleOutput.contents)
  writeFileSync(stagedNotices, notices)
  if (existsSync(outfile)) {
    renameSync(outfile, backupBundle)
    backedUpBundle = true
  }
  if (existsSync(noticesFile)) {
    renameSync(noticesFile, backupNotices)
    backedUpNotices = true
  }
  renameSync(stagedBundle, outfile)
  promotedBundle = true
  renameSync(stagedNotices, noticesFile)
  promotedNotices = true
} catch (error) {
  if (promotedBundle) rmSync(outfile, { force: true })
  if (promotedNotices) rmSync(noticesFile, { force: true })
  if (backedUpBundle) renameSync(backupBundle, outfile)
  if (backedUpNotices) renameSync(backupNotices, noticesFile)
  throw error
} finally {
  rmSync(stagingDir, { recursive: true, force: true })
}

console.log(outfile)
console.log(`${noticesFile} (${packageRoots.size} packages)`)
