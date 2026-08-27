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
    { runtime: 'claude', sessionId: 's', rootAgentRef: 'r' },
    { runtime: 'claude', sessionId: 's', label: '' },
    { runtime: 'codex', label: 'Основная сессия' }
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
  // Per-model wall time sums the spans while the model was active: root
  // 10:00:01 (turn_context) → 10:05:00 (299s) + child 10:02:00→10:03:00 (60s).
  assert.deepEqual(result.by_model, [
    { model: 'gpt-5.6-terra', wall_seconds: 359, steps: 3, tokens: { input: 1500, cached_input: 600, output: 80, total: 1580 }, cost_usd: 0.0029 }
  ]);

  // The collector renders the «Затрачено» block itself: caller-side digit
  // formatting is banned, the caller pastes rendered.block verbatim.
  const rows = '| Разработка<br>*gpt-5.6-terra* | 5м 59с | 1 500<br>*кэш 600* | 80 | 1 580 | 3 | 0.0029 |';
  // The ИТОГО line uses the launch-level wall time (5м 0с), not the per-model
  // wall sum (5м 59с).
  const totalRow = '| **ИТОГО** | 5м 0с | 1 500<br>*кэш 600* | 80 | 1 580 | 3 | 0.0029 |';
  assert.deepEqual(result.rendered, {
    block: `Затрачено:\n\n${TABLE_HEADER}\n${rows}\n${totalRow}`,
    table_header: TABLE_HEADER,
    rows,
    total_row: totalRow
  });
  assert.equal(
    result.comment_html,
    '<p>Метрики Разработка: 5м 0с · шаги 3 · $0.0029</p>' +
      '<ul><li><b>gpt-5.6-terra</b>: 5м 59с · вход 1 500 (кэш 600) · выход 80 · всего 1 580 · шаги 3 · $0.0029</li></ul>'
  );
});

test('Codex splits a model switch inside one thread by token_count deltas', async () => {
  const sessionsRoot = await makeLogs({
    'rollout-root.jsonl': [
      codexMeta('thread-root', 'sess-1', '/root/development'),
      codexTurnContext('gpt-5.6-sol', '2026-01-01T10:00:10.000Z'),
      codexTokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 }, '2026-01-01T10:01:00.000Z'),
      codexTurnContext('gpt-5.6-terra', '2026-01-01T10:01:30.000Z'),
      codexTokenCount({ input_tokens: 300, cached_input_tokens: 50, output_tokens: 30, total_tokens: 330 }, '2026-01-01T10:03:00.000Z')
    ]
  });
  const empty = await emptyDir();

  const result = await runCollector({
    runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка',
    codexRoot: sessionsRoot, codexArchivedRoot: empty
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.deepEqual(result.tokens, { input: 300, cached_input: 50, output: 30, total: 330 });
  assert.equal(result.steps, 2);
  // sol: the first cumulative event (100/0/10); terra: the delta of the second
  // (200/50/20). Wall: sol active 10:00:10→10:01:00, terra 10:01:30→10:03:00.
  assert.deepEqual(result.by_model, [
    { model: 'gpt-5.6-sol', wall_seconds: 50, steps: 1, tokens: { input: 100, cached_input: 0, output: 10, total: 110 }, cost_usd: 0.0008 },
    { model: 'gpt-5.6-terra', wall_seconds: 90, steps: 1, tokens: { input: 200, cached_input: 50, output: 20, total: 220 }, cost_usd: 0.0006 }
  ]);
  // Raw sums before rounding: sol 0.0008 + terra 0.00055.
  assert.equal(result.cost_usd, 0.0014);
  assert.equal(
    result.rendered.rows,
    '| Разработка<br>*gpt-5.6-sol* | 0м 50с | 100<br>*кэш 0* | 10 | 110 | 1 | 0.0008 |\n' +
      '| Разработка<br>*gpt-5.6-terra* | 1м 30с | 200<br>*кэш 50* | 20 | 220 | 1 | 0.0006 |'
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

// multi_agent_v1 spawns write agent_path: null; the only parent-side launch
// evidence is the child thread id echoed in tool output.
function codexMultiAgentSpawnOutput(agentId, at = '2026-01-01T10:00:10.000Z') {
  return {
    timestamp: at,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: `call-${agentId}`,
      output: [{ type: 'input_text', text: `{"agent_id":"${agentId}","nickname":"Mencius"}` }]
    }
  };
}

test('Codex resolves a multi_agent_v1 root by thread id when agent_path is null', async () => {
  const root = await makeLogs({
    'root.jsonl': [
      codexMeta('01a0-root-thread', 'sess-1', null),
      codexTurnContext('gpt-5.6-terra'),
      codexTokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 }, '2026-01-01T10:07:00.000Z')
    ]
  });
  const empty = await emptyDir();
  const result = await runCollector({
    runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '01a0-root-thread', label: 'Разработка',
    codexRoot: root, codexArchivedRoot: empty
  });
  assert.equal(result.ok, true);
  assert.equal(result.agents, 1);
  assert.deepEqual(result.tokens, { input: 100, cached_input: 0, output: 10, total: 110 });
  assert.equal(result.wall_seconds, 420);
});

