import { createServer, type Server } from 'node:http';

const WIDE_REPLY = [
  'A wide reply:', '',
  '| Model | Overall | Coding | Research | Planning | Execution | Passed | Median time | Tokens/s | Cost |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  '| deepseek/deepseek-v4.1-flash-with-a-long-name | 8.1 | 8.4 | 7.9 | 8.0 | 8.2 | 90% | 41 s | 55 | $0.0123 |', '',
  '```ts', `const veryLongLine = '${'x'.repeat(200)}';`, '```', '',
  `See /home/someone/projects/${'deeply-nested-folder/'.repeat(8)}file.ts and https://example.com/${'segment/'.repeat(12)}page`
].join('\n');

/** A minimal OpenAI-compatible server: one model, a text reply, and a Write tool call. */
export async function fakeModelServer({ port = 0, replyGapMs = 0 }: { port?: number; replyGapMs?: number } = {}): Promise<Server> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fake-coder' }] })); return; }
      if (request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end('{}'); return; }
      const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: string | null }> };
      const last = messages[messages.length - 1];
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const delta = last.role === 'tool' ? { content: 'Done.' }
        : String(lastUser?.content).includes('write notes') ? { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'notes.txt', content: 'hello from e2e\n' }) } }] }
          : String(lastUser?.content).includes('wide reply') ? { content: WIDE_REPLY }
            : { content: 'Hi from the fake model.' };
      response.setHeader('content-type', 'text/event-stream');
      const sendDelta = (item: typeof delta): void => {
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', choices: [{ delta: item }] })}\n\n`);
      };
      const finish = (): void => {
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-e2e', choices: [{ delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
        response.end('data: [DONE]\n\n');
      };
      if (replyGapMs > 0 && delta.content !== undefined) {
        const split = Math.ceil(delta.content.length / 2);
        const content = delta.content;
        sendDelta({ content: content.slice(0, split) });
        setTimeout(() => { sendDelta({ content: content.slice(split) }); finish(); }, replyGapMs);
      } else {
        sendDelta(delta);
        finish();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
