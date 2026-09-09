# wiki-web

A self-hosted web UI for your Markdown wiki vault: browse pages with resolved wikilinks, BM25 full-text search, backlinks, and a live lint dashboard. **No Obsidian, no database, no build step** — the vault stays a plain Markdown directory you own, fully compatible with Obsidian and any other Markdown tool. Use it entirely standalone, or let an AI agent manage the vault for you.

Powered by the [dsh-plugin-wiki-tools](https://github.com/Lion-1209/dsh-plugin-wiki-tools) engine — the same battle-tested vault, bookkeeping, search, and health-check core the dsh agent tools use. The engine is a plain ESM library with zero framework dependencies, so the web UI works fully standalone.

## Quick start

```sh
npx @lion1209/wiki-web --vault /path/to/your/vault
```

or clone and run:

```sh
git clone https://github.com/Lion-1209/wiki-web
cd wiki-web && npm install
node server.js --vault /path/to/your/vault --port 3210
```

A vault is a directory holding `wiki/` (Markdown pages) and `.raw/` (sources). Don't have one? Open the server in a browser and click **Scaffold vault here** — it creates the folder structure, seed pages, and index/log files for you.

## What you get

| Page | What it shows |
| --- | --- |
| Dashboard | page/link/type counts, `hot.md` recent context, `index.md` master catalog, recent activity from `log.md` |
| `/wiki/<Title>` | rendered page with clickable wikilinks (aliases resolved), frontmatter table, outbound links (dead ones flagged), backlinks |
| `/search?q=…` | BM25 full-text ranking with snippets, inbound/outbound counts |
| `/lint` | live health check: dead links, orphan pages, frontmatter gaps, empty sections, stale index and hot cache — every issue with a suggested fix |

Read-only by design: the vault is your source of truth, and the AI does the writing through the agent tools.

## Pairing with an agent

The web UI is the human half. For AI management, point any supported agent at the same vault — it writes through the same engine, so the bookkeeping (indexes, log, frontmatter) stays consistent no matter who writes.

**DeepSeek Harness (dsh)** — first-class plugins:

```sh
dsh plugin --profile web add dsh-plugin-wiki-tools
# then set vaultPath in the profile's cordis.patch.yml to the same directory
```

Chat in dsh: *"把这篇文章收进知识库"* — pages, cross-references, indexes, and the log update automatically; refresh this web UI to see the result.

**Any MCP-capable agent** — on the roadmap (see below); the same vault tools will be exposed over MCP so Claude Desktop, Cursor, and friends can manage the vault too.

## Roadmap

- [ ] Graph visualization (force-directed link map)
- [ ] In-browser editing via `wiki_write` (bookkeeping included for free)
- [ ] MCP server mode — let any MCP-capable agent manage the same vault (planned next)
- [ ] Docker one-liner
- [ ] Multi-vault support

## How it works

`dsh-plugin-wiki-tools` ships the vault engine as plain ESM (`lib/vault.js`, `lib/search.js`, `lib/lint.js`, `lib/scaffold.js`): path routing, frontmatter completion, BM25 with link-graph context, bookkeeping writes, source delta tracking, and health checks — all operating on a Markdown directory with cross-process advisory locks. This server is a thin `node:http` layer rendering that engine: no database, no build step, one dependency (`marked`) besides the engine itself.

## License

[MIT](LICENSE)
