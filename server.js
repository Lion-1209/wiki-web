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
import fs, { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { marked } from 'marked'
import {
  collectMarkdown,
  buildAliasMap,
  resolveLinkTarget,
  isMachineryPage,
  splitFrontmatter,
  Vault,
  TYPE_FOLDERS,
  PAGE_STATUSES,
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
const GIT_AUTO_COMMIT = process.env.WIKI_GIT_AUTO_COMMIT === '1'

// Write path (edit form): the engine serializes per file, locks cross-process,
// and keeps frontmatter bookkeeping (created/unknown fields, index, log).
const vault = new Vault(VAULT, { gitAutoCommit: GIT_AUTO_COMMIT })

// ---------- engine access ----------

let cache = { ts: 0, pages: [] }
let cachePending = null
const CACHE_MS = 5000

// force → always rescan; otherwise a 5s TTL plus single-flight (concurrent
// requests share one in-flight scan instead of stampeding the filesystem).
async function pages(force = false) {
  if (!force && Date.now() - cache.ts < CACHE_MS) return cache.pages
  if (cachePending !== null && !force) return cachePending
  cachePending = collectMarkdown(WIKI_DIR()).then((list) => {
    cache = { ts: Date.now(), pages: list }
    cachePending = null
    return list
  }, (error) => {
    cachePending = null
    throw error
  })
  return cachePending
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
    // No raw HTML policy: vault content includes text ingested from third
    //-party web pages, so every `<` outside code becomes literal text. This
    // kills script/iframe/event-handler injection at the source (marked does
    // not sanitize); javascript:/data: hrefs from markdown links are filtered
    // post-parse below.
    const htmlFree = part.replace(/</g, '&lt;')
    return htmlFree
      .replace(/!?\[\[([^\]|#]+)#([^\]|]+)\]\]/g, (_, t) => wikilink(t.trim(), t.trim()))
      .replace(/!?\[\[([^\]|#]+)\|([^\]]+)\]\]/g, (_, t, a) => wikilink(a.trim(), t.trim()))
      .replace(/!?\[\[([^\]]+)\]\]/g, (_, t) => wikilink(t.trim(), t.trim()))
  }).join('')
  return marked.parse(converted, { async: false })
    .replace(/href=["'](javascript|data|vbscript):[^"']*["']/gi, 'href="#"')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
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
.pagecols { display: flex; gap: 20px; align-items: flex-start; }
.pagecol-main { flex: 1; min-width: 0; }
.pagecol-side { width: 260px; flex-shrink: 0; }
.pagecol-side .card { padding: 12px 16px; margin-bottom: 14px; }
.pagecol-side ul { list-style: none; margin: 4px 0; padding: 0; }
.pagecol-side li { padding: 1px 0; }
.pagecol-side li.folder { color: #656d76; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-top: 8px; }
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
<script>window.addEventListener('error', e => { (window.__errs = window.__errs || []).push(String(e.message)) }); window.addEventListener('unhandledrejection', e => { (window.__errs = window.__errs || []).push('rejection: ' + (e.reason && e.reason.stack ? e.reason.stack.split(String.fromCharCode(10)).slice(0, 2).join(' | ') : String(e.reason))) })</script>
<style>${CSS}</style>
</head><body>
<header>
  <a class="brand" href="/">🗂 wiki vault</a>
  <a href="/">Dashboard</a>
  <a href="/graph">Graph</a>
  <a href="/lint">Lint</a>
  <a href="/wiki/log">Log</a>
  <a href="/wiki/index">Index</a>
  <a href="/new">+ New page</a>
  <form action="/search" method="get"><input type="search" name="q" placeholder="Search the vault…" required> <button>Search</button></form>
</header>
<main>${body}</main>
<footer>vault: ${esc(VAULT)} · dsh-wiki-web 0.2.0 · vault stays plain Markdown on disk</footer>
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
<div class="card"><h2>hot.md — recent context</h2>${renderMarkdown(strip(quick.hot) || '_(missing)_')}</div>
<div class="card"><h2>index.md — master catalog</h2>${renderMarkdown(collapseIndexSections(strip(quick.index)) || '_(missing)_')}</div>
<div class="card"><h2>Recent activity (log.md)</h2>${renderMarkdown(view)}<p class="meta"><a href="/wiki/log">full log →</a></p></div>`
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
  return `<div class="pagecol-side"><div class="card"><b>${list.length} pages</b><ul>${items}</ul></div></div>`
}

async function pageView(res, rawName, saved = false, status = 200) {
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
  const mainCol = `
<h1>${esc(page.name)}</h1>
<p class="meta">${isMachineryPage(page.name) ? 'vault machinery · ' : ''}${esc(page.rel)} · <a href="/wiki/${encodeURIComponent(page.name)}?edit=1">✏️ edit</a></p>
${metaRows ? `<div class="card"><table>${metaRows}</table></div>` : ''}
<div class="card">${renderMarkdown(rendered)}</div>
<div class="card"><h2>Outbound links (${outgoing.length})</h2>${outgoing.length === 0 ? '<p class="meta">none</p>'
    : `<ul>${outgoing.map((target) => `<li>${wikilink(target, target)}${dead.includes(target) ? ' <span class="badge error">dead</span>' : ''}</li>`).join('')}</ul>`}</div>
<div class="card"><h2>Backlinks (${backlinks.length})</h2>${backlinks.length === 0 ? '<p class="meta">no other page links here yet</p>'
    : `<ul>${backlinks.map((candidate) => `<li><a href="/wiki/${encodeURIComponent(candidate.name)}">${esc(candidate.name)}</a></li>`).join('')}</ul>`}</div>`
  const body = `
<div class="pagecols">
<div class="pagecol-main">${saved ? '<div class="card" style="border-color:#1a7f37"><span class="badge" style="background:#dafbe1;color:#1a7f37">saved</span> page written through the engine — frontmatter, indexes, and log updated.</div>' : ''}${mainCol}</div>
${sidebarFor(list, page.name)}
</div>`
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

// ---------- editing ----------

function editForm(res, { title, values, error, status = 200 }) {
  const page = values.page
  const locked = page !== undefined && page !== null
  const typeOptions = Object.keys(TYPE_FOLDERS).map((key) =>
    `<option value="${key}"${key === values.type ? ' selected' : ''}>${key}</option>`).join('')
  const statusOptions = ['<option value="">(keep current)</option>']
    .concat(PAGE_STATUSES.map((key) => `<option value="${key}"${key === values.status ? ' selected' : ''}>${key}</option>`)).join('')
  const body = `
<h1>${page ? `Edit: ${esc(title)}` : 'New page'}</h1>
${error ? `<div class="card"><span class="badge error">error</span> ${esc(error)}</div>` : ''}
<form method="post" action="/edit">
<table>
<tr><th>Title <span class="meta">(also the filename)</span></th><td><input type="text" name="title" value="${esc(title)}" required></td></tr>
<tr><th>Type</th><td><select name="type"${locked ? ' disabled' : ''}>${typeOptions}</select>${locked ? '<span class="meta"> fixed for existing pages (folder routing would orphan the old file)</span>' : ''}</td></tr>
<tr><th>Status</th><td><select name="status">${statusOptions}</select></td></tr>
<tr><th>Tags <span class="meta">(comma separated)</span></th><td><input type="text" name="tags" value="${esc(values.tags)}"></td></tr>
<tr><th>Summary <span class="meta">(index line; blank = first content line)</span></th><td><input type="text" name="summary" value="${esc(values.summary)}"></td></tr>
</table>
<p><textarea name="content" rows="22" style="width:100%" required>${esc(values.content)}</textarea></p>
<p><button type="submit">Save</button> ${title ? `<a href="/wiki/${encodeURIComponent(title)}">Cancel</a>` : '<a href="/">Cancel</a>'}
<span class="meta">saving runs the engine's bookkeeping: frontmatter completion, master/folder index, log entry${GIT_AUTO_COMMIT ? ', git commit' : ''}</span></p>
</form>`
  html(res, status, page ? `Edit ${title}` : 'New page', body)
}

function editValuesFor(page) {
  const fields = page?.fields ?? {}
  return {
    page,
    type: typeof fields.type === 'string' && fields.type in TYPE_FOLDERS ? fields.type : 'concept',
    status: PAGE_STATUSES.includes(fields.status) ? fields.status : '',
    tags: Array.isArray(fields.tags) ? fields.tags.join(', ') : '',
    summary: '',
    content: page?.content ?? '',
  }
}

async function editGet(res, rawName) {
  if (!vaultReady()) return setupPage(res)
  const name = decodeURIComponent(rawName)
  const list = await pages()
  const page = list.find((candidate) => candidate.name === name)
    ?? list.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
  if (isMachineryPage(name) && page === undefined) {
    return html(res, 400, 'Reserved', `<h1>Reserved name</h1><p><code>${esc(name)}</code> is vault machinery. <a href="/wiki/${encodeURIComponent(name)}">View it instead.</a></p>`)
  }
  const values = editValuesFor(page)
  editForm(res, { title: page?.name ?? name, values, error: undefined })
}

async function editPost(req, res) {
  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end(error.message)
  }
  const form = new URLSearchParams(raw)
  const title = (form.get('title') ?? '').trim()
  const content = form.get('content') ?? ''
  const submitted = { title, type: form.get('type') ?? '', status: form.get('status') ?? '', tags: form.get('tags') ?? '', summary: form.get('summary') ?? '', content, page: undefined }

  if (title.length === 0 || /[\\/\0]|\.\./.test(title)) {
    return editForm(res, { title, values: submitted, error: 'title is required and must not contain path separators', status: 400 })
  }
  if (content.trim().length === 0) {
    return editForm(res, { title, values: submitted, error: 'content is required', status: 400 })
  }

  const list = await pages(true)
  const existing = list.find((candidate) => candidate.name === title)
  if (existing === undefined && isMachineryPage(title)) {
    return editForm(res, { title, values: submitted, error: `"${title}" is a reserved vault-machinery name (index, log, hot, _index, lint reports)`, status: 400 })
  }
  const fields = existing?.fields ?? {}
  // A disabled type select submits nothing; an existing page keeps its type
  // (changing it would route to a new folder and orphan the old file).
  const existingType = typeof fields.type === 'string' && fields.type in TYPE_FOLDERS ? fields.type : undefined
  const type = Object.keys(TYPE_FOLDERS).includes(submitted.type) ? submitted.type : (existingType ?? 'meta')
  const status = PAGE_STATUSES.includes(submitted.status) ? submitted.status : undefined
  const tags = submitted.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
  const summary = submitted.summary.trim() || undefined

  try {
    const result = await vault.writePage({
      type, title, content,
      tags: tags.length > 0 ? tags : undefined,
      status, summary,
    })
    cache = { ts: 0, pages: [] }
    res.writeHead(303, { location: `/wiki/${encodeURIComponent(result.title)}?saved=1` })
    return res.end()
  } catch (error) {
    const message = error.message.split(VAULT).join('<vault>')
    return editForm(res, { title, values: submitted, error: message, status: 400 })
  }
}

// ---------- graph ----------

async function graphData() {
  const list = await pages()
  const names = new Set(list.map((page) => page.name))
  const aliases = buildAliasMap(list)
  const nodes = list.map((page) => ({
    id: page.name,
    folder: folderOf(page),
    type: String(page.fields?.type ?? 'untyped'),
    machinery: isMachineryPage(page.name),
    degree: 0,
  }))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set()
  const links = []
  for (const page of list) {
    for (const target of page.links) {
      const resolved = resolveLinkTarget(target, names, aliases)
      if (resolved === undefined || resolved === page.name) continue
      const key = [page.name, resolved].sort().join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ source: page.name, target: resolved })
      byId.get(page.name).degree += 1
      byId.get(resolved).degree += 1
    }
  }
  return { nodes, links }
}

function graphPage(res) {
  const body = `
<h1>Link graph</h1>
<p class="meta">Every page is a node, every resolved wikilink an edge (duplicates merged, self-links dropped). Color = folder, size = degree. Drag a node to pin it under the pointer; release to let the layout resettle. Click (without dragging) opens the page.</p>
<div class="card" style="padding:6px"><canvas id="graph" style="width:100%; height:600px; display:block"></canvas></div>
<div class="card" id="legend"></div>
<script src="/vendor/d3-dispatch.min.js"></script>
<script src="/vendor/d3-quadtree.min.js"></script>
<script src="/vendor/d3-timer.min.js"></script>
<script src="/vendor/d3-force.min.js"></script>
<script>
(async () => {
  const { nodes, links } = await (await fetch('/api/graph')).json()
  const canvas = document.getElementById('graph')
  const dpr = window.devicePixelRatio || 1
  const W = canvas.clientWidth, H = 600
  canvas.width = W * dpr; canvas.height = H * dpr
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr)

  const palette = ['#4a90d9', '#e07b39', '#2ecc71', '#9b59b6', '#e74c3c', '#f1c40f', '#1abc9c', '#8b949e', '#d63384', '#20c997']
  const folders = [...new Set(nodes.map(n => n.folder))]
  const colorOf = f => palette[folders.indexOf(f) % palette.length]
  const maxDeg = Math.max(1, ...nodes.map(n => n.degree))
  const r = n => 3 + Math.sqrt(n.degree / maxDeg) * 11

  // d3-force: the battle-tested layout engine. alpha decays automatically, so
  // the graph settles to a full stop; dragging pins the node with fx/fy and
  // reheats via alphaTarget — the canonical, deterministic drag pattern.
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(90).strength(0.4))
    .force('charge', d3.forceManyBody().strength(-280))
    .force('collide', d3.forceCollide().radius(n => r(n) + 9))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .alphaDecay(0.028)

  let hover = null
  let downAt = null        // { x, y, node, moved } while a pointer is down
  let suppressClick = false

  function hitTest(e, prefer) {
    if (prefer !== undefined && prefer !== null) return prefer
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left, y = e.clientY - rect.top
    let best = null, bestD = 1e9
    for (const n of nodes) {
      const d2 = (n.x - x) ** 2 + (n.y - y) ** 2
      if (d2 <= r(n) ** 2 + 25 && d2 < bestD) { best = n; bestD = d2 }
    }
    return best
  }

  canvas.addEventListener('mousedown', (e) => {
    const hit = hitTest(e, null)
    downAt = { x: e.clientX, y: e.clientY, node: hit, moved: false }
    if (hit !== null) {
      hit.fx = hit.x; hit.fy = hit.y
      hover = hit
      simulation.alphaTarget(0.25).restart()
    }
    canvas.style.cursor = hit !== null ? 'grabbing' : 'default'
  })
  window.addEventListener('mousemove', (e) => {
    if (downAt !== null && downAt.node !== null) {
      const rect = canvas.getBoundingClientRect()
      downAt.node.fx = e.clientX - rect.left
      downAt.node.fy = e.clientY - rect.top
      if (Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) > 6) downAt.moved = true
    } else {
      hover = hitTest(e, null)
    }
    canvas.style.cursor = (downAt !== null && downAt.node !== null) ? 'grabbing' : (hover ? 'grab' : 'default')
  })
  window.addEventListener('mouseup', () => {
    if (downAt !== null && downAt.node !== null) {
      downAt.node.fx = null; downAt.node.fy = null
      simulation.alphaTarget(0)
      suppressClick = downAt.moved
    }
    downAt = null
  })
  canvas.addEventListener('click', () => {
    if (!suppressClick && hover !== null) location.href = '/wiki/' + encodeURIComponent(hover.id)
    suppressClick = false
  })

  function draw() {
    ctx.clearRect(0, 0, W, H)
    ctx.strokeStyle = '#30363d'; ctx.lineWidth = 1
    for (const l of links) {
      ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); ctx.stroke()
    }
    const labelCut = Math.min(nodes.length, nodes.filter(n => n.degree > 1).length + 8)
    const sorted = [...nodes].sort((a, b) => b.degree - a.degree)
    for (const n of nodes) {
      ctx.beginPath()
      ctx.fillStyle = n.machinery ? '#8b949e' : colorOf(n.folder)
      ctx.arc(n.x, n.y, r(n), 0, Math.PI * 2); ctx.fill()
      if (n === hover) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke() }
    }
    ctx.fillStyle = '#c9d1d9'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'
    for (const n of sorted.slice(0, labelCut)) {
      if (r(n) > 4.5 || n === hover) ctx.fillText(n.id, n.x, n.y - r(n) - 4)
    }
    if (hover) { ctx.fillStyle = '#e6edf3'; ctx.fillText(hover.id + ' (' + hover.degree + ')', hover.x, hover.y - r(hover) - 4) }
    requestAnimationFrame(draw)
  }
  draw()

  const legend = document.getElementById('legend')
  legend.innerHTML = '<b>' + nodes.length + '</b> nodes · <b>' + links.length + '</b> edges · ' +
    folders.map(f => '<span style="color:' + colorOf(f) + '">■</span> ' + f).join(' · ') +
    ' · <span style="color:#8b949e">■</span> machinery'
})()
</script>`
  html(res, 200, 'Graph', body)
}

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
  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end(error.message)
  }
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

const MAX_BODY_BYTES = 5 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('request body too large (5 MB limit)'), { code: 'E_TOO_LARGE' }))
      req.destroy()
      return
    }
    // setEncoding makes Node reassemble multibyte UTF-8 across chunk boundaries;
    // manual Buffer→string concatenation would corrupt split characters.
    req.setEncoding('utf8')
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large (5 MB limit)'), { code: 'E_TOO_LARGE' }))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

// Cross-site request forgery: any web page can HTML-form-POST to a loopback
// server without cookies. Defense for a tokenless local tool: a browser always
// attaches Origin to cross-origin POSTs, and it cannot forge the victim's
// origin. Requests without Origin (curl, same-origin some cases) pass; when
// the server binds a loopback address the Host header is pinned too, which
// also kills DNS-rebinding.
function csrfGuard(req) {
  const host = req.headers.host ?? ''
  const origin = req.headers.origin
  const isLoopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(HOST)
  if (isLoopbackBind && host !== `${HOST}:${PORT}` && host !== `${HOST}`) {
    return `Host header mismatch (${esc(host)}) — possible DNS rebinding`
  }
  if (origin !== undefined) {
    const allowed = [`http://${host}`, `https://${host}`]
    if (!allowed.includes(origin)) {
      return `Origin ${esc(origin)} is not this server — cross-site write blocked`
    }
  }
  return null
}

// d3-force's UMD bundle reads its dependencies (dispatch/quadtree/timer)
// from the shared global d3 namespace, so all four files load in order.
const BUNDLES = {
  'd3-dispatch.min.js': readFileSync(new URL('./node_modules/d3-dispatch/dist/d3-dispatch.min.js', import.meta.url)),
  'd3-quadtree.min.js': readFileSync(new URL('./node_modules/d3-quadtree/dist/d3-quadtree.min.js', import.meta.url)),
  'd3-timer.min.js': readFileSync(new URL('./node_modules/d3-timer/dist/d3-timer.min.js', import.meta.url)),
  'd3-force.min.js': readFileSync(new URL('./node_modules/d3-force/dist/d3-force.min.js', import.meta.url)),
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname
  try {
    if (pathname.startsWith('/vendor/d3-')) {
      const name = pathname.slice('/vendor/'.length)
      const file = Object.prototype.hasOwnProperty.call(BUNDLES, name) ? BUNDLES[name] : undefined
      if (file === undefined) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      return res.end(file)
    }
    if (req.method === 'POST') {
      const csrfError = csrfGuard(req)
      if (csrfError !== null) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(csrfError)
      }
    }
    if (req.method === 'POST' && pathname === '/setup') return await scaffold(req, res)
    if (req.method === 'POST' && pathname === '/edit') return await editPost(req, res)
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
    if (pathname === '/' || pathname === '/index.html') return await dashboard(res)
    if (pathname === '/lint') return await lintPage(res)
    if (pathname === '/graph') return graphPage(res)
    if (pathname === '/api/graph') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify(await graphData()))
    }
    if (pathname === '/search') return await searchPage(res, url.searchParams.get('q'))
    if (pathname === '/new') return await editGet(res, '')
    if (pathname.startsWith('/wiki/')) {
      if (!vaultReady()) return setupPage(res)
      if (url.searchParams.get('edit') === '1') return await editGet(res, pathname.slice('/wiki/'.length))
      return await pageView(res, pathname.slice('/wiki/'.length), url.searchParams.get('saved') === '1')
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
