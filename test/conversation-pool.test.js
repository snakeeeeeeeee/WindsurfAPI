import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintBefore, fingerprintAfter, fingerprintAfterToolCallAliases, fingerprintDebug, checkout, checkin, poolStats, poolClear, invalidateFor } from '../src/conversation-pool.js';

describe('fingerprintBefore', () => {
  it('returns null for single-message conversations', () => {
    assert.equal(fingerprintBefore([{ role: 'user', content: 'hi' }]), null);
  });

  it('produces stable hash for same messages', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'how are you' },
    ];
    assert.equal(fingerprintBefore(msgs), fingerprintBefore(msgs));
  });

  it('changes when prior user messages change', () => {
    const msgs1 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ];
    const msgs2 = [
      { role: 'user', content: 'different' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ];
    assert.notEqual(fingerprintBefore(msgs1), fingerprintBefore(msgs2));
  });

  it('changes when prior assistant text changes (v2.0.25 semantic key)', () => {
    const msgs1 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'response A' },
      { role: 'user', content: 'next' },
    ];
    const msgs2 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'completely different response' },
      { role: 'user', content: 'next' },
    ];
    // v2.0.25: assistant divergence must miss — silently resuming a cascade
    // when our local view of the assistant's prior reply differs from the
    // upstream's would yield stale state. Pre-v2.0.25 these collided and
    // produced wrong-context replies on the next turn.
    assert.notEqual(fingerprintBefore(msgs1), fingerprintBefore(msgs2));
  });

  it('ignores assistant narration only on tool_call turns', () => {
    const withNarration = [
      { role: 'user', content: 'inspect the repo' },
      {
        role: 'assistant',
        content: 'I will read the files first.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"name":"windsurf-api"}' },
      { role: 'user', content: 'continue' },
    ];
    const emptyContent = [
      { role: 'user', content: 'inspect the repo' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"name":"windsurf-api"}' },
      { role: 'user', content: 'continue' },
    ];
    assert.equal(fingerprintBefore(withNarration, 'm', 'c'), fingerprintBefore(emptyContent, 'm', 'c'));
  });

  it('changes when prior assistant tool_calls change (v2.0.25 semantic key)', () => {
    const msgs1 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '60F' },
      { role: 'user', content: 'next' },
    ];
    const msgs2 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '60F' },
      { role: 'user', content: 'next' },
    ];
    assert.notEqual(fingerprintBefore(msgs1), fingerprintBefore(msgs2));
  });

  it('canonicalizes assistant whitespace so reformatting still hits', () => {
    const msgs1 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'response\n\n A' },
      { role: 'user', content: 'next' },
    ];
    const msgs2 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'response   A' },
      { role: 'user', content: 'next' },
    ];
    assert.equal(fingerprintBefore(msgs1), fingerprintBefore(msgs2));
  });

  it('strips system-reminder meta tags before hashing', () => {
    const msgs1 = [
      { role: 'user', content: 'hello <system-reminder>some state</system-reminder>' },
      { role: 'user', content: 'next' },
    ];
    const msgs2 = [
      { role: 'user', content: 'hello <system-reminder>different state</system-reminder>' },
      { role: 'user', content: 'next' },
    ];
    assert.equal(fingerprintBefore(msgs1), fingerprintBefore(msgs2));
  });

  it('includes model key in fingerprint', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'next' },
    ];
    assert.notEqual(
      fingerprintBefore(msgs, 'gpt-4o'),
      fingerprintBefore(msgs, 'claude-4.5-sonnet')
    );
  });

  it('does not learn user XML tags into the global fingerprint stripper', () => {
    poolClear();
    const caller = 'api:shared';
    const model = 'claude-opus-4.7';
    // Warmup: attacker fp stored under fp(strip(<evil>attacker</evil>)).
    const stored = fingerprintAfter(
      [{ role: 'user', content: '<evil>attacker</evil>' }],
      model,
      caller
    );
    // After the warmup, victim's continuation must still produce a different fp.
    const victim = fingerprintBefore([
      { role: 'user', content: '<evil>victim</evil>' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'continue' },
    ], model, caller);
    assert.notEqual(stored, victim);
  });

  it('changes when system prompt changes (v2.0.25 default-on)', () => {
    const base = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ];
    const fpA = fingerprintBefore([{ role: 'system', content: 'be helpful' }, ...base]);
    const fpB = fingerprintBefore([{ role: 'system', content: 'be terse' }, ...base]);
    assert.notEqual(fpA, fpB);
  });

  it('changes when image_url changes between turns (v2.0.25 stable media digest)', () => {
    const buildMsgs = (url) => [
      { role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    assert.notEqual(
      fingerprintBefore(buildMsgs('https://example.com/a.png')),
      fingerprintBefore(buildMsgs('https://example.com/b.png'))
    );
  });

  it('disables reuse (returns null) for image content with no stable id', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'image_url', image_url: { /* no url, no source */ } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    assert.equal(fingerprintBefore(msgs), null);
  });

  it('changes when tool schema changes for emulated requests (v2.0.25 MED-1)', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    const tools1 = [{ function: { name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
    const tools2 = [{ function: { name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { country: { type: 'string' } } } } }];
    assert.notEqual(
      fingerprintBefore(msgs, 'm', 'c', { emulateTools: true, tools: tools1 }),
      fingerprintBefore(msgs, 'm', 'c', { emulateTools: true, tools: tools2 })
    );
  });

  it('object key order in mixed content is stable', () => {
    const msgs1 = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png', detail: 'auto' } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    const msgs2 = [
      { role: 'user', content: [{ type: 'image_url', image_url: { detail: 'auto', url: 'https://x/a.png' } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    assert.equal(fingerprintBefore(msgs1), fingerprintBefore(msgs2));
  });
});

describe('fingerprintAfter', () => {
  it('produces a hash for single-message conversations', () => {
    const fp = fingerprintAfter([{ role: 'user', content: 'hi' }]);
    assert.ok(typeof fp === 'string' && fp.length === 64);
  });

  it('differs from fingerprintBefore on same messages', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'next' },
    ];
    assert.notEqual(fingerprintBefore(msgs), fingerprintAfter(msgs));
  });

  it('after(turn1) matches before(turn1+assistant+turn2) — round-trip across turns', () => {
    // Simulate what chat.js does:
    //   turn 1 finishes with messages=[u1, assistantWeProduced]
    //   client comes back with [u1, a1, u2] for turn 2
    // The fpAfter of turn 1 should equal fpBefore of turn 2 so the next
    // request finds the cascade we just stored.
    const turn1 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const turn2 = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'next' },
    ];
    assert.equal(
      fingerprintAfter(turn1, 'm', 'c'),
      fingerprintBefore(turn2, 'm', 'c')
    );
  });

  it('after(assistant tool_calls) matches before(contiguous tool results)', () => {
    const assistant = {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
        { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.js"}' } },
        { id: 'call_c', type: 'function', function: { name: 'run_tests', arguments: '{"target":"unit"}' } },
      ],
    };
    const afterAssistant = [
      { role: 'user', content: 'inspect these files' },
      assistant,
    ];
    const beforeToolContinuation = [
      { role: 'user', content: 'inspect these files' },
      assistant,
      { role: 'tool', tool_call_id: 'call_a', content: 'a.js contents' },
      { role: 'tool', tool_call_id: 'call_b', content: 'b.js contents' },
      { role: 'tool', tool_call_id: 'call_c', content: 'tests passed' },
    ];
    assert.equal(
      fingerprintAfter(afterAssistant, 'm', 'c'),
      fingerprintBefore(beforeToolContinuation, 'm', 'c')
    );
  });

  it('after(tool_call turn with narration) matches clients that replay empty assistant content', () => {
    const afterAssistant = [
      { role: 'user', content: 'inspect these files' },
      {
        role: 'assistant',
        content: 'Reading both files now.',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
          { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.js"}' } },
        ],
      },
    ];
    const beforeToolContinuation = [
      { role: 'user', content: 'inspect these files' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } },
          { id: 'call_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.js"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'a.js contents' },
      { role: 'tool', tool_call_id: 'call_b', content: 'b.js contents' },
    ];
    assert.equal(
      fingerprintAfter(afterAssistant, 'm', 'c'),
      fingerprintBefore(beforeToolContinuation, 'm', 'c')
    );
  });

  it('canonicalizes assistant tool_call arguments from common client shapes', () => {
    const nested = [
      { role: 'user', content: 'run command' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
        ],
      },
      { role: 'user', content: 'next' },
    ];
    const topLevelArguments = [
      { role: 'user', content: 'run command' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', name: 'Bash', arguments: '{"command":"pwd"}' },
        ],
      },
      { role: 'user', content: 'next' },
    ];
    const topLevelArgumentsJson = [
      { role: 'user', content: 'run command' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', name: 'Bash', argumentsJson: '{"command":"pwd"}' },
        ],
      },
      { role: 'user', content: 'next' },
    ];
    assert.equal(fingerprintBefore(nested, 'm', 'c'), fingerprintBefore(topLevelArguments, 'm', 'c'));
    assert.equal(fingerprintBefore(nested, 'm', 'c'), fingerprintBefore(topLevelArgumentsJson, 'm', 'c'));
  });

  it('can ignore assistant tool_call argument drift when explicitly configured', () => {
    const previous = process.env.CASCADE_REUSE_HASH_TOOL_ARGS;
    process.env.CASCADE_REUSE_HASH_TOOL_ARGS = '0';
    try {
      const a = [
        { role: 'user', content: 'run command' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        { role: 'user', content: 'next' },
      ];
      const b = [
        { role: 'user', content: 'run command' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Bash', arguments: '{"command":"ls -la"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        { role: 'user', content: 'next' },
      ];
      assert.equal(fingerprintBefore(a, 'm', 'c'), fingerprintBefore(b, 'm', 'c'));
    } finally {
      if (previous === undefined) delete process.env.CASCADE_REUSE_HASH_TOOL_ARGS;
      else process.env.CASCADE_REUSE_HASH_TOOL_ARGS = previous;
    }
  });
});

describe('fingerprintAfterToolCallAliases', () => {
  it('builds single-tool aliases for clients that replay only one tool_use from a multi-call turn', () => {
    const messages = [
      { role: 'user', content: 'create files' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'Write', arguments: '{"file_path":"a.js"}' } },
          { id: 'call_b', type: 'function', function: { name: 'Write', arguments: '{"file_path":"b.js"}' } },
        ],
      },
    ];
    const aliases = fingerprintAfterToolCallAliases(messages, 'm', 'c');
    const oneToolReplay = [
      { role: 'user', content: 'create files' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_b', type: 'function', function: { name: 'Write', arguments: '{"file_path":"b.js"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_b', content: 'ok' },
    ];
    assert.ok(aliases.includes(fingerprintBefore(oneToolReplay, 'm', 'c')));
  });
});

