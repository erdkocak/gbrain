/**
 * `gbrain cache` \u2014 manage the semantic query cache (v0.32.x search-lite).
 *
 * Subcommands:
 *   gbrain cache stats   \u2014 print row/hit counts and freshness breakdown.
 *   gbrain cache clear   \u2014 wipe cache rows.
 *   gbrain cache prune   \u2014 delete only stale (past-TTL) rows.
 *
 * Read-only by default. `clear` requires `--yes` to avoid accidents.
 *
 * No DB writes outside the cache table.
 */

import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { SemanticQueryCache, loadCacheConfig, secureCompanyCacheSourceIds } from '../core/search/query-cache.ts';

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`
gbrain cache \u2014 manage the semantic query cache (v0.32.x search-lite)

Usage:
  gbrain cache stats        Print cache row counts, hit counts, freshness.
  gbrain cache clear        Wipe cache rows. Requires --yes.
  gbrain cache prune        Delete only stale (past-TTL) rows.

Flags:
  --yes                     Bypass clear confirmation prompt.
  --source <id>             Scope clear to a single source_id.
  --include-company-secure  Include protected company source rows.
  --help                    Show this help.
`);
}

export async function runCache(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (!config) {
    // eslint-disable-next-line no-console
    console.error('gbrain cache: no brain configured. Run `gbrain init` first.');
    process.exit(1);
  }
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);

  try {
    const cacheCfg = await loadCacheConfig(engine);
    const cache = new SemanticQueryCache(engine, cacheCfg);
    const includeCompanySecure = args.includes('--include-company-secure');
    const sourceIdx = args.indexOf('--source');
    const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
    const excludedSourceIds = includeCompanySecure ? [] : await secureCompanyCacheSourceIds(engine);
    if (sourceId && excludedSourceIds.includes(sourceId)) {
      // eslint-disable-next-line no-console
      console.error('gbrain cache: protected company source rows require --include-company-secure from a trusted local operator.');
      process.exit(1);
    }
    const managementScope = sourceId
      ? { sourceId }
      : excludedSourceIds.length > 0
        ? { excludeSourceIds: excludedSourceIds }
        : {};

    if (sub === 'stats') {
      const stats = await cache.stats(managementScope);
      // eslint-disable-next-line no-console
      console.log('Semantic Query Cache stats');
      // eslint-disable-next-line no-console
      console.log('--------------------------');
      // eslint-disable-next-line no-console
      console.log(`enabled                : ${cacheCfg.enabled ?? true}`);
      // eslint-disable-next-line no-console
      console.log(`similarity_threshold   : ${cacheCfg.similarityThreshold ?? 0.92}`);
      // eslint-disable-next-line no-console
      console.log(`ttl_seconds            : ${cacheCfg.ttlSeconds ?? 3600}`);
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(`total rows             : ${stats.total_rows}`);
      // eslint-disable-next-line no-console
      console.log(`  fresh                : ${stats.fresh_rows}`);
      // eslint-disable-next-line no-console
      console.log(`  stale                : ${stats.stale_rows}`);
      // eslint-disable-next-line no-console
      console.log(`total hits             : ${stats.total_hits}`);
      return;
    }

    if (sub === 'clear') {
      const yes = args.includes('--yes') || args.includes('-y');
      if (!yes) {
        // eslint-disable-next-line no-console
        console.error('gbrain cache clear: refusing to wipe without --yes flag.');
        process.exit(1);
      }
      const n = await cache.clear(managementScope);
      // eslint-disable-next-line no-console
      console.log(`Cleared ${n} cache row(s)${sourceId ? ` (source=${sourceId})` : ''}.`);
      return;
    }

    if (sub === 'prune') {
      const n = await cache.prune(managementScope);
      // eslint-disable-next-line no-console
      console.log(`Pruned ${n} stale cache row(s).`);
      return;
    }

    // eslint-disable-next-line no-console
    console.error(`gbrain cache: unknown subcommand "${sub}". See \`gbrain cache --help\`.`);
    process.exit(1);
  } finally {
    try { await engine.disconnect(); } catch { /* ignore */ }
  }
}
