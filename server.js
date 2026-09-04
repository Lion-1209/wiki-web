#!/usr/bin/env node
/**
 * dsh-wiki-web — self-hosted web UI over a dsh wiki vault.
 *
 * Read-only companion for dsh-plugin-wiki-tools: browse pages with resolved
 * wikilinks, BM25 full-text search, backlinks, and a live lint dashboard.
 * The vault stays a plain Markdown directory on disk (Obsidian-compatible);
 * this server never mutates it except when you explicitly scaffold one.
 *
 * Usage:
 *   node server.js --vault /path/to/vault [--port 3210] [--host 127.0.0.1]
 *   WIKI_VAULT_PATH=/path/to/vault node server.js
 *
 * Without a vault the server serves a setup page that scaffolds one into
 * ./vault via the engine's wiki_scaffold.
 */

import http from 'node:http'
import fs from 'node:fs'
import { join, relative, sep } from 'node:path'
import { marked } from 'marked'
import {
  collectMarkdown,
  buildAliasMap,
  resolveLinkTarget,
  isMachineryPage,
  splitFrontmatter,
} from 'dsh-plugin-wiki-tools/lib/vault.js'
import { searchVault, quickView } from 'dsh-plugin-wiki-tools/lib/search.js'
import { lintVault } from 'dsh-plugin-wiki-tools/lib/lint.js'
import { scaffoldVault } from 'dsh-plugin-wiki-tools/lib/scaffold.js'

// ---------- config ----------