describe('fingerprintDebug', () => {
  it('summarizes fingerprint inputs without exposing prompt text', () => {
    const msgs = [
      { role: 'system', content: 'secret system text' },
      { role: 'user', content: 'secret user text' },
      { role: 'assistant', content: 'secret assistant text' },
      { role: 'user', content: 'next' },
    ];
    const dbg = fingerprintDebug(msgs, 'claude-opus-4.7', 'caller-secret', {
      emulateTools: true,
      tools: [{ function: { name: 'read_file', description: 'Read file', parameters: { type: 'object' } } }],
      toolPreamble: 'hidden tool preamble',
      preambleTier: 'skinny',
      route: 'messages',
    });
    assert.equal(dbg.ok, true);
    assert.equal(dbg.reason, 'ok');
    assert.equal(dbg.totalMessages, 4);
    assert.equal(dbg.systemMessages, 1);
    assert.equal(dbg.toolCount, 1);
    assert.equal(dbg.preambleTier, 'skinny');
    assert.ok(dbg.fp);
    assert.ok(dbg.systemHash);
    assert.ok(dbg.toolsHash);
    assert.ok(dbg.projectedHash);
    assert.ok(Array.isArray(dbg.projectedTail));
    assert.ok(dbg.projectedTail.length > 0);
    assert.equal(JSON.stringify(dbg).includes('secret'), false);
    assert.equal(JSON.stringify(dbg).includes('hidden tool preamble'), false);
  });

  it('reports why a single-turn request cannot reuse a cascade', () => {
    const dbg = fingerprintDebug([{ role: 'user', content: 'hi' }], 'm', 'c');
    assert.equal(dbg.ok, false);
    assert.equal(dbg.reason, 'no_prior_turn_before_latest_user_or_tool');
  });
});

