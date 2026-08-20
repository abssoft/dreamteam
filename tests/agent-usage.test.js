import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

process.env.TZ = 'UTC';

const execFileAsync = promisify(execFile);
const scriptPath = join(process.cwd(), 'skills', 'agent-usage', 'scripts', 'agent-usage.mjs');

async function makeLogs(files) {
  const root = await mkdtemp(join(tmpdir(), 'agent-usage-'));
  for (const [relativePath, records] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${records.map(JSON.stringify).join('\n')}\n`);
  }
  return root;
}

async function emptyDir() {
  return mkdtemp(join(tmpdir(), 'agent-usage-empty-'));
}

async function runCollector(args) {
  const argv = args === undefined ? [scriptPath] : [scriptPath, typeof args === 'string' ? args : JSON.stringify(args)];
  const { stdout } = await execFileAsync(process.execPath, argv);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one JSON line on stdout');
  return JSON.parse(lines[0]);
}

function codexMeta(id, parentId, agentPath) {
  return {
    timestamp: '2026-01-01T10:00:00.000Z',
    type: 'session_meta',
    payload: { id, source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: agentPath } } } }
  };
}

function codexTurnContext(model, at = '2026-01-01T10:00:01.000Z') {
  return { timestamp: at, type: 'turn_context', payload: { model } };
}

function codexTokenCount(usage, at) {
  return { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage } } };
}

function claudeAssistant({ requestId, model, usage, at }) {
  return { type: 'assistant', requestId, timestamp: at, message: { model, usage } };
}

const TABLE_HEADER = '| Роль | Время | Вход | Выход | Всего | Шаги | $ |\n|---|---:|---:|---:|---:|---:|---:|';

// --- argument validation ----------------------------------------------------

test('collector rejects malformed arguments with bad_args and exit 0', async () => {
  for (const args of [
    undefined,
    '{not json',
    { runtime: 'other', sessionId: 's', rootAgentRef: 'r', label: 'Разработка' },
    { runtime: 'codex', sessionId: ' ', rootAgentRef: 'r', label: 'Разработка' },
    { runtime: 'codex', sessionId: 's', rootAgentRef: '', label: 'Разработка' },
    { runtime: 'claude', sessionId: 's', rootAgentRef: 'r', label: '' },
    { runtime: 'claude', sessionId: 's', rootAgentRef: 'r' }
  ]) {
    assert.deepEqual(await runCollector(args), {
      ok: false,
      code: 'bad_args',
      warning_line: 'Предупреждение: метрики не собраны — bad_args.'
    });
  }
});

function failure(code, label) {
  return {
    ok: false,
    code,
    warning_line: label
      ? `Предупреждение: метрики ${label} не собраны — ${code}.`
      : `Предупреждение: метрики не собраны — ${code}.`
  };
}

// --- Codex ------------------------------------------------------------------

test('Codex sums the launched thread tree: last cumulative token_count per thread, models from turn_context', async () => {
  const sessionsRoot = await makeLogs({
    '2026/01/01/rollout-root.jsonl': [
      codexMeta('thread-root', 'sess-1', '/root/development'),
      codexTurnContext('gpt-5.6-terra'),
      codexTokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, total_tokens: 105 }, '2026-01-01T10:01:00.000Z'),
      codexTokenCount({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, total_tokens: 1050 }, '2026-01-01T10:05:00.000Z')
    ],
    '2026/01/01/rollout-other.jsonl': [
      codexMeta('thread-other', 'sess-1', '/root/review'),
      codexTurnContext('gpt-5.6-terra'),
      codexTokenCount({ input_tokens: 7, cached_input_tokens: 0, output_tokens: 7, total_tokens: 14 }, '2026-01-01T10:00:30.000Z')
    ]
  });
  const archivedRoot = await makeLogs({
    '2026/01/01/rollout-child.jsonl': [
      codexMeta('thread-child', 'thread-root', '/root/development/helper'),
      codexTurnContext('gpt-5.6-terra', '2026-01-01T10:02:00.000Z'),
      codexTokenCount({ input_tokens: 500, cached_input_tokens: 200, output_tokens: 30, total_tokens: 530 }, '2026-01-01T10:03:00.000Z')
    ]
  });

  const result = await runCollector({
    runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка',
    codexRoot: sessionsRoot, codexArchivedRoot: archivedRoot
  });

  assert.equal(result.ok, true);
  assert.equal(result.label, 'Разработка');
  assert.equal(result.source, 'codex');
  assert.equal(result.agents, 2);
  assert.deepEqual(result.models, ['gpt-5.6-terra']);
  assert.deepEqual(result.tokens, { input: 1500, cached_input: 600, output: 80, total: 1580 });
  assert.equal(result.started_at, '2026-01-01T10:00:00.000Z');
  assert.equal(result.ended_at, '2026-01-01T10:05:00.000Z');
  assert.equal(result.wall_seconds, 300);
  // Steps = API model requests: one per token_count event (2 root + 1 child).
  assert.equal(result.steps, 3);
  // gpt-5.6-terra: ((1500-600)*2 + 600*0.2 + 80*12) / 1e6, rounded to 4 decimals.
  assert.equal(result.cost_usd, 0.0029);
  assert.deepEqual(result.unpriced_models, []);
  assert.deepEqual(result.by_model, [
    { model: 'gpt-5.6-terra', steps: 3, tokens: { input: 1500, cached_input: 600, output: 80, total: 1580 }, cost_usd: 0.0029 }
  ]);

  // The collector renders the «Затрачено» block itself: caller-side digit
  // formatting is banned, the caller pastes rendered.block verbatim.
  const rows = '| Разработка<br>*gpt-5.6-terra* | 5м 0с | 1 500<br>*кэш 600* | 80 | 1 580 | 3 | 0.0029 |';
  assert.deepEqual(result.rendered, {
    block: `Затрачено:\n\n${TABLE_HEADER}\n${rows}`,
    table_header: TABLE_HEADER,
    rows
  });
  assert.equal(
    result.comment_html,
    '<p>Метрики Разработка: 5м 0с · шаги 3 · $0.0029</p>' +
      '<ul><li><b>gpt-5.6-terra</b>: вход 1 500 (кэш 600) · выход 80 · всего 1 580 · шаги 3 · $0.0029</li></ul>'
  );
});

test('Codex failure codes: logs_not_found, root_not_found, ambiguous_root', async () => {
  const empty = await emptyDir();
  assert.deepEqual(
    await runCollector({ runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка', codexRoot: empty, codexArchivedRoot: empty }),
    failure('logs_not_found', 'Разработка')
  );

  const mismatched = await makeLogs({
    'r.jsonl': [codexMeta('thread-a', 'sess-1', '/root/review'), codexTokenCount({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, '2026-01-01T10:00:01.000Z')]
  });
  assert.deepEqual(
    await runCollector({ runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка', codexRoot: mismatched, codexArchivedRoot: empty }),
    failure('root_not_found', 'Разработка')
  );

  const doubled = await makeLogs({
    'one.jsonl': [codexMeta('thread-a', 'sess-1', '/root/development')],
    'two.jsonl': [codexMeta('thread-b', 'sess-1', '/root/development')]
  });
  assert.deepEqual(
    await runCollector({ runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка', codexRoot: doubled, codexArchivedRoot: empty }),
    failure('ambiguous_root', 'Разработка')
  );
});

test('Codex without any timestamped record fails with timestamps_missing', async () => {
  const root = await makeLogs({
    'r.jsonl': [
      { type: 'session_meta', payload: { id: 'thread-a', source: { subagent: { thread_spawn: { parent_thread_id: 'sess-1', agent_path: '/root/development' } } } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } }
    ]
  });
  const empty = await emptyDir();
  assert.deepEqual(
    await runCollector({ runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка', codexRoot: root, codexArchivedRoot: empty }),
    failure('timestamps_missing', 'Разработка')
  );
});

// --- Claude Code ------------------------------------------------------------

test('Claude sums root and nested subagents with per-request dedup and full input accounting', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid/subagents/agent-root1.jsonl': [
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:00.000Z',
        usage: { input_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
      }),
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:05.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 40 }
      }),
      { type: 'assistant', requestId: 'req2', timestamp: '2026-01-01T10:00:06.000Z', message: { model: '<synthetic>', content: [] } },
      { type: 'user', timestamp: '2026-01-01T10:00:07.000Z', toolUseResult: { agentId: 'child1' } }
    ],
    'proj/sess-uuid/subagents/agent-child1.jsonl': [
      claudeAssistant({
        requestId: 'req3', model: 'claude-sonnet-5', at: '2026-01-01T10:02:00.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }
      })
    ]
  });

  const result = await runCollector({
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Ревью',
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  assert.equal(result.label, 'Ревью');
  assert.equal(result.source, 'claude');
  assert.equal(result.agents, 2);
  assert.deepEqual(result.models, ['claude-sonnet-5'], '<synthetic> never reaches the model list');
  // input = input_tokens + cache_creation + cache_read; req1 keeps only the last record.
  assert.deepEqual(result.tokens, { input: 610, cached_input: 300, output: 45, total: 655 });
  // Steps = distinct API requests with usage: req1 (deduped) + req3; the
  // usage-less <synthetic> req2 does not count.
  assert.equal(result.steps, 2);
  assert.equal(result.wall_seconds, 120);
  // claude-sonnet-5: (100*2 + 200*2.5 + 300*0.2 + 40*10 + 10*2 + 5*10) / 1e6, rounded to 4 decimals.
  assert.equal(result.cost_usd, 0.0012);
  assert.deepEqual(result.unpriced_models, []);
});

test('Claude splits the report per model with exact per-request attribution', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid/subagents/agent-root1.jsonl': [
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:00.000Z',
        usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 }
      }),
      claudeAssistant({
        requestId: 'req2', model: 'claude-opus-5', at: '2026-01-01T10:01:00.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      }),
      claudeAssistant({
        requestId: 'req3', model: 'claude-sonnet-5', at: '2026-01-01T10:02:00.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }
      })
    ]
  });

  const result = await runCollector({
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'PRD',
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(result.tokens, { input: 1110, cached_input: 0, output: 115, total: 1225 });
  assert.equal(result.steps, 3);
  // opus: (100*5 + 10*25) / 1e6; sonnet: (1010*2 + 105*10) / 1e6; total from raw sums.
  assert.deepEqual(result.by_model, [
    { model: 'claude-opus-5', steps: 1, tokens: { input: 100, cached_input: 0, output: 10, total: 110 }, cost_usd: 0.0008 },
    { model: 'claude-sonnet-5', steps: 2, tokens: { input: 1010, cached_input: 0, output: 105, total: 1115 }, cost_usd: 0.0031 }
  ]);
  assert.equal(result.cost_usd, 0.0038);

  // One table row per model; the launch wall time appears only on the first row.
  assert.equal(
    result.rendered.rows,
    '| PRD<br>*claude-opus-5* | 2м 0с | 100<br>*кэш 0* | 10 | 110 | 1 | 0.0008 |\n' +
      '| PRD<br>*claude-sonnet-5* |  | 1 010<br>*кэш 0* | 105 | 1 115 | 2 | 0.0031 |'
  );
  assert.equal(result.rendered.block, `Затрачено:\n\n${TABLE_HEADER}\n${result.rendered.rows}`);
  assert.equal(
    result.comment_html,
    '<p>Метрики PRD: 2м 0с · шаги 3 · $0.0038</p><ul>' +
      '<li><b>claude-opus-5</b>: вход 100 (кэш 0) · выход 10 · всего 110 · шаги 1 · $0.0008</li>' +
      '<li><b>claude-sonnet-5</b>: вход 1 010 (кэш 0) · выход 105 · всего 1 115 · шаги 2 · $0.0031</li></ul>'
  );
});

test('Claude failure codes: root_not_found beside the session transcript, logs_not_found otherwise', async () => {
  const withTranscript = await makeLogs({
    'proj/sess-uuid.jsonl': [{ type: 'user', timestamp: '2026-01-01T10:00:00.000Z' }]
  });
  assert.deepEqual(
    await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Разработка', claudeProjectsRoot: withTranscript }),
    failure('root_not_found', 'Разработка')
  );

  const empty = await emptyDir();
  assert.deepEqual(
    await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Разработка', claudeProjectsRoot: empty }),
    failure('logs_not_found', 'Разработка')
  );
});

// --- pricing ----------------------------------------------------------------

test('pricing matches model prefixes and quarantines unknown models without dropping their tokens', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid/subagents/agent-root1.jsonl': [
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5-20260101', at: '2026-01-01T10:00:00.000Z',
        usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 }
      }),
      claudeAssistant({
        requestId: 'req2', model: 'mystery-9', at: '2026-01-01T10:00:10.000Z',
        usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }
      })
    ]
  });

  const result = await runCollector({
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'PRD',
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['claude-sonnet-5-20260101', 'mystery-9']);
  assert.deepEqual(result.tokens, { input: 1050, cached_input: 0, output: 105, total: 1155 });
  assert.equal(result.steps, 2);
  // Only the prefix-priced claude-sonnet-5-20260101 is billed: (1000*2 + 100*10) / 1e6.
  assert.equal(result.cost_usd, 0.003);
  assert.deepEqual(result.unpriced_models, ['mystery-9']);
  const [priced, unpriced] = result.by_model;
  assert.equal(priced.cost_usd, 0.003);
  assert.equal(unpriced.cost_usd, null);
  const [first, second] = result.rendered.rows.split('\n');
  assert.match(first, /^\| PRD<br>\*claude-sonnet-5-20260101\* \| /);
  assert.match(first, /\| 1 \| 0\.003 \|$/);
  assert.match(second, /^\| PRD<br>\*mystery-9\* \| {2}\| /);
  assert.match(second, /\| 1 \| без тарифа \|$/);
});

// --- rendering ----------------------------------------------------------------

test('rendering switches to millions with two decimals at 1 000 000 tokens, output stays space-separated', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid/subagents/agent-root1.jsonl': [
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:00.000Z',
        usage: { input_tokens: 2000000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1238493, output_tokens: 323885 }
      }),
      claudeAssistant({
        requestId: 'req2', model: 'claude-sonnet-5', at: '2026-01-01T10:12:34.000Z',
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
      })
    ]
  });

  const result = await runCollector({
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Ревью',
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tokens, { input: 3238493, cached_input: 1238493, output: 323885, total: 3562378 });
  assert.equal(result.wall_seconds, 754);
  assert.equal(result.steps, 2);
  assert.equal(
    result.rendered.rows,
    `| Ревью<br>*claude-sonnet-5* | 12м 34с | 3.24М<br>*кэш 1.24М* | 323 885 | 3.56М | 2 | ${result.cost_usd} |`
  );
});
