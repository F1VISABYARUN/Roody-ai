const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const sourceRoot = path.resolve(__dirname, "../src");
const extensionId = "roody-test-extension";
const voiceUrl = `chrome-extension://${extensionId}/src/voice.html`;
const apiKey = "sk-test-full-key-never-expose-to-page";
const contentSender = { id: extensionId, url: "https://example.com/docs", tab: { id: 7 } };
const voiceSender = { id: extensionId, url: voiceUrl, tab: { id: 23 } };
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// Execute the actual service worker and its dependency scripts. Storage clones
// on both sides of its async boundary, like Chrome does: sharing references
// would conceal lost updates and mutations that are invalid in the browser.
function background({ initial = {}, fetchImpl, storageDelay = 0 } = {}) {
  const storage = clone(initial);
  const messageListeners = [];
  const removedListeners = [];
  const requests = [];
  const writes = [];
  const createdWindows = [];
  const pause = () => storageDelay ? new Promise((resolve) => setTimeout(resolve, storageDelay)) : Promise.resolve();
  const chrome = {
    runtime: {
      id: extensionId,
      getURL: (file) => `chrome-extension://${extensionId}/${file}`,
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      openOptionsPage: () => {},
    },
    action: { onClicked: { addListener: () => {} } },
    storage: { local: {
      async get(keys) {
        const snapshot = {};
        for (const key of keys) if (Object.hasOwn(storage, key)) snapshot[key] = clone(storage[key]);
        await pause();
        return snapshot;
      },
      async set(values) {
        const snapshot = clone(values);
        await pause();
        writes.push(snapshot);
        Object.assign(storage, snapshot);
      },
    } },
    windows: {
      onRemoved: { addListener: (listener) => removedListeners.push(listener) },
      async create(options) {
        createdWindows.push(clone(options));
        return { id: 11, tabs: [{ id: 23, url: options.url }] };
      },
      async get(id) {
        assert.equal(id, 11);
        return { id, tabs: [{ id: 23, url: voiceUrl }] };
      },
      async update() {},
    },
  };
  const context = vm.createContext({
    chrome,
    crypto: { randomUUID },
    console,
    setTimeout,
    clearTimeout,
    URL,
    AbortSignal,
    performance,
    async fetch(url, options) {
      requests.push({ url, options });
      if (!fetchImpl) throw new Error("Unexpected network request in test");
      return fetchImpl(url, options);
    },
  });
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      const filename = path.join(sourceRoot, file.replace(/^src\//, ""));
      vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, "background.js"), "utf8"), context, { filename: "background.js" });

  const send = (type, payload, sender = contentSender) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No runtime response to ${type}`)), 1000);
    const respond = (value) => {
      clearTimeout(timeout);
      resolve(clone(value));
    };
    try {
      for (const listener of messageListeners) listener({ type, payload }, sender, respond);
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
  return {
    send,
    storage,
    requests,
    writes,
    createdWindows,
    closeVoice: () => removedListeners.forEach((listener) => listener(11)),
  };
}

const rememberedState = {
  goal: "Ship the Roody hackathon demo",
  tasks: [{ id: "task-1", title: "Fix login", status: "blocked", blocker: "Waiting for reproduction" }],
  preferences: { persona: "founder", mode: "teach", language: "te" },
};

test("runtime updates persist goals, tasks, status, blockers and language preferences across worker restart", async () => {
  const app = background();
  assert.equal((await app.send("roody:companionUpdate", { type: "goal", text: "  Ship a demo  " })).state.goal, "Ship a demo");
  const added = await app.send("roody:companionUpdate", { type: "add-task", text: "Fix voice" });
  assert.equal(added.ok, true);
  const id = added.state.tasks[0].id;
  await app.send("roody:companionUpdate", { type: "task", id, status: "blocked", text: "Need microphone access" });
  await app.send("roody:companionUpdate", { type: "preferences", persona: "grandparent", mode: "teach", language: "te" });
  assert.equal(app.storage.roodyLang, "te-IN");
  const restarted = background({ initial: app.storage });
  const state = await restarted.send("roody:companionState");
  assert.deepEqual(state, {
    ok: true,
    state: { goal: "Ship a demo", tasks: [{ id, title: "Fix voice", status: "blocked", blocker: "Need microphone access" }], preferences: { persona: "grandparent", mode: "teach", language: "te" } },
  });
  await restarted.send("roody:companionUpdate", { type: "preferences", language: "auto" });
  assert.equal(restarted.storage.roodyLang, "");
  assert.equal(restarted.requests.length, 0);
});

test("simultaneous runtime task additions do not overwrite one another", async () => {
  const app = background({ storageDelay: 2 });
  const titles = ["Voice", "Screen", "Planner", "Demo"];
  const responses = await Promise.all(titles.map((text) => app.send("roody:companionUpdate", { type: "add-task", text })));
  assert.ok(responses.every((response) => response.ok));
  const { state } = await app.send("roody:companionState");
  assert.deepEqual(state.tasks.map((task) => task.title), titles);
  assert.equal(new Set(state.tasks.map((task) => task.id)).size, titles.length);
  assert.equal(app.writes.length, titles.length);
});

test("an invalid update leaves saved memory intact and does not poison subsequent queued updates", async () => {
  const app = background({ initial: { roodyCompanion: rememberedState } });
  const invalid = await app.send("roody:companionUpdate", { type: "task", id: "task-1", status: apiKey });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Invalid companion update/);
  assert.ok(!JSON.stringify(invalid).includes(apiKey));
  assert.deepEqual(app.storage.roodyCompanion, rememberedState);
  const valid = await app.send("roody:companionUpdate", { type: "add-task", text: "Test the demo" });
  assert.equal(valid.ok, true);
  assert.equal(valid.state.tasks.length, 2);
});

test("companion responses and shared voice context never expose stored API credentials", async () => {
  const app = background({ initial: {
    roodyOpenAIKey: apiKey,
    roodyCompanion: { ...rememberedState, roodyOpenAIKey: apiKey, preferences: { ...rememberedState.preferences, key: apiKey } },
  } });
  await app.send("roody:openVoice", {
    pageContext: "Login fails with a 401 response", title: "Login docs", site: "example.com", roodyOpenAIKey: apiKey,
  });
  const content = await app.send("roody:companionState");
  const voice = await app.send("roody:companionState", undefined, voiceSender);
  assert.deepEqual(content, { ok: true, state: rememberedState });
  assert.deepEqual(voice.pageContext, { text: "Login fails with a 401 response", title: "Login docs", site: "example.com" });
  assert.ok(!JSON.stringify({ content, voice }).includes(apiKey));
  const changed = await app.send("roody:companionUpdate", { type: "goal", text: "Prepare the demo" });
  assert.ok(!JSON.stringify(changed).includes(apiKey));
  assert.equal(app.storage.roodyOpenAIKey, apiKey);
  assert.ok(!JSON.stringify(app.storage.roodyCompanion).includes(apiKey));
  const anotherVoiceTab = await app.send("roody:companionState", undefined, { ...voiceSender, tab: { id: 99 } });
  assert.equal(anotherVoiceTab.pageContext, null);
});

test("voice credentials require both the extension ID and exact trusted voice page URL, before fetch", async () => {
  const app = background({ initial: { roodyOpenAIKey: apiKey } });
  const unauthorized = [
    contentSender,
    { ...voiceSender, id: "other-extension" },
    { ...voiceSender, url: `chrome-extension://${extensionId}/src/options.html` },
    { ...voiceSender, url: `${voiceUrl}?imitate=voice` },
    { ...voiceSender, url: `https://example.com/src/voice.html` },
  ];
  for (const sender of unauthorized) {
    const response = await app.send("roody:voiceToken", undefined, sender);
    assert.equal(response.ok, false);
    assert.match(response.error, /only available inside the Roody voice window/);
    assert.ok(!JSON.stringify(response).includes(apiKey));
  }
  assert.equal(app.requests.length, 0);
});

