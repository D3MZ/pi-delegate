import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const sessions = args[args.indexOf('--session-dir') + 1];
mkdirSync(sessions, { recursive: true });
writeFileSync(join(sessions, 'fixture.jsonl'), JSON.stringify({ args, child: process.env.PI_DELEGATE_CHILD }));
if (process.env.FIXTURE_MODE === 'wait') setInterval(() => {}, 1000);
else {
  const mode = process.env.FIXTURE_MODE;
  if (mode === 'startup-error') {
    process.stderr.write('Failed to load extension: missing callback.ts\n');
    process.exit(1);
  }
  if (['tool-error', 'empty-error'].includes(mode)) {
    const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
    if (mode === 'tool-error') emit({ type: 'message_end', message: { role: 'assistant',
      stopReason: 'stop', content: [{ type: 'text', text: 'Last real response' }] } });
    emit({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'Not the response' }] } });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error',
      errorMessage: 'WebSocket error', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'partial' } }] } });
    process.exit(0);
  }
  const stopReason = mode === 'error' ? 'error' : mode === 'length' ? 'length' : 'stop';
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason,
    content: [{ type: 'text', text: mode === 'blocked' ? 'Blocked: cannot finish' : 'Worker result 😀' }] } }) + '\n');
  process.exitCode = process.env.FIXTURE_MODE === 'exit' ? 3 : 0;
}