test('Codex multi_agent_v1 children need the parent log to mention their thread id', async () => {
  const childRecords = [
    codexMeta('child-thread', 'root-thread', null),
    codexTurnContext('gpt-5.6-terra', '2026-01-01T10:01:00.000Z'),
    codexTokenCount({ input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, total_tokens: 55 }, '2026-01-01T10:03:00.000Z')
  ];
  const rootRecords = [
    codexMeta('root-thread', 'sess-1', null),
    codexTurnContext('gpt-5.6-terra'),
    codexTokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 }, '2026-01-01T10:04:00.000Z')
  ];
  const evidenced = await makeLogs({
    'root.jsonl': [...rootRecords, codexMultiAgentSpawnOutput('child-thread')],
    'child.jsonl': childRecords
  });
  const unevidenced = await makeLogs({
    'root.jsonl': rootRecords,
    'child.jsonl': childRecords
  });
  const empty = await emptyDir();
  const args = { runtime: 'codex', sessionId: 'sess-1', rootAgentRef: 'root-thread', label: 'Разработка', codexArchivedRoot: empty };

  const result = await runCollector({ ...args, codexRoot: evidenced });
  assert.equal(result.ok, true);
  assert.equal(result.agents, 2);
  assert.deepEqual(result.tokens, { input: 150, cached_input: 0, output: 15, total: 165 });

  assert.deepEqual(await runCollector({ ...args, codexRoot: unevidenced }), failure('workflow_run_incomplete', 'Разработка'));
});

