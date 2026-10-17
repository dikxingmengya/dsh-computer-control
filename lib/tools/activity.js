// The operation list: what this session has done to the machine.
import { KINDS, kindOf } from '../activity.js';
import { defineTool, intOr, text } from '../toolkit.js';



function clockOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function activityTools(runtime) {
  const log = runtime.activity;

  const activity = defineTool({
    name: 'computer_activity',
    description:
      'List what this session has done to the machine, newest last: every capture, click, keystroke, window move, application launch, clipboard write, wait and system action, with its time, a one-line description and whether it completed, was refused by a risk gate, or was only rehearsed under dryRun. Use it to check what already happened - before repeating a step, after an interruption, or to report what was done. Screenshots are listed too, because reading the screen is something the person at the machine has a right to see. "history" reads the on-disk mirror, which also survives a restart; "clear" empties the in-memory list.',
    parameters: {
      action: { type: 'string', enum: ['list', 'history', 'clear'], description: 'What to do. Defaults to "list".' },
      limit: { type: 'integer', description: 'How many operations to return, most recent last. Defaults to 30.' },
      kind: { type: 'string', enum: KINDS, description: 'Return only this kind of operation.' },
      since: { type: 'integer', description: 'Return only operations after this index, for reading incrementally.' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        if (value.action === 'clear') {
          return text(
            `Cleared ${value.cleared} recorded operation(s). ${value.remaining > 0
              ? 'The clear itself is now operation #' + value.entries[0].index + ', because every call is recorded.'
              : 'The list is empty.'}`,
          );
        }
        if (value.entries.length === 0) {
          return text(value.action === 'history'
            ? `${log.text.blocked} no operations have been written to disk for this session yet.`
            : 'No operations have been recorded in this session yet.');
        }
        const lines = [`${value.entries.length} of ${value.total} operation(s)${value.kind ? ` of kind "${value.kind}"` : ''}, oldest first:`];
        for (const entry of value.entries) {
          const kind = log.text.kinds[entry.kind] ?? entry.kind;
          const outcome = log.text.outcomes[entry.outcome] ?? entry.outcome;
          const detail = entry.outcome === 'ok' ? '' : ` - ${entry.detail ?? ''}`;
          lines.push(`  #${entry.index} ${clockOf(entry.at)} [${kind}] ${entry.summary} - ${outcome}${detail} (${entry.elapsedMs} ms)`);
        }
        return text(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      const action = args.action ?? 'list';
      const sessionKey = exec.agent?.id;
      if (action === 'clear') {
        const cleared = await log.clear(sessionKey);
        // The clear is an operation too, so it lands in the list it just emptied.
        const entries = await log.list(sessionKey, { limit: 1 });
        return { action: 'clear', cleared, remaining: await log.count(sessionKey), entries };
      }
      const limit = intOr(args.limit, 30, { min: 1, max: 500, name: 'limit' });
      const kind = args.kind === undefined ? undefined : String(args.kind);
      if (kind !== undefined && !KINDS.includes(kind)) {
        throw new Error(`kind must be one of ${KINDS.join(', ')}, got ${JSON.stringify(kind)}`);
      }
      if (action === 'history') {
        const entries = await log.history(sessionKey, limit);
        return { action: 'history', total: await log.count(sessionKey), entries, ...(kind === undefined ? {} : { kind }) };
      }
      if (action !== 'list') throw new Error(`action must be list, history, or clear; got ${JSON.stringify(action)}`);
      const entries = await log.list(sessionKey, { limit, kind, since: args.since });
      return {
        action: 'list',
        total: await log.count(sessionKey),
        returned: entries.length,
        entries,
        ...(kind === undefined ? {} : { kind }),
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Read the operation list', kind: 'read' }),
  });

  return [activity];
}
