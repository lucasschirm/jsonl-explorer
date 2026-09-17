# jsonlex — JSONL Explorer CLI

Serves a local JSONL file over a loopback-only Fastify server with a
capability-protected URL, then opens [JSONL Explorer](https://jsonlexplorer.lucasschirm.com)
pointed at it. Zero runtime dependencies: the server and the explorer site
(`--local` mode) are bundled into the package.

## Install

```sh
npm install -g jsonlex
```

## Usage

```sh
jsonlex data.jsonl                  # serve + open the hosted explorer
jsonlex data.jsonl --local          # serve + open the bundled site (same origin)
jsonlex data.jsonl -p 8080 --no-open
jsonlex -- -weird.jsonl             # file names starting with a dash
```

| Option | Meaning |
| ------ | ------- |
| `-p, --port <n>` | Port to bind (default: ephemeral) |
| `-h, --host <h>` | Host to bind (default `127.0.0.1`; non-loopback requires `--local`) |
| `--no-open` | Don't open a browser |
| `--local` | Serve the bundled static site (same-origin `?url=` bootstrap) |
| `--help` / `--version` | Self-explanatory |

`--` ends option parsing (for dash-prefixed file names). Duplicate options:
the last occurrence wins. Unknown options are a typed error.

The printed `Opening:` URL contains a one-time capability in its path;
treat it as a secret (it grants read access to the file for the process
lifetime).

## Security

- Binds to loopback by default; non-loopback hosts are refused unless the
  site is served from the same server (`--local`).
- The file endpoint is reachable only with the exact capability path.
- The explorer site carries a `no-referrer` policy and the CLI server sets
  `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, and
  loopback-only CORS.

## Development (workspace)

```sh
pnpm build          # builds app, then bundles + stages the site
pnpm --filter jsonlex test:unit
```

`scripts/stage-site.mjs` copies `packages/app/.output/public` into
`packages/cli/site` (gitignored; included in the published tarball).

## License

MIT — see [LICENSE](../../LICENSE).
