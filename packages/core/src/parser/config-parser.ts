import * as path from 'node:path';
import type { FileService } from '../io/index.js';
import type {
  AgentConfig,
  SettingsFile,
  PluginsDirectory,
  InstalledPluginsFile,
  KnownMarketplacesFile,
  InstallCountsCacheFile,
  PluginCacheEntry,
  PluginManifest,
  McpConfigFile,
  MarketplaceManifest,
  StatsigDirectory,
  StatsigCachedEvaluations,
  StatsigFailedLogs,
  StatsigLastModifiedTime,
  StatsigSessionId,
  StatsigStableId,
  IdeDirectory,
  IdeLockFile,
  ShellSnapshotsDirectory,
  ShellSnapshotFile,
  CacheDirectory,
  StatusLineCommandFile,
} from '../types/index.js';

export interface ConfigParserOptions {
  allShellSnapshots?: boolean;
}

export interface ConfigParser {
  parseConfig(claudeDir: string, options?: ConfigParserOptions): AgentConfig;
  empty(): AgentConfig;
}

export class ConfigParserImpl implements ConfigParser {
  constructor(private fileService: FileService) {}

  parseConfig(claudeDir: string, options?: ConfigParserOptions): AgentConfig {
    return {
      settings: this.parseSettings(claudeDir),
      plugins: this.parsePlugins(claudeDir),
      statsig: this.parseStatsig(claudeDir),
      ide: this.parseIde(claudeDir),
      shellSnapshots: this.parseShellSnapshots(claudeDir, options?.allShellSnapshots ?? false),
      cache: this.parseCache(claudeDir),
      statusLineCommand: this.parseStatusLineCommand(claudeDir),
    };
  }

  empty(): AgentConfig {
    return {
      settings: { permissions: { allow: [] } },
      plugins: {
        installedPlugins: { version: 2, plugins: {} },
        knownMarketplaces: {},
        installCountsCache: { version: 1, fetchedAt: '', counts: [] },
        cache: [],
        marketplaces: [],
      },
      statsig: {},
      ide: { lockFiles: [] },
      shellSnapshots: { snapshots: [] },
      cache: {},
      statusLineCommand: null,
    };
  }

  private parseSettings(claudeDir: string): SettingsFile {
    return this.readJsonSafe<SettingsFile>(
      path.join(claudeDir, 'settings.json'),
      { permissions: { allow: [] } },
    );
  }

  private parsePlugins(claudeDir: string): PluginsDirectory {
    const pluginsDir = path.join(claudeDir, 'plugins');

    const installedPlugins = this.readJsonSafe<InstalledPluginsFile>(
      path.join(pluginsDir, 'installed_plugins.json'),
      { version: 2, plugins: {} },
    );
    const knownMarketplaces = this.readJsonSafe<KnownMarketplacesFile>(
      path.join(pluginsDir, 'known_marketplaces.json'),
      {},
    );
    const installCountsCache = this.readJsonSafe<InstallCountsCacheFile>(
      path.join(pluginsDir, 'install-counts-cache.json'),
      { version: 1, fetchedAt: '', counts: [] },
    );
    const cache = this.parsePluginCache(pluginsDir);
    const marketplaces = this.parseMarketplaces(pluginsDir);

    return { installedPlugins, knownMarketplaces, installCountsCache, cache, marketplaces };
  }

  private parsePluginCache(pluginsDir: string): PluginCacheEntry[] {
    const entries: PluginCacheEntry[] = [];
    const cacheDir = path.join(pluginsDir, 'cache');

    try {
      const marketplacePaths = this.fileService.scanDirectorySync(cacheDir, { includeDirectories: true });

      for (const marketplacePath of marketplacePaths) {
        try {
          const marketplace = path.basename(marketplacePath);
          const pluginPaths = this.fileService.scanDirectorySync(marketplacePath, { includeDirectories: true });

          for (const pluginPath of pluginPaths) {
            try {
              const plugin = path.basename(pluginPath);
              const versionPaths = this.fileService.scanDirectorySync(pluginPath, { includeDirectories: true });

              for (const versionPath of versionPaths) {
                try {
                  const version = path.basename(versionPath);
                  const entry: PluginCacheEntry = { marketplace, plugin, version };

                  const manifest = this.fileService.readJsonSync<PluginManifest>(
                    path.join(versionPath, '.claude-plugin', 'plugin.json'),
                  );
                  if (manifest) entry.manifest = manifest;

                  const mcpConfig = this.fileService.readJsonSync<McpConfigFile>(
                    path.join(versionPath, '.mcp.json'),
                  );
                  if (mcpConfig) entry.mcpConfig = mcpConfig;

                  try {
                    const orphanedContent = this.fileService.readFileSync(path.join(versionPath, '.orphaned_at'));
                    const ts = parseInt(orphanedContent.trim(), 10);
                    if (!isNaN(ts)) entry.orphanedAt = ts;
                  } catch { /* optional */ }

                  entries.push(entry);
                } catch { /* skip bad version dir */ }
              }
            } catch { /* skip bad plugin dir */ }
          }
        } catch { /* skip bad marketplace dir */ }
      }
    } catch {
      // cache dir doesn't exist
    }

    return entries;
  }

