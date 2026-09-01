import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

process.env.TZ = 'UTC';

const execFileAsync = promisify(execFile);
const scriptPath = join(process.cwd(), 'skills', 'agent-usage', 'scripts', 'agent-usage.mjs');
const fixturesRoot = join(process.cwd(), 'tests', 'fixtures');

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

async function loadFixture(name) {
  return JSON.parse(await readFile(join(fixturesRoot, name), 'utf8'));
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

function codexTurnContext(model, at = '2026-01-01T10:00:01.000Z', serviceTier = 'default') {
  return { timestamp: at, type: 'turn_context', payload: { model, service_tier: serviceTier } };
}

function codexTokenCount(usage, at) {
  return { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage } } };
}

function claudeAssistant({ requestId, model, usage, at }) {
  return { type: 'assistant', requestId, timestamp: at, message: { model, usage } };
}

const round4 = (value) => Math.round(value * 10_000) / 10_000;

function tokenBreakdown(input, cachedInput, output, cacheWriteInput = 0) {
  return {
    input,
    uncached_input: input - cachedInput - cacheWriteInput,
    cache_read_input: cachedInput,
    cache_write_input: cacheWriteInput,
    cached_input: cachedInput,
    output,
    total: input + output
  };
}

const TABLE_HEADER = '| Роль | Время | Шаги | Токены всего | В т.ч. кэш | Выход | $ |\n|---|---:|---:|---:|---:|---:|---:|';

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
    { runtime: 'codex', label: 'Основная сессия' },
    { runtime: 'claude', sessionId: 's', full: 'yes' }
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
    runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка', full: true,
    codexRoot: sessionsRoot, codexArchivedRoot: archivedRoot
  });

  assert.equal(result.ok, true);
  assert.equal(result.label, 'Разработка');
  assert.equal(result.source, 'codex');
  assert.equal(result.agents, 2);
  assert.deepEqual(result.models, ['gpt-5.6-terra']);
  assert.deepEqual(result.tokens, tokenBreakdown(1500, 600, 80));
  assert.equal(result.started_at, '2026-01-01T10:00:00.000Z');
  assert.equal(result.ended_at, '2026-01-01T10:05:00.000Z');
  assert.equal(result.wall_seconds, 300);
  // Steps = API model requests: one per token_count event (2 root + 1 child).
  assert.equal(result.steps, 3);
  // gpt-5.6-terra: ((1500-600)*2 + 600*0.2 + 80*12) / 1e6.
  assert.equal(result.cost_usd, 0.00288);
  assert.equal(result.token_cost_usd, 0.00288);
  assert.deepEqual(result.cost_breakdown_usd, {
    uncached_input: 0.0018, cache_read_input: 0.00012, cache_write_input: 0, output: 0.00096, total: 0.00288
  });
  assert.equal(result.pricing.status, 'priced');
  assert.deepEqual(result.pricing.service_tiers, ['default']);
  assert.deepEqual(result.unpriced_models, []);
  // Per-model wall time sums the spans while the model was active: root
  // 10:00:01 (turn_context) → 10:05:00 (299s) + child 10:02:00→10:03:00 (60s).
  assert.deepEqual(result.by_model.map(({ cost_breakdown_usd, ...row }) => row), [
    {
      model: 'gpt-5.6-terra', service_tiers: ['default'], wall_seconds: 359, steps: 3,
      tokens: tokenBreakdown(1500, 600, 80), token_cost_usd: 0.00288, cost_usd: 0.00288
    }
  ]);

  // The collector renders the «Затрачено» block itself: caller-side digit
  // formatting is banned, the caller pastes rendered.block verbatim. One
  // row per launch × model: the root under the report label, the spawned
  // thread under its role name derived from agent_path.
  assert.deepEqual(result.by_launch.map(({ cost_breakdown_usd, ...row }) => row), [
    {
      launch: 'Разработка', model: 'gpt-5.6-terra', service_tier: 'default', wall_seconds: 299,
      steps: 2, tokens: tokenBreakdown(1000, 400, 50), token_cost_usd: 0.00188, cost_usd: 0.00188
    },
    {
      launch: 'Helper', model: 'gpt-5.6-terra', service_tier: 'default', wall_seconds: 60,
      steps: 1, tokens: tokenBreakdown(500, 200, 30), token_cost_usd: 0.001, cost_usd: 0.001
    }
  ]);
  const rows =
    '| Разработка<br>*gpt-5.6-terra · default* | 4м 59с | 2 | 1 000 | 400 | 50 | 0.001 |\n' +
    '| Helper<br>*gpt-5.6-terra · default* | 1м 0с | 1 | 500 | 200 | 30 | 0.001 |';
  // The ИТОГО line uses the launch-level wall time (5м 0с), not the per-model
  // wall sum (5м 59с).
  const totalRow = '| **ИТОГО** | 5м 0с | 3 | 1 500 | 600 | 80 | 0.002 |';
  assert.deepEqual(result.rendered, {
    block: `Затрачено:\n\n${TABLE_HEADER}\n${rows}\n${totalRow}`,
    table_header: TABLE_HEADER,
    rows,
    total_row: totalRow
  });
  assert.equal(
    result.comment_html,
    '<p>Метрики Разработка: 5м 0с · шаги 3 · $ 0.002</p>' +
      '<ul><li><b>Разработка · gpt-5.6-terra · default</b>: 4м 59с · шаги 2 · токены всего 1 000 · в т.ч. кэш 400 · выход 50 · $ 0.001</li>' +
      '<li><b>Helper · gpt-5.6-terra · default</b>: 1м 0с · шаги 1 · токены всего 500 · в т.ч. кэш 200 · выход 30 · $ 0.001</li></ul>'
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
    runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '/root/development', label: 'Разработка', full: true,
    codexRoot: sessionsRoot, codexArchivedRoot: empty
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.deepEqual(result.tokens, tokenBreakdown(300, 50, 30));
  assert.equal(result.steps, 2);
  // sol: the first cumulative event (100/0/10); terra: the delta of the second
  // (200/50/20). Wall: sol active 10:00:10→10:01:00, terra 10:01:30→10:03:00.
  assert.deepEqual(result.by_model.map(({ cost_breakdown_usd, ...row }) => row), [
    {
      model: 'gpt-5.6-sol', service_tiers: ['default'], wall_seconds: 50, steps: 1,
      tokens: tokenBreakdown(100, 0, 10), token_cost_usd: 0.0006, cost_usd: 0.0006
    },
    {
      model: 'gpt-5.6-terra', service_tiers: ['default'], wall_seconds: 90, steps: 1,
      tokens: tokenBreakdown(200, 50, 20), token_cost_usd: 0.00055, cost_usd: 0.00055
    }
  ]);
  assert.equal(result.cost_usd, 0.00115);
  assert.equal(
    result.rendered.rows,
    '| Разработка<br>*gpt-5.6-sol · default* | 0м 50с | 1 | 100 | 0 | 10 | 0.000 |\n' +
      '| Разработка<br>*gpt-5.6-terra · default* | 1м 30с | 1 | 200 | 50 | 20 | 0.000 |'
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
    runtime: 'codex', sessionId: 'sess-1', rootAgentRef: '01a0-root-thread', label: 'Разработка', full: true,
    codexRoot: root, codexArchivedRoot: empty
  });
  assert.equal(result.ok, true);
  assert.equal(result.agents, 1);
  assert.deepEqual(result.tokens, tokenBreakdown(100, 0, 10));
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
  const args = { runtime: 'codex', sessionId: 'sess-1', rootAgentRef: 'root-thread', label: 'Разработка', full: true, codexArchivedRoot: empty };

  const result = await runCollector({ ...args, codexRoot: evidenced });
  assert.equal(result.ok, true);
  assert.equal(result.agents, 2);
  assert.deepEqual(result.tokens, tokenBreakdown(150, 0, 15));

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

  const result = await runCollector({ runtime: 'codex', sessionId: 'sess-1', full: true, codexRoot: sessionsRoot, codexArchivedRoot: empty });

  assert.equal(result.ok, true);
  assert.equal(result.label, 'Основная сессия');
  assert.equal(result.agents, 2, 'the session itself plus its spawned thread; the foreign session stays out');
  assert.deepEqual(result.models, ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.deepEqual(result.tokens, tokenBreakdown(1200, 100, 120));
  assert.equal(result.steps, 2);
  assert.equal(result.wall_seconds, 360);
  // sol: ((1000-100)*4 + 100*0.4 + 100*20) / 1e6; terra: (200*2 + 20*12) / 1e6.
  assert.deepEqual(result.by_model.map(({ cost_breakdown_usd, ...row }) => row), [
    {
      model: 'gpt-5.6-sol', service_tiers: ['default'], wall_seconds: 355, steps: 1,
      tokens: tokenBreakdown(1000, 100, 100), token_cost_usd: 0.00564, cost_usd: 0.00564
    },
    {
      model: 'gpt-5.6-terra', service_tiers: ['default'], wall_seconds: 60, steps: 1,
      tokens: tokenBreakdown(200, 0, 20), token_cost_usd: 0.00064, cost_usd: 0.00064
    }
  ]);
  assert.equal(result.cost_usd, 0.00628);
  // The spawned thread rows under its role name (/root/development → Разработка), not the session label.
  assert.equal(
    result.rendered.rows,
    '| Основная сессия<br>*gpt-5.6-sol · default* | 5м 55с | 1 | 1 000 | 100 | 100 | 0.005 |\n' +
      '| Разработка<br>*gpt-5.6-terra · default* | 1м 0с | 1 | 200 | 0 | 20 | 0.000 |'
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

  const result = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', full: true, claudeProjectsRoot: projectsRoot });

  assert.equal(result.ok, true);
  assert.equal(result.label, 'Основная сессия');
  assert.equal(result.agents, 2, 'the session transcript plus one subagent file; other sessions stay out');
  assert.deepEqual(result.models, ['claude-fable-5', 'claude-sonnet-5']);
  assert.deepEqual(result.tokens, tokenBreakdown(1350, 200, 115));
  assert.equal(result.steps, 3);
  assert.equal(result.wall_seconds, 600);
  // fable: (1000*10 + 200*1 + 100*50 + 100*10 + 10*50) / 1e6; sonnet: (50*2 + 5*10) / 1e6.
  assert.deepEqual(result.by_model.map(({ cost_breakdown_usd, ...row }) => row), [
    {
      model: 'claude-fable-5', service_tiers: ['standard'], wall_seconds: 600, steps: 2,
      tokens: tokenBreakdown(1300, 200, 110), token_cost_usd: 0.0167, cost_usd: 0.0167
    },
    {
      model: 'claude-sonnet-5', service_tiers: ['standard'], wall_seconds: 0, steps: 1,
      tokens: tokenBreakdown(50, 0, 5), token_cost_usd: 0.00015, cost_usd: 0.00015
    }
  ]);
  assert.equal(result.cost_usd, 0.01685);
  // The unlinked subagent has no Task tool_use name to inherit, so it rows
  // under the id-prefix placeholder.
  assert.equal(
    result.rendered.rows,
    '| Основная сессия<br>*claude-fable-5 · standard* | 10м 0с | 2 | 1 300 | 200 | 110 | 0.016 |\n' +
      '| Сабагент orphan<br>*claude-sonnet-5 · standard* | 0м 0с | 1 | 50 | 0 | 5 | 0.000 |'
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
      { type: 'assistant', requestId: 'req2', timestamp: '2026-01-01T10:00:06.000Z', message: { model: '<synthetic>', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Помощник ревью' } }] } },
      { type: 'user', timestamp: '2026-01-01T10:00:07.000Z', toolUseResult: { agentId: 'child1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } }
    ],
    'proj/sess-uuid/subagents/agent-child1.jsonl': [
      claudeAssistant({
        requestId: 'req3', model: 'claude-sonnet-5', at: '2026-01-01T10:02:00.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }
      })
    ]
  });

  const result = await runCollector({
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Ревью', full: true,
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  assert.equal(result.label, 'Ревью');
  assert.equal(result.source, 'claude');
  assert.equal(result.agents, 2);
  assert.deepEqual(result.models, ['claude-sonnet-5'], '<synthetic> never reaches the model list');
  // input = input_tokens + cache_creation + cache_read; req1 keeps only the last record.
  assert.deepEqual(result.tokens, tokenBreakdown(610, 300, 45, 200));
  // Steps = distinct API requests with usage: req1 (deduped) + req3; the
  // usage-less <synthetic> req2 does not count.
  assert.equal(result.steps, 2);
  assert.equal(result.wall_seconds, 120);
  // Generic cache_creation_input_tokens does not prove whether the write used
  // the 5m or 1h tariff, so token totals stay exact and pricing fails closed.
  assert.equal(result.cost_usd, null);
  assert.deepEqual(result.unpriced_models, ['claude-sonnet-5']);
  assert.deepEqual(result.pricing.issues.map((issue) => issue.code), ['tariff_not_found']);
  // The nested subagent rows under the parent's tool_use description.
  assert.deepEqual(result.by_launch.map((row) => row.launch), ['Ревью', 'Помощник ревью']);
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
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'PRD', full: true,
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(result.tokens, tokenBreakdown(1110, 0, 115));
  assert.equal(result.steps, 3);
  // opus: (100*5 + 10*25) / 1e6; sonnet: (1010*2 + 105*10) / 1e6; total from raw sums.
  // Per-model wall time spans the model's own records: sonnet 10:00:00→10:02:00,
  // opus has a single record → 0s.
  assert.deepEqual(result.by_model.map(({ cost_breakdown_usd, ...row }) => row), [
    {
      model: 'claude-opus-5', service_tiers: ['standard'], wall_seconds: 0, steps: 1,
      tokens: tokenBreakdown(100, 0, 10), token_cost_usd: 0.00075, cost_usd: 0.00075
    },
    {
      model: 'claude-sonnet-5', service_tiers: ['standard'], wall_seconds: 120, steps: 2,
      tokens: tokenBreakdown(1010, 0, 105), token_cost_usd: 0.00307, cost_usd: 0.00307
    }
  ]);
  assert.equal(result.cost_usd, 0.00382);

  // One table row per model; each row carries that model's own working time.
  assert.equal(
    result.rendered.rows,
    '| PRD<br>*claude-opus-5 · standard* | 0м 0с | 1 | 100 | 0 | 10 | 0.000 |\n' +
      '| PRD<br>*claude-sonnet-5 · standard* | 2м 0с | 2 | 1 010 | 0 | 105 | 0.003 |'
  );
  assert.equal(
    result.rendered.total_row,
    '| **ИТОГО** | 2м 0с | 3 | 1 110 | 0 | 115 | 0.003 |'
  );
  assert.equal(result.rendered.block, `Затрачено:\n\n${TABLE_HEADER}\n${result.rendered.rows}\n${result.rendered.total_row}`);
  assert.equal(
    result.comment_html,
    '<p>Метрики PRD: 2м 0с · шаги 3 · $ 0.003</p><ul>' +
      '<li><b>PRD · claude-opus-5 · standard</b>: 0м 0с · шаги 1 · токены всего 100 · в т.ч. кэш 0 · выход 10 · $ 0.000</li>' +
      '<li><b>PRD · claude-sonnet-5 · standard</b>: 2м 0с · шаги 2 · токены всего 1 010 · в т.ч. кэш 0 · выход 105 · $ 0.003</li></ul>'
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

test('Codex modern last_token_usage prices uncached, cache read, cache write, and output exactly', async () => {
  const sessionsRoot = await makeLogs({
    'modern.jsonl': await loadFixture('codex-token-count-modern.json')
  });
  const empty = await emptyDir();

  const result = await runCollector({
    runtime: 'codex', sessionId: 'sanitized-modern-codex', analyze: true, full: true,
    codexRoot: sessionsRoot, codexArchivedRoot: empty
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tokens, tokenBreakdown(100000, 80000, 1000, 10000));
  assert.equal(result.token_cost_usd, 0.142);
  assert.equal(result.cost_usd, 0.142);
  assert.deepEqual(result.cost_breakdown_usd, {
    uncached_input: 0.04,
    cache_read_input: 0.032,
    cache_write_input: 0.05,
    output: 0.02,
    total: 0.142
  });
  assert.equal(result.pricing.status, 'priced');
  assert.deepEqual(result.pricing.service_tiers, ['default']);
  assert.deepEqual(result.pricing.issues, []);
  assert.equal(result.analysis.cache.read, result.tokens.cache_read_input);
  assert.equal(result.analysis.cache.write, result.tokens.cache_write_input);
});

test('Codex long-context pricing switches only above 272000 input tokens', async () => {
  const collectAt = async (input, id) => {
    const usage = { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 100, total_tokens: input + 100 };
    const sessionsRoot = await makeLogs({
      [`${id}.jsonl`]: [
        { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id } },
        codexTurnContext('gpt-5.6-sol'),
        codexStep(usage, usage, '2026-01-01T10:00:02.000Z')
      ]
    });
    return runCollector({ runtime: 'codex', sessionId: id, full: true, codexRoot: sessionsRoot, codexArchivedRoot: await emptyDir() });
  };

  const threshold = await collectAt(272000, 'at-threshold');
  const above = await collectAt(272001, 'above-threshold');

  assert.equal(threshold.cost_usd, 1.09);
  assert.equal(threshold.pricing.long_context_steps, 0);
  assert.equal(above.cost_usd, 2.179008);
  assert.deepEqual(above.cost_breakdown_usd, {
    uncached_input: 2.176008,
    cache_read_input: 0,
    cache_write_input: 0,
    output: 0.003,
    total: 2.179008
  });
  assert.equal(above.pricing.long_context_steps, 1);
});

test('Codex ignores repeated cumulative events and starts a new segment after a counter reset', async () => {
  const first = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 10, total_tokens: 110 };
  const reset = { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 5, output_tokens: 5, total_tokens: 55 };
  const sessionsRoot = await makeLogs({
    'main.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'dedup-reset' } },
      codexTurnContext('gpt-5.6-terra'),
      codexStep(first, first, '2026-01-01T10:00:02.000Z'),
      codexStep(first, first, '2026-01-01T10:00:03.000Z'),
      codexStep(reset, reset, '2026-01-01T10:00:04.000Z')
    ]
  });

  const result = await runCollector({
    runtime: 'codex', sessionId: 'dedup-reset', full: true, codexRoot: sessionsRoot, codexArchivedRoot: await emptyDir()
  });

  assert.equal(result.steps, 2);
  assert.deepEqual(result.tokens, tokenBreakdown(150, 30, 15, 15));
  assert.equal(result.pricing.status, 'priced');
});

test('Codex keeps cumulative tokens but fails pricing closed on last/delta mismatch or invalid breakdown', async () => {
  const mismatchTotal = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 10, total_tokens: 110 };
  const mismatchLast = { input_tokens: 90, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 10, total_tokens: 100 };
  const mismatchRoot = await makeLogs({
    'mismatch.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'mismatch' } },
      codexTurnContext('gpt-5.6-sol'),
      codexStep(mismatchLast, mismatchTotal, '2026-01-01T10:00:02.000Z')
    ]
  });
  const mismatch = await runCollector({
    runtime: 'codex', sessionId: 'mismatch', full: true, codexRoot: mismatchRoot, codexArchivedRoot: await emptyDir()
  });

  assert.deepEqual(mismatch.tokens, tokenBreakdown(100, 20, 10, 10));
  assert.equal(mismatch.cost_usd, null);
  assert.deepEqual(mismatch.pricing.issues.map((issue) => issue.code), ['usage_mismatch']);

  const invalidUsage = { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 30, output_tokens: 10, total_tokens: 110 };
  const invalidRoot = await makeLogs({
    'invalid.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'invalid' } },
      codexTurnContext('gpt-5.6-sol'),
      codexStep(invalidUsage, invalidUsage, '2026-01-01T10:00:02.000Z')
    ]
  });
  const invalid = await runCollector({
    runtime: 'codex', sessionId: 'invalid', full: true, codexRoot: invalidRoot, codexArchivedRoot: await emptyDir()
  });

  assert.deepEqual(invalid.tokens, tokenBreakdown(100, 80, 10, 20));
  assert.equal(invalid.cost_usd, null);
  assert.deepEqual(invalid.pricing.issues.map((issue) => issue.code), ['invalid_token_breakdown']);
});

test('Codex separates service tiers, requires actual Fast evidence, prices an unrecorded tier as Standard, and honors reroutes', async () => {
  const first = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, total_tokens: 110 };
  const cumulative = { input_tokens: 200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, total_tokens: 220 };
  const fastStep = codexStep(first, cumulative, '2026-01-01T10:00:04.000Z');
  fastStep.payload.info.actual_service_tier = 'fast';
  const sessionsRoot = await makeLogs({
    'tiers.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'tier-split' } },
      codexTurnContext('gpt-5.6-sol'),
      codexStep(first, first, '2026-01-01T10:00:02.000Z'),
      { timestamp: '2026-01-01T10:00:03.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'fast' } } },
      fastStep
    ],
    'reroute.jsonl': [
      { timestamp: '2026-01-01T11:00:00.000Z', type: 'session_meta', payload: { id: 'reroute' } },
      codexTurnContext('gpt-5.6-sol', '2026-01-01T11:00:01.000Z'),
      { timestamp: '2026-01-01T11:00:02.000Z', type: 'event_msg', payload: { type: 'model/rerouted', toModel: 'gpt-5.6-terra' } },
      codexStep(first, first, '2026-01-01T11:00:03.000Z')
    ]
  });
  const empty = await emptyDir();

  const split = await runCollector({ runtime: 'codex', sessionId: 'tier-split', full: true, codexRoot: sessionsRoot, codexArchivedRoot: empty });
  assert.deepEqual(split.by_launch.map((row) => row.service_tier), ['default', 'fast']);
  assert.deepEqual(split.by_launch.map((row) => row.cost_usd), [0.0006, 0.0012]);
  assert.equal(split.cost_usd, 0.0018);

  const rerouted = await runCollector({ runtime: 'codex', sessionId: 'reroute', full: true, codexRoot: sessionsRoot, codexArchivedRoot: empty });
  // The pre-reroute model bucket saw wall stamps but no request: dropped.
  assert.deepEqual(rerouted.by_launch.map((row) => row.model), ['gpt-5.6-terra']);
  assert.equal(rerouted.cost_usd, 0.00032);

  const unprovenRoot = await makeLogs({
    'unproven.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'unproven-fast' } },
      codexTurnContext('gpt-5.6-sol', '2026-01-01T10:00:01.000Z', 'fast'),
      codexStep(first, first, '2026-01-01T10:00:02.000Z')
    ]
  });
  const unproven = await runCollector({ runtime: 'codex', sessionId: 'unproven-fast', full: true, codexRoot: unprovenRoot, codexArchivedRoot: empty });
  assert.equal(unproven.cost_usd, null);
  assert.deepEqual(unproven.pricing.issues.map((issue) => issue.code), ['actual_service_tier_unknown']);

  const missingTierRoot = await makeLogs({
    'missing-tier.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'missing-tier' } },
      { timestamp: '2026-01-01T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      codexStep(first, first, '2026-01-01T10:00:02.000Z')
    ]
  });
  // Spawned subagent threads never record a service tier: absence is the
  // unset default and prices as Standard, not as an unknown override.
  const missingTier = await runCollector({ runtime: 'codex', sessionId: 'missing-tier', full: true, codexRoot: missingTierRoot, codexArchivedRoot: empty });
  assert.equal(missingTier.cost_usd, 0.0006);
  assert.deepEqual(missingTier.pricing.issues, []);
  assert.equal(missingTier.pricing.status, 'priced');
  assert.deepEqual(missingTier.by_launch.map((row) => row.service_tier), ['default']);
});

