// End-to-end chain test: raw cascade text → salvage parser → OpenAI
// tool_calls → openAIToAnthropic translator → Anthropic tool_use block.
//
// Issue #109 sub2api E2E: clients hitting /v1/messages with non-Claude
// models expected a `content[].type === "tool_use"` block in the
// response, but got plain text because the model's tool call shape
// didn't match the strict streaming parser. v2.0.53 added a salvage
// pass that recognises the common off-format shapes (markdown-fenced
// JSON, OpenAI native function_call/tool_calls, whitespace-padded bare
// JSON). This test verifies salvage's output is shaped correctly so
// the rest of the chain (chat.js response builder + messages.js
// translator) successfully produces a valid Anthropic tool_use block.
//
// Why this is more useful than the unit tests: the salvage function
// returns `{name, argumentsJson}` records, but downstream consumers
// (chat.js builds OpenAI shape, messages.js then unwraps to
// Anthropic shape) make assumptions about that shape — id presence,
// arguments serialisability, name fallback. If any of these break,
// the client sees an empty content array or malformed input. This
// test simulates the full chain on synthetic inputs that mimic real
// GPT-5.x and Gemini-3.x observed shapes.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCallsFromText } from '../src/handlers/tool-emulation.js';
import { openAIToAnthropic } from '../src/handlers/messages.js';

// Mimic chat.js:1758-1792 — build the OpenAI chat-completion response
// shape from parsed tool calls. This is what messages.js receives
// after a non-stream cascade turn that emulated tools.
function buildOpenAIResponse(toolCalls, residualText) {
  const message = { role: 'assistant', content: residualText || null };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: tc.id || `call_${i}_${Date.now().toString(36)}`,
      type: 'function',
      function: {
        name: tc.name || 'unknown',
        arguments: tc.argumentsJson || tc.arguments || '{}',
      },
    }));
    message.content = null;
  }
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gpt-5.5-medium',
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

function runChain(rawText, opts = {}) {
  const parsed = parseToolCallsFromText(rawText, { dialect: 'openai_json_xml', ...opts });
  const openAI = buildOpenAIResponse(parsed.toolCalls, parsed.text);
  const anthropic = openAIToAnthropic(openAI, 'gpt-5.5-medium', 'msg_test');
  return { parsed, openAI, anthropic };
}

