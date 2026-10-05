import { Type } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { constants, runInThisContext } from 'node:vm';
export default async function (pi: ExtensionAPI) {
  // Inherited by native child processes: never register this tool or delegation policy there.
  if (process.env.PI_DELEGATE_CHILD === '1') return;
  // Jiti strips query strings from transformed imports, retaining stale .mjs modules
  // across /reload. Use Node's native import with a unique URL for each factory run.
  const nativeImport = runInThisContext('(url) => import(url)', {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (url: string) => Promise<any>;
  const reload = `${Date.now()}-${Math.random()}`;
  const [{ resolvePointer }, { completionText, startWorker }] = await Promise.all([
    nativeImport(`${new URL('./pointer.mjs', import.meta.url).href}?reload=${reload}`),
    nativeImport(`${new URL('./runner.mjs', import.meta.url).href}?reload=${reload}`),
  ]);

  let enabled = true;
  let shuttingDown = false;
  const running = new Map<string, Awaited<ReturnType<typeof startWorker>>>();
  const starting = new Set<ReturnType<typeof startWorker>>();
  type Callback = { origin: string; leafId?: string; notifyOnCompletion?: boolean; returnLastResponse: boolean; result?: any; delivered: boolean };
  const callbacks = new Map<string, Callback>();

  function deliver(result: any, options: { notifyOnCompletion?: boolean; returnLastResponse: boolean }) {
    const triggerTurn = options.notifyOnCompletion ?? !result.success;
    pi.sendMessage({
      customType: 'pi-delegate-result', display: true, details: result,
      content: completionText(result, options.returnLastResponse),
    }, triggerTurn ? { triggerTurn: true, deliverAs: 'followUp' } : { triggerTurn: false });
  }

  pi.on('session_start', (_event, ctx) => {
    shuttingDown = false;
    enabled = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'pi-delegate-mode') {
        enabled = (entry.data as { enabled: boolean }).enabled;
      }
    }
  });

  // Legacy releases persisted the same policy on every turn. Keep the log intact,
  // but exclude those copies from provider context (including resumed sessions).
  pi.on('context', event => ({
    messages: event.messages.filter(message =>
      !(message.role === 'custom' && message.customType === 'pi-delegate-policy')),
  }));

  pi.on('before_agent_start', (event, ctx) => {
    // A named prompt section is replaced, not appended to conversation history.
    // Pi emits a prompt delta only when mode or session path actually changes.
    event.systemPromptOptions.sections.pi_delegate_policy = (enabled
        ? 'Delegate mode is ON. For user requests to execute work, invoke delegate with no task text. ' +
          'Omit messageId for the latest request; for an earlier message, read the session log and use its top-level user-entry ID, which delegate validates. ' +
          `Session log: ${JSON.stringify(ctx.sessionManager.getSessionFile() ?? null)}. ` +
          'Use optional start/end for separate portions. Set returnLastResponse:true when you need the worker’s answer, including on failure; the default notification omits it. ' +
          'Set notifyOnCompletion:true at launch when you need a follow-up turn to continue user-authorized work after completion. ' +
          'Use delegate_callback({id}) to subscribe later, even after completion; it does not launch work. ' +
          'Discuss questions and review feedback here; do not spawn for conversation alone. ' +
          'After launching, yield and remain available. Do not poll, wait, monitor workers, or duplicate their work. ' +
          'Use completion notifications. Continue a previously user-requested sequence when its callback arrives; do not invent new follow-up work. ' +
          'Multiple calls share the working directory; do not assign overlapping edits. Never delegate a completion notification as a new assignment; for authorized next steps, use the original user-message ID and an appropriate range.'
        : 'Delegate mode is OFF. Work directly; do not invoke delegate or substitute another delegation tool.') +
        ' A pi-delegate-result notification reports worker-ID:Completed on a clean final response, or worker-ID:Error on incomplete output, process/provider failure or cancellation. ' +
        'Review the worker’s response for its result or blocker. A callback may resume an already authorized sequence, but is not authorization for new work.';
  });

  const command = {
    description: 'Delegate on|off|status, or cancel <worker-id|all>',
    handler: async (args: string, ctx: import('@earendil-works/pi-coding-agent').ExtensionCommandContext) => {
      const [action = 'status', id] = args.trim().split(/\s+/).filter(Boolean);
      if (action === 'on' || action === 'off') {
        enabled = action === 'on';
        pi.appendEntry('pi-delegate-mode', { enabled });
      } else if (action === 'cancel') {
        const workers = id === 'all' ? [...running.values()] : [running.get(id)].filter(Boolean);
        if (!workers.length) throw new Error('Specify a running worker ID or all.');
        for (const worker of workers) worker!.cancel();
      } else if (action !== 'status') {
        throw new Error('Use /delegate on|off|status or /delegate cancel <worker-id|all>.');
      }
      ctx.ui.notify(`Delegate ${enabled ? 'on' : 'off'}. Running: ${[...running.keys()].join(', ') || 'none'}.`);
    },
  };
  pi.registerCommand('delegate', command);
  pi.registerCommand('delegation', command); // Preserve the original command name.

  pi.registerTool({
    name: 'delegate', label: 'Delegate',
    description: 'Spawn a background Pi worker using only a pointer into this session. For the current request call delegate({}), without messageId. ' +
      'Returns immediately; completion is displayed automatically. Set notifyOnCompletion:true to wake the parent for previously authorized next steps. ' +
      'Use delegate_callback to subscribe later. No task text or polling. ' +
      'Workers share this cwd; assign disjoint work. messageId is a top-level session entry ID on the active branch.',
    parameters: Type.Object({
      messageId: Type.Optional(Type.String({ description: 'Earlier user-message entry ID; defaults to latest user message.' })),
      start: Type.Optional(Type.Integer({ minimum: 0, description: 'Zero-based Unicode code point in text blocks joined with newline. Requires end.' })),
      end: Type.Optional(Type.Integer({ minimum: 1, description: 'Exclusive Unicode code point end. Requires start.' })),
      returnLastResponse: Type.Optional(Type.Boolean({ description: 'Pass the last assistant response to the parent when you need its answer or summary, including on failure. Default false.' })),
      notifyOnCompletion: Type.Optional(Type.Boolean({ description: 'Wake the parent with a follow-up turn on completion. True for authorized next steps; false for passive display only. If omitted, only errors wake the parent.' })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      if (!enabled || shuttingDown) throw new Error('Delegate is off.');
      if (signal?.aborted) throw new Error('Delegate cancelled before launch.');
      const origin = ctx.sessionManager.getSessionFile();
      const { returnLastResponse = false, notifyOnCompletion, ...pointerArgs } = args;
      const pointer = resolvePointer(origin, ctx.sessionManager.getBranch(), pointerArgs);
      await access(pointer.sessionFile);
      if (!enabled || shuttingDown || signal?.aborted) throw new Error('Delegate cancelled before launch.');
      const launch = startWorker({ cwd: ctx.cwd, root: join(getAgentDir(), 'delegate-runs'), pointer });
      starting.add(launch);
      let worker: Awaited<ReturnType<typeof startWorker>>;
      try { worker = await launch; } finally { starting.delete(launch); }
      running.set(worker.id, worker);
      const callback: Callback = { origin: origin!, leafId: pointer.contextLeafId,
        notifyOnCompletion, returnLastResponse, delivered: false };
      callbacks.set(worker.id, callback);
      if (signal?.aborted || shuttingDown) worker.cancel();
      void worker.done.then(result => {
        running.delete(worker.id);
        // Never deliver an old session's result into another conversation.
        if (shuttingDown || ctx.sessionManager.getSessionFile() !== origin) return;
        callback.result = result;
        deliver(result, callback);
        callback.delivered = callback.notifyOnCompletion ?? !result.success;
      }).catch(error => {
        if (!shuttingDown) ctx.ui.notify(`Delegate notification failed: ${String(error)}`, 'error');
      });
      return {
        content: [{ type: 'text', text: `Started worker ${worker.id}. Logs: ${worker.directory}. Continue the conversation; do not wait or poll.` }],
        details: { id: worker.id, directory: worker.directory, pointer },
      };
    },
  });

  pi.registerTool({
    name: 'delegate_callback', label: 'Delegate callback',
    description: 'Subscribe to a worker completion without spawning or polling. Works for a running worker or a completed result on this active branch (including after reload). A completed task wakes the parent immediately, once per runtime. Use only for user-authorized follow-up work.',
    parameters: Type.Object({
      id: Type.String({ description: 'Worker ID returned by delegate or its completion notification.' }),
      notifyOnCompletion: Type.Optional(Type.Boolean({ description: 'Default true. False disables the completion wake-up; passive display remains.' })),
      returnLastResponse: Type.Optional(Type.Boolean({ description: 'Include the worker answer, including on failure. Default true.' })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      if (shuttingDown || signal?.aborted) throw new Error('Callback cancelled.');
      const origin = ctx.sessionManager.getSessionFile();
      const branch = ctx.sessionManager.getBranch();
      let callback = callbacks.get(args.id);
      if (callback && (callback.origin !== origin ||
          (callback.leafId && !branch.some(entry => entry.id === callback!.leafId)))) callback = undefined;
      // Persisted notifications are authoritative only on the current branch.
      const result = [...branch].reverse().find(entry =>
        entry.type === 'custom_message' && entry.customType === 'pi-delegate-result'
          && (entry.details as any)?.id === args.id)?.details as any;
      if (callback?.result && !result) callback = undefined;
      if (!callback && result) {
        callback = { origin: origin!, result, returnLastResponse: false, delivered: false };
        callbacks.set(args.id, callback);
      }
      if (!callback) throw new Error('Unknown worker in this session. Use an ID from delegate or a completion on the active branch.');
      callback.notifyOnCompletion = args.notifyOnCompletion ?? true;
      callback.returnLastResponse = args.returnLastResponse ?? true;
      if (callback.result && callback.notifyOnCompletion && !callback.delivered) {
        deliver(callback.result, callback);
        callback.delivered = true;
      }
      return {
        content: [{ type: 'text', text: callback.notifyOnCompletion
          ? `Completion callback registered for ${args.id}. Yield; do not wait or poll.`
          : `Completion wake-up disabled for ${args.id}.` }],
        details: { id: args.id, notifyOnCompletion: callback.notifyOnCompletion, returnLastResponse: callback.returnLastResponse },
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