test('Claude normalizes cache reads and exact mixed 5m/1h cache writes', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid/subagents/agent-root1.jsonl': [
      claudeAssistant({
        requestId: 'req1', model: 'claude-sonnet-5', at: '2026-01-01T10:00:00.000Z',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 200,
          output_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }
        }
      })
    ]
  });

  const result = await runCollector({
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Ревью', analyze: true, full: true,
    claudeProjectsRoot: projectsRoot
  });

  assert.deepEqual(result.tokens, tokenBreakdown(600, 200, 10, 300));
  assert.equal(result.cost_usd, 0.00139);
  assert.deepEqual(result.cost_breakdown_usd, {
    uncached_input: 0.0002,
    cache_read_input: 0.00004,
    cache_write_input: 0.00105,
    output: 0.0001,
    total: 0.00139
  });
  assert.equal(result.analysis.cache.read, result.tokens.cache_read_input);
  assert.equal(result.analysis.cache.write, result.tokens.cache_write_input);
});

test('pricing matches documented snapshots and fails the report closed on an unknown model', async () => {
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
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'PRD', full: true,
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['claude-sonnet-5-20260101', 'mystery-9']);
  assert.deepEqual(result.tokens, tokenBreakdown(1050, 0, 105));
  assert.equal(result.steps, 2);
  assert.equal(result.cost_usd, null);
  assert.deepEqual(result.unpriced_models, ['mystery-9']);
  assert.deepEqual(result.pricing.issues.map((issue) => issue.code), ['unknown_model']);
  const [priced, unpriced] = result.by_model;
  assert.equal(priced.cost_usd, 0.003);
  assert.equal(unpriced.cost_usd, null);
  const [first, second] = result.rendered.rows.split('\n');
  assert.match(first, /^\| PRD<br>\*claude-sonnet-5-20260101 · standard\* \| 0м 0с \| /);
  assert.match(first, /\| 1 \| 1 000 \| 0 \| 100 \| 0\.003 \|$/);
  assert.match(second, /^\| PRD<br>\*mystery-9 · standard\* \| 0м 0с \| /);
  assert.match(second, /\| 1 \| 50 \| 0 \| 5 \| тариф не определён \|$/);
  assert.match(result.rendered.total_row, /^\| \*\*ИТОГО\*\* \| .* \| 2 \| 1 050 \| 0 \| 105 \| тариф не определён \|$/);
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
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Ревью', full: true,
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tokens, tokenBreakdown(3238493, 1238493, 323885));
  assert.equal(result.wall_seconds, 754);
  assert.equal(result.steps, 2);
  assert.equal(
    result.rendered.rows,
    `| Ревью<br>*claude-sonnet-5 · standard* | 12м 34с | 2 | 3.24М | 1.24М | 323 885 | 7.486 |`
  );
  // A one-row table carries no ИТОГО: the total would only repeat the row.
  assert.equal('total_row' in result.rendered, false);
  assert.equal(result.rendered.block, `Затрачено:\n\n${TABLE_HEADER}\n${result.rendered.rows}`);
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

  const result = await runCollector({ runtime: 'codex', sessionId: 'sess-1', full: true, codexRoot: sessionsRoot, codexArchivedRoot: empty });

  assert.equal(result.ok, true);
  assert.equal(result.started_at, '2026-01-01T10:00:00.000Z');
  assert.equal(result.ended_at, '2026-01-02T09:10:00.000Z');
  assert.equal(result.wall_seconds, 900, '5 minutes on day one plus 10 on day two; the overnight gap does not count');
  assert.equal(result.by_model[0].wall_seconds, 900);
  assert.match(result.rendered.rows, /^\| Основная сессия<br>\*gpt-5\.6-terra · default\* \| 15м 0с \| /);
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

  const result = await runCollector({ runtime: 'codex', sessionId: 'sess-1', full: true, codexRoot: sessionsRoot, codexArchivedRoot: empty });

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

  const result = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', full: true, claudeProjectsRoot: projectsRoot });

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

  const result = await runCollector({ runtime: 'codex', sessionId: 'sess-1', full: true, codexRoot: sessionsRoot, codexArchivedRoot: empty });

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

  const result = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', full: true, claudeProjectsRoot: projectsRoot });

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
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Разработка', full: true,
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
    runtime: 'claude', sessionId: 'sess-uuid', rootAgentRef: 'root1', label: 'Ревью', full: true,
    claudeProjectsRoot: projectsRoot
  });

  assert.equal(result.ok, true);
  // Root file span 30s + child file span 40s; the gap between files is not attributed.
  assert.equal(result.by_model[0].wall_seconds, 70);
  assert.equal(result.wall_seconds, 100, 'launch wall time stays the full span');
});

