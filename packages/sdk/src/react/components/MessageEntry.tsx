import React from 'react';
import { MetaRow } from './MetaRow.js';
import { Badge } from './Badge.js';
import { formatTokenCount, formatDuration } from '../utils/formatters.js';

type AnyMsg = Record<string, any>;

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  messageCount: number;
}

export interface MessageContext {
  toolResultMap: Map<string, { content: string; isError: boolean }>;
  subagentMap: Map<string, SubagentInfo>;
}

export function buildMessageContext(messages: AnyMsg[], subagents: SubagentInfo[]): MessageContext {
  const toolResultMap = new Map<string, { content: string; isError: boolean }>();
  for (const msg of messages) {
    if (msg.type !== 'user') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        toolResultMap.set(block.tool_use_id, {
          content: String(block.content ?? ''),
          isError: block.is_error === true,
        });
      }
    }
  }

  const taskToolUseIds: string[] = [];
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use' && String(block.name).toLowerCase() === 'task') {
        taskToolUseIds.push(String(block.id));
      }
    }
  }

  const taskSubagents = subagents.filter((s) => s.agentType === 'task');
  const subagentMap = new Map<string, SubagentInfo>();
  for (let i = 0; i < Math.min(taskToolUseIds.length, taskSubagents.length); i++) {
    subagentMap.set(taskToolUseIds[i], taskSubagents[i]);
  }

  return { toolResultMap, subagentMap };
}

export function isToolResultOnlyMessage(msg: AnyMsg): boolean {
  if (msg.type !== 'user') return false;
  const content = msg.message?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b: AnyMsg) => b?.type === 'tool_result');
}