describe('end-to-end: salvaged tool_call → Anthropic tool_use block', () => {
  test('GPT-style markdown-fenced JSON yields valid tool_use block', () => {
    const rawText = "I'll use the echo_text tool to print HELLO.\n\n```json\n{\"name\": \"echo_text\", \"arguments\": {\"text\": \"HELLO\"}}\n```";
    const { parsed, anthropic } = runChain(rawText);
    assert.equal(parsed.toolCalls.length, 1, 'salvage extracts the call');
    const toolUse = anthropic.content.find(c => c.type === 'tool_use');
    assert.ok(toolUse, 'response contains tool_use block');
    assert.ok(toolUse.id && toolUse.id.length > 0, 'tool_use has non-empty id');
    assert.equal(toolUse.name, 'echo_text');
    assert.deepEqual(toolUse.input, { text: 'HELLO' });
    assert.equal(anthropic.stop_reason, 'tool_use');
  });

  test('OpenAI native function_call shape yields valid tool_use block', () => {
    const rawText = '{"function_call":{"name":"echo_text","arguments":"{\\"text\\":\\"HELLO\\"}"}}';
    const { parsed, anthropic } = runChain(rawText);
    assert.equal(parsed.toolCalls.length, 1);
    const toolUse = anthropic.content.find(c => c.type === 'tool_use');
    assert.ok(toolUse);
    assert.equal(toolUse.name, 'echo_text');
    assert.deepEqual(toolUse.input, { text: 'HELLO' });
  });

  test('OpenAI tool_calls array yields multiple tool_use blocks', () => {
    const rawText = '{"tool_calls":[{"function":{"name":"a","arguments":"{\\"x\\":1}"}},{"function":{"name":"b","arguments":"{\\"y\\":2}"}}]}';
    const { parsed, anthropic } = runChain(rawText);
    assert.equal(parsed.toolCalls.length, 2);
    const toolUses = anthropic.content.filter(c => c.type === 'tool_use');
    assert.equal(toolUses.length, 2);
    assert.equal(toolUses[0].name, 'a');
    assert.deepEqual(toolUses[0].input, { x: 1 });
    assert.equal(toolUses[1].name, 'b');
    assert.deepEqual(toolUses[1].input, { y: 2 });
    // Each tool_use needs its own id so client tool_result can match.
    assert.ok(toolUses[0].id && toolUses[1].id && toolUses[0].id !== toolUses[1].id);
  });

  test('Whitespace-padded bare JSON yields valid tool_use block', () => {
    const rawText = 'Here you go:\n{ "name": "echo_text", "arguments": { "text": "HELLO" } }';
    const { parsed, anthropic } = runChain(rawText);
    assert.equal(parsed.toolCalls.length, 1);
    const toolUse = anthropic.content.find(c => c.type === 'tool_use');
    assert.ok(toolUse);
    assert.deepEqual(toolUse.input, { text: 'HELLO' });
  });

  test('canonical XML envelope (primary path) still produces tool_use', () => {
    // Sanity: the salvage path doesn't break the primary parser's existing
    // contract for models that follow the dialect.
    const rawText = '<tool_call>{"name":"echo_text","arguments":{"text":"HELLO"}}</tool_call>';
    const { parsed, anthropic } = runChain(rawText);
    assert.equal(parsed.toolCalls.length, 1);
    const toolUse = anthropic.content.find(c => c.type === 'tool_use');
    assert.ok(toolUse);
    assert.equal(toolUse.name, 'echo_text');
    assert.deepEqual(toolUse.input, { text: 'HELLO' });
  });

  test('prose-only response (no tool call) yields text block, not tool_use', () => {
    // Negative case: when the model genuinely doesn't emit a tool call,
    // we must NOT hallucinate a tool_use block. Salvage must return 0
    // calls and the response must be a plain text message.
    const rawText = "I'm sorry, I cannot help with that.";
    const { parsed, anthropic } = runChain(rawText);
    assert.equal(parsed.toolCalls.length, 0);
    const textBlocks = anthropic.content.filter(c => c.type === 'text');
    assert.equal(textBlocks.length, 1);
    assert.equal(textBlocks[0].text, rawText);
    assert.equal(anthropic.stop_reason, 'end_turn');
    assert.equal(anthropic.content.find(c => c.type === 'tool_use'), undefined);
  });

  test('tool_use id is non-empty even when salvage assigns its own', () => {
    // Salvage assigns ids like `call_salvage_0_xxxx`. The chat.js builder
    // preserves them. messages.js translator copies them into tool_use.id.
    // Anthropic clients use this id to match tool_result back. If empty,
    // multi-call flows break.
    const rawText = '```json\n{"name":"foo","arguments":{}}\n```';
    const { parsed, anthropic } = runChain(rawText);
    const toolUse = anthropic.content.find(c => c.type === 'tool_use');
    assert.ok(toolUse.id && /^call_/.test(toolUse.id), 'tool_use.id must start with "call_"');
  });

  test('multi-arg JSON with nested object arguments survives chain intact', () => {
    // Real-world tool calls have non-trivial argument structures. The
    // salvage parser stringifies via JSON.stringify, then chat.js stuffs
    // it as a string into function.arguments, then messages.js does
    // JSON.parse to make it `input`. Round-trip must preserve types.
    const rawText = '```json\n{"name":"create_file","arguments":{"path":"/a/b","content":"x","options":{"overwrite":true,"mode":420}}}\n```';
    const { parsed, anthropic } = runChain(rawText);
    const toolUse = anthropic.content.find(c => c.type === 'tool_use');
    assert.deepEqual(toolUse.input, {
      path: '/a/b',
      content: 'x',
      options: { overwrite: true, mode: 420 },
    });
  });

  test('escaped strings in arguments survive the round-trip', () => {
    const rawText = '```json\n{"name":"shell","arguments":{"cmd":"echo \\"hi\\" > out.txt"}}\n```';
    const { parsed, anthropic } = runChain(rawText);
    const toolUse = anthropic.content.find(c => c.type === 'tool_use');
    assert.equal(toolUse.input.cmd, 'echo "hi" > out.txt');
  });

  test('conversation compaction mode must return tool-shaped text as text', () => {
    const rawText = '<tool_call>{"name":"echo_text","arguments":{"text":"HELLO"}}</tool_call>\nSummary for future continuation.';
    const openAI = {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'claude-sonnet-4.6',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: rawText },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
    const anthropic = openAIToAnthropic(openAI, 'claude-sonnet-4.6', 'msg_test');
    assert.equal(anthropic.stop_reason, 'end_turn');
    assert.equal(anthropic.content.length, 1);
    assert.deepEqual(anthropic.content[0], { type: 'text', text: rawText });
  });
});
