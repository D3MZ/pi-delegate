import { Type } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { pointerIndex, resolvePointer } from './pointer.mjs';
import { completionText, startWorker } from './runner.mjs';

export default function (pi: ExtensionAPI) {
  // Inherited by native child processes: never register this tool or delegation policy there.
  if (process.env.PI_DELEGATE_CHILD === '1') return;

  let enabled = true;
  let shuttingDown = false;
  const running = new Map<string, Awaited<ReturnType<typeof startWorker>>>();
  const starting = new Set<ReturnType<typeof startWorker>>();

  pi.on('session_start', (_event, ctx) => {
    shuttingDown = false;
    enabled = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'pi-delegate-mode') {
        enabled = (entry.data as { enabled: boolean }).enabled;
      }
    }
  });

  // Refresh on every model request, including queued follow-ups. Context-only metadata
  // avoids copying task text or appending an index to the persisted conversation.
  pi.on('context', (event, ctx) => {
    if (!enabled) return;
    return { messages: [...event.messages, {
      role: 'custom' as const, customType: 'pi-delegate-pointers', display: false,
      content: 'Delegation pointer index (real JSONL entry IDs, not model-generated conversation IDs). ' +
        'For the current request use delegate({}); only use messageId for an earlier request. ' +
        'For older entries beyond this index, inspect sessionFile. No task text is included.\n' +
        JSON.stringify(pointerIndex(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getBranch())),
      timestamp: Date.now(),
    }] };
  });

  pi.on('before_agent_start', () => ({
    message: {
      customType: 'pi-delegate-policy', display: false,
      content: (enabled
        ? 'Delegation mode is ON. For user requests to execute work, invoke delegate with no task text. ' +
          'For the current request call delegate({}) without messageId. Use real log IDs from the pointer index, never model-generated conversation IDs, for earlier requests. ' +
          'Use optional start/end for separate portions. ' +
          'Discuss questions and review feedback here; do not spawn for conversation alone. ' +
          'After launching, yield and remain available. Do not poll, wait, monitor workers, or duplicate their work. ' +
          'Use completion notifications. Delegate follow-up execution only when the user requests it. ' +
          'Multiple calls share the working directory; do not assign overlapping edits. Never auto-redelegate a completion notification.'
        : 'Delegation mode is OFF. Work directly; do not invoke delegate or substitute another delegation tool.') +
        ' A pi-delegate-result callback contains only process status and a child session log pointer. ' +
        'That log contains the source task pointer and work. Read its final response for the result or blocker. ' +
        'Finished does not mean verified success. Never automatically delegate a callback.',
    },
  }));

  pi.registerCommand('delegation', {
    description: 'Delegation on|off|status, or cancel <worker-id|all>',
    handler: async (args, ctx) => {
      const [action = 'status', id] = args.trim().split(/\s+/).filter(Boolean);
      if (action === 'on' || action === 'off') {
        enabled = action === 'on';
        pi.appendEntry('pi-delegate-mode', { enabled });
      } else if (action === 'cancel') {
        const workers = id === 'all' ? [...running.values()] : [running.get(id)].filter(Boolean);
        if (!workers.length) throw new Error('Specify a running worker ID or all.');
        for (const worker of workers) worker!.cancel();
      } else if (action !== 'status') {
        throw new Error('Use /delegation on|off|status or /delegation cancel <worker-id|all>.');
      }
      ctx.ui.notify(`Delegation ${enabled ? 'on' : 'off'}. Running: ${[...running.keys()].join(', ') || 'none'}.`);
    },
  });

  pi.registerTool({
    name: 'delegate', label: 'Delegate',
    description: 'Spawn a background Pi worker using only a pointer into this session. For the current request call delegate({}), without messageId. ' +
      'Returns immediately; completion is notified automatically. No task text or polling. ' +
      'Workers share this cwd; assign disjoint work. messageId is a top-level session entry ID on the active branch.',
    parameters: Type.Object({
      messageId: Type.Optional(Type.String({ description: 'Earlier user-message entry ID; defaults to latest user message.' })),
      start: Type.Optional(Type.Integer({ minimum: 0, description: 'Zero-based Unicode code point in text blocks joined with newline. Requires end.' })),
      end: Type.Optional(Type.Integer({ minimum: 1, description: 'Exclusive Unicode code point end. Requires start.' })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      if (!enabled || shuttingDown) throw new Error('Delegation is off.');
      if (signal?.aborted) throw new Error('Delegation cancelled before launch.');
      const origin = ctx.sessionManager.getSessionFile();
      const pointer = resolvePointer(origin, ctx.sessionManager.getBranch(), args);
      await access(pointer.sessionFile);
      if (!enabled || shuttingDown || signal?.aborted) throw new Error('Delegation cancelled before launch.');
      const launch = startWorker({ cwd: ctx.cwd, root: join(getAgentDir(), 'delegate-runs'), pointer });
      starting.add(launch);
      let worker: Awaited<ReturnType<typeof startWorker>>;
      try { worker = await launch; } finally { starting.delete(launch); }
      running.set(worker.id, worker);
      if (signal?.aborted || shuttingDown) worker.cancel();
      void worker.done.then(result => {
        running.delete(worker.id);
        // Never deliver an old session's result into another conversation.
        if (shuttingDown || ctx.sessionManager.getSessionFile() !== origin) return;
        pi.sendMessage({
          customType: 'pi-delegate-result', display: true, details: result,
          content: completionText(result),
        }, { triggerTurn: true, deliverAs: 'followUp' });
      }).catch(error => {
        if (!shuttingDown) ctx.ui.notify(`Delegation notification failed: ${String(error)}`, 'error');
      });
      return {
        content: [{ type: 'text', text: `Started worker ${worker.id}. Logs: ${worker.directory}. Continue the conversation; do not wait or poll.` }],
        details: { id: worker.id, directory: worker.directory, pointer },
      };
    },
  });

  pi.on('session_shutdown', async () => {
    shuttingDown = true;
    await Promise.allSettled([...starting]);
    const workers = [...running.values()];
    for (const worker of workers) worker.cancel();
    await Promise.all(workers.map(worker => worker.done));
    running.clear();
  });
}
