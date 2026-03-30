# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This repo publishes proxy/router configuration assets rather than a conventional application. It combines:

- hand-maintained client configs under `config/`
- custom rule lists under `clash/`
- a small Python generation script in `main.py`
- GitHub Actions automation that builds generated artifacts and publishes them to the `release` branch

Important context from `README.md`:

- Many config files are examples/templates and may require local edits before direct use.
- A core project goal is to avoid external subscription-conversion services by relying on client-native subscription/rule capabilities.
- `no-resolve` handling is intentional: router transparent-proxy scenarios and device-local client scenarios use different rule preferences.

## Common commands

### Local build

`main.py` uses only Python standard library modules; no Python dependency file was found.

To reproduce the GitHub Actions build locally from the repo root:

```bash
rm -rf data publish
mkdir -p data
git clone --depth 1 https://github.com/v2fly/domain-list-community temp-domain-list
mv temp-domain-list/data data/geosite
rm -rf temp-domain-list

git clone --depth 1 https://github.com/ACL4SSR/ACL4SSR temp-acl4ssr
mv temp-acl4ssr/Clash data/acl4ssr
rm -rf temp-acl4ssr
cp -rf clash data/acl4ssr/Custom

python main.py
```

Generated output is written to `publish/`.

### Run the generator only

Use this only after `data/geosite` and `data/acl4ssr` have already been prepared:

```bash
python main.py
```

### Tests

No automated test suite was found in this repo.

### Run a single test

No single-test command exists because no test framework/config was found.

### Lint / format

No repo-standard lint or formatter config was found (`pyproject.toml`, `ruff.toml`, `.flake8`, `package.json`, etc. are absent).

## Build and release model

- The main automation entrypoint is `.github/workflows/daily-build.yml`.
- CI runs daily and also on pushes that touch `clash/**` or `main.py`.
- CI clones two upstream sources at build time:
  - `v2fly/domain-list-community` → `data/geosite`
  - `ACL4SSR/ACL4SSR` → `data/acl4ssr`
- The local `clash/` directory is copied into `data/acl4ssr/Custom` before generation.
- `python main.py` generates `publish/` outputs.
- CI force-pushes the contents of `publish/` to the `release` branch.

`data/` and `publish/` are build artifacts and are ignored by git on `main`.

## High-level architecture

### Source inputs

- `clash/`: source-of-truth custom rule lists such as `CustomDirect.list`, `CustomProxy.list`, `CustomReject.list`, plus topic-specific lists.
- `config/`: end-user client configuration templates for Surge, Stash, Quantumult X, Loon, Shadowrocket, and node-filter test inputs.
- `script/`: supporting Surge scripts referenced by generated or static configs.
- `module/`: hand-authored modules/plugins.
- `blank/`: placeholder assets used when converting Quantumult X rewrites to Surge modules.
- `direct_domains` and `exclude_domains`: inputs for dnsmasq generation logic.

### Generator responsibilities in `main.py`

`main.py` is the only real code path in the repository. It performs three active generation tasks:

1. Convert ACL4SSR `.list` files into Clash/Stash provider YAML under `publish/Providers/`.
2. Split provider outputs into domain/IP-focused variants under `publish/ProvidersD/`.
3. Fetch remote rule lists and convert them into mosdns whitelist/blacklist files under `publish/mosdns/`.
4. Fetch remote Quantumult X rewrite/script configs and convert them into Surge `.sgmodule` files under `publish/sgmodule/`.

There is also dnsmasq generation logic for `publish/direct.domains.conf`, but the `gen_dnsmasq(...)` call is currently commented out in `main.py`, so it is not part of the active build path.

## How the pieces fit together

### `main` branch vs `release` branch

This split matters:

- `main` contains editable source lists, client configs, scripts, and modules.
- `release` contains generated artifacts from `publish/`.

Do not assume a file referenced by a client config is generated; many configs intentionally consume raw files from `main` directly.

### Consumer patterns by client

- `config/Stash.yaml` is tightly coupled to generated provider YAML hosted from the `release` branch.
- Other client configs under `config/` more often reference raw source files from `main` and third-party upstream rule/module URLs directly.

Because of that, edits under `config/`, `script/`, or `module/` usually affect files consumed directly from `main` and do not by themselves trigger CI rebuilds.

### Shared policy taxonomy

Client configs mirror the same routing concepts across several formats: `Proxy`, `Domestic`, `AdBlock`, media/service groups, gaming groups, and region-based selectors. This structure is manually maintained across client formats rather than generated from a single schema.

### Node test subscriptions

`config/Node/` contains intentionally invalid node subscriptions for policy-group filtering tests. They point at `test.cloudflare.com` and are not real deployable subscriptions.

## File-specific guidance

- When changing generation behavior, inspect both `main.py` and `.github/workflows/daily-build.yml` so local behavior stays aligned with CI.
- When changing `clash/` rule lists, remember they serve two roles:
  - direct raw inputs for some client configs on `main`
  - overlaid custom inputs to ACL4SSR during generation
- When changing Stash providers or related naming, verify the generated output paths still match what `config/Stash.yaml` references.
- Be cautious with `no-resolve` changes in client configs; the README documents different intended behavior for router vs device-local use.
- Treat large embedded cert/key-like blobs in config files as part of the checked-in config template unless the user specifically asks to rotate or remove them.

## Important files to read first

- `README.md`
- `main.py`
- `.github/workflows/daily-build.yml`
- `config/Stash.yaml`
- `config/Node/README.md`