const args = process.argv.slice(2)
function argValue(flag) {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const PORT = Number(argValue('--port') ?? process.env.PORT ?? 3210)
const HOST = argValue('--host') ?? process.env.HOST ?? '127.0.0.1'
const VAULT = (argValue('--vault') ?? process.env.WIKI_VAULT_PATH ?? join(process.cwd(), 'vault')).replace(/\\/g, '/')

// ---------- engine access ----------

let cache = { ts: 0, pages: [] }
const CACHE_MS = 5000

async function pages(force = false) {
  if (!force && Date.now() - cache.ts < CACHE_MS) return cache.pages
  const list = await collectMarkdown(join(VAULT, 'wiki'))
  cache = { ts: Date.now(), pages: list }
  return list
}

const vaultReady = () => fs.existsSync(join(VAULT, 'wiki'))

// collectMarkdown's rel is relative to the page's immediate folder (the walk
// recurses with a new base), so the wiki-root-relative folder must be derived
// from the absolute path.
const WIKI_DIR = () => join(VAULT, 'wiki')
function folderOf(page) {
  const rel = relative(WIKI_DIR(), page.path).split(sep).join('/')
  return rel.includes('/') ? rel.split('/')[0] : '(root)'
}

// ---------- rendering helpers ----------

const esc = (value) =>
  String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function renderMarkdown(md) {
  // Fence-aware wikilink conversion: [[Target]], [[Target|alias]],
  // [[Target#anchor]] (anchor simplified away in MVP) become /wiki/ links.
  // Code fences and inline code are left untouched.
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  const converted = parts.map((part) => {
    if (part.startsWith('```') || part.startsWith('`')) return part
    return part
      .replace(/!?\[\[([^\]|#]+)#([^\]|]+)\]\]/g, (_, t) => wikilink(t.trim(), t.trim()))
      .replace(/!?\[\[([^\]|#]+)\|([^\]]+)\]\]/g, (_, t, a) => wikilink(a.trim(), t.trim()))
      .replace(/!?\[\[([^\]]+)\]\]/g, (_, t) => wikilink(t.trim(), t.trim()))
  }).join('')
  return marked.parse(converted, { async: false })
}

function wikilink(label, target) {
  return `<a class="wikilink" href="/wiki/${encodeURIComponent(target)}">${esc(label)}</a>`
}

// The master index accumulates duplicate section headings over a vault's life
// (scaffold + per-type writes) and carries empty sections for types with no
// entries yet. Collapse both for display: merge same-named sections into the
// first occurrence and drop sections with no entries.
function collapseIndexSections(md) {
  const lines = md.split('\n')
  const prefix = []
  const order = []
  const sections = new Map()
  let current = null
  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line)
    if (heading !== null) {
      current = heading[1]
      if (!sections.has(current.toLowerCase())) {
        sections.set(current.toLowerCase(), [])
        order.push(current)
      }
      continue
    }
    if (current === null) prefix.push(line)
    else sections.get(current.toLowerCase()).push(line)
  }
  const out = [...prefix]
  for (const original of order) {
    const text = sections.get(original.toLowerCase()).join('\n').replace(/^\s+|\s+$/g, '')
    if (text.length > 0) out.push(`## ${original}`, '', text, '')
  }
  return out.join('\n')
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f6f8fa; color: #1f2328; }
header { background: #1f2328; color: #fff; padding: 10px 20px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
header a { color: #c9d1d9; text-decoration: none; font-size: 14px; }
header a:hover { color: #fff; }
header .brand { font-weight: 700; font-size: 15px; color: #fff; margin-right: 8px; }
header form { margin-left: auto; display: flex; gap: 6px; }
header input[type=search] { background: #2d333b; border: 1px solid #444c56; color: #e6edf3; border-radius: 6px; padding: 4px 10px; width: 220px; }
main { max-width: 1100px; margin: 24px auto; padding: 0 20px; }
.card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px 24px; margin-bottom: 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 20px; }
.stat { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 18px; }
.stat b { font-size: 26px; display: block; }
.stat span { color: #656d76; font-size: 13px; }
h1 { font-size: 24px; margin: 0 0 14px; }
h2 { font-size: 18px; border-bottom: 1px solid #d0d7de; padding-bottom: 6px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #d0d7de; font-size: 14px; vertical-align: top; }
th { color: #656d76; font-weight: 600; background: #f6f8fa; }
.wikilink { color: #0969da; text-decoration: none; border-bottom: 1px dotted #0969da55; }
.wikilink:hover { border-bottom-style: solid; }
.wikilink.dead { color: #cf222e; }
pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px; overflow-x: auto; }
code { background: #eff1f3; border-radius: 4px; padding: 1px 5px; font-size: 13px; }
pre code { background: none; padding: 0; }
blockquote { margin: 0; padding: 4px 14px; border-left: 3px solid #d0d7de; color: #656d76; }
.badge { display: inline-block; border-radius: 20px; padding: 1px 10px; font-size: 12px; font-weight: 600; }
.badge.error { background: #ffebe9; color: #cf222e; }
.badge.warn { background: #fff8c5; color: #9a6700; }
.badge.info { background: #ddf4ff; color: #0969da; }
.meta { color: #656d76; font-size: 13px; }
.sidebar { float: right; width: 260px; margin-left: 20px; }
.sidebar .card { padding: 12px 16px; margin-bottom: 14px; }
.sidebar ul { list-style: none; margin: 4px 0; padding: 0; }
.sidebar li { padding: 1px 0; }
.sidebar li.folder { color: #656d76; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-top: 8px; }
.snippet { color: #57606a; font-size: 13px; margin-top: 2px; }
.clear { clear: both; }
input[type=text] { padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; width: 320px; }
button { background: #1f883d; color: #fff; border: 0; border-radius: 6px; padding: 7px 16px; font-size: 14px; cursor: pointer; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
footer { text-align: center; color: #8b949e; font-size: 12px; padding: 10px 0 30px; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  .card, .stat { background: #161b22; border-color: #30363d; }
  th { background: #161b22; }
  th, td { border-color: #30363d; }
  h2 { border-color: #30363d; }
  pre { background: #161b22; border-color: #30363d; }
  code { background: #21262d; }
  input[type=text] { background: #0d1117; color: #e6edf3; border-color: #30363d; }
  .meta, .snippet { color: #8b949e; }
}
`

function layout(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — dsh-wiki-web</title>
<style>${CSS}</style>
</head><body>
<header>
  <a class="brand" href="/">🗂 wiki vault</a>
  <a href="/">Dashboard</a>
  <a href="/lint">Lint</a>
  <a href="/wiki/log">Log</a>
  <a href="/wiki/index">Index</a>
  <form action="/search" method="get"><input type="search" name="q" placeholder="Search the vault…" required> <button>Search</button></form>
</header>
<main>${body}</main>
<footer>vault: ${esc(VAULT)} · dsh-wiki-web 0.1.0 · read-only</footer>
</body></html>`
}

function html(res, status, title, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(layout(title, body))
}

// ---------- pages ----------

async function dashboard(res) {
  const list = await pages()
  if (!vaultReady() || list.length === 0) return setupPage(res)

  const byType = {}
  const byFolder = {}
  let linkCount = 0
  for (const page of list) {
    const type = String(page.fields?.type ?? 'untyped')
    byType[type] = (byType[type] ?? 0) + 1
    const folder = folderOf(page)
    byFolder[folder] = (byFolder[folder] ?? 0) + 1
    linkCount += page.links.length
  }
  let view = list.filter((page) => page.name === 'log').map((page) => page.content).at(0) ?? ''
  view = view.split('\n## ').slice(0, 6).join('\n## ')

  const quick = await quickView(VAULT).catch(() => ({ hot: '', index: '' }))
  const strip = (raw) => splitFrontmatter(raw ?? '', 'quickview').content
  const body = `
<h1>Dashboard</h1>
<div class="grid">
  <div class="stat"><b>${list.length}</b><span>pages</span></div>
  <div class="stat"><b>${linkCount}</b><span>wikilinks</span></div>
  <div class="stat"><b>${Object.keys(byType).length}</b><span>types</span></div>
  <div class="stat"><b>${Object.keys(byFolder).length}</b><span>folders</span></div>
</div>
<div class="card"><h2>Pages by type</h2><table><tr>${Object.entries(byType).map(([t, n]) => `<th>${esc(t)}</th>`).join('')}</tr><tr>${Object.values(byType).map((n) => `<td>${n}</td>`).join('')}</tr></table></div>
<div class="card"><h2>hot.md — recent context</h2>${marked.parse(strip(quick.hot) || '_(missing)_', { async: false })}</div>
<div class="card"><h2>index.md — master catalog</h2>${marked.parse(collapseIndexSections(strip(quick.index)) || '_(missing)_', { async: false })}</div>
<div class="card"><h2>Recent activity (log.md)</h2>${marked.parse(view, { async: false })}<p class="meta"><a href="/wiki/log">full log →</a></p></div>`
  html(res, 200, 'Dashboard', body)
}

function sidebarFor(list, current) {
  const groups = new Map()
  for (const page of list) {
    if (page.name.startsWith('_index')) continue
    const folder = folderOf(page)
    if (!groups.has(folder)) groups.set(folder, [])
    groups.get(folder).push(page)
  }
  const items = [...groups.entries()].map(([folder, pagesIn]) => {
    const links = pagesIn.map((page) =>
      `<li>${page.name === current ? `<b>${esc(page.name)}</b>` : `<a href="/wiki/${encodeURIComponent(page.name)}">${esc(page.name)}</a>`}</li>`).join('')
    return `<li class="folder">${esc(folder)}</li>${links}`
  }).join('')
  return `<div class="sidebar"><div class="card"><b>${list.length} pages</b><ul>${items}</ul></div></div>`
}

async function pageView(res, rawName, status = 200) {
  const name = decodeURIComponent(rawName)
  const list = await pages()
  const page = list.find((candidate) => candidate.name === name)
    ?? list.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
  if (page === undefined) {
    return html(res, 404, name, `<h1>Not found</h1><p>No page named <code>${esc(name)}</code> in this vault. <a href="/search?q=${encodeURIComponent(name)}">Search for it?</a></p>`)
  }

  const aliases = buildAliasMap(list)
  const names = new Set(list.map((candidate) => candidate.name))
  const outgoing = [...new Set(page.links)]
  const backlinks = list.filter((candidate) =>
    candidate.name !== page.name
    && candidate.links.some((target) => resolveLinkTarget(target, names, aliases) === page.name))

  const fields = page.fields ?? {}
  const metaRows = ['type', 'status', 'created', 'updated', 'tags', 'aliases']
    .filter((key) => fields[key] !== undefined)
    .map((key) => `<tr><th>${key}</th><td>${esc(Array.isArray(fields[key]) ? fields[key].join(', ') : String(fields[key]))}</td></tr>`).join('')

  const dead = outgoing.filter((target) => resolveLinkTarget(target, names, aliases) === undefined)
  const rendered = page.name.toLowerCase() === 'index'
    ? collapseIndexSections(page.content)
    : page.content
  const body = `
${sidebarFor(list, page.name)}
<h1>${esc(page.name)}</h1>
<p class="meta">${isMachineryPage(page.name) ? 'vault machinery · ' : ''}${esc(page.rel)}</p>
${metaRows ? `<div class="card"><table>${metaRows}</table></div>` : ''}
<div class="card">${renderMarkdown(rendered)}</div>
<div class="card"><h2>Outbound links (${outgoing.length})</h2>${outgoing.length === 0 ? '<p class="meta">none</p>'
    : `<ul>${outgoing.map((target) => `<li>${wikilink(target, target)}${dead.includes(target) ? ' <span class="badge error">dead</span>' : ''}</li>`).join('')}</ul>`}</div>
<div class="card"><h2>Backlinks (${backlinks.length})</h2>${backlinks.length === 0 ? '<p class="meta">no other page links here yet</p>'
    : `<ul>${backlinks.map((candidate) => `<li><a href="/wiki/${encodeURIComponent(candidate.name)}">${esc(candidate.name)}</a></li>`).join('')}</ul>`}</div>`
  html(res, status, page.name, body)
}

async function searchPage(res, query) {
  if (!query?.trim()) return html(res, 200, 'Search', '<h1>Search</h1><p>Type a query in the header box.</p>')
  const { results, totalMatches } = await searchVault(VAULT, { query: query.trim(), limit: 30 })
  const rows = results.map((hit) => `
<tr><td><a href="/wiki/${encodeURIComponent(hit.name)}">${esc(hit.name)}</a>
<div class="snippet">${hit.snippets.map((snippet) => esc(snippet)).join(' <b>…</b> ') || '&nbsp;'}</div></td>
<td>${hit.score.toFixed(2)}</td><td>${hit.inbound.length}</td><td>${hit.outbound}</td></tr>`).join('')
  const body = `
<h1>Search: ${esc(query.trim())}</h1>
<p class="meta">${results.length} shown of ${totalMatches} matching pages (BM25 ranking).</p>
<table><tr><th>Page</th><th>Score</th><th>In</th><th>Out</th></tr>${rows}</table>`
  html(res, 200, 'Search', body)
}

const SEVERITY_CLASS = { error: 'error', warn: 'warn', info: 'info' }

async function lintPage(res) {
  const { issues, summary, reportPath } = await lintVault(VAULT)
  const grouped = new Map()
  for (const issue of issues) {
    if (!grouped.has(issue.check)) grouped.set(issue.check, [])
    grouped.get(issue.check).push(issue)
  }
  const sections = [...grouped.entries()].map(([check, group]) => `
<div class="card"><h2>${esc(check)} <span class="badge ${SEVERITY_CLASS[group[0].severity] ?? 'info'}">${group.length}</span></h2>
<table>${group.map((issue) => `<tr><td><a href="/wiki/${encodeURIComponent(issue.page)}">${esc(issue.page)}</a></td><td>${esc(issue.detail)}</td><td class="meta">${esc(issue.suggestion)}</td></tr>`).join('')}</table></div>`).join('')
  const healthy = summary.issues === 0
    ? '<div class="card"><h2>✅ All clear</h2><p>No issues found across ' + summary.pagesScanned + ' pages.</p></div>'
    : sections || '<div class="card"><p>No issues.</p></div>'
  const body = `
<h1>Lint dashboard</h1>
<div class="grid">
  <div class="stat"><b>${summary.pagesScanned}</b><span>pages scanned</span></div>
  <div class="stat"><b style="color:${summary.issues === 0 ? '#1a7f37' : '#cf222e'}">${summary.issues}</b><span>issues</span></div>
  ${Object.entries(summary.byCheck).map(([check, count]) => `<div class="stat"><b>${count}</b><span>${esc(check)}</span></div>`).join('')}
</div>
${healthy}
<p class="meta">full report: <code>${esc(reportPath ?? 'not written')}</code> · re-runs live on every visit</p>`
  html(res, 200, 'Lint', body)
}

function setupPage(res, message = '') {
  const body = `
<h1>Set up your wiki vault</h1>
<div class="card">
<p>No vault found at <code>${esc(VAULT)}</code>. Scaffold a fresh one — folder structure, seed pages, index/log/hot files, and a raw-source manifest — then start talking to your agent.</p>
${message ? `<p class="meta">${esc(message)}</p>` : ''}
<form method="post" action="/setup">
<table>
<tr><th>Purpose</th><td><input type="text" name="purpose" placeholder="What is this vault for? (optional)"></td></tr>
</table>
<p><button type="submit">Scaffold vault here</button></p>
</form>
<p class="meta">The vault is a plain Markdown directory — Obsidian can open it anytime, and it stays yours.</p>
</div>`
  html(res, 200, 'Setup', body)
}

async function scaffold(req, res) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const form = new URLSearchParams(raw)
  const purpose = form.get('purpose')?.trim() || undefined
  fs.mkdirSync(join(VAULT, 'wiki'), { recursive: true })
  const result = await scaffoldVault(VAULT, { mode: 'generic', purpose })
  cache = { ts: 0, pages: [] }
  const body = `
<h1>Vault created</h1>
<div class="card"><p>Scaffolded <b>${result.created.length} files</b> under <code>${esc(VAULT)}</code> (skipped ${result.skipped.length} existing).</p>
<p class="meta">${result.created.map((file) => esc(file)).join(' · ')}</p>
<p>Now point your agent at it — in dsh: <code>dsh plugin --profile web add dsh-plugin-wiki-tools</code> and set <code>vaultPath</code> to this directory. Then chat: <i>"把这篇文章收进知识库"</i>.</p>
<p><a href="/">Open the dashboard →</a></p></div>`
  html(res, 200, 'Vault created', body)
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname
  try {
    if (req.method === 'POST' && pathname === '/setup') return await scaffold(req, res)
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
    if (pathname === '/' || pathname === '/index.html') return await dashboard(res)
    if (pathname === '/lint') return await lintPage(res)
    if (pathname === '/search') return await searchPage(res, url.searchParams.get('q'))
    if (pathname.startsWith('/wiki/')) {
      if (!vaultReady()) return setupPage(res)
      return await pageView(res, pathname.slice('/wiki/'.length))
    }
    if (!vaultReady()) return setupPage(res)
    html(res, 404, 'Not found', `<h1>Not found</h1><p><a href="/">Back to the dashboard</a></p>`)
  } catch (error) {
    html(res, 500, 'Error', `<h1>Something broke</h1><pre>${esc(error.stack ?? error.message)}</pre>`)
  }
})

if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error(`bad port: ${PORT}`)
  process.exit(1)
}
server.listen(PORT, HOST, () => {
  console.log(`dsh-wiki-web serving ${VAULT}`)
  console.log(`  → http://${HOST}:${PORT}`)
})
