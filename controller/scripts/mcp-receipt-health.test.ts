import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubwaveClient } from '../src/mcp/client.js';
import { registerSubwaveTools } from '../src/mcp/tools.js';

test('MCP reports receipt outcomes and distinguishes an off-air source from missing data', async t => {
  const server = new McpServer({ name: 'station', version: '1.0.0' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  let body: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  registerSubwaveTools(server, new SubwaveClient({ baseUrl: 'http://controller.test' }));
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  for (const [phase, success, pattern] of [
    ['aired', true, /requested track.* aired/],
    ['queued', true, /^Queued.* at position 2/],
    ['declined', false, /^Request declined: Already aired/],
    ['answered', true, /^The DJ answered/],
  ] as const) {
    body = { phase, status: 'resolved', success, ack: 'Thanks',
      track: phase === 'answered' ? null : { title: 'Song', artist: 'Band' },
      queuePosition: phase === 'queued' ? 2 : null,
      message: phase === 'declined' ? 'Already aired' : null,
      airedAt: phase === 'aired' ? '2026-11-18T12:00:00Z' : null,
    };
    const result = await client.callTool({ name: 'subwave_request_status', arguments: { requestId: 'receipt' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.phase, phase);
    assert.ok(Array.isArray(result.content));
    assert.match(result.content[0]?.text, pattern);
  }

  for (const [streamOnline, onAir, pattern] of [
    [true, true, /has a live source/],
    [false, false, /reports no live source/],
    [undefined, null, /status is unavailable/],
  ] as const) {
    body = { status: 'on-air', streamOnline };
    const result = await client.callTool({ name: 'subwave_health' });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.structuredContent, { reachable: true, onAir });
    assert.match(JSON.stringify(result.content), pattern);
  }
});
