const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class Memory {
  constructor(file) {
    this.file = file;
    this.state = { goal: '', tasks: [], decisions: [], preferences: { mode: 'with', persona: 'developer', language: 'auto' } };
    if (fs.existsSync(file)) {
      // A corrupt file is an actionable error; never overwrite a user's memory.
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!saved || !Array.isArray(saved.tasks) || !Array.isArray(saved.decisions)) throw new Error('Invalid Roody memory file');
      this.state = { ...this.state, ...saved, preferences: { ...this.state.preferences, ...saved.preferences } };
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return this.read();
  }
  read() { return structuredClone(this.state); }
  update(action) {
    const text = String(action.text || '').trim().slice(0, 2000);
    if (action.type === 'goal') this.state.goal = text;
    else if (action.type === 'add-task') {
      if (!text) throw new Error('Give the task a title');
      if (this.state.tasks.length >= 200) throw new Error('Task limit reached');
      this.state.tasks.push({ id: randomUUID(), title: text, status: 'pending', blocker: '', created: new Date().toISOString() });
    } else if (action.type === 'task') {
      const task = this.state.tasks.find(t => t.id === action.id);
      if (!task) throw new Error('Task not found');
      if (!['pending', 'active', 'blocked', 'done'].includes(action.status)) throw new Error('Invalid task status');
      task.status = action.status;
      task.blocker = action.status === 'blocked' ? text : '';
    } else if (action.type === 'preferences') {
      const choices = { mode: ['teach', 'with', 'for'], persona: ['grandparent', 'developer', 'founder'], language: ['auto', 'en', 'te'] };
      for (const key of Object.keys(choices)) {
        if (action[key] !== undefined) {
          if (!choices[key].includes(action[key])) throw new Error('Invalid ' + key);
          this.state.preferences[key] = action[key];
        }
      }
    } else throw new Error('Unsupported memory action');
    return this.save();
  }
}
module.exports = { Memory };
