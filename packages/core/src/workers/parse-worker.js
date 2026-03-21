var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// packages/core/src/workers/parse-worker.ts
import { parentPort } from "node:worker_threads";

// packages/core/src/io/file-service.ts
import { EventEmitter } from "events";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  statSync as statSync2,
  mkdirSync,
  readdirSync,
  watch as fsWatch
} from "fs";
import { readFile, writeFile, appendFile, unlink } from "fs/promises";
import { dirname, join } from "path";
import chokidar from "chokidar";

// packages/core/src/io/streaming-jsonl-reader.ts
import { openSync, readSync, closeSync, statSync } from "fs";
var BUFFER_SIZE = 65536;
function readJsonlStreaming(filePath, callback, options) {
  const result = {
    totalLines: 0,
    processedLines: 0,
    finalBytePosition: 0,
    errorCount: 0
  };
  let fileSize;
  try {
    const stats = statSync(filePath);
    fileSize = stats.size;
  } catch {
    return result;
  }
  const startPosition = options?.fromBytePosition ?? 0;
  if (startPosition >= fileSize) {
    result.finalBytePosition = startPosition;
    return result;
  }
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return result;
  }
  try {
    const buffer = Buffer.alloc(BUFFER_SIZE);
    let fileOffset = startPosition;
    let lineIndex = 0;
    let leftoverBuf = null;
    while (fileOffset < fileSize) {
      const bytesToRead = Math.min(BUFFER_SIZE, fileSize - fileOffset);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, fileOffset);
      if (bytesRead === 0) break;
      let workBuf;
      let leftoverLen;
      if (leftoverBuf && leftoverBuf.length > 0) {
        leftoverLen = leftoverBuf.length;
        workBuf = Buffer.concat([leftoverBuf, buffer.subarray(0, bytesRead)]);
      } else {
        leftoverLen = 0;
        workBuf = buffer.subarray(0, bytesRead);
      }
      const workBufFileStart = fileOffset - leftoverLen;
      fileOffset += bytesRead;
      let scanFrom = 0;
      while (scanFrom < workBuf.length) {
        const newlinePos = workBuf.indexOf(10, scanFrom);
        if (newlinePos === -1) {
          leftoverBuf = Buffer.from(workBuf.subarray(scanFrom));
          scanFrom = workBuf.length;
        } else {
          const lineBytes = workBuf.subarray(scanFrom, newlinePos);
          const lineStr = lineBytes.toString("utf-8").trim();
          const lineByteOffset = workBufFileStart + scanFrom;
          if (lineStr.length > 0) {
            result.totalLines++;
            try {
              const entry = JSON.parse(lineStr);
              callback(entry, lineIndex, lineByteOffset);
              result.processedLines++;
            } catch (error) {
              result.errorCount++;
              options?.onError?.(
                lineIndex,
                error instanceof Error ? error.message : String(error)
              );
            }
            lineIndex++;
          }
          scanFrom = newlinePos + 1;
          leftoverBuf = null;
        }
      }
    }
    if (leftoverBuf && leftoverBuf.length > 0) {
      const finalStr = leftoverBuf.toString("utf-8").trim();
      if (finalStr.length > 0) {
        result.totalLines++;
        const lineByteOffset = fileOffset - leftoverBuf.length;
        try {
          const entry = JSON.parse(finalStr);
          callback(entry, lineIndex, lineByteOffset);
          result.processedLines++;
        } catch (error) {
          result.errorCount++;
          options?.onError?.(
            lineIndex,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }
    result.finalBytePosition = fileOffset;
  } finally {
    closeSync(fd);
  }
  return result;
}

// packages/core/src/io/file-service.ts
var FileServiceImpl = class extends EventEmitter {
  directoryWatchers = /* @__PURE__ */ new Map();
  fileWatchers = /* @__PURE__ */ new Map();
  watchDirectory(id, options) {
    if (this.directoryWatchers.has(id) || this.fileWatchers.has(id)) {
      this.unwatch(id);
    }
    const watcher = chokidar.watch(options.patterns, {
      persistent: true,
      ignoreInitial: options.ignoreInitial ?? true,
      awaitWriteFinish: options.awaitWriteFinish === true ? { stabilityThreshold: 300, pollInterval: 100 } : options.awaitWriteFinish === false ? false : options.awaitWriteFinish ?? { stabilityThreshold: 300, pollInterval: 100 },
      depth: options.depth
    });
    watcher.on("add", (path2, stats) => this.emitChange(id, "add", path2, stats));
    watcher.on("change", (path2, stats) => this.emitChange(id, "change", path2, stats));
    watcher.on("unlink", (path2) => this.emitChange(id, "unlink", path2));
    watcher.on("error", (error) => this.emit("error", { watcherId: id, error }));
    watcher.on("ready", () => this.emit("ready", { watcherId: id }));
    this.directoryWatchers.set(id, watcher);
  }
  watchFile(id, path2, options) {
    if (this.directoryWatchers.has(id) || this.fileWatchers.has(id)) {
      this.unwatch(id);
    }
    try {
      const watcher = fsWatch(path2, { persistent: options?.persistent ?? true }, (eventType) => {
        if (eventType === "change") {
          const stats = this.getStats(path2);
          this.emitChange(id, "change", path2, stats ?? void 0);
        }
      });
      watcher.on("error", (error) => this.emit("error", { watcherId: id, path: path2, error }));
      this.fileWatchers.set(id, watcher);
    } catch (error) {
      this.emit("error", { watcherId: id, path: path2, error });
    }
  }
  unwatch(id) {
    const dirWatcher = this.directoryWatchers.get(id);
    if (dirWatcher) {
      dirWatcher.close();
      this.directoryWatchers.delete(id);
    }
    const fileWatcher = this.fileWatchers.get(id);
    if (fileWatcher) {
      fileWatcher.close();
      this.fileWatchers.delete(id);
    }
  }
  unwatchAll() {
    for (const [id] of this.directoryWatchers) {
      this.unwatch(id);
    }
    for (const [id] of this.fileWatchers) {
      this.unwatch(id);
    }
  }
  getActiveWatchers() {
    return [...this.directoryWatchers.keys(), ...this.fileWatchers.keys()];
  }
  emitChange(watcherId, event, path2, stats) {
    let fileStats;
    if (stats) {
      const isDir = typeof stats.isDirectory === "function" ? stats.isDirectory() : stats.isDirectory;
      fileStats = {
        size: stats.size,
        mtimeMs: "mtimeMs" in stats ? stats.mtimeMs : stats.mtime?.getTime() ?? 0,
        isDirectory: isDir
      };
    }
    const change = { watcherId, event, path: path2, stats: fileStats };
    this.emit("change", change);
  }
  async readFile(path2, options) {
    return readFile(path2, options?.encoding ?? "utf-8");
  }
  readFileSync(path2, options) {
    return readFileSync(path2, options?.encoding ?? "utf-8");
  }
  async readJson(path2) {
    try {
      if (!this.exists(path2)) return null;
      const content = await this.readFile(path2);
      return JSON.parse(content);
    } catch (error) {
      this.emit("error", { path: path2, error });
      return null;
    }
  }
  readJsonSync(path2) {
    try {
      if (!this.exists(path2)) return null;
      const content = this.readFileSync(path2);
      return JSON.parse(content);
    } catch (error) {
      this.emit("error", { path: path2, error });
      return null;
    }
  }
  async readJsonl(path2) {
    return this.readJsonlSync(path2);
  }
  readJsonlSync(path2) {
    const result = { entries: [], errors: [], totalLines: 0 };
    if (!this.exists(path2)) return result;
    try {
      const content = this.readFileSync(path2);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        result.totalLines++;
        try {
          result.entries.push(JSON.parse(line));
        } catch (error) {
          result.errors.push({
            line: i + 1,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      this.emit("error", { path: path2, error });
    }
    return result;
  }
  readFirstLine(path2, maxBytes = 8192) {
    if (!this.exists(path2)) return null;
    try {
      const fd = __require("fs").openSync(path2, "r");
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = __require("fs").readSync(fd, buffer, 0, maxBytes, 0);
      __require("fs").closeSync(fd);
      const content = buffer.subarray(0, bytesRead).toString("utf-8");
      const newlineIndex = content.indexOf("\n");
      return newlineIndex !== -1 ? content.substring(0, newlineIndex) : content;
    } catch (error) {
      this.emit("error", { path: path2, error });
      return null;
    }
  }
  readBytes(path2, options) {
    const fd = __require("fs").openSync(path2, "r");
    const buffer = Buffer.alloc(options.length);
    __require("fs").readSync(fd, buffer, 0, options.length, options.start);
    __require("fs").closeSync(fd);
    return buffer;
  }
  readLastBytes(path2, bytes) {
    const stats = this.getStats(path2);
    if (!stats) return Buffer.alloc(0);
    const start = Math.max(0, stats.size - bytes);
    const length = Math.min(bytes, stats.size);
    return this.readBytes(path2, { start, length });
  }
  readJsonlIncremental(path2, fromPosition) {
    const result = { entries: [], newPosition: fromPosition, errors: [] };
    const stats = this.getStats(path2);
    if (!stats || stats.size <= fromPosition) return result;
    try {
      const bytesToRead = stats.size - fromPosition;
      const buffer = this.readBytes(path2, { start: fromPosition, length: bytesToRead });
      const content = buffer.toString("utf-8");
      const lines = content.split("\n");
      let processedBytes = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        processedBytes += Buffer.byteLength(line, "utf-8") + 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (i === lines.length - 1 && !content.endsWith("\n")) {
          processedBytes -= Buffer.byteLength(line, "utf-8") + 1;
          break;
        }
        try {
          result.entries.push(JSON.parse(trimmed));
        } catch (error) {
          result.errors.push({
            line: i,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      result.newPosition = fromPosition + processedBytes;
    } catch (error) {
      this.emit("error", { path: path2, error });
    }
    return result;
  }
  readJsonlStreaming(path2, callback, options) {
    return readJsonlStreaming(path2, callback, options);
  }
  async writeFile(path2, content) {
    await this.ensureDir(dirname(path2));
    await writeFile(path2, content);
  }
  writeFileSync(path2, content) {
    this.ensureDirSync(dirname(path2));
    writeFileSync(path2, content);
  }
  async writeJson(path2, data) {
    await this.writeFile(path2, JSON.stringify(data, null, 2));
  }
  writeJsonSync(path2, data) {
    this.writeFileSync(path2, JSON.stringify(data, null, 2));
  }
  async appendFile(path2, content) {
    await this.ensureDir(dirname(path2));
    await appendFile(path2, content);
  }
  appendFileSync(path2, content) {
    this.ensureDirSync(dirname(path2));
    appendFileSync(path2, content);
  }
  async appendJsonl(path2, entry) {
    await this.appendFile(path2, JSON.stringify(entry) + "\n");
  }
  async ensureDir(path2) {
    if (!existsSync(path2)) {
      mkdirSync(path2, { recursive: true });
    }
  }
  ensureDirSync(path2) {
    if (!existsSync(path2)) {
      mkdirSync(path2, { recursive: true });
    }
  }
  async scanDirectory(path2, options) {
    return this.scanDirectorySync(path2, options);
  }
  scanDirectorySync(path2, options, currentDepth = 0) {
    if (!this.exists(path2)) return [];
    if (options?.maxDepth !== void 0 && currentDepth > options.maxDepth) {
      return [];
    }
    const entries = readdirSync(path2, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      const fullPath = join(path2, entry.name);
      if (entry.isDirectory()) {
        if (options?.includeDirectories) {
          if (!options.pattern || this.matchPattern(entry.name, options.pattern)) {
            results.push(fullPath);
          }
        }
        if (options?.recursive) {
          results.push(...this.scanDirectorySync(fullPath, options, currentDepth + 1));
        }
      } else {
        if (!options?.pattern || this.matchPattern(entry.name, options.pattern)) {
          results.push(fullPath);
        }
      }
    }
    return results;
  }
  matchPattern(filename, pattern) {
    const braceMatch = pattern.match(/\{([^}]+)\}/);
    if (braceMatch) {
      const alternatives = braceMatch[1].split(",");
      return alternatives.some((alt) => {
        const expandedPattern = pattern.replace(braceMatch[0], alt);
        return this.matchPattern(filename, expandedPattern);
      });
    }
    let regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "___STAR___").replace(/\\\?/g, "___QUESTION___").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/___STAR___/g, "\\*").replace(/___QUESTION___/g, "\\?");
    regex = `^${regex}$`;
    try {
      return new RegExp(regex).test(filename);
    } catch {
      return filename === pattern;
    }
  }
  exists(path2) {
    return existsSync(path2);
  }
  getStats(path2) {
    try {
      const stats = statSync2(path2);
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isDirectory: stats.isDirectory()
      };
    } catch {
      return null;
    }
  }
  getFileSize(path2) {
    const stats = this.getStats(path2);
    return stats?.size ?? null;
  }
  async deleteFile(path2) {
    if (this.exists(path2)) {
      await unlink(path2);
    }
  }
  async cleanupOldFiles(directory, options) {
    const files = await this.scanDirectory(directory, { pattern: options.pattern });
    if (files.length === 0) return 0;
    const fileInfos = files.map((f) => ({ path: f, stats: this.getStats(f) })).filter((f) => f.stats !== null).sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    let deleted = 0;
    const now = Date.now();
    const maxAgeMs = options.maxAgeDays ? options.maxAgeDays * 24 * 60 * 60 * 1e3 : null;
    for (let i = 0; i < fileInfos.length; i++) {
      const file = fileInfos[i];
      let shouldDelete = false;
      if (options.maxFiles !== void 0 && i >= options.maxFiles) {
        shouldDelete = true;
      }
      if (maxAgeMs && file.stats && now - file.stats.mtimeMs > maxAgeMs) {
        shouldDelete = true;
      }
      if (shouldDelete) {
        await this.deleteFile(file.path);
        deleted++;
      }
    }
    return deleted;
  }
};
function createFileService() {
  return new FileServiceImpl();
}

// packages/core/src/parser/project-parser.ts
import * as path from "node:path";
var ProjectParserImpl = class {
  constructor(fileService2) {
    this.fileService = fileService2;
  }
  parseAllProjects(claudeDir, options) {
    const projectsDir = path.join(claudeDir, "projects");
    const projects = [];
    const planIndex = this.buildPlanIndex(claudeDir);
    try {
      const projectPaths = this.fileService.scanDirectorySync(projectsDir, {
        includeDirectories: true
      });
      for (const projectPath of projectPaths) {
        try {
          const slug = path.basename(projectPath);
          const project = this.parseProjectInternal(claudeDir, slug, options, planIndex);
          if (project) projects.push(project);
        } catch {
        }
      }
    } catch {
    }
    return projects;
  }
  parseAllProjectsStreaming(claudeDir, sink, options) {
    const projectsDir = path.join(claudeDir, "projects");
    const planIndex = this.buildPlanIndex(claudeDir);
    for (const [planSlug, plan] of planIndex) {
      sink.onPlan(planSlug, plan);
    }
    try {
      const projectPaths = this.fileService.scanDirectorySync(projectsDir, {
        includeDirectories: true
      });
      for (const projectPath of projectPaths) {
        try {
          const slug = path.basename(projectPath);
          this.parseProjectStreamingInternal(claudeDir, slug, sink, options, planIndex);
        } catch {
        }
      }
    } catch {
    }
  }
  parseProjectStreaming(claudeDir, slug, sink, options) {
    const planIndex = this.buildPlanIndex(claudeDir);
    for (const [planSlug, plan] of planIndex) {
      sink.onPlan(planSlug, plan);
    }
    this.parseProjectStreamingInternal(claudeDir, slug, sink, options, planIndex);
  }
  parseProjectStreamingInternal(claudeDir, slug, sink, options, planIndex) {
    const projectDir = path.join(claudeDir, "projects", slug);
    const sessionsIndex = this.parseSessionsIndex(projectDir);
    const originalPath = sessionsIndex.originalPath ?? this.slugToPath(slug);
    const skipMessages = options?.skipSessionMessages ?? false;
    sink.onProject(slug, originalPath, sessionsIndex);
    const memory = this.parseProjectMemory(slug, projectDir);
    if (memory) {
      sink.onProjectMemory(slug, memory.content);
    }
    for (const entry of sessionsIndex.entries) {
      try {
        const sessionId = entry.sessionId;
        sink.onSession(slug, entry);
        if (!skipMessages) {
          const canonicalPath = path.join(projectDir, `${sessionId}.jsonl`);
          const filePath = this.fileService.exists(canonicalPath) ? canonicalPath : entry.fullPath && this.fileService.exists(entry.fullPath) ? entry.fullPath : canonicalPath;
          let messageCount = 0;
          let lastBytePosition = 0;
          try {
            const streamResult = this.fileService.readJsonlStreaming(
              filePath,
              (message, index, byteOffset) => {
                sink.onMessage(slug, sessionId, message, index, byteOffset);
                messageCount++;
                lastBytePosition = byteOffset;
              }
            );
            lastBytePosition = streamResult.finalBytePosition;
          } catch {
          }
          const subagents = this.parseSubagents(projectDir, sessionId);
          for (const subagent of subagents) {
            sink.onSubagent(slug, sessionId, subagent);
          }
          const toolResults = this.parseToolResults(projectDir, sessionId);
          for (const toolResult of toolResults) {
            sink.onToolResult(slug, sessionId, toolResult);
          }
          sink.onSessionComplete(slug, sessionId, messageCount, lastBytePosition);
        } else {
          sink.onSessionComplete(slug, sessionId, 0, 0);
        }
        const fileHistory = this.parseFileHistory(claudeDir, sessionId);
        if (fileHistory) {
          sink.onFileHistory(sessionId, fileHistory);
        }
        const todos = this.parseTodos(claudeDir, sessionId);
        for (const todo of todos) {
          sink.onTodo(sessionId, todo);
        }
        const task = this.parseTask(claudeDir, sessionId);
        if (task) {
          sink.onTask(sessionId, task);
        }
      } catch {
      }
    }
    sink.onProjectComplete(slug);
  }
  parseProject(claudeDir, slug, options) {
    const planIndex = this.buildPlanIndex(claudeDir);
    return this.parseProjectInternal(claudeDir, slug, options, planIndex);
  }
  parseProjectInternal(claudeDir, slug, options, planIndex) {
    const projectDir = path.join(claudeDir, "projects", slug);
    const sessionsIndex = this.parseSessionsIndex(projectDir);
    const originalPath = sessionsIndex.originalPath ?? this.slugToPath(slug);
    const sessions = [];
    for (const entry of sessionsIndex.entries) {
      try {
        const session = this.buildSession(claudeDir, projectDir, slug, entry, options, planIndex);
        sessions.push(session);
      } catch {
      }
    }
    const memory = this.parseProjectMemory(slug, projectDir);
    return { slug, originalPath, sessionsIndex, sessions, memory };
  }
  parseSession(claudeDir, slug, sessionId) {
    const projectDir = path.join(claudeDir, "projects", slug);
    const sessionsIndex = this.parseSessionsIndex(projectDir);
    const entry = sessionsIndex.entries.find((e) => e.sessionId === sessionId);
    if (!entry) return null;
    const planIndex = this.buildPlanIndex(claudeDir);
    try {
      return this.buildSession(claudeDir, projectDir, slug, entry, void 0, planIndex);
    } catch {
      return null;
    }
  }
  buildSession(claudeDir, projectDir, slug, entry, options, planIndex) {
    const sessionId = entry.sessionId;
    const skipMessages = options?.skipSessionMessages ?? false;
    const messages = skipMessages ? [] : this.parseSessionMessages(projectDir, sessionId, entry.fullPath);
    const planSlug = messages.length > 0 ? this.extractPlanSlugFromMessages(messages, planIndex) : this.peekPlanSlug(projectDir, sessionId, planIndex);
    return {
      sessionId,
      indexEntry: entry,
      messages,
      subagents: skipMessages ? [] : this.parseSubagents(projectDir, sessionId),
      toolResults: skipMessages ? [] : this.parseToolResults(projectDir, sessionId),
      fileHistory: this.parseFileHistory(claudeDir, sessionId),
      todos: this.parseTodos(claudeDir, sessionId),
      task: this.parseTask(claudeDir, sessionId),
      plan: planSlug ? planIndex.get(planSlug) ?? null : null
    };
  }
  parseSessionsIndex(projectDir) {
    try {
      const index = this.fileService.readJsonSync(
        path.join(projectDir, "sessions-index.json")
      );
      if (index && index.entries.length > 0) {
        const merged = this.mergeWithDiscoveredEntries(
          index.entries,
          projectDir,
          index.originalPath
        );
        return { ...index, entries: merged };
      }
      if (index?.originalPath) {
        return { ...index, entries: this.discoverSessionEntries(projectDir, index.originalPath) };
      }
    } catch {
    }
    return {
      version: 1,
      entries: this.discoverSessionEntries(projectDir, void 0)
    };
  }
  /**
   * Merge entries from sessions-index.json with JSONL files discovered on
   * disk.  Any on-disk JSONL file whose session ID is NOT already in the
   * index gets a freshly-built entry appended.  This handles the common case
   * where the index is stale (e.g. after a Claude upgrade or migration).
   */
  mergeWithDiscoveredEntries(indexEntries, projectDir, originalPath) {
    const indexedIds = new Set(indexEntries.map((e) => e.sessionId));
    const discovered = this.discoverSessionEntries(projectDir, originalPath);
    const extra = discovered.filter((e) => !indexedIds.has(e.sessionId));
    if (extra.length === 0) return indexEntries;
    return [...indexEntries, ...extra];
  }
  discoverSessionEntries(projectDir, originalPath) {
    const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
    const entries = [];
    let filePaths;
    try {
      filePaths = this.fileService.scanDirectorySync(projectDir, { pattern: "*.jsonl" });
    } catch {
      return entries;
    }
    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      if (!UUID_JSONL.test(fileName)) continue;
      const sessionId = fileName.replace(".jsonl", "");
      const stats = this.fileService.getStats(filePath);
      if (!stats) continue;
      let firstPrompt = "";
      try {
        const result = this.fileService.readJsonlSync(filePath);
        for (const msg of result.entries) {
          const message = msg.message;
          if (message?.role === "user") {
            const content = message.content;
            if (typeof content === "string") {
              firstPrompt = content.slice(0, 200);
            } else if (Array.isArray(content)) {
              for (const block of content) {
                const b = block;
                if (b.type === "text" && typeof b.text === "string") {
                  firstPrompt = b.text.slice(0, 200);
                  break;
                }
              }
            }
            break;
          }
        }
      } catch {
      }
      const modifiedIso = new Date(stats.mtimeMs).toISOString();
      entries.push({
        sessionId,
        fullPath: filePath,
        fileMtime: stats.mtimeMs,
        firstPrompt: firstPrompt || "No prompt",
        summary: "",
        messageCount: 0,
        created: modifiedIso,
        modified: modifiedIso,
        gitBranch: "",
        projectPath: originalPath ?? this.slugToPath(path.basename(projectDir)),
        isSidechain: false
      });
    }
    return entries;
  }
  parseSessionMessages(projectDir, sessionId, fullPath) {
    try {
      const canonicalPath = path.join(projectDir, `${sessionId}.jsonl`);
      const filePath = this.fileService.exists(canonicalPath) ? canonicalPath : fullPath && this.fileService.exists(fullPath) ? fullPath : canonicalPath;
      const result = this.fileService.readJsonlSync(filePath);
      return result.entries;
    } catch {
      return [];
    }
  }
  parseSubagents(projectDir, sessionId) {
    const subagentsDir = path.join(projectDir, sessionId, "subagents");
    const transcripts = [];
    try {
      const filePaths = this.fileService.scanDirectorySync(subagentsDir, { pattern: "*.jsonl" });
      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const agentId = this.extractAgentId(fileName);
          const agentType = this.inferAgentType(fileName);
          const result = this.fileService.readJsonlSync(filePath);
          transcripts.push({ agentId, agentType, fileName, messages: result.entries });
        } catch {
        }
      }
    } catch {
    }
    return transcripts;
  }
  extractAgentId(fileName) {
    const match = fileName.match(/^agent-(a.+)\.jsonl$/);
    return match ? match[1] : fileName.replace(/\.jsonl$/, "");
  }
  inferAgentType(fileName) {
    if (fileName.includes("prompt_suggestion")) return "prompt_suggestion";
    if (fileName.includes("compact")) return "compact";
    return "task";
  }
  parseToolResults(projectDir, sessionId) {
    const resultsDir = path.join(projectDir, sessionId, "tool-results");
    const results = [];
    try {
      const filePaths = this.fileService.scanDirectorySync(resultsDir, { pattern: "*.txt" });
      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const toolUseId = fileName.replace(/\.txt$/, "");
          const content = this.fileService.readFileSync(filePath);
          results.push({ toolUseId, content });
        } catch {
        }
      }
    } catch {
    }
    return results;
  }
  parseProjectMemory(projectSlug, projectDir) {
    try {
      const content = this.fileService.readFileSync(
        path.join(projectDir, "memory", "MEMORY.md")
      );
      return { projectSlug, content };
    } catch {
      return null;
    }
  }
  parseFileHistory(claudeDir, sessionId) {
    const historyDir = path.join(claudeDir, "file-history", sessionId);
    try {
      const filePaths = this.fileService.scanDirectorySync(historyDir);
      if (filePaths.length === 0) return null;
      const snapshots = [];
      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const match = fileName.match(/^([0-9a-f]+)@v(\d+)$/);
          if (!match) continue;
          const content = this.fileService.readFileSync(filePath);
          const stats = this.fileService.getStats(filePath);
          snapshots.push({
            hash: match[1],
            version: parseInt(match[2], 10),
            fileName,
            content,
            size: stats?.size ?? 0
          });
        } catch {
        }
      }
      return snapshots.length > 0 ? { sessionId, snapshots } : null;
    } catch {
      return null;
    }
  }
  parseTodos(claudeDir, sessionId) {
    const todosDir = path.join(claudeDir, "todos");
    const todoFiles = [];
    try {
      const filePaths = this.fileService.scanDirectorySync(todosDir, {
        pattern: `${sessionId}-agent-*.json`
      });
      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const match = fileName.match(/^(.+?)-agent-(.+)\.json$/);
          if (!match) continue;
          const items = this.fileService.readJsonSync(filePath) ?? [];
          todoFiles.push({
            sessionId: match[1],
            agentId: match[2],
            items: Array.isArray(items) ? items : []
          });
        } catch {
        }
      }
    } catch {
    }
    return todoFiles;
  }
  parseTask(claudeDir, sessionId) {
    const taskDir = path.join(claudeDir, "tasks", sessionId);
    try {
      const lockExists = this.fileService.exists(path.join(taskDir, ".lock"));
      if (!lockExists) return null;
      let hasHighwatermark = false;
      let highwatermark = null;
      try {
        const hwContent = this.fileService.readFileSync(path.join(taskDir, ".highwatermark"));
        hasHighwatermark = true;
        highwatermark = parseInt(hwContent.trim(), 10);
        if (isNaN(highwatermark)) highwatermark = null;
      } catch {
      }
      return { taskId: sessionId, hasHighwatermark, highwatermark, lockExists: true };
    } catch {
      return null;
    }
  }
  buildPlanIndex(claudeDir) {
    const index = /* @__PURE__ */ new Map();
    const plansDir = path.join(claudeDir, "plans");
    try {
      const filePaths = this.fileService.scanDirectorySync(plansDir, { pattern: "*.md" });
      for (const filePath of filePaths) {
        try {
          const fileName = path.basename(filePath);
          const planSlug = fileName.replace(/\.md$/, "");
          const content = this.fileService.readFileSync(filePath);
          const stats = this.fileService.getStats(filePath);
          const titleMatch = content.match(/^#\s+(.+)$/m);
          const title = titleMatch ? titleMatch[1] : planSlug;
          index.set(planSlug, { slug: planSlug, title, content, size: stats?.size ?? 0 });
        } catch {
        }
      }
    } catch {
    }
    return index;
  }
  extractPlanSlugFromMessages(messages, planIndex) {
    for (const msg of messages) {
      const raw = msg;
      const slug = raw.slug;
      if (typeof slug === "string" && planIndex.has(slug)) {
        return slug;
      }
    }
    return null;
  }
  peekPlanSlug(projectDir, sessionId, planIndex) {
    if (planIndex.size === 0) return null;
    try {
      const filePath = path.join(projectDir, `${sessionId}.jsonl`);
      const content = this.fileService.readFileSync(filePath);
      const slugPattern = /"slug"\s*:\s*"([^"]+)"/;
      const match = content.match(slugPattern);
      if (match) {
        const candidate = match[1];
        if (planIndex.has(candidate)) return candidate;
      }
    } catch {
    }
    return null;
  }
  slugToPath(slug) {
    const naive = slug.replace(/^-/, "/").replace(/-/g, "/");
    const parts = slug.replace(/^-/, "").split("-");
    if (parts.length === 0) return naive;
    let resolved = "";
    let i = 0;
    while (i < parts.length) {
      let matched = false;
      for (let end = parts.length; end > i; end--) {
        const candidate = "/" + parts.slice(i, end).join("-");
        const fullCandidate = resolved + candidate;
        const stats = this.fileService.getStats(fullCandidate);
        if (stats) {
          resolved = fullCandidate;
          i = end;
          matched = true;
          break;
        }
      }
      if (!matched) {
        resolved += "/" + parts[i];
        i++;
      }
    }
    return resolved || naive;
  }
};
function createProjectParser(fileService2) {
  return new ProjectParserImpl(fileService2);
}

