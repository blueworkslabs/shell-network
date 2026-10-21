#!/usr/bin/env node
// Kept for the existing unit: the generic bridge (bin/bridge.ts) for Gem.
process.env.BRIDGE_BOT ??= "gem";
await import("./bridge.ts");
