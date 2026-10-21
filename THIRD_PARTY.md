# Third-party software

This project's own code (including `lib/vendor/`) is MIT, see LICENSE. It installs the npm packages below; their
exact versions are pinned in `package-lock.json`, and each package ships its own license file in `node_modules/`.

## Runtime (`npm ci --omit=dev`)

| Package | Version | License |
|---|---|---|
| @discordjs/collection | 2.1.1 | Apache-2.0 |
| @discordjs/core | 2.6.0 | Apache-2.0 |
| @discordjs/rest | 2.6.3 | Apache-2.0 |
| @discordjs/util | 1.2.0 | Apache-2.0 |
| @discordjs/ws | 2.0.4 | Apache-2.0 |
| @sapphire/async-queue | 1.5.5 | MIT |
| @sapphire/snowflake | 3.5.5 | MIT |
| @types/node | 24.19.2 | MIT |
| @types/ws | 8.18.2 | MIT |
| @vladfrangu/async_event_emitter | 2.4.7 | MIT |
| discord-api-types | 0.38.57 | MIT |
| magic-bytes.js | 1.13.1 | MIT |
| tslib | 2.8.1 | 0BSD |
| undici | 6.29.1 | MIT |
| undici-types | 7.24.6 | MIT |
| ws | 8.22.0 | MIT |

## Development only (`npm ci`)

| Package | Version | License |
|---|---|---|
| typescript | 7.0.2 | Apache-2.0 |
| `@typescript/typescript-<platform>` (20 optional platform binaries, one installed) | 7.0.2 | Apache-2.0 |

Runtime and development packages under Apache-2.0 (`@discordjs/*`, `typescript`) are used unmodified; the
repository does not redistribute them.