export function MessageEntry({
  msg,
  ctx,
  expandedToolResults,
  onExpandToolResult,
  expandedSubagentId,
  subagentMessages,
  loadingSubagent,
  subagentHasMore,
  onExpandSubagent,
  onLoadMoreSubagent,
}: {
  msg: AnyMsg;
  ctx: MessageContext;
  expandedToolResults: Record<string, string>;
  onExpandToolResult: (toolUseId: string) => void;
  expandedSubagentId: string | null;
  subagentMessages: AnyMsg[];
  loadingSubagent: boolean;
  subagentHasMore: boolean;
  onExpandSubagent: (agentId: string) => void;
  onLoadMoreSubagent: () => void;
}) {
  const msgType = String(msg.type ?? '');
  const timeStr = msg.timestamp ? String(msg.timestamp).slice(11, 19) : '';

  if (msgType === 'user') {
    const content = msg.message?.content;
    let textContent = '';
    const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];

    if (typeof content === 'string') {
      textContent = content;
    } else if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content) {
        if (block?.type === 'text') textParts.push(String(block.text ?? ''));
        else if (block?.type === 'tool_result') toolResults.push(block);
      }
      textContent = textParts.join('\n\n');
    }

    return (
      <div className="border-l-2 border-l-green-500 bg-green-500/[0.04] px-3 py-2 mb-0.5">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-bold text-green-400 uppercase tracking-wider">User</span>
          {msg.agentId && <Badge text={`agent: ${msg.agentId}`} color="green-500/20 text-green-300" />}
          {msg.isMeta && <Badge text="meta" color="yellow-500/20 text-yellow-300" />}
          {msg.isCompactSummary && <Badge text="compact-summary" color="cyan-500/20 text-cyan-300" />}
          <span className="text-[10px] text-white/20 ml-auto">{timeStr}</span>
        </div>
        <MetaRow
          items={[
            ['uuid', msg.uuid?.slice(0, 12)],
            ['parent', msg.parentUuid?.slice(0, 12)],
            ['cwd', msg.cwd],
            ['v', msg.version],
            ['branch', msg.gitBranch || undefined],
          ]}
        />
        {textContent && <div className="text-xs text-white/80 whitespace-pre-wrap break-words mt-1">{textContent}</div>}
        {toolResults.map((tr, i) => (
          <div
            key={i}
            className={`mt-1 border-l-2 ${tr.is_error ? 'border-l-red-500 bg-red-500/[0.04]' : 'border-l-purple-400 bg-purple-500/[0.02]'} px-2 py-1`}
          >
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-purple-300">tool_result</span>
              <span className="text-[9px] font-mono text-white/20">{tr.tool_use_id}</span>
              {tr.is_error && <Badge text="error" color="red-500/20 text-red-300" />}
            </div>
            <pre className="text-[10px] text-white/50 whitespace-pre-wrap break-words font-mono mt-0.5">
              {tr.content}
            </pre>
          </div>
        ))}
      </div>
    );
  }

  if (msgType === 'assistant') {
    const payload = msg.message;
    const blocks: AnyMsg[] = Array.isArray(payload?.content) ? payload.content : [];
    const model = String(payload?.model ?? '');
    const usage = payload?.usage;
    const stopReason = payload?.stop_reason;

    return (
      <div className="border-l-2 border-l-blue-500 bg-blue-500/[0.04] px-3 py-2 mb-0.5">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Assistant</span>
          {model && <span className="text-[10px] text-white/25 font-mono">{model}</span>}
          {stopReason && <Badge text={`stop: ${stopReason}`} color="blue-500/15 text-blue-300/60" />}
          <span className="text-[10px] text-white/20 ml-auto">{timeStr}</span>
        </div>
        <MetaRow
          items={[
            ['uuid', msg.uuid?.slice(0, 12)],
            ['parent', msg.parentUuid?.slice(0, 12)],
            ['requestId', msg.requestId?.slice(0, 16)],
          ]}
        />
        {blocks.map((block, bi) => {
          if (!block) return null;
          if (block.type === 'thinking') {
            return (
              <div key={bi} className="mt-1.5 border-l-2 border-l-amber-500 bg-amber-500/[0.04] px-2 py-1.5">
                <span className="text-[9px] font-bold text-amber-400 uppercase tracking-wider">Thinking</span>
                <div className="text-xs text-white/50 whitespace-pre-wrap break-words italic mt-0.5">
                  {block.thinking}
                </div>
              </div>
            );
          }
          if (block.type === 'text') {
            return (
              <div key={bi} className="text-xs text-white/70 whitespace-pre-wrap break-words mt-1.5">
                {block.text}
              </div>
            );
          }
          if (block.type === 'tool_use') {
            const toolUseId = String(block.id ?? '');
            const toolName = String(block.name ?? '');
            const inputStr = block.input ? JSON.stringify(block.input, null, 2) : '';
            const pairedResult = ctx.toolResultMap.get(toolUseId);
            const persistedResult = expandedToolResults[toolUseId];
            const subagent = ctx.subagentMap.get(toolUseId);
            const isTask = toolName.toLowerCase() === 'task';

            return (
              <div key={bi} className="mt-1.5 border-l-2 border-l-purple-500 bg-purple-500/[0.03]">
                <div className="px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">Tool</span>
                    <span className="text-[11px] text-purple-300 font-mono font-semibold">{toolName}</span>
                    <span className="text-[9px] text-white/20 font-mono">{toolUseId}</span>
                    {toolUseId && (
                      <button
                        className="text-[10px] text-white/30 hover:text-white/60 cursor-pointer underline ml-1"
                        onClick={() => onExpandToolResult(toolUseId)}
                      >
                        {persistedResult ? 'hide full' : 'full result'}
                      </button>
                    )}
                  </div>
                  {inputStr && inputStr !== '{}' && (
                    <pre className="text-[10px] text-white/40 bg-white/[0.03] rounded p-1.5 mt-1 overflow-x-auto whitespace-pre-wrap font-mono">
                      {inputStr}
                    </pre>
                  )}
                </div>
                {pairedResult && pairedResult.content && (
                  <div
                    className={`px-2 py-1.5 border-t border-purple-500/10 ${pairedResult.isError ? 'bg-red-500/[0.04]' : 'bg-purple-500/[0.02]'}`}
                  >
                    <span
                      className={`text-[10px] font-semibold ${pairedResult.isError ? 'text-red-400' : 'text-purple-300'}`}
                    >
                      Result
                    </span>
                    <pre className="text-[10px] text-white/50 whitespace-pre-wrap break-words font-mono mt-0.5">
                      {pairedResult.content}
                    </pre>
                  </div>
                )}
                {persistedResult && (
                  <div className="px-2 py-1.5 border-t border-purple-500/10 bg-white/[0.02]">
                    <span className="text-[10px] text-white/30">Full persisted result:</span>
                    <pre className="text-[10px] text-white/50 whitespace-pre-wrap break-words font-mono mt-0.5">
                      {persistedResult}
                    </pre>
                  </div>
                )}
                {isTask && subagent && (
                  <div className="border-t border-indigo-500/20">
                    <button
                      onClick={() => onExpandSubagent(subagent.agentId)}
                      className="w-full text-left px-2 py-1.5 flex items-center gap-2 hover:bg-indigo-500/10 cursor-pointer"
                    >
                      <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-wider">Subagent</span>
                      <span className="text-[10px] font-mono text-indigo-300">{subagent.agentId.slice(0, 10)}</span>
                      <Badge text={subagent.agentType} color="indigo-500/20 text-indigo-300" />
                      <span className="text-[10px] text-white/40">{subagent.messageCount} msgs</span>
                    </button>
                    {expandedSubagentId === subagent.agentId && (
                      <div className="ml-3 border-l-2 border-indigo-500/30 bg-indigo-500/[0.02]">
                        {subagentMessages.map((sm, j) => (
                          <div key={j} className="ml-1">
                            <MessageEntry
                              msg={sm}
                              ctx={{ toolResultMap: new Map(), subagentMap: new Map() }}
                              expandedToolResults={{}}
                              onExpandToolResult={() => {}}
                              expandedSubagentId={null}
                              subagentMessages={[]}
                              loadingSubagent={false}
                              subagentHasMore={false}
                              onExpandSubagent={() => {}}
                              onLoadMoreSubagent={() => {}}
                            />
                          </div>
                        ))}
                        {loadingSubagent && <div className="px-2 py-1 text-[10px] text-white/30">Loading...</div>}
                        {subagentHasMore && !loadingSubagent && (
                          <button
                            onClick={onLoadMoreSubagent}
                            className="w-full py-1 text-[10px] text-indigo-300/60 hover:text-indigo-300 hover:bg-indigo-500/10 cursor-pointer"
                          >
                            Load more subagent messages
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          }
          return null;
        })}
        {usage && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 text-[9px] text-white/25 font-mono border-t border-blue-500/10 pt-1">
            <span>in: {formatTokenCount(usage.input_tokens)}</span>
            <span>out: {formatTokenCount(usage.output_tokens)}</span>
            {usage.cache_read_input_tokens > 0 && (
              <span>cache_read: {formatTokenCount(usage.cache_read_input_tokens)}</span>
            )}
            {usage.cache_creation_input_tokens > 0 && (
              <span>cache_create: {formatTokenCount(usage.cache_creation_input_tokens)}</span>
            )}
          </div>
        )}
      </div>
    );
  }

  if (msgType === 'summary') {
    return (
      <div className="border-l-2 border-l-cyan-500 bg-cyan-500/[0.04] px-3 py-2 mb-0.5">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">Summary</span>
          <span className="text-[10px] text-white/20 ml-auto">{timeStr}</span>
        </div>
        <div className="text-xs text-white/60 whitespace-pre-wrap break-words">{msg.summary}</div>
      </div>
    );
  }

  if (msgType === 'system') {
    const subtype = String(msg.subtype ?? '');
    return (
      <div className="border-l-2 border-l-gray-500 bg-white/[0.02] px-3 py-1.5 mb-0.5">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">System</span>
          <Badge text={subtype || 'generic'} color="white/10 text-white/40" />
          <span className="text-[10px] text-white/20 ml-auto">{timeStr}</span>
        </div>
        {subtype === 'turn_duration' && (
          <div className="text-[10px] text-white/40 mt-0.5">
            Duration: <span className="text-white/60 font-mono">{formatDuration(msg.durationMs ?? 0)}</span>
          </div>
        )}
        {subtype === 'compact_boundary' && msg.content && (
          <div className="text-[10px] text-white/40 mt-0.5">{msg.content}</div>
        )}
      </div>
    );
  }

  // Fallback for progress, file-history-snapshot, saved_hook_context, queue-operation, unknown
  return (
    <div className="border-l-2 border-l-gray-600 bg-white/[0.02] px-3 py-1.5 mb-0.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-white/30">{msgType || 'unknown'}</span>
        <span className="text-[10px] text-white/20 ml-auto">{timeStr}</span>
      </div>
    </div>
  );
}