test('Codex rejects a rootAgentRef matching both a task path and a thread id', async () => {
  const root = await makeLogs({
    'path.jsonl': [codexMeta('path-thread', 'sess-1', '/root/development'), codexTurnContext('gpt-5.6-terra')],
    'id.jsonl': [codexMeta('/root/development', 'sess-1', null), codexTurnContext('gpt-5.6-terra')]
  });
  const empty = await emptyDir();
  assert.deepEqual(
    await runCollector({ runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка', codexRoot: root, codexArchivedRoot: empty }),
    failure('ambiguous_root', 'Разработка')
  );
});

// --- whole-session scope (rootAgentRef omitted) -----------------------------

test('Codex whole-session scope sums the session rollout and its spawned tree per model', async () => {
  const sessionsRoot = await makeLogs({
    'main.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-1' } },
      codexTurnContext('gpt-5.6-sol', '2026-01-01T10:00:05.000Z'),
      codexTokenCount({ input_tokens: 1000, cached_input_tokens: 100, output_tokens: 100, total_tokens: 1100 }, '2026-01-01T10:06:00.000Z')
    ],
    'task.jsonl': [
      codexMeta('thread-task', 'sess-1', '/root/development'),
      codexTurnContext('gpt-5.6-terra', '2026-01-01T10:01:00.000Z'),
      codexTokenCount({ input_tokens: 200, cached_input_tokens: 0, output_tokens: 20, total_tokens: 220 }, '2026-01-01T10:02:00.000Z')
    ],
    'foreign.jsonl': [
      codexMeta('thread-foreign', 'sess-2', '/root/review'),
      codexTurnContext('gpt-5.6-terra', '2026-01-01T10:00:30.000Z'),
      codexTokenCount({ input_tokens: 7, output_tokens: 7, total_tokens: 14 }, '2026-01-01T10:00:40.000Z')
    ]
  });
  const empty = await emptyDir();

  const result = await runCollector({ runtime: 'codex', sessionId: 'sess-1', codexRoot: sessionsRoot, codexArchivedRoot: empty });

  assert.equal(result.ok, true);
  assert.equal(result.label, 'Основная сессия');
  assert.equal(result.agents, 2, 'the session itself plus its spawned thread; the foreign session stays out');
  assert.deepEqual(result.models, ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.deepEqual(result.tokens, { input: 1200, cached_input: 100, output: 120, total: 1320 });
  assert.equal(result.steps, 2);
  assert.equal(result.wall_seconds, 360);
  // sol: ((1000-100)*5 + 100*0.5 + 100*30) / 1e6; terra: (200*2 + 20*12) / 1e6.
  assert.deepEqual(result.by_model, [
    { model: 'gpt-5.6-sol', wall_seconds: 355, steps: 1, tokens: { input: 1000, cached_input: 100, output: 100, total: 1100 }, cost_usd: 0.0076 },
    { model: 'gpt-5.6-terra', wall_seconds: 60, steps: 1, tokens: { input: 200, cached_input: 0, output: 20, total: 220 }, cost_usd: 0.0006 }
  ]);
  assert.equal(result.cost_usd, 0.0082);
  assert.equal(
    result.rendered.rows,
    '| Основная сессия<br>*gpt-5.6-sol* | 5м 55с | 1 000<br>*кэш 100* | 100 | 1 100 | 1 | 0.0076 |\n' +
      '| Основная сессия<br>*gpt-5.6-terra* | 1м 0с | 200<br>*кэш 0* | 20 | 220 | 1 | 0.0006 |'
  );
});

test('Codex whole-session scope without the session rollout fails with logs_not_found', async () => {
  const sessionsRoot = await makeLogs({
    'foreign.jsonl': [codexMeta('thread-foreign', 'sess-2', '/root/review'), codexTurnContext('gpt-5.6-terra')]
  });
  const empty = await emptyDir();
  assert.deepEqual(
    await runCollector({ runtime: 'codex', sessionId: 'sess-1', codexRoot: sessionsRoot, codexArchivedRoot: empty }),
    failure('logs_not_found', 'Основная сессия')
  );
});

