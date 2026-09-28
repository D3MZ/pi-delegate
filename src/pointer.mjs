import { isAbsolute } from 'node:path';

export function messageText(content) {
  return typeof content === 'string' ? content : (content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n');
}

export function resolvePointer(sessionFile, branch, args = {}) {
  if (!sessionFile || !isAbsolute(sessionFile)) throw new Error('Delegation requires a persisted session.');
  if (Object.keys(args).some(key => !['messageId', 'start', 'end'].includes(key))) {
    throw new Error('Only messageId, start, and end are accepted; no task text.');
  }
  const users = branch.filter(entry => entry.type === 'message' && entry.message.role === 'user');
  const entry = args.messageId === undefined ? users.at(-1) : users.find(entry => entry.id === args.messageId);
  if (!entry) throw new Error('User message not found on the active branch. For the current request call delegate({}); for an earlier request read the session log and use its top-level user-entry ID, not a model-generated conversation ID.');
  if (branch.some(item => item.type === 'context_edit' && item.targetId === entry.id)) {
    throw new Error('This message has context edits. Submit the intended request as a new message.');
  }
  const pointer = { sessionFile, messageId: entry.id, contextLeafId: branch.at(-1)?.id };
  if (args.start !== undefined || args.end !== undefined) {
    const length = Array.from(messageText(entry.message.content)).length;
    if (!Number.isSafeInteger(args.start) || !Number.isSafeInteger(args.end)
      || args.start < 0 || args.end <= args.start || args.end > length) {
      throw new Error(`Supply both start and end: 0 <= start < end <= ${length} Unicode code points.`);
    }
    pointer.start = args.start;
    pointer.end = args.end;
  }
  return pointer;
}

export function makePrompt(pointer) {
  return `Execute the user request identified by this Pi session pointer:\n${JSON.stringify(pointer)}\n\n` +
    'Read the referenced JSONL log yourself; the request is not reproduced here. ' +
    'Entry IDs are the top-level id fields. Follow parentId from contextLeafId to reconstruct the active thread ' +
    'as it existed at delegation, including later user reviews that clarify the selected request. ' +
    'Inspect further referenced logs when necessary, but do not treat abandoned branches or later appended messages as new assignments. ' +
    'Honor context_edit entries when interpreting context. ' +
    'If start/end are present, the assignment is only that zero-based, end-exclusive Unicode-code-point range ' +
    'of the selected message text (text blocks joined with a newline); surrounding text is context, not additional work. ' +
    'Read image blocks in the source message when relevant. ' +
    'Perform and verify the work directly. Do not delegate or spawn other agents. ' +
    'If blocked or the request is ambiguous, explain that in your final response rather than guessing. ' +
    'Finish with a concise result or blocker. Do not modify the parent log.';
}
