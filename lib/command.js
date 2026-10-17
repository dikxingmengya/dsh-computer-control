import { KINDS } from './activity.js';

// `/computer-activity` - the human-command half of the operation list.
//
// The same Host method backs two callers, as the plugin guide requires: the
// `computer_activity` tool that the model calls, and this command, which the
// Settings page runs through `ctx.remote.commands.execute` and a person can type
// in the composer. There is one implementation, so the page and the tool can
// never disagree about what happened.
//
// The command protocol carries text only, so `--json` asks for the machine-
// readable form the page parses; without it the reply is the table a person reads.

/** Parse the flag list of a bare command invocation. */
function flagsOf(rawInput) {
  return String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

const USAGE = {
  zh: '用法：/computer-activity [--json] [--kind capture] [--limit 50] [--all]\n'
    + '  列出本次会话对这台机器做过的操作。--json 返回页面用的结构化数据，--all 读磁盘历史（含重启前的）。',
  en: 'Usage: /computer-activity [--json] [--kind capture] [--limit 50] [--all]\n'
    + '  List what this session has done to the machine. --json returns the structured form the page uses; --all reads the on-disk history, including before a restart.',
};



export function activityCommandDefinition(runtime) {
  const log = runtime.activity;
  return {
    definitionId: '@local/dsh-computer-control',
    name: 'computer-activity',
    description: 'List what this session has done to the machine (captures, clicks, keystrokes, windows, apps).',
    async handler(invocation) {
      const language = log.language;
      const tokens = flagsOf(invocation.rawInput);

      const json = tokens.includes('--json');
      const all = tokens.includes('--all');
      let kind;
      let limit = 50;
      let bridge;
      const stray = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token === '--json' || token === '--all') continue;
        // The page's switch. A runtime toggle rather than a configuration write, so
        // the plugin needs no settings schema for it to exist.
        if (token === '--bridge') {
          bridge = tokens[i + 1];
          if (bridge !== 'on' && bridge !== 'off') return { kind: 'error', text: USAGE[language] };
          i += 1;
          continue;
        }
        if (token === '--kind') { kind = tokens[i + 1]; i += 1; continue; }
        if (token === '--limit') {
          const parsed = Number.parseInt(tokens[i + 1] ?? '', 10);
          if (!Number.isFinite(parsed) || parsed <= 0) return { kind: 'error', text: USAGE[language] };
          limit = Math.min(parsed, 500);
          i += 1;
          continue;
        }
        stray.push(token);
      }
      // Anything left over is a typo, and a typo must fail loudly rather than
      // silently answering a different question than the one that was asked.
      if (stray.length > 0 || (kind !== undefined && !KINDS.includes(kind))) {
        return { kind: 'error', text: USAGE[language] };
      }

      const sessionKey = invocation.agent?.id;
      if (bridge === 'on') await runtime.live?.enable();
      else if (bridge === 'off') runtime.live?.disable();
      const entries = all
        ? await log.history(sessionKey, limit)
        : await log.list(sessionKey, { limit, kind });
      const total = await log.count(sessionKey);
      if (json) {
        // The page learns how to reach the live bridge here, once, when it mounts.
        //
        // When the bridge is running the entries are left out on purpose. The page
        // subscribes the moment it has the credentials, and the stream pushes the whole
        // list on connect - so shipping three hundred records through this call would put
        // a twenty-kilobyte JSON blob into the conversation for data that arrives a
        // moment later by another route. Every command result is written into the session
        // and rendered as a row, which is why the size of this reply is a user-visible
        // thing and not just an efficiency question.
        const live = runtime.live?.credentials();
        if (live !== undefined) return { kind: 'success', text: JSON.stringify({ live }) };
        return { kind: 'success', text: JSON.stringify({ total, returned: entries.length, kind: kind ?? null, all, entries }) };
      }

      if (entries.length === 0) {
        return { kind: 'success', text: language === 'zh' ? '本次会话还没有任何操作记录。' : 'No operations recorded in this session yet.' };
      }
      const lines = [language === 'zh' ? `${entries.length} / ${total} 条操作：` : `${entries.length} of ${total} operation(s):`];
      for (const entry of entries) {
        const clock = new Date(entry.at);
        const pad = (n) => String(n).padStart(2, '0');
        const time = Number.isNaN(clock.getTime()) ? '--:--:--' : `${pad(clock.getHours())}:${pad(clock.getMinutes())}:${pad(clock.getSeconds())}`;
        lines.push(`  #${entry.index} ${time} [${log.text.kinds[entry.kind] ?? entry.kind}] ${entry.summary} - ${log.text.outcomes[entry.outcome] ?? entry.outcome}${entry.outcome === 'ok' ? '' : ` - ${entry.detail ?? ''}`}`);
      }
      return { kind: 'success', text: lines.join('\n') };
    },
  };
}