test("trusted live voice without an OpenAI key gives a useful Settings instruction without fetching", async () => {
  const app = background({ initial: { roodyGeminiKey: "gemini-test-key" } });
  const response = await app.send("roody:voiceToken", undefined, voiceSender);
  assert.equal(response.ok, false);
  assert.match(response.error, /Open Settings and save an OpenAI API key/);
  assert.equal(app.requests.length, 0);
});

test("live voice exchanges the full key only in authorization and returns only the ephemeral value", async () => {
  const app = background({ initial: { roodyOpenAIKey: apiKey, roodyCompanion: rememberedState }, fetchImpl: async () => ({
    ok: true,
    json: async () => ({ value: "ek-short-lived-voice-token", expires_at: 123, secret_debug: apiKey, session: { sensitive: apiKey } }),
  }) });
  await app.send("roody:openVoice", { pageContext: "Login returns 401; retry cookie session", title: "Login investigation", site: "example.com" });
  const response = await app.send("roody:voiceToken", undefined, voiceSender);
  assert.deepEqual(response, { ok: true, value: "ek-short-lived-voice-token" });
  assert.equal(app.requests.length, 1);
  const { url, options } = app.requests[0];
  assert.equal(url, "https://api.openai.com/v1/realtime/client_secrets");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(options.headers["content-type"], "application/json");
  assert.ok(!url.includes(apiKey));
  assert.ok(!options.body.includes(apiKey));
  assert.ok(!JSON.stringify(response).includes(apiKey));
  const body = JSON.parse(options.body);
  assert.equal(body.session.type, "realtime");
  assert.equal(body.session.model, "gpt-realtime");
  assert.match(body.session.instructions, /TEACH ME/);
  assert.match(body.session.instructions, /CEO\/CTO adviser/);
  assert.match(body.session.instructions, /use Telugu/);
  assert.match(body.session.instructions, /Ship the Roody hackathon demo/);
  assert.match(body.session.instructions, /Waiting for reproduction/);
  assert.match(body.session.instructions, /Login returns 401; retry cookie session/);
  assert.match(body.session.instructions, /snapshot explicitly shared, not live changes/);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(app.writes.length, 0);
});