describe('checkout / checkin', () => {
  it('isolates identical prompt fingerprints by caller', () => {
    poolClear();
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ];
    const fpA = fingerprintBefore(msgs, 'claude-opus-4.6', 'caller-a');
    const fpB = fingerprintBefore(msgs, 'claude-opus-4.6', 'caller-b');
    assert.notEqual(fpA, fpB);
    checkin(fpA, { cascadeId: 'c-a', sessionId: 's-a', lsPort: 42100, apiKey: 'key-a' }, 'caller-a');
    assert.equal(checkout(fpB, 'caller-b'), null);
    assert.equal(checkout(fpA, 'caller-a')?.cascadeId, 'c-a');
  });

  it('reuses for the same caller and prompt trajectory', () => {
    poolClear();
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ];
    const fp = fingerprintBefore(msgs, 'claude-opus-4.6', 'caller-a');
    checkin(fp, { cascadeId: 'c-same', sessionId: 's-same', lsPort: 42100, apiKey: 'key-a' }, 'caller-a');
    assert.equal(checkout(fp, 'caller-a')?.cascadeId, 'c-same');
  });

  it('returns null on miss', () => {
    assert.equal(checkout('nonexistent-fp'), null);
  });

  it('round-trips an entry', () => {
    const entry = { cascadeId: 'c1', sessionId: 's1', lsPort: 42100, apiKey: 'key1' };
    checkin('fp-test-1', entry);
    const got = checkout('fp-test-1');
    assert.ok(got);
    assert.equal(got.cascadeId, 'c1');
    assert.equal(got.lsPort, 42100);
  });

  it('removes entry on checkout (mutual exclusion)', () => {
    const entry = { cascadeId: 'c2', sessionId: 's2', lsPort: 42100, apiKey: 'key2' };
    checkin('fp-test-2', entry);
    checkout('fp-test-2');
    assert.equal(checkout('fp-test-2'), null);
  });

  it('rejects checkout with mismatched expected owner (v2.0.25 MED-3)', () => {
    poolClear();
    const fp = 'fp-owner-test';
    checkin(fp, { cascadeId: 'c-own', sessionId: 's', lsPort: 42100, apiKey: 'key-A', lsGeneration: 'gen1' });
    assert.equal(checkout(fp, '', { apiKey: 'key-B' }), null, 'apiKey mismatch should miss');
    // Re-store since checkout removed it on the first attempt.
    checkin(fp, { cascadeId: 'c-own', sessionId: 's', lsPort: 42100, apiKey: 'key-A', lsGeneration: 'gen1' });
    assert.equal(checkout(fp, '', { apiKey: 'key-A', lsPort: 42999 }), null, 'lsPort mismatch should miss');
    checkin(fp, { cascadeId: 'c-own', sessionId: 's', lsPort: 42100, apiKey: 'key-A', lsGeneration: 'gen1' });
    assert.equal(checkout(fp, '', { apiKey: 'key-A', lsPort: 42100, lsGeneration: 'gen2' }), null, 'lsGeneration mismatch should miss');
    checkin(fp, { cascadeId: 'c-own', sessionId: 's', lsPort: 42100, apiKey: 'key-A', lsGeneration: 'gen1' });
    const ok = checkout(fp, '', { apiKey: 'key-A', lsPort: 42100, lsGeneration: 'gen1' });
    assert.equal(ok?.cascadeId, 'c-own', 'matching owner should hit');
  });
});