  private parseMarketplaces(pluginsDir: string): MarketplaceManifest[] {
    const manifests: MarketplaceManifest[] = [];
    const marketplacesDir = path.join(pluginsDir, 'marketplaces');

    try {
      const dirPaths = this.fileService.scanDirectorySync(marketplacesDir, { includeDirectories: true });

      for (const dirPath of dirPaths) {
        const manifest = this.fileService.readJsonSync<MarketplaceManifest>(
          path.join(dirPath, '.claude-plugin', 'marketplace.json'),
        );
        if (manifest) manifests.push(manifest);
      }
    } catch {
      // marketplaces dir doesn't exist
    }

    return manifests;
  }

  private parseStatsig(claudeDir: string): StatsigDirectory {
    const statsigDir = path.join(claudeDir, 'statsig');
    const result: StatsigDirectory = {};

    try {
      const filePaths = this.fileService.scanDirectorySync(statsigDir);

      for (const filePath of filePaths) {
        const fileName = path.basename(filePath);

        try {
          if (fileName.startsWith('statsig.cached.evaluations.')) {
            result.cachedEvaluations = this.fileService.readJsonSync<StatsigCachedEvaluations>(filePath) ?? undefined;
          } else if (fileName.startsWith('statsig.failed_logs.')) {
            result.failedLogs = this.fileService.readJsonSync<StatsigFailedLogs>(filePath) ?? undefined;
          } else if (fileName === 'statsig.last_modified_time.evaluations') {
            result.lastModifiedTime = this.fileService.readJsonSync<StatsigLastModifiedTime>(filePath) ?? undefined;
          } else if (fileName.startsWith('statsig.session_id.')) {
            result.sessionId = this.fileService.readJsonSync<StatsigSessionId>(filePath) ?? undefined;
          } else if (fileName.startsWith('statsig.stable_id.')) {
            result.stableId = this.fileService.readJsonSync<StatsigStableId>(filePath) ?? undefined;
          }
        } catch { /* skip bad statsig file */ }
      }
    } catch {
      // statsig dir doesn't exist
    }

    return result;
  }

  private parseIde(claudeDir: string): IdeDirectory {
    try {
      const ideDir = path.join(claudeDir, 'ide');
      const filePaths = this.fileService.scanDirectorySync(ideDir, { pattern: '*.lock' });

      const lockFiles: IdeLockFile[] = [];
      for (const filePath of filePaths) {
        const lockFile = this.fileService.readJsonSync<IdeLockFile>(filePath);
        if (lockFile) lockFiles.push(lockFile);
      }

      return { lockFiles };
    } catch {
      return { lockFiles: [] };
    }
  }

  private parseShellSnapshots(claudeDir: string, all: boolean): ShellSnapshotsDirectory {
    try {
      const snapshotsDir = path.join(claudeDir, 'shell-snapshots');
      const filePaths = this.fileService.scanDirectorySync(snapshotsDir, { pattern: 'snapshot-*.sh' });

      if (!all) {
        const latest = this.findLatestSnapshot(filePaths);
        if (!latest) return { snapshots: [] };
        return { snapshots: [latest] };
      }

      const snapshots: ShellSnapshotFile[] = [];
      for (const filePath of filePaths) {
        const snapshot = this.parseSnapshotFile(filePath);
        if (snapshot) snapshots.push(snapshot);
      }

      return { snapshots };
    } catch {
      return { snapshots: [] };
    }
  }

  private findLatestSnapshot(filePaths: string[]): ShellSnapshotFile | null {
    let latestPath: string | null = null;
    let latestTimestamp = -1;

    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      const match = fileName.match(/^snapshot-\w+-(\d+)-\w+\.sh$/);
      if (!match) continue;
      const ts = parseInt(match[1], 10);
      if (ts > latestTimestamp) {
        latestTimestamp = ts;
        latestPath = filePath;
      }
    }

    return latestPath ? this.parseSnapshotFile(latestPath) : null;
  }

  private parseSnapshotFile(filePath: string): ShellSnapshotFile | null {
    try {
      const fileName = path.basename(filePath);
      const match = fileName.match(/^snapshot-(\w+)-(\d+)-(\w+)\.sh$/);
      if (!match) return null;

      const content = this.fileService.readFileSync(filePath);
      const stats = this.fileService.getStats(filePath);

      return {
        shell: match[1],
        timestamp: parseInt(match[2], 10),
        hash: match[3],
        fileName,
        content,
        size: stats?.size ?? 0,
      };
    } catch {
      return null;
    }
  }

  private parseCache(claudeDir: string): CacheDirectory {
    const result: CacheDirectory = {};

    try {
      const changelogPath = path.join(claudeDir, 'cache', 'changelog.md');
      const content = this.fileService.readFileSync(changelogPath);
      const stats = this.fileService.getStats(changelogPath);
      result.changelog = { content, size: stats?.size ?? 0 };
    } catch {
      // no changelog
    }

    return result;
  }

  private parseStatusLineCommand(claudeDir: string): StatusLineCommandFile | null {
    try {
      const filePath = path.join(claudeDir, 'statusline-command.sh');
      const content = this.fileService.readFileSync(filePath);
      const stats = this.fileService.getStats(filePath);
      return { content, size: stats?.size ?? 0 };
    } catch {
      return null;
    }
  }

  private readJsonSafe<T>(filePath: string, fallback: T): T {
    try {
      return this.fileService.readJsonSync<T>(filePath) ?? fallback;
    } catch {
      return fallback;
    }
  }
}

export function createConfigParser(fileService: FileService): ConfigParser {
  return new ConfigParserImpl(fileService);
}
