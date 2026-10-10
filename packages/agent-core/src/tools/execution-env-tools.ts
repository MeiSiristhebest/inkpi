import type { AgentTool } from '@inkpi/protocol';
import type { ExecutionEnv } from '../ports/execution-env.js';

/** The host selects an environment before granting these tools to a task. */
export function createExecutionEnvTools(environment: ExecutionEnv): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: 'env_read_file',
      description: 'Read a bounded UTF-8 line range within the granted execution directory.',
      replay: 'safe',
      implementationVersion: '1',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          maxLines: { type: 'integer', minimum: 1 },
          maxBytes: { type: 'integer', minimum: 1 }
        },
        required: ['path']
      },
      execute: async (_id, args, signal) => {
        const { text, ...details } = await environment.readText(
          args.path,
          { startLine: args.startLine, maxLines: args.maxLines, maxBytes: args.maxBytes },
          signal
        );
        return {
          content: [
            {
              type: 'text',
              text:
                text +
                (details.truncated
                  ? `\n[Read limited: ${details.retainedBytes} bytes retained, ${details.skippedBytes} scanned bytes skipped${details.nextLine === null ? '; no complete line cursor' : `; next line ${details.nextLine}`}.]`
                  : '')
            }
          ],
          details
        };
      }
    },
    {
      name: 'env_list_directory',
      description: 'List one bounded directory page; reuse the returned cursor for the next page.',
      replay: 'safe',
      implementationVersion: '1',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          cursor: { type: 'object' }
        },
        required: ['path']
      },
      execute: async (_id, args, signal) => {
        const page = await environment.listDirectory(args.path, args.limit, args.cursor, signal);
        return { content: [{ type: 'text', text: JSON.stringify(page) }] };
      }
    }
  ];
  if (environment.capabilities.write)
    tools.push(
      {
        name: 'env_write_file',
        description: 'Write UTF-8 text atomically within the granted execution directory.',
        replay: 'never',
        implementationVersion: '1',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, text: { type: 'string' } },
          required: ['path', 'text']
        },
        execute: async (_id, args, signal) => ({
          content: [{ type: 'text', text: JSON.stringify(await environment.writeText(args.path, args.text, signal)) }]
        })
      },
      {
        name: 'env_edit_file',
        description: 'Replace exactly one text match while serializing edits to the same file.',
        replay: 'never',
        implementationVersion: '1',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            oldText: { type: 'string', minLength: 1 },
            newText: { type: 'string' }
          },
          required: ['path', 'oldText', 'newText']
        },
        execute: async (_id, args, signal) => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify(await environment.editText(args.path, args.oldText, args.newText, signal))
            }
          ]
        })
      }
    );
  if (environment.capabilities.process)
    tools.push({
      name: 'env_run_process',
      description: 'Run a host-approved executable with an argv array and bounded output; no shell expansion.',
      replay: 'never',
      implementationVersion: '1',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 }
        },
        required: ['command', 'args']
      },
      execute: async (_id, args, signal, onUpdate) => {
        let lastCheckpoint = performance.now();
        const result = await environment.runProcess(args, signal, (progress) => {
          const now = performance.now();
          const checkpoint = now - lastCheckpoint >= 1000;
          if (checkpoint) lastCheckpoint = now;
          onUpdate?.({ content: [{ type: 'text', text: JSON.stringify(progress) }] }, { checkpoint });
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: result.termination !== 'exited' || result.exitCode !== 0
        };
      }
    });
  return tools;
}