test('Claude whole-session scope sums the transcript plus every subagent file per model', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid.jsonl': [
      claudeAssistant({
        requestId: 'req1', model: 'claude-fable-5', at: '2026-01-01T10:00:00.000Z',
        usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 100 }
      }),
      claudeAssistant({
        requestId: 'req2', model: 'claude-fable-5', at: '2026-01-01T10:10:00.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      })
    ],
    // No toolUseResult link anywhere — directory membership alone puts the
    // subagent file in scope.
    'proj/sess-uuid/subagents/agent-orphan.jsonl': [
      claudeAssistant({
        requestId: 'req3', model: 'claude-sonnet-5', at: '2026-01-01T10:05:00.000Z',
        usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }
      })
    ],
    'other/other-sess.jsonl': [
      claudeAssistant({
        requestId: 'reqX', model: 'claude-sonnet-5', at: '2026-01-01T09:00:00.000Z',
        usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }
      })
    ]
  });

  const result = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', claudeProjectsRoot: projectsRoot });

  assert.equal(result.ok, true);
  assert.equal(result.label, 'Основная сессия');
  assert.equal(result.agents, 2, 'the session transcript plus one subagent file; other sessions stay out');
  assert.deepEqual(result.models, ['claude-fable-5', 'claude-sonnet-5']);
  assert.deepEqual(result.tokens, { input: 1350, cached_input: 200, output: 115, total: 1465 });
  assert.equal(result.steps, 3);
  assert.equal(result.wall_seconds, 600);
  // fable: (1000*10 + 200*1 + 100*50 + 100*10 + 10*50) / 1e6; sonnet: (50*2 + 5*10) / 1e6.
  assert.deepEqual(result.by_model, [
    { model: 'claude-fable-5', wall_seconds: 600, steps: 2, tokens: { input: 1300, cached_input: 200, output: 110, total: 1410 }, cost_usd: 0.0167 },
    { model: 'claude-sonnet-5', wall_seconds: 0, steps: 1, tokens: { input: 50, cached_input: 0, output: 5, total: 55 }, cost_usd: 0.0001 }
  ]);
  assert.equal(result.cost_usd, 0.0169);
  assert.equal(
    result.rendered.rows,
    '| Основная сессия<br>*claude-fable-5* | 10м 0с | 1 300<br>*кэш 200* | 110 | 1 410 | 2 | 0.0167 |\n' +
      '| Основная сессия<br>*claude-sonnet-5* | 0м 0с | 50<br>*кэш 0* | 5 | 55 | 1 | 0.0001 |'
  );
});

