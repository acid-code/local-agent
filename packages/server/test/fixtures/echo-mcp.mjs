// A tiny real MCP stdio server (newline-delimited JSON-RPC) used by the tests.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write_note', description: 'Write a note', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'env', description: 'Show whether a secret env var is set', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'crash', description: 'Exit the process', inputSchema: { type: 'object' } },
];
process.stdout.write('starting echo server (log line, not JSON)\n');
rl.on('line', (line) => {
  let rpc; try { rpc = JSON.parse(line); } catch { return; }
  if (rpc.id == null) return;
  if (rpc.method === 'initialize') return send({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  if (rpc.method === 'tools/list') {
    // Two pages, to exercise pagination.
    if (!rpc.params?.cursor) return send({ jsonrpc: '2.0', id: rpc.id, result: { tools: tools.slice(0, 2), nextCursor: 'p2' } });
    return send({ jsonrpc: '2.0', id: rpc.id, result: { tools: tools.slice(2) } });
  }
  if (rpc.method === 'tools/call') {
    const { name, arguments: args = {} } = rpc.params ?? {};
    if (name === 'crash') { process.exit(3); }
    if (name === 'echo') return send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] } });
    if (name === 'write_note') return send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `saved ${String(args.text ?? '').length} chars` }] } });
    if (name === 'env') return send({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `token ${process.env.ECHO_TOKEN ? `set (${process.env.ECHO_TOKEN})` : 'missing'}` }] } });
    return send({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: `no tool ${name}` }] } });
  }
  send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'method not found' } });
});
