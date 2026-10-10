(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const scenarios = {
    developer: {
      title: 'Why does this login always succeed?',
      description: 'Two files, one sneaky bug. Look at what the function returns and how the caller uses it.',
      files: [
        ['auth.js', 'export async function isAllowed(userId) {\n  const response = await fetch(\n    `/api/access/${userId}`\n  );\n  if (!response.ok) return false;\n  const data = await response.json();\n  return data.allowed === true;\n}'],
        ['app.js', 'import { isAllowed } from "./auth.js";\n\nexport function openDashboard(userId) {\n  if (isAllowed(userId)) {\n    showDashboard();\n  } else {\n    showAccessDenied();\n  }\n}']
      ],
      question: 'Compare auth.js and app.js. Why can access be granted when it should be denied? Explain the cause, suggest the smallest fix, and ask me one useful question.',
      reply: 'isAllowed returns a Promise because it is async. app.js checks that Promise itself, which is truthy, rather than waiting for the boolean.\n\nMake openDashboard async and use: if (await isAllowed(userId)). Then test both allowed and denied responses. This client check should not replace authorization on the server.\n\nWhat should the user see if the access request fails?'
    },
    founder: {
      title: 'Three ideas. One afternoon.',
      description: 'A fictional team has four hours before its hackathon presentation. Help them choose a convincing next step.',
      heading: 'Demo plan',
      items: ['Goal: show one complete companion conversation.', 'Available time: 4 hours. Team: 2 people.', 'Idea A: add five integrations — estimated 2 days.', 'Idea B: polish voice and a two-file debugging example — estimated 3 hours.', 'Idea C: rebuild the entire homepage — estimated 6 hours.'],
      question: 'Act as my founder and CTO companion. Given this demo plan, what should we prioritize in the next four hours? Explain the tradeoff and suggest a small plan.',
      reply: 'Choose idea B: one complete voice conversation plus a clear two-file debugging example. It fits the time and shows the product’s core value.\n\nSpend 90 minutes on the conversation flow, 60 minutes on the example, and 30 minutes recording a backup. Keep the last hour for rehearsal and fixes.\n\nWhat single thing should the judges understand after watching your demo?'
    },
    grandparent: {
      title: 'Understand a practice appointment page.',
      description: 'A fictional appointment summary. Nothing is booked, no payment is taken, and no personal information is required.',
      heading: 'Practice appointment — fictional',
      items: ['Service: introductory computer lesson.', 'Day: Tuesday. Time: 10:00–10:30 AM.', 'Location: community learning room.', 'Status: not booked. This is only a practice summary.', 'Next step: read the details and decide what you would like to ask.'],
      question: 'Explain this fictional appointment summary in simple English, one step at a time. Help me understand what has and has not happened, then ask one gentle question.',
      reply: 'This is a practice example for a 30-minute computer lesson on Tuesday at 10 in the morning, in a community learning room.\n\nYou have not booked anything. We can read the details together first, and there is no need to enter personal information here.\n\nWould you like me to explain the time or what the lesson might include?'
    }
  };
  let selected = 'developer', guestCode = '', busy = false, connected = false, revision = 0;
  const messages = $('messages');
  function addMessage(role, text, preview = false) {
    const message = document.createElement('div');
    message.className = 'message ' + role;
    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = role === 'user' ? 'YOU' : preview ? 'SAMPLE REPLY · SCRIPTED PREVIEW' : 'ROODY · LIVE REPLY';
    message.append(label, document.createTextNode(text));
    messages.append(message);
    messages.scrollTop = messages.scrollHeight;
  }
  function setBusy(value) {
    busy = value;
    $('send').disabled = value;
    $('connect-form').querySelector('button').disabled = value;
    $('sample-reply').disabled = value;
    document.querySelectorAll('[data-scenario]').forEach(button => { button.disabled = value; });
  }
  function renderScenario() {
    const scenario = scenarios[selected];
    revision++;
    $('sample-title').textContent = scenario.title;
    $('sample-description').textContent = scenario.description;
    $('copy-status').textContent = '';
    $('sample-content').replaceChildren();
    if (scenario.files) {
      scenario.files.forEach(([name, source]) => {
        const container = document.createElement('div'); container.className = 'code-file';
        const filename = document.createElement('div'); filename.className = 'file-name'; filename.textContent = name;
        const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = source;
        pre.append(code); container.append(filename, pre); $('sample-content').append(container);
      });
    } else {
      const box = document.createElement('div'); box.className = 'sample-details';
      const title = document.createElement('strong'); title.textContent = scenario.heading;
      const list = document.createElement('ul');
      scenario.items.forEach(text => { const item = document.createElement('li'); item.textContent = text; list.append(item); });
      box.append(title, list); $('sample-content').append(box);
    }
    document.querySelectorAll('[data-scenario]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scenario === selected)));
    messages.replaceChildren();
    const welcome = document.createElement('p'); welcome.className = 'small-note';
    welcome.textContent = connected ? 'Ask a question about this sample. Each live reply uses 1 demo credit.' : 'Pick a scenario, then show a sample reply. Connect a guest code when you want a real AI response.';
    messages.append(welcome);
    $('question').value = '';
  }
  const context = () => {
    const scenario = scenarios[selected];
    return scenario.title + '\n' + scenario.description + '\n' + (scenario.files ? scenario.files.map(([name, source]) => 'FILE: ' + name + '\n' + source).join('\n\n') : scenario.items.join('\n'));
  };
  async function request(action, fields = {}, code = guestCode) {
    const response = await fetch('/api/demo', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + code }, body: JSON.stringify({ action, ...fields }), signal: AbortSignal.timeout(40000) });
    let data;
    try { data = await response.json(); } catch { throw new Error('The demo server is not available yet. Ask the owner to check the deployment.'); }
    if (!response.ok || !data.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Demo access could not connect.');
    return data;
  }
  $('sample-reply').addEventListener('click', () => {
    messages.replaceChildren(); addMessage('user', scenarios[selected].question); addMessage('assistant', scenarios[selected].reply, true);
    $('chat-status').textContent = 'Scripted sample shown. No API call was made and no credits were used.';
  });
  document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => { if (!busy) renderSelection(button.dataset.scenario); }));
  function renderSelection(value) { selected = value; renderScenario(); }
  $('connect-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const code = $('demo-code').value.trim(); if (!code) return;
    setBusy(true); $('chat-status').textContent = 'Checking your demo code…';
    try {
      const data = await request('balance', {}, code);
      guestCode = code; connected = true; $('demo-code').value = ''; $('access').open = false;
      $('chat-mode').textContent = 'Guest demo connected · 1 credit per text reply';
      $('balance').hidden = false; $('balance').textContent = data.remaining + ' credits';
      $('message-form').hidden = false;
      $('chat-status').textContent = 'Connected. Ask about the sample or type your own question. Your code is kept only in this page’s memory.';
      renderScenario(); $('question').value = scenarios[selected].question; $('question').focus();
    } catch (error) { $('chat-status').textContent = error.name === 'TimeoutError' ? 'The server took too long. Try again.' : error.message || 'Could not connect. Check your code and connection.'; }
    finally { setBusy(false); }
  });
  $('message-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !connected) return;
    const text = $('question').value.trim(); if (!text) return;
    const snapshotRevision = revision;
    addMessage('user', text); $('question').value = ''; setBusy(true); $('chat-status').textContent = 'Roody is thinking with you…';
    try {
      const data = await request('chat', { text, context: context(), instructions: 'Persona: ' + selected + '. This is a fictional sample. Explain clearly and suggest one small next step.' });
      if (snapshotRevision === revision) addMessage('assistant', data.text);
      $('balance').textContent = data.remaining + ' credits';
      $('chat-status').textContent = 'Live reply received · 1 demo credit used.';
    } catch (error) { $('question').value = text; $('chat-status').textContent = error.name === 'TimeoutError' ? 'The request timed out. A credit may have been used; check your balance before retrying.' : error.message || 'The request did not finish.'; }
    finally { setBusy(false); }
  });
  async function copy(text, statusId) {
    try { await navigator.clipboard.writeText(text); $(statusId).textContent = 'Copied.'; }
    catch { $(statusId).textContent = 'Copy this: ' + text; }
  }
  $('copy-prompt').addEventListener('click', () => copy(scenarios[selected].question, 'copy-status'));
  $('copy-server').textContent = location.origin;
  $('copy-server').addEventListener('click', () => copy(location.origin, 'server-status'));
  renderScenario();
})();