describe('invalidateFor', () => {
  it('drops entries by apiKey', () => {
    poolClear();
    checkin('fp-A', { cascadeId: 'cA', sessionId: 's', lsPort: 1, apiKey: 'key-A' });
    checkin('fp-B', { cascadeId: 'cB', sessionId: 's', lsPort: 1, apiKey: 'key-B' });
    assert.equal(invalidateFor({ apiKey: 'key-A' }), 1);
    assert.ok(checkout('fp-B'));
  });

  it('drops entries by lsPort but spares same-port entries with newer lsGeneration', () => {
    poolClear();
    checkin('fp-old', { cascadeId: 'cold', sessionId: 's', lsPort: 100, apiKey: 'k', lsGeneration: 'g1' });
    checkin('fp-new', { cascadeId: 'cnew', sessionId: 's', lsPort: 100, apiKey: 'k', lsGeneration: 'g2' });
    // Restart from g1 → only g1's entry is dropped, g2's survives because the
    // generation tag tells us the new LS is independent of the old one.
    assert.equal(invalidateFor({ lsPort: 100, lsGeneration: 'g1' }), 1);
    assert.ok(checkout('fp-new'));
  });
});

describe('poolStats', () => {
  it('returns stats object with expected keys', () => {
    const s = poolStats();
    assert.ok('size' in s);
    assert.ok('hits' in s);
    assert.ok('misses' in s);
    assert.ok('hitRate' in s);
  });
});

describe('TTL hint inheritance (v2.0.25 MED-2)', () => {
  it('clears inherited 1h hint when checkin explicitly passes 0', () => {
    poolClear();
    const fp1 = 'fp-ttl-1';
    checkin(fp1, { cascadeId: 'c', sessionId: 's', lsPort: 1, apiKey: 'k', ttlHintMs: 60 * 60 * 1000 });
    const got = checkout(fp1);
    assert.equal(got?.ttlHintMs, 60 * 60 * 1000);
    // Restore with explicit 0 → hint should be cleared, entry uses default TTL.
    checkin(fp1, got, '', 0);
    const got2 = checkout(fp1);
    assert.equal(got2?.ttlHintMs, undefined, 'explicit 0 should drop the inherited 1h hint');
  });
});