test('Claude whole-session scope failure codes: logs_not_found without the transcript, ambiguous_root on duplicates', async () => {
  const withoutTranscript = await makeLogs({
    'proj/sess-uuid/subagents/agent-root1.jsonl': [
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:00.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
      })
    ]
  });
  assert.deepEqual(
    await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: null, claudeProjectsRoot: withoutTranscript }),
    failure('logs_not_found', 'Основная сессия')
  );

  const doubled = await makeLogs({
    'projA/sess-uuid.jsonl': [{ type: 'user', timestamp: '2026-01-01T10:00:00.000Z' }],
    'projB/sess-uuid.jsonl': [{ type: 'user', timestamp: '2026-01-01T10:00:00.000Z' }]
  });
  assert.deepEqual(
    await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', label: 'Чат', claudeProjectsRoot: doubled }),
    failure('ambiguous_root', 'Чат')
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
  // Per-model wall time spans the model's own records: sonnet 10:00:00→10:02:00,
  // opus has a single record → 0s.
  assert.deepEqual(result.by_model, [
    { model: 'claude-opus-5', wall_seconds: 0, steps: 1, tokens: { input: 100, cached_input: 0, output: 10, total: 110 }, cost_usd: 0.0008 },
    { model: 'claude-sonnet-5', wall_seconds: 120, steps: 2, tokens: { input: 1010, cached_input: 0, output: 105, total: 1115 }, cost_usd: 0.0031 }
  ]);
  assert.equal(result.cost_usd, 0.0038);

  // One table row per model; each row carries that model's own working time.
  assert.equal(
    result.rendered.rows,
    '| PRD<br>*claude-opus-5* | 0м 0с | 100<br>*кэш 0* | 10 | 110 | 1 | 0.0008 |\n' +
      '| PRD<br>*claude-sonnet-5* | 2м 0с | 1 010<br>*кэш 0* | 105 | 1 115 | 2 | 0.0031 |'
  );
  assert.equal(
    result.rendered.total_row,
    '| **ИТОГО** | 2м 0с | 1 110<br>*кэш 0* | 115 | 1 225 | 3 | 0.0038 |'
  );
  assert.equal(result.rendered.block, `Затрачено:\n\n${TABLE_HEADER}\n${result.rendered.rows}\n${result.rendered.total_row}`);
  assert.equal(
    result.comment_html,
    '<p>Метрики PRD: 2м 0с · шаги 3 · $0.0038</p><ul>' +
      '<li><b>claude-opus-5</b>: 0м 0с · вход 100 (кэш 0) · выход 10 · всего 110 · шаги 1 · $0.0008</li>' +
      '<li><b>claude-sonnet-5</b>: 2м 0с · вход 1 010 (кэш 0) · выход 105 · всего 1 115 · шаги 2 · $0.0031</li></ul>'
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
  assert.match(first, /^\| PRD<br>\*claude-sonnet-5-20260101\* \| 0м 0с \| /);
  assert.match(first, /\| 1 \| 0\.003 \|$/);
  assert.match(second, /^\| PRD<br>\*mystery-9\* \| 0м 0с \| /);
  assert.match(second, /\| 1 \| без тарифа \|$/);
  // The ИТОГО $ cell carries the unpriced note, same as comment_html.
  assert.match(result.rendered.total_row, /^\| \*\*ИТОГО\*\* \| .* \| 2 \| 0\.003 \(без тарифа: mystery-9\) \|$/);
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

test('idle gaps over 30 minutes are excluded from wall time; started/ended keep the calendar span', async () => {
  // A session resumed the next day: 5 minutes of work, an overnight gap,
  // 10 more minutes. Wall time is the active sum, not the calendar span.
  const sessionsRoot = await makeLogs({
    'main.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-1' } },
      codexTurnContext('gpt-5.6-terra', '2026-01-01T10:00:00.000Z'),
      codexTokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 }, '2026-01-01T10:05:00.000Z'),
      codexTokenCount({ input_tokens: 300, cached_input_tokens: 0, output_tokens: 30, total_tokens: 330 }, '2026-01-02T09:00:00.000Z'),
      codexTokenCount({ input_tokens: 500, cached_input_tokens: 0, output_tokens: 50, total_tokens: 550 }, '2026-01-02T09:10:00.000Z')
    ]
  });
  const empty = await emptyDir();

  const result = await runCollector({ runtime: 'codex', sessionId: 'sess-1', codexRoot: sessionsRoot, codexArchivedRoot: empty });

  assert.equal(result.ok, true);
  assert.equal(result.started_at, '2026-01-01T10:00:00.000Z');
  assert.equal(result.ended_at, '2026-01-02T09:10:00.000Z');
  assert.equal(result.wall_seconds, 900, '5 minutes on day one plus 10 on day two; the overnight gap does not count');
  assert.equal(result.by_model[0].wall_seconds, 900);
  assert.match(result.rendered.total_row, /^\| \*\*ИТОГО\*\* \| 15м 0с \| /);
});