// --- analysis mode (analyze: true) ------------------------------------------

function claudeStep({ requestId, at, ctx, output, toolUse }) {
  const record = {
    type: 'assistant',
    requestId,
    timestamp: at,
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: ctx, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output }
    }
  };
  if (toolUse) record.message.content = [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }];
  return record;
}

function claudeToolResult({ at, id, text, isError = false }) {
  return {
    type: 'user',
    timestamp: at,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }
  };
}

function codexToolCall(callId, name, args, at) {
  return { timestamp: at, type: 'response_item', payload: { type: 'function_call', call_id: callId, name, arguments: args } };
}

function codexToolOutput(callId, output, at) {
  return { timestamp: at, type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } };
}

function codexStep(lastUsage, totalUsage, at) {
  return {
    timestamp: at,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: totalUsage, last_token_usage: lastUsage } }
  };
}

// Four steps whose context grows 100 → 1000 → 1500 → 2000, with one tool
// result landing in each of the first two gaps.
function claudeAnalysisLog(finalCtx) {
  return {
    'proj/sess-uuid.jsonl': [
      { type: 'user', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'go' } },
      claudeStep({ requestId: 'r1', at: '2026-01-01T10:00:01.000Z', ctx: 100, output: 10, toolUse: { id: 't1', name: 'Read', input: { file_path: '/a.txt' } } }),
      claudeToolResult({ at: '2026-01-01T10:00:02.000Z', id: 't1', text: 'a'.repeat(4000) }),
      claudeStep({ requestId: 'r2', at: '2026-01-01T10:00:03.000Z', ctx: 1000, output: 10, toolUse: { id: 't2', name: 'Read', input: { file_path: '/b.txt' } } }),
      claudeToolResult({ at: '2026-01-01T10:00:04.000Z', id: 't2', text: 'b'.repeat(2000) }),
      claudeStep({ requestId: 'r3', at: '2026-01-01T10:00:05.000Z', ctx: 1500, output: 10 }),
      claudeStep({ requestId: 'r4', at: '2026-01-01T10:00:06.000Z', ctx: 2000, output: 10 }),
      claudeStep({ requestId: 'r5', at: '2026-01-01T10:00:07.000Z', ctx: finalCtx, output: 10 })
    ]
  };
}

