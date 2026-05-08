// v2.0.74 — two real fixes (not "wait for user reply" deflection)
//   #122 zhangzhang-bit · 25s warm stall killing 30s-success cascades.
//        Default warmStallMs 25 → 45s + new toolActive ceiling 180s.
//   #116 zhangzhang-bit · Claude Code system-prompt hash drifts
//        across turns even though len is identical → reuse always
//        misses → model "loops". Cause: gitStatus / Recent commits /
//        Status block bodies + git short hashes were not normalised.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cascadePollDelayForElapsed, pickWarmStallCeiling, __TEST_CASCADE_TIMEOUTS } from '../src/client.js';
import { fingerprintBefore } from '../src/conversation-pool.js';

describe('#122 — pickWarmStallCeiling tier ordering', () => {
  const T = { warmStallMs: 45_000, warmStallThinkingMs: 120_000, warmStallToolActiveMs: 180_000 };
  const POLL_T = {
    pollIntervalMs: 500,
    pollFastMs: 100,
    pollFastUntilMs: 2000,
    pollMidMs: 250,
    pollMidUntilMs: 8000,
  };

  it('text-only baseline is the new 45s default (was 25s pre-v2.0.74)', () => {
    assert.equal(pickWarmStallCeiling({ totalThinking: 0, toolCallCount: 0 }, T), 45_000);
  });

  it('thinking emission picks the 120s ceiling', () => {
    assert.equal(pickWarmStallCeiling({ totalThinking: 250, toolCallCount: 0 }, T), 120_000);
  });

  it('tool-active picks the 180s ceiling — beats both', () => {
    assert.equal(pickWarmStallCeiling({ totalThinking: 0, toolCallCount: 1 }, T), 180_000);
  });

  it('tool-active wins when thinking ALSO fired (sonnet-thinking + tool calls)', () => {
    assert.equal(pickWarmStallCeiling({ totalThinking: 9999, toolCallCount: 2 }, T), 180_000);
  });

  it('zero everything falls through to text-only baseline', () => {
    assert.equal(pickWarmStallCeiling({}, T), 45_000);
  });

  it('production CASCADE_TIMEOUTS object exposes the three tiers in increasing order', () => {
    assert.ok(__TEST_CASCADE_TIMEOUTS.warmStallMs >= 30_000, 'baseline at least 30s');
    assert.ok(__TEST_CASCADE_TIMEOUTS.warmStallThinkingMs > __TEST_CASCADE_TIMEOUTS.warmStallMs);
    assert.ok(__TEST_CASCADE_TIMEOUTS.warmStallToolActiveMs > __TEST_CASCADE_TIMEOUTS.warmStallThinkingMs);
  });

  it('uses faster polling near the beginning of a cascade and backs off later', () => {
    assert.equal(cascadePollDelayForElapsed(0, POLL_T), 100);
    assert.equal(cascadePollDelayForElapsed(1999, POLL_T), 100);
    assert.equal(cascadePollDelayForElapsed(2000, POLL_T), 250);
    assert.equal(cascadePollDelayForElapsed(7999, POLL_T), 250);
    assert.equal(cascadePollDelayForElapsed(8000, POLL_T), 500);
  });

  it('reads cascade polling env overrides at call time', () => {
    const prevFast = process.env.CASCADE_POLL_FAST_MS;
    const prevFastUntil = process.env.CASCADE_POLL_FAST_UNTIL_MS;
    try {
      process.env.CASCADE_POLL_FAST_MS = '75';
      process.env.CASCADE_POLL_FAST_UNTIL_MS = '1000';
      assert.equal(cascadePollDelayForElapsed(0), 75);
      assert.equal(cascadePollDelayForElapsed(999), 75);
    } finally {
      if (prevFast === undefined) delete process.env.CASCADE_POLL_FAST_MS;
      else process.env.CASCADE_POLL_FAST_MS = prevFast;
      if (prevFastUntil === undefined) delete process.env.CASCADE_POLL_FAST_UNTIL_MS;
      else process.env.CASCADE_POLL_FAST_UNTIL_MS = prevFastUntil;
    }
  });
});

