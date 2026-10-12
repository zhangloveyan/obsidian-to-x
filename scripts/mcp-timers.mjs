import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Keep the SDK's Node subprocess shutdown timer local to its transport module. */
export function mcpNodeTimers() {
  return {
    name: 'mcp-node-timers',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]@modelcontextprotocol[\\/]sdk[\\/]dist[\\/]esm[\\/]client[\\/]stdio\.js$/ }, async ({ path }) => ({
        // Obsidian's renderer has browser timers, whose numeric IDs have no unref().
        // Do not replace global timers or inject into functions serialized for X.
        contents: `import { setTimeout } from 'node:timers';\n${await readFile(path, 'utf8')}`,
        loader: 'js',
        resolveDir: dirname(path),
      }));
    },
  };
}