test('analysis is opt-in: absent by default, non-boolean analyze is a caller bug', async () => {
  const projectsRoot = await makeLogs(claudeAnalysisLog(2500));

  const plain = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', claudeProjectsRoot: projectsRoot });
  assert.equal(plain.ok, true);
  assert.equal('analysis' in plain, false, 'existing callers never see the analysis payload');
  assert.equal('analysis_block' in plain.rendered, false, 'rendered.block stays the only launch table');
  // Default output is the caller contract: rendered strings only — the
  // machine fields (tokens, by_launch, pricing, …) appear with full:true.
  assert.deepEqual(Object.keys(plain).sort(), ['comment_html', 'label', 'ok', 'rendered']);

  // analyze without full: the rendered analysis block is there, the raw
  // attribution object still is not.
  const analyzed = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', analyze: true, claudeProjectsRoot: projectsRoot });
  assert.match(analyzed.rendered.analysis_block, /^Анализ контекста:/);
  assert.deepEqual(Object.keys(analyzed).sort(), ['comment_html', 'label', 'ok', 'rendered']);

  assert.equal(
    (await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', analyze: 'yes', claudeProjectsRoot: projectsRoot })).code,
    'bad_args'
  );
});

test('Claude attribution splits the measured context growth and charges each chunk for later steps', async () => {
  const projectsRoot = await makeLogs(claudeAnalysisLog(2500));

  const result = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', analyze: true, full: true, claudeProjectsRoot: projectsRoot });

  assert.equal(result.ok, true);
  const { analysis } = result;
  assert.equal(analysis.requests, 5);
  // Gap 1 grew 900 and the previous step wrote 10 of it itself → 890 to /a.txt;
  // gap 2 grew 500 minus 10 → 490 to /b.txt. One result per gap, so exact.
  assert.deepEqual(analysis.by_detail, [
    // /a.txt is re-sent by steps 3, 4 and 5: 890 × 3. Priced as one cache
    // write plus three cache reads on opus-5 (6.25 / 0.5 per 1M).
    { detail: 'Read · /a.txt', calls: 1, errors: 0, injected: 890, resent: 2670, estimated_cost_usd: 0.0069 },
    // /b.txt lands one step later, so it is re-sent twice.
    { detail: 'Read · /b.txt', calls: 1, errors: 0, injected: 490, resent: 980, estimated_cost_usd: 0.0036 }
  ]);
  assert.deepEqual(analysis.by_tool, [{ tool: 'Read', calls: 2, errors: 0, injected: 1380, resent: 3650, estimated_cost_usd: 0.0104 }]);
  // The opening context belongs to no tool and is re-sent by every later step.
  assert.deepEqual(analysis.base, { tokens: 100, per_unit: 100, resent: 400, share: analysis.base.share, estimated_cost_usd: 0.0008 });
  assert.equal(analysis.context.growth, 2400);
  assert.equal(analysis.coverage.attributed, 1380);
  assert.equal(analysis.resets, 0);
  assert.equal(analysis.per_step.growth, 480, 'context gained per model request');
  assert.equal(analysis.accuracy, 'inferred');
  assert.equal(analysis.per_step.estimated_cost_usd, round4(result.cost_usd / 5));
  assert.match(result.rendered.analysis_block, /^Анализ контекста:/);
  assert.match(result.rendered.analysis_block, /\| Read \| 2 \| 1 380 \| 3 650 \| — \| ≈\$0\.01 \|/);
  // The verdict is prose with the same figures, never a second table.
  assert.match(result.rendered.analysis_block, /\*\*Куда ушло больше всего\.\*\*/);
  assert.match(result.rendered.analysis_block, /\*\*Read\*\* — ≈\$0\.01\. 2 вызова/);
  assert.match(result.rendered.analysis_block, /\*\*На будущее\.\*\* Оценка составила ≈\$[\d.]+ за шаг на 5 шагах\./);
});

test('a context reset ends the segment so earlier chunks stop being charged', async () => {
  // The last step's context collapses to 400 — a compaction: nothing injected
  // before it survives into the steps that follow.
  const projectsRoot = await makeLogs(claudeAnalysisLog(400));

  const { analysis } = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', analyze: true, full: true, claudeProjectsRoot: projectsRoot });

  assert.equal(analysis.resets, 1);
  // /a.txt is now re-sent by steps 3 and 4 only: 890 × 2, not × 3.
  assert.deepEqual(analysis.by_detail, [
    { detail: 'Read · /a.txt', calls: 1, errors: 0, injected: 890, resent: 1780, estimated_cost_usd: 0.0065 },
    { detail: 'Read · /b.txt', calls: 1, errors: 0, injected: 490, resent: 490, estimated_cost_usd: 0.0033 }
  ]);
});

test('repeats list only content-bearing sources, not repeated command words', async () => {
  const projectsRoot = await makeLogs({
    'proj/sess-uuid.jsonl': [
      { type: 'user', timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'user', content: 'go' } },
      claudeStep({ requestId: 'r1', at: '2026-01-01T10:00:01.000Z', ctx: 100, output: 10, toolUse: { id: 't1', name: 'Read', input: { file_path: '/a.txt' } } }),
      claudeToolResult({ at: '2026-01-01T10:00:02.000Z', id: 't1', text: 'a'.repeat(400) }),
      claudeStep({ requestId: 'r2', at: '2026-01-01T10:00:03.000Z', ctx: 1000, output: 10, toolUse: { id: 't2', name: 'Read', input: { file_path: '/a.txt' } } }),
      claudeToolResult({ at: '2026-01-01T10:00:04.000Z', id: 't2', text: 'a'.repeat(400) }),
      claudeStep({ requestId: 'r3', at: '2026-01-01T10:00:05.000Z', ctx: 1500, output: 10, toolUse: { id: 't3', name: 'Bash', input: { command: 'git status' } } }),
      claudeToolResult({ at: '2026-01-01T10:00:06.000Z', id: 't3', text: 'c'.repeat(400) }),
      claudeStep({ requestId: 'r4', at: '2026-01-01T10:00:07.000Z', ctx: 2000, output: 10, toolUse: { id: 't4', name: 'Bash', input: { command: 'git diff' } } }),
      claudeToolResult({ at: '2026-01-01T10:00:08.000Z', id: 't4', text: 'd'.repeat(400) }),
      claudeStep({ requestId: 'r5', at: '2026-01-01T10:00:09.000Z', ctx: 2500, output: 10 })
    ]
  });

  const { analysis } = await runCollector({ runtime: 'claude', sessionId: 'sess-uuid', analyze: true, full: true, claudeProjectsRoot: projectsRoot });

  // Both /a.txt and `git` were hit twice; only the re-read re-injects the same bytes.
  assert.deepEqual(analysis.repeats.map((entry) => entry.detail), ['Read · /a.txt']);
  assert.equal(analysis.repeats[0].calls, 2);
});