test("OpenAI voice error bodies are neither read, persisted nor echoed to the user", async () => {
  let bodyReads = 0;
  const app = background({ initial: { roodyOpenAIKey: apiKey }, fetchImpl: async () => ({
    ok: false,
    status: 401,
    text: async () => { bodyReads++; return `Incorrect API key: ${apiKey}`; },
    json: async () => { bodyReads++; return { error: { message: `Incorrect API key: ${apiKey}` } }; },
  }) });
  const response = await app.send("roody:voiceToken", undefined, voiceSender);
  assert.equal(response.ok, false);
  assert.match(response.error, /Voice access failed \(401\)/);
  assert.match(response.error, /text chat is still available/);
  assert.ok(!JSON.stringify(response).includes(apiKey));
  assert.equal(bodyReads, 0);
  assert.equal(app.writes.length, 0);
});

test("network failures and malformed voice secrets produce safe actionable errors", async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`Network exception containing ${apiKey}`); },
    async () => ({ ok: true, json: async () => ({ value: "" }) }),
    async () => ({ ok: true, json: async () => ({ value: { token: apiKey } }) }),
    async () => ({ ok: true, json: async () => { throw new Error(`Bad JSON containing ${apiKey}`); } }),
  ]) {
    const app = background({ initial: { roodyOpenAIKey: apiKey }, fetchImpl });
    const response = await app.send("roody:voiceToken", undefined, voiceSender);
    assert.equal(response.ok, false);
    assert.match(response.error, /Could not (connect|create)/);
    assert.ok(!JSON.stringify(response).includes(apiKey));
    assert.equal(app.writes.length, 0);
  }
});

test("voice window reuse updates its explicit page snapshot and closing clears it", async () => {
  const app = background();
  await app.send("roody:openVoice", { pageContext: "First page", title: "One", site: "example.com" });
  await app.send("roody:openVoice", { pageContext: "Second page", title: "Two", site: "example.org" });
  assert.equal(app.createdWindows.length, 1);
  assert.equal((await app.send("roody:companionState", undefined, voiceSender)).pageContext.text, "Second page");
  app.closeVoice();
  assert.equal((await app.send("roody:companionState", undefined, voiceSender)).pageContext, null);
  await app.send("roody:openVoice");
  assert.equal(app.createdWindows.length, 2);
  assert.equal((await app.send("roody:companionState", undefined, voiceSender)).pageContext, null);
});

test("text chat request includes the selected companion mode and saved memory alongside page context", async () => {
  const app = background({ initial: { roodyOpenAIKey: apiKey, roodyBrainPref: "openai", roodyCompanion: rememberedState }, fetchImpl: async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "Let's inspect the login request." } }] }),
  }) });
  const response = await app.send("roody:ask", { userText: "Teach me what fails", pageContext: "The login page says 401", history: [], site: "example.com", title: "Login", pageMode: "code" });
  assert.deepEqual(response, { ok: true, text: "Let's inspect the login request." });
  assert.equal(app.requests.length, 1);
  const { options } = app.requests[0];
  const body = JSON.parse(options.body);
  const system = body.messages.find((message) => message.role === "system").content;
  assert.match(system, /TEACH ME/);
  assert.match(system, /CEO\/CTO adviser/);
  assert.match(system, /Ship the Roody hackathon demo/);
  assert.match(system, /Waiting for reproduction/);
  assert.match(system, /use Telugu/);
  assert.match(system, /CODE MODE/);
  const lastMessage = body.messages.at(-1);
  assert.match(lastMessage.content, /The login page says 401/);
  assert.match(lastMessage.content, /Teach me what fails/);
  assert.equal(options.headers.authorization, `Bearer ${apiKey}`);
  assert.ok(!options.body.includes(apiKey));
});
