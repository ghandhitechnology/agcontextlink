#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { parseArgs } from 'node:util';
import { parseLink, RoomClient, VERSION } from './client.js';
import { createHelper } from './server.js';

const USAGE = `agcontextlink ${VERSION}

Usage: agcontextlink <room link> [--name <display name>]

Runs as Claude Code's connection to an agcontextlink room:
  claude mcp add agcontextlink -- npx -y agcontextlink <room link>

For live push, start Claude Code with:
  claude --dangerously-load-development-channels server:agcontextlink`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
});

if (values.version) {
  console.log(VERSION);
  process.exit(0);
}
if (values.help || positionals.length !== 1) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 1);
}

let client: RoomClient;
try {
  client = new RoomClient(parseLink(positionals[0]!));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

await client.load();
const helper = createHelper(client, values.name);
// Push only once the session is ready, so no message lands before Claude Code listens.
helper.server.server.oninitialized = () => helper.startPush();

const transport = new StdioServerTransport();
transport.onclose = () => {
  helper.stop();
  process.exit(0);
};
await helper.server.connect(transport);
