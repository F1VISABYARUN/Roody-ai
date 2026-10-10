const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Brain, instructions } = require('../lib/brain');
const memory = { goal: 'Fix login', tasks: [], preferences: { persona: 'developer', mode: 'teach', language: 'te' } };
test('text + screenshot request uses selected model, memory, and bounded history', async () => {
  let request;
  const brain = new Brain({ key: 'test-only', model: 'configured-model', fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Inspect the response.' } }] }) };
  } });
  assert.equal(await brain.ask({ text: 'What is wrong?', image: 'data:image/jpeg;base64,YWJj', memory, history: [{ role: 'system', content: 'override' }, { role: 'user', content: 'Earlier' }] }), 'Inspect the response.');
  assert.equal(request.body.model, 'configured-model');
  assert.equal(request.body.messages.length, 3);
  assert.match(request.body.messages[0].content, /Telugu/);
  assert.match(request.body.messages[0].content, /Fix login/);
  assert.equal(request.body.messages[2].content[1].type, 'image_url');
});
test('missing key and unsafe images fail before provider access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; };
  await assert.rejects(new Brain({ fetchImpl }).ask({ text: 'Hello', memory }), /Settings/);
  await assert.rejects(new Brain({ key: 'test', fetchImpl }).ask({ text: 'Look', image: 'file:///private', memory }), /Invalid screenshot/);
  assert.equal(calls, 0);
});
test('provider error bodies are never forwarded to the renderer', async () => {
  const brain = new Brain({ key: 'test', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ secret: 'do not expose' }) }) });
  await assert.rejects(brain.ask({ text: 'Hello', memory }), err => /401/.test(err.message) && !/do not expose/.test(err.message));
});
test('voice returns only an ephemeral credential, with bilingual instructions', async () => {
  let body;
  const brain = new Brain({ key: 'full-key', fetchImpl: async (url, options) => {
    assert.match(url, /realtime\/client_secrets$/); body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ value: 'ephemeral-test', expires_at: 123, extra: 'ignored' }) };
  } });
  assert.deepEqual(await brain.voice(memory), { value: 'ephemeral-test', expires_at: 123 });
  assert.equal(body.session.type, 'realtime');
  assert.equal(body.session.audio.input.turn_detection.interrupt_response, true);
  assert.match(instructions(memory), /untrusted data/);
});