test('Codex wall time is the union of task_started→task_complete turns; pauses between turns never count', async () => {
  const sessionsRoot = await makeLogs({
    'main.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-1' } },
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      codexTurnContext('gpt-5.6-terra', '2026-01-01T10:00:01.000Z'),
      codexTokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 }, '2026-01-01T10:03:00.000Z'),
      { timestamp: '2026-01-01T10:04:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
      // 10 minutes of the user reading — inside the old 30-minute gap, but
      // between turns, so it must not count.
      { timestamp: '2026-01-01T10:14:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      codexTokenCount({ input_tokens: 300, cached_input_tokens: 0, output_tokens: 30, total_tokens: 330 }, '2026-01-01T10:15:00.000Z'),
      // No task_complete: the interrupted turn closes at the last record.
      codexTokenCount({ input_tokens: 400, cached_input_tokens: 0, output_tokens: 40, total_tokens: 440 }, '2026-01-01T10:16:00.000Z')
    ],
    // Subagent thread working inside the parent's first turn: its own turn
    // overlaps the parent's interval and must count once, not twice.
    'task.jsonl': [
      codexMeta('thread-task', 'sess-1', '/root/development'),
      { timestamp: '2026-01-01T10:01:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      codexTurnContext('gpt-5.6-terra', '2026-01-01T10:01:00.000Z'),
      codexTokenCount({ input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, total_tokens: 55 }, '2026-01-01T10:02:00.000Z'),
      { timestamp: '2026-01-01T10:02:30.000Z', type: 'event_msg', payload: { type: 'task_complete' } }
    ]
  });
  const empty = await emptyDir();

  const result = await runCollector({ runtime: 'codex', sessionId: 'sess-1', codexRoot: sessionsRoot, codexArchivedRoot: empty });

  assert.equal(result.ok, true);
  // Turn one 10:00:00→10:04:00 (240s, subagent inside), turn two
  // 10:14:00→10:16:00 (120s, closed at the last record).
  assert.equal(result.wall_seconds, 360);
  assert.equal(result.started_at, '2026-01-01T10:00:00.000Z');
  assert.equal(result.ended_at, '2026-01-01T10:16:00.000Z');
  // Per-model activity clips to turn intervals: main terra 10:00:01→10:04:00
  // (239s) plus 10:14:00→10:16:00 (120s) — the model segment spans the
  // pause (gap under 30m) but the clip cuts it out; the task thread adds
  // 10:01:00→10:02:30 (90s).
  assert.equal(result.by_model[0].wall_seconds, 239 + 120 + 90);
});

test('Claude wall time runs from each real user message to the last record before the next; think pauses never count', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid.jsonl': [
      { type: 'user', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'go' } },
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:30.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      }),
      // Tool result: a user-typed record but not a turn start.
      { type: 'user', timestamp: '2026-01-01T10:01:00.000Z', message: { role: 'user', content: [] }, toolUseResult: { ok: true } },
      claudeAssistant({
        requestId: 'req2', model: 'claude-sonnet-5', at: '2026-01-01T10:02:00.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      }),
      // 15 minutes of the user thinking — under the 30-minute gap, but
      // between turns, so it must not count.
      { type: 'user', timestamp: '2026-01-01T10:17:00.000Z', message: { role: 'user', content: 'more' } },
      claudeAssistant({
        requestId: 'req3', model: 'claude-sonnet-5', at: '2026-01-01T10:18:00.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      })
    ]
  });

  const result = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', claudeProjectsRoot: projectsRoot });

  assert.equal(result.ok, true);
  // Turn one 10:00:00→10:02:00 (120s), turn two 10:17:00→10:18:00 (60s).
  assert.equal(result.wall_seconds, 180);
  assert.equal(result.started_at, '2026-01-01T10:00:00.000Z');
  assert.equal(result.ended_at, '2026-01-01T10:18:00.000Z');
  // Model segments (10:00:30→10:02:00→…→10:18:00, gaps under 30m) clip to
  // the turn intervals: 90s inside turn one, 60s inside turn two.
  assert.equal(result.by_model[0].wall_seconds, 150);
  assert.equal(result.steps, 3);
});

test('Codex dangling turn closes at the last record before the resume, and turn_aborted closes a turn', async () => {
  const sessionsRoot = await makeLogs({
    'main.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-1' } },
      // Turn one dies without task_complete (crash): its last record is
      // 10:04:00, and the resume next day must not bridge the idle night.
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      codexTurnContext('gpt-5.6-terra', '2026-01-01T10:00:01.000Z'),
      codexTokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 }, '2026-01-01T10:04:00.000Z'),
      { timestamp: '2026-01-02T09:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      // Turn two is interrupted: turn_aborted closes it; the 40-minute
      // pause after the abort must not count even in this marker unit.
      { timestamp: '2026-01-02T09:02:00.000Z', type: 'event_msg', payload: { type: 'turn_aborted' } },
      { timestamp: '2026-01-02T09:42:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      codexTokenCount({ input_tokens: 300, cached_input_tokens: 0, output_tokens: 30, total_tokens: 330 }, '2026-01-02T09:43:00.000Z'),
      { timestamp: '2026-01-02T09:44:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } }
    ]
  });
  const empty = await emptyDir();

  const result = await runCollector({ runtime: 'codex', sessionId: 'sess-1', codexRoot: sessionsRoot, codexArchivedRoot: empty });

  assert.equal(result.ok, true);
  // 240s (crashed turn, closed at its own last record) + 120s (aborted)
  // + 120s (completed). Neither the overnight idle nor the 40m pause count.
  assert.equal(result.wall_seconds, 480);
  assert.equal(result.ended_at, '2026-01-02T09:44:00.000Z');
});

