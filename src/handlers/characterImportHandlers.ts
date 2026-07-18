import { wrapHandler } from '../utils/errorHandling.js';

/**
 * Reads a PoE character or stash tab via GGG's public, unauthenticated
 * character-window endpoints. These only return data when the target
 * account has enabled "Public" profile / stash visibility
 * (pathofexile.com/my-account/privacy) — there is no session/credential
 * involved on our end, and this file must never accept or forward a
 * POESESSID or any other cookie. If the account is private, GGG returns
 * an empty/error payload and we surface that plainly rather than guessing.
 */

const UA = { 'User-Agent': 'pob-mcp-character-import/1.0 (contact: local tool)' };

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: UA });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GGG API returned HTTP ${res.status} for ${url}. Response: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `GGG API did not return JSON (likely a login page, meaning the profile/stash is not public). ` +
      `Response started with: ${text.slice(0, 200)}`
    );
  }
}

function sumResistMods(mods: string[] = []): { fire: number; cold: number; lightning: number; chaos: number } {
  const out = { fire: 0, cold: 0, lightning: 0, chaos: 0 };
  for (const m of mods) {
    const lower = m.toLowerCase();
    const match = m.match(/([+-]?\d+)%/);
    const val = match ? parseInt(match[1], 10) : 0;
    if (!val) continue;
    const isAll = lower.includes('all elemental resistances') || lower.includes('to all resistances');
    if (isAll || lower.includes('fire resistance')) out.fire += val;
    if (isAll || lower.includes('cold resistance')) out.cold += val;
    if (isAll || lower.includes('lightning resistance')) out.lightning += val;
    if (lower.includes('chaos resistance')) out.chaos += val;
  }
  return out;
}

export async function handleImportCharacter(args: { account: string; character: string; realm?: string }) {
  return wrapHandler('import character', async () => {
    const { account, character, realm = 'pc' } = args;
    const base = 'https://www.pathofexile.com/character-window/get-items';
    const url = `${base}?accountName=${encodeURIComponent(account)}&character=${encodeURIComponent(character)}&realm=${encodeURIComponent(realm)}`;

    let data: any;
    try {
      data = await fetchJson(url);
    } catch (err: any) {
      return {
        content: [{
          type: 'text' as const,
          text:
            `Could not fetch character "${character}" on account "${account}".\n\n` +
            `${err.message}\n\n` +
            `This requires the account's profile to be set to PUBLIC at ` +
            `https://www.pathofexile.com/my-account/privacy — specifically the ` +
            `"Character tab" / profile visibility option. This tool never uses a ` +
            `session cookie, so it can only see what a logged-out visitor to your ` +
            `profile page could see. If the profile is public and this still fails, ` +
            `double-check the account name (it's Name#1234 format, not display name) ` +
            `and the exact character name (case-sensitive).`,
        }],
      };
    }

    if (!data.items) {
      return {
        content: [{
          type: 'text' as const,
          text: `GGG returned a response but no "items" field — the character may not exist, ` +
                `or the profile is private. Raw keys returned: ${Object.keys(data).join(', ') || '(none)'}`,
        }],
      };
    }

    const items: any[] = data.items;
    let totalRes = { fire: 0, cold: 0, lightning: 0, chaos: 0 };
    let life = 0, es = 0;

    let out = `=== Imported Character: ${character} (${account}) ===\n\n`;
    out += `NOTE: this is a raw summary from GGG's public API, not a full PoB import — `;
    out += `mod parsing here is best-effort text matching, not PoB's real calculator. `;
    out += `Use it to sanity-check gaps quickly; cross-check anything critical in PoB itself.\n\n`;

    out += `Level: ${data.character?.level ?? '?'}  Class: ${data.character?.class ?? '?'}  League: ${data.character?.league ?? '?'}\n\n`;
    out += `--- Equipped Items ---\n`;
    for (const item of items) {
      if (item.inventoryId && !['Weapon', 'Weapon2', 'Offhand', 'Offhand2', 'Helm', 'BodyArmour', 'Gloves', 'Boots', 'Belt', 'Amulet', 'Ring', 'Ring2', 'Flask'].includes(item.inventoryId)) {
        continue; // skip non-equipped inventory items (skill gems in belt/etc show up here too)
      }
      const mods: string[] = [...(item.explicitMods || []), ...(item.implicitMods || []), ...(item.craftedMods || [])];
      const res = sumResistMods(mods);
      totalRes.fire += res.fire; totalRes.cold += res.cold; totalRes.lightning += res.lightning; totalRes.chaos += res.chaos;

      const lifeMod = mods.find(m => /maximum life/i.test(m));
      const esMod = mods.find(m => /maximum energy shield/i.test(m));
      if (lifeMod) { const m = lifeMod.match(/(\d+)/); if (m) life += parseInt(m[1], 10); }
      if (esMod) { const m = esMod.match(/(\d+)/); if (m) es += parseInt(m[1], 10); }

      out += `\n${item.inventoryId}: ${item.name ? item.name + ' ' : ''}${item.typeLine}`;
      if (item.corrupted) out += ' (Corrupted)';
      out += `\n`;
      if (mods.length > 0) out += `  ${mods.join(' | ')}\n`;
    }

    out += `\n--- Rough Totals (sum of explicit/implicit/crafted mod text matches only) ---\n`;
    out += `Life: +${life}  ES: +${es}\n`;
    out += `Resist mods found: Fire +${totalRes.fire}%  Cold +${totalRes.cold}%  Lightning +${totalRes.lightning}%  Chaos +${totalRes.chaos}%\n`;
    out += `(These are gear-mod sums only — does NOT include tree/ascendancy/base resist cap, so compare against in-game character sheet, not as an absolute.)\n`;

    return { content: [{ type: 'text' as const, text: out }] };
  });
}

