const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Memory } = require('../lib/memory');
function file(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roody-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'memory.json'); }
test('goals, blocked tasks, completion and preferences survive restart', t => {
  const location = file(t), memory = new Memory(location);
  memory.update({ type: 'goal', text: 'Fix login' });
  const task = memory.update({ type: 'add-task', text: 'Inspect auth response' }).tasks[0];
  memory.update({ type: 'task', id: task.id, status: 'blocked', text: 'Need response headers' });
  memory.update({ type: 'preferences', persona: 'founder', mode: 'teach', language: 'te' });
  const restored = new Memory(location);
  assert.equal(restored.read().goal, 'Fix login');
  assert.equal(restored.read().tasks[0].blocker, 'Need response headers');
  assert.deepEqual(restored.read().preferences, { persona: 'founder', mode: 'teach', language: 'te' });
  restored.update({ type: 'task', id: task.id, status: 'done' });
  assert.equal(new Memory(location).read().tasks[0].blocker, '');
});
test('invalid task updates do not corrupt persisted memory', t => {
  const location = file(t), memory = new Memory(location);
  const task = memory.update({ type: 'add-task', text: 'Learn closures' }).tasks[0];
  assert.throws(() => memory.update({ type: 'task', id: task.id, status: 'invented' }));
  assert.equal(new Memory(location).read().tasks[0].status, 'pending');
  assert.throws(() => memory.update({ type: 'preferences', language: 'invalid' }));
});
test('corrupt existing memory is reported and preserved', t => {
  const location = file(t); fs.writeFileSync(location, 'bad json');
  assert.throws(() => new Memory(location));
  assert.equal(fs.readFileSync(location, 'utf8'), 'bad json');
});