test('Claude non-work records stamped at user-return time never extend a turn', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid.jsonl': [
      { type: 'user', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'go' } },
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:02:00.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      }),
      // The user returns two hours later: queue-operation and system
      // records are stamped at submit time, right before the user record —
      // the turn must still close at the last WORK record (10:02:00).
      { type: 'queue-operation', timestamp: '2026-01-01T12:00:08.000Z', operation: 'enqueue' },
      { type: 'system', timestamp: '2026-01-01T12:00:09.000Z' },
      { type: 'user', timestamp: '2026-01-01T12:00:10.000Z', message: { role: 'user', content: 'more' } },
      claudeAssistant({
        requestId: 'req2', model: 'claude-sonnet-5', at: '2026-01-01T12:01:10.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      })
    ]
  });

  const result = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', claudeProjectsRoot: projectsRoot });

  assert.equal(result.ok, true);
  // Turn one 10:00:00→10:02:00 (120s), turn two 12:00:10→12:01:10 (60s).
  assert.equal(result.wall_seconds, 180);
});

test('Claude subagent tool results without the toolUseResult side-field are work, not turn starts', async () => {
  const projectsRoot = await makeLogs({
    // Real subagent files open with the task prompt (a genuine user record)
    // and store tool results as user-role records with a tool_result
    // content block but NO toolUseResult side-field: they must extend the
    // turn, not restart it — the 5 minutes a tool runs stay counted.
    'proj/sess-uuid/subagents/agent-root1.jsonl': [
      { type: 'user', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'task prompt' } },
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:30.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      }),
      { type: 'user', timestamp: '2026-01-01T10:05:30.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] } },
      claudeAssistant({
        requestId: 'req2', model: 'claude-sonnet-5', at: '2026-01-01T10:06:00.000Z',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
      })
    ]
  });

  const result = await runCollector({
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Разработка',
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  // One turn 10:00:00→10:06:00; the tool_result at 10:05:30 must not split it.
  assert.equal(result.wall_seconds, 360);
  assert.equal(result.by_model[0].wall_seconds, 330, 'model segment 10:00:30→10:06:00 clipped to the turn');
});

test('per-model wall time sums the model span across separate agent files', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid/subagents/agent-root1.jsonl': [
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:00.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
      }),
      claudeAssistant({
        requestId: 'req2', model: 'claude-sonnet-5', at: '2026-01-01T10:00:30.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
      }),
      { type: 'user', timestamp: '2026-01-01T10:00:31.000Z', toolUseResult: { agentId: 'child1' } }
    ],
    'proj/sess-uuid/subagents/agent-child1.jsonl': [
      claudeAssistant({
        requestId: 'req3', model: 'claude-sonnet-5', at: '2026-01-01T10:01:00.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
      }),
      claudeAssistant({
        requestId: 'req4', model: 'claude-sonnet-5', at: '2026-01-01T10:01:40.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
      })
    ]
  });

  const result = await runCollector({
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Ревью',
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  // Root file span 30s + child file span 40s; the gap between files is not attributed.
  assert.equal(result.by_model[0].wall_seconds, 70);
  assert.equal(result.wall_seconds, 100, 'launch wall time stays the full span');
});