export async function handleImportStashTab(args: { account: string; league: string; tab_index?: number; tab_name?: string; realm?: string }) {
  return wrapHandler('import stash tab', async () => {
    const { account, league, tab_index, tab_name, realm = 'pc' } = args;
    const base = 'https://www.pathofexile.com/character-window/get-stash-items';

    // First call without tabIndex to list tabs, if we need to resolve tab_name -> index
    let resolvedIndex = tab_index;
    if (resolvedIndex === undefined && tab_name) {
      const listUrl = `${base}?accountName=${encodeURIComponent(account)}&league=${encodeURIComponent(league)}&tabs=1&realm=${encodeURIComponent(realm)}`;
      let listData: any;
      try {
        listData = await fetchJson(listUrl);
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: publicProfileError(err, account) }] };
      }
      const tabs: any[] = listData.tabs || [];
      const match = tabs.find(t => t.n?.toLowerCase() === tab_name.toLowerCase());
      if (!match) {
        const names = tabs.map(t => `${t.i}: ${t.n}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `No public tab named "${tab_name}" found. Public tabs on this account:\n${names || '(none — profile/stash may not be public)'}`,
          }],
        };
      }
      resolvedIndex = match.i;
    }
    if (resolvedIndex === undefined) resolvedIndex = 0;

    const url = `${base}?accountName=${encodeURIComponent(account)}&league=${encodeURIComponent(league)}&tabIndex=${resolvedIndex}&tabs=0&realm=${encodeURIComponent(realm)}`;
    let data: any;
    try {
      data = await fetchJson(url);
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: publicProfileError(err, account) }] };
    }

    const items: any[] = data.items || [];
    if (items.length === 0) {
      return { content: [{ type: 'text' as const, text: `Tab ${resolvedIndex} returned no items — either it's empty, not public, or the index/name is wrong.` }] };
    }

    // Currency/stackable items (typeLine repeats, no unique mods) vs regular items
    const stacks = new Map<string, number>();
    const regular: any[] = [];
    for (const item of items) {
      if (item.stackSize && item.stackSize > 0 && (!item.explicitMods || item.explicitMods.length === 0)) {
        const key = item.typeLine;
        stacks.set(key, (stacks.get(key) || 0) + item.stackSize);
      } else {
        regular.push(item);
      }
    }

    let out = `=== Stash Tab ${resolvedIndex}${tab_name ? ` ("${tab_name}")` : ''} (${account}, ${league}) ===\n\n`;
    out += `NOTE: raw GGG data, not price-checked here — use get_currency_rates or search_trade_items to value anything.\n\n`;

    if (stacks.size > 0) {
      out += `--- Currency / Stackables (${stacks.size} types) ---\n`;
      const sorted = [...stacks.entries()].sort((a, b) => b[1] - a[1]);
      for (const [name, count] of sorted) out += `  ${count.toLocaleString()}x ${name}\n`;
      out += `\n`;
    }

    if (regular.length > 0) {
      out += `--- Items (${regular.length}) ---\n`;
      for (const item of regular.slice(0, 60)) {
        out += `  ${item.name ? item.name + ' — ' : ''}${item.typeLine}${item.corrupted ? ' (Corrupted)' : ''}\n`;
      }
      if (regular.length > 60) out += `  ... and ${regular.length - 60} more (truncated)\n`;
    }

    return { content: [{ type: 'text' as const, text: out }] };
  });
}

function publicProfileError(err: any, account: string): string {
  return `Could not read stash for "${account}".\n\n${err.message}\n\n` +
    `This needs TWO things enabled on the account, both under ` +
    `https://www.pathofexile.com/my-account/privacy:\n` +
    `  1. The account-level privacy toggle that allows public profile/stash viewing.\n` +
    `  2. Each individual stash tab you want visible must ALSO have its own ` +
    `"Public" flag set (right-click the tab in-game, or the tab settings icon).\n\n` +
    `This tool never uses a session cookie/POESESSID — it only sees what a ` +
    `logged-out visitor to your public profile could see.`;
}
