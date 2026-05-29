# Plan: Port the Upgrade Finder tools to PoE1 (`pob-mcp`)

This repo (`pob-mcp`, PoE1) is a sibling of `pob2-mcp` (PoE2) and shares the same
architecture: `tradeClient`, `tradeQueryBuilder`, `statMapper`,
`itemShoppingHandler`, `pobLuaBridge`, `toolRouter`, `toolSchemas`.

Two tools were built in `pob2-mcp` (see `src/handlers/upgradeFinderHandlers.ts`
there). This plan ports both to PoE1. Auth choice: **link generation only, no
live trade fetch** (zero ToS risk). Delta method: **real PoB recompute via the
Lua bridge**.

## The two tools

1. `generate_upgrade_links` — scans the loaded build's gear slots, computes each
   slot's gaps (resist / life / ES), emits a clickable `pathofexile.com/trade`
   link per slot with the query pre-filled via `?q=<url-encoded JSON>`.
2. `evaluate_trade_item` — inject a pasted item via the Lua bridge, recompute,
   report real DPS/EHP/resist delta vs the equipped item, then restore the build.

## Steps

1. **Copy the handler.**
   Copy `pob2-mcp/src/handlers/upgradeFinderHandlers.ts` →
   `pob-mcp/src/handlers/upgradeFinderHandlers.ts`. Most of it is identical.

2. **Change the trade URL host (PoE1).**
   In the copied file, change `tradeUrl()`:
   - PoE2: `https://www.pathofexile.com/trade2/search/<league>?q=...`
   - PoE1: `https://www.pathofexile.com/trade/search/<league>?q=...`  (drop the `2`)

3. **Verify PoE1 pseudo stat IDs.**
   PoE1's pseudo IDs are stable and already used by this repo's `statMapper.ts` /
   `tradeQueryBuilder.ts` (`pseudo.pseudo_total_fire_resistance`,
   `pseudo.pseudo_total_life`, `pseudo.pseudo_total_energy_shield`, etc.).
   These are CORRECT for PoE1 (they were originally PoE1 IDs). No change expected —
   unlike PoE2 where they need validation against `/api/trade2/data/stats`.

4. **Slot → category map.**
   `tradeQueryBuilder.withType()` already maps PoE1 categories
   (`armour.helmet`, `armour.chest`, `accessory.ring`, ...). The `SLOT_TO_TYPE`
   table in the handler is game-agnostic and can stay as-is.

5. **Add a Body Armour 6-link consideration (PoE1-specific).**
   PoE1 cares about links. In `generate_upgrade_links`, for `Body Armour`
   (and 6-link weapons) optionally add `builder.withLinks(6)` when the build's
   main skill needs a 6-link. PoE2 has no links, so this branch is PoE1-only.

6. **Wire into the router.**
   In `src/server/toolRouter.ts` (or this repo's equivalent dispatch):
   - add `import { handleGenerateUpgradeLinks, handleEvaluateTradeItem } from "../handlers/upgradeFinderHandlers.js";`
   - add two `case` blocks mirroring the existing `find_item_upgrades` case,
     passing `{ getLuaClient: deps.getLuaClient, ensureLuaClient: deps.ensureLuaClient }`.

7. **Register the schemas.**
   In `src/server/toolSchemas.ts` add the two tool schema objects (copy from
   `pob2-mcp`). Keep `league` required on `generate_upgrade_links` and
   `item_text` required on `evaluate_trade_item`.

8. **Build & verify.**
   `npm run build`, then check `build/server/toolSchemas.js` and
   `build/server/toolRouter.js` contain both tool names and
   `build/handlers/upgradeFinderHandlers.js` exists.

9. **Restart the MCP** so the new tools are exposed.

## Runtime prerequisite (applies to both games)

The Lua-bridge tools need a headless PoB fork + `luajit`:
- Install `luajit` (on PATH) or set `POB_CMD` to its full path.
- Clone the PoB fork that supports the stdio API (`POB_API_STDIO`) and point
  `POB_FORK_PATH` at its `src/` dir (or place it at `~/Projects/PathOfBuilding/src`).
- For PoE1 use the PoE1 PoB fork (not the PoE2 one).

Without this, `generate_upgrade_links` and `evaluate_trade_item` (and existing
Lua tools like `find_item_upgrades`, `plan_leveling`) cannot read the loaded build.

## Usage once live

1. `lua_load_build` with the PoE1 build XML.
2. `generate_upgrade_links { league: "<current PoE1 league>" }` → per-slot links.
3. Open a link, find a candidate, copy the item (Ctrl+C in game or trade copy).
4. `evaluate_trade_item { item_text: "<pasted>", slot: "Helmet" }` → DPS/EHP delta + verdict.

## Caveats carried over from PoE2 build

- Weapon slots are skipped in link generation (base type is build-dependent);
  the user searches weapons manually. A future improvement: read the equipped
  weapon's base via `getItems()` and set the weapon category accordingly.
- Resistance asks are capped at +20% per item so a single slot isn't over-constrained.
- `evaluate_trade_item` compares against whatever is currently equipped in the
  target slot and restores the build afterward via `exportBuildXml`/`loadBuildXml`.