test('Codex attribution reads context from last_token_usage and flags non-zero exit codes', async () => {
  const sessionsRoot = await makeLogs({
    'main.jsonl': [
      { timestamp: '2026-01-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'sess-1' } },
      codexTurnContext('gpt-5.6-sol', '2026-01-01T10:00:01.000Z'),
      codexStep({ input_tokens: 1000, output_tokens: 20 }, { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 20, total_tokens: 1020 }, '2026-01-01T10:00:02.000Z'),
      codexToolCall('c1', 'shell', '{"cmd":"rg foo"}', '2026-01-01T10:00:03.000Z'),
      codexToolOutput('c1', 'x'.repeat(4000), '2026-01-01T10:00:04.000Z'),
      codexStep({ input_tokens: 5000, output_tokens: 30 }, { input_tokens: 6000, cached_input_tokens: 0, output_tokens: 50, total_tokens: 6050 }, '2026-01-01T10:00:05.000Z'),
      codexToolCall('c2', 'shell', '{"cmd":"cat missing"}', '2026-01-01T10:00:06.000Z'),
      codexToolOutput('c2', 'Process exited with code 1', '2026-01-01T10:00:07.000Z'),
      codexStep({ input_tokens: 6000, output_tokens: 10 }, { input_tokens: 12000, cached_input_tokens: 0, output_tokens: 60, total_tokens: 12060 }, '2026-01-01T10:00:08.000Z')
    ]
  });
  const empty = await emptyDir();

  const { analysis } = await runCollector({
    runtime: 'codex', sessionId: 'sess-1', analyze: true, full: true, codexRoot: sessionsRoot, codexArchivedRoot: empty
  });

  assert.equal(analysis.requests, 3);
  assert.deepEqual(analysis.by_tool, [{ tool: 'Shell', calls: 2, errors: 1, injected: 4950, resent: 3980, estimated_cost_usd: 0.0263 }]);
  assert.deepEqual(analysis.by_detail, [
    { detail: 'Shell · rg', calls: 1, errors: 0, injected: 3980, resent: 3980, estimated_cost_usd: 0.0215 },
    { detail: 'Shell · cat', calls: 1, errors: 1, injected: 970, resent: 0, estimated_cost_usd: 0.0049 }
  ]);
  assert.deepEqual(analysis.base, { tokens: 1000, per_unit: 1000, resent: 2000, share: analysis.base.share, estimated_cost_usd: 0.0058 });
  // The failed call is charged exactly, not by proportion of the tool's total.
  assert.deepEqual(analysis.errors, { calls: 1, injected: 970, resent: 0, estimated_cost_usd: 0.0049 });
});