// packages/core/src/workers/parse-worker.ts
if (!parentPort) {
  throw new Error("parse-worker must be run as a worker thread");
}
var fileService = createFileService();
var parser = createProjectParser(fileService);
var port = parentPort;
port.on("message", (msg) => {
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  if (msg.type === "parse-project") {
    const startTime = Date.now();
    const { claudeDir, slug } = msg;
    try {
      let messageBatch = [];
      let batchStartIndex = 0;
      let batchByteOffsets = [];
      let currentSlug = "";
      let currentSessionId = "";
      const flushBatch = () => {
        if (messageBatch.length > 0) {
          port.postMessage({
            type: "message-batch",
            slug: currentSlug,
            sessionId: currentSessionId,
            messages: messageBatch,
            startIndex: batchStartIndex,
            byteOffsets: batchByteOffsets
          });
          messageBatch = [];
          batchByteOffsets = [];
        }
      };
      const sink = {
        onProject(slug2, originalPath, sessionsIndex) {
          port.postMessage({
            type: "project-result",
            slug: slug2,
            originalPath,
            sessionsIndexJson: JSON.stringify(sessionsIndex)
          });
        },
        onProjectMemory(slug2, content) {
          port.postMessage({ type: "project-memory", slug: slug2, content });
        },
        onSession(slug2, entry) {
          port.postMessage({
            type: "session-result",
            slug: slug2,
            sessionId: entry.sessionId,
            indexEntryJson: JSON.stringify(entry)
          });
        },
        onMessage(slug2, sessionId, message, index, byteOffset) {
          if (currentSessionId !== sessionId) {
            flushBatch();
            currentSlug = slug2;
            currentSessionId = sessionId;
            batchStartIndex = index;
          }
          messageBatch.push(JSON.stringify(message));
          batchByteOffsets.push(byteOffset);
          if (messageBatch.length >= 150) {
            flushBatch();
            batchStartIndex = index + 1;
          }
        },
        onSubagent(slug2, sessionId, transcript) {
          flushBatch();
          port.postMessage({
            type: "subagent-result",
            slug: slug2,
            sessionId,
            agentId: transcript.agentId,
            agentType: transcript.agentType,
            fileName: transcript.fileName,
            messagesJson: JSON.stringify(transcript.messages),
            messageCount: transcript.messages.length
          });
        },
        onToolResult(slug2, sessionId, toolResult) {
          port.postMessage({
            type: "tool-result",
            slug: slug2,
            sessionId,
            toolUseId: toolResult.toolUseId,
            content: toolResult.content
          });
        },
        onFileHistory(sessionId, history) {
          port.postMessage({
            type: "file-history",
            sessionId,
            dataJson: JSON.stringify(history)
          });
        },
        onTodo(sessionId, todo) {
          port.postMessage({
            type: "todo-result",
            sessionId,
            agentId: todo.agentId,
            itemsJson: JSON.stringify(todo.items)
          });
        },
        onTask(sessionId, task) {
          port.postMessage({
            type: "task-result",
            sessionId,
            taskJson: JSON.stringify(task)
          });
        },
        onPlan(slug2, plan) {
          port.postMessage({
            type: "plan-result",
            slug: slug2,
            title: plan.title,
            content: plan.content,
            size: plan.size
          });
        },
        onSessionComplete(slug2, sessionId, messageCount, lastBytePosition) {
          flushBatch();
          port.postMessage({
            type: "session-complete",
            slug: slug2,
            sessionId,
            messageCount,
            lastBytePosition
          });
        },
        onProjectComplete(slug2) {
          flushBatch();
          port.postMessage({
            type: "project-complete",
            slug: slug2,
            durationMs: Date.now() - startTime
          });
        }
      };
      parser.parseProjectStreaming(claudeDir, slug, sink);
    } catch (err) {
      port.postMessage({
        type: "worker-error",
        slug,
        error: String(err)
      });
    }
  }
});
