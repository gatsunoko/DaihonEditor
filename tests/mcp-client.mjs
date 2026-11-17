import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'script-editor-browser-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/stdio.mjs')],
  env: { ...process.env }, stderr: 'inherit',
}));
process.stdout.write(JSON.stringify({ ready: true }) + '\n');
try {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const { name, args } = JSON.parse(line);
      const result = name === 'tools/list' ? await client.listTools() : await client.callTool({ name, arguments: args || {} });
      process.stdout.write(JSON.stringify({ result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    }
  }
} finally { await client.close(); }