describe('#116 — system-prompt normalize swallows Claude Code git block drift', () => {
  // The two system prompts below differ ONLY in the gitStatus body
  // (Status: lines + Recent commits: lines + branch metadata is
  // identical). zhangzhang-bit's 30-turn log shows 26892-byte system
  // prompts hashing differently — git short hashes shift every commit
  // while keeping total length stable. After normalize both should
  // collapse to the same fingerprint so cascade reuse hits.
  const sysT1 = [
    'You are Claude Code.',
    '',
    'gitStatus: This is the git status at the start of the conversation.',
    '',
    'Current branch: master',
    'Main branch (you will usually use this for PRs): master',
    'Git user: dwgx',
    'Status:',
    'M src/foo.js',
    '?? new-file.txt',
    '',
    'Recent commits:',
    'abc1234 release: 2.0.73 — hotfix',
    'def5678 release: 2.0.72 — NLU layer',
    '90fea33 release: 2.0.71 — issue triage',
    '',
    "Today's date is 2026-05-02",
  ].join('\n');

  const sysT2 = [
    'You are Claude Code.',
    '',
    'gitStatus: This is the git status at the start of the conversation.',
    '',
    'Current branch: master',
    'Main branch (you will usually use this for PRs): master',
    'Git user: dwgx',
    'Status:',
    'M src/bar.js',
    '?? other.txt',
    '',
    'Recent commits:',
    '1234567 release: 2.0.74 — stall fix',
    '89abcde release: 2.0.73 — hotfix',
    'fffeeed release: 2.0.72 — NLU layer',
    '',
    "Today's date is 2026-05-03",
  ].join('\n');

  const buildMessages = (sys) => [
    { role: 'system', content: sys },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello there' },
    { role: 'user', content: 'continue please' },
  ];

  it('two systems differing only in git block + date hash to the same fingerprint', () => {
    const fpA = fingerprintBefore(buildMessages(sysT1), 'claude-sonnet-4.6', 'caller-x');
    const fpB = fingerprintBefore(buildMessages(sysT2), 'claude-sonnet-4.6', 'caller-x');
    assert.ok(fpA, 'fpA should be a string fingerprint');
    assert.ok(fpB, 'fpB should be a string fingerprint');
    assert.equal(fpA, fpB);
  });

  it('genuine system-prompt edits still produce a different fingerprint', () => {
    // Real prose change — must NOT be normalised away (that would
    // poison reuse with cross-prompt collisions).
    const sysGenuineEdit = sysT1.replace('You are Claude Code.', 'You are Codex CLI.');
    const fpA = fingerprintBefore(buildMessages(sysT1), 'claude-sonnet-4.6', 'caller-x');
    const fpC = fingerprintBefore(buildMessages(sysGenuineEdit), 'claude-sonnet-4.6', 'caller-x');
    assert.ok(fpA && fpC);
    assert.notEqual(fpA, fpC);
  });

  it('inline git short hashes outside the gitStatus block also collapse', () => {
    // Common Claude Code pattern — middle of a long instruction:
    //   "Recent commit: abc1234. Working on ..."
    const sysHashInProse = sysT1.replace('You are Claude Code.', 'See commit abc1234 for context.');
    const sysHashShifted = sysT1.replace('You are Claude Code.', 'See commit def5678 for context.');
    const fpA = fingerprintBefore(buildMessages(sysHashInProse), 'claude-sonnet-4.6', 'caller-x');
    const fpB = fingerprintBefore(buildMessages(sysHashShifted), 'claude-sonnet-4.6', 'caller-x');
    assert.equal(fpA, fpB);
  });

  it('epoch timestamps embedded in system prompt collapse', () => {
    // 1820000000 = 2027 epoch — well within the 17/18/19/20 prefix range.
    const sysWithEpoch1 = sysT1 + '\nlast_modified_unix: 1820000000';
    const sysWithEpoch2 = sysT1 + '\nlast_modified_unix: 1830000000';
    const fpA = fingerprintBefore(buildMessages(sysWithEpoch1), 'claude-sonnet-4.6', 'caller-x');
    const fpB = fingerprintBefore(buildMessages(sysWithEpoch2), 'claude-sonnet-4.6', 'caller-x');
    assert.equal(fpA, fpB);
  });

  it('phone-number-shaped 10 digits NOT mistaken for an epoch (preserves identity)', () => {
    // 1234567890 is a 10-digit number that should NOT match the epoch
    // pattern (prefix 12, not 17/18/19/20). Ensures we don't over-eat.
    const sys1 = sysT1 + '\nphone: 1234567890';
    const sys2 = sysT1 + '\nphone: 9876543210';
    const fpA = fingerprintBefore(buildMessages(sys1), 'claude-sonnet-4.6', 'caller-x');
    const fpB = fingerprintBefore(buildMessages(sys2), 'claude-sonnet-4.6', 'caller-x');
    assert.notEqual(fpA, fpB);
  });

  it('prose words that look like hex (deadbeef) are NOT collapsed', () => {
    // Pattern requires at least one digit; deadbeef has no digits so it
    // stays. A real hash like ab12cd3 has a digit and gets folded.
    const sys1 = sysT1 + '\nbreakpoint at deadbeef in libc.so.6';
    const sys2 = sysT1 + '\nbreakpoint at cafebabe in libc.so.6';
    const fpA = fingerprintBefore(buildMessages(sys1), 'claude-sonnet-4.6', 'caller-x');
    const fpB = fingerprintBefore(buildMessages(sys2), 'claude-sonnet-4.6', 'caller-x');
    assert.notEqual(fpA, fpB);
  });

  it('zhangzhang-bit reproducer — gitStatus block plus a Recent files block', () => {
    // Same Recent files heading, body changes. Fingerprint must be stable.
    const withRecentFiles1 = sysT1 + '\n\nRecent files:\nsrc/foo.js  modified  2 minutes ago\nsrc/bar.js  modified  5 minutes ago\n';
    const withRecentFiles2 = sysT1 + '\n\nRecent files:\nsrc/baz.js  modified  1 minute ago\nsrc/qux.js  modified  9 minutes ago\n';
    const fpA = fingerprintBefore(buildMessages(withRecentFiles1), 'claude-sonnet-4.6', 'caller-x');
    const fpB = fingerprintBefore(buildMessages(withRecentFiles2), 'claude-sonnet-4.6', 'caller-x');
    assert.equal(fpA, fpB);
  });
});
