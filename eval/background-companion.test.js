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
function background({ initial = {}, initialSession = {}, fetchImpl, storageDelay = 0, hostPermission = false } = {}) {
  const storage = clone(initial);
  const sessionStorage = clone(initialSession);
  const messageListeners = [];
  const removedListeners = [];
  const activatedListeners = [];
  const updatedListeners = [];
  const focusListeners = [];
  const permissionRemovedListeners = [];
  const requests = [];
  const writes = [];
  const sessionWrites = [];
  const createdWindows = [];
  const windowUpdates = [];
  const tabMessages = [];
  const injections = [];
  const permissionChecks = [];
  const tabs = [{ id: 7, windowId: 1, active: true, url: contentSender.url, title: "Docs" }];
  const tabContexts = new Map([[7, { text: "Documentation page", title: "Docs", site: "example.com", pageMode: "page", sensitive: false }]]);
  const tabErrors = new Map();
  let granted = hostPermission;
  const pause = () => storageDelay ? new Promise((resolve) => setTimeout(resolve, storageDelay)) : Promise.resolve();
  const chrome = {
    runtime: {
      id: extensionId,
      getURL: (file) => `chrome-extension://${extensionId}/${file}`,
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      openOptionsPage: () => {},
    },
    action: { onClicked: { addListener: () => {} } },
    storage: { session: {
      async get(keys) {
        const snapshot = {};
        for (const key of keys) if (Object.hasOwn(sessionStorage, key)) snapshot[key] = clone(sessionStorage[key]);
        return snapshot;
      },
      async set(values) { sessionWrites.push(clone(values)); Object.assign(sessionStorage, clone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStorage[key]; },
    }, local: {
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
      onFocusChanged: { addListener: (listener) => focusListeners.push(listener) },
      WINDOW_ID_NONE: -1,
      async getLastFocused() { return { id: 1, type: "normal", focused: true, tabs: clone(tabs.filter((tab) => tab.windowId === 1)) }; },
      async getAll() { return [{ id: 1, type: "normal", focused: true, tabs: clone(tabs) }]; },
      async create(options) {
        createdWindows.push(clone(options));
        return { id: 11, tabs: [{ id: 23, url: options.url }] };
      },
      async get(id) {
        if (id === 11) return { id, type: "popup", tabs: [{ id: 23, url: voiceUrl }] };
        return { id, type: "normal", tabs: clone(tabs.filter((tab) => tab.windowId === id)) };
      },
      async update(id, options) { windowUpdates.push({ id, ...clone(options) }); },
    },
    permissions: {
      async contains(details) { permissionChecks.push(clone(details)); return granted; },
      onRemoved: { addListener: (listener) => permissionRemovedListeners.push(listener) },
    },
    scripting: {
      async executeScript(details) { injections.push(clone(details)); return []; },
      async insertCSS() {},
    },
    tabs: {
      onActivated: { addListener: (listener) => activatedListeners.push(listener) },
      onUpdated: { addListener: (listener) => updatedListeners.push(listener) },
      onRemoved: { addListener: () => {} },
      async get(id) {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) throw new Error("No such tab");
        return clone(tab);
      },
      async query(query) {
        return clone(tabs.filter((tab) =>
          (query.active === undefined || tab.active === query.active) &&
          (query.windowId === undefined || tab.windowId === query.windowId) &&
          (query.url === undefined || tab.url === query.url)));
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, ...clone(message) });
        if (message.type === "roody:readVoiceContext") {
          if (tabErrors.has(tabId)) throw tabErrors.get(tabId);
          const value = tabContexts.get(tabId);
          return clone(typeof value === "function" ? await value() : value);
        }
        return { ok: true };
      },
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
    windowUpdates,
    sessionStorage,
    sessionWrites,
    tabMessages,
    injections,
    permissionChecks,
    tabs,
    tabContexts,
    tabErrors,
    grantPermission: (value = true) => { granted = value; },
    activateTab(id) {
      for (const tab of tabs) tab.active = tab.id === id;
      for (const listener of activatedListeners) listener({ tabId: id, windowId: tabs.find((tab) => tab.id === id)?.windowId });
    },
    focusWindow(id) { for (const listener of focusListeners) listener(id); },
    revokePermission() {
      granted = false;
      for (const listener of permissionRemovedListeners) listener({ origins: ["http://*/*", "https://*/*"] });
    },
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

test("follow, page polling, orb status and minimizing reject untrusted senders before accessing browser data", async () => {
  const app = background({ hostPermission: true, initial: { roodyOpenAIKey: apiKey } });
  const unauthorized = [contentSender, { ...voiceSender, id: "other-extension" }, { ...voiceSender, url: `${voiceUrl}?fake=1` }];
  for (const sender of unauthorized) {
    for (const type of ["roody:followBrowser", "roody:voiceContextPoll", "roody:voiceStatus", "roody:voiceMinimize"]) {
      const response = await app.send(type, { enabled: true, active: true, state: "listening", title: "Listening" }, sender);
      assert.equal(response.ok, false, `${type} accepted ${sender.url}`);
      assert.ok(!JSON.stringify(response).includes(apiKey));
    }
  }
  assert.equal(app.permissionChecks.length, 0);
  assert.equal(app.tabMessages.length, 0);
  assert.equal(app.sessionWrites.length, 0);
  assert.equal(app.windowUpdates.length, 0);
});

test("live browsing defaults paused and cannot be enabled before optional host permission is granted", async () => {
  const app = background();
  await app.send("roody:openVoice", { pageContext: "Explicit one-time snapshot", title: "One" });
  const paused = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(paused.following, false);
  assert.equal(paused.status, "paused");
  assert.equal(app.tabMessages.filter((message) => message.type === "roody:readVoiceContext").length, 0);
  const denied = await app.send("roody:followBrowser", { enabled: true }, voiceSender);
  assert.equal(denied.ok, false);
  assert.equal(denied.enabled, false);
  assert.deepEqual(app.permissionChecks.at(-1), { origins: ["http://*/*", "https://*/*"] });
  assert.equal(app.injections.length, 0);
  app.grantPermission();
  assert.deepEqual(await app.send("roody:followBrowser", { enabled: true }, voiceSender), { ok: true, enabled: true });
});

test("following reads the normal browser tab behind the voice popup and keeps only two distinct pages", async () => {
  const app = background({ hostPermission: true });
  await app.send("roody:openVoice", { pageContext: "Initial docs", title: "Docs" });
  await app.send("roody:followBrowser", { enabled: true }, voiceSender);
  app.focusWindow(11);
  const first = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(first.ok, true);
  assert.equal(first.following, true);
  assert.equal(first.status, "ready");
  assert.equal(first.pageContext.text, "Documentation page");
  app.tabs.push({ id: 8, windowId: 1, active: false, url: "https://example.com/login.js", title: "login.js" });
  app.tabContexts.set(8, { text: "function login() { return fetch('/login'); }", title: "login.js", site: "example.com", pageMode: "code", sensitive: false });
  app.activateTab(8);
  const second = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(second.pageContext.title, "login.js");
  assert.equal(second.pages.length, 2);
  assert.ok(second.pages.some((page) => page.title === "Docs"));
  app.tabContexts.set(8, { ...app.tabContexts.get(8), text: "function login() { return fetch('/login', {credentials:'include'}); }" });
  const edited = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(edited.pages.length, 2);
  assert.match(edited.pageContext.text, /credentials/);
  app.tabs.push({ id: 9, windowId: 1, active: false, url: "https://example.com/session.js", title: "session.js" });
  app.tabContexts.set(9, { text: "export const session = readCookie();", title: "session.js", site: "example.com", pageMode: "code", sensitive: false });
  app.activateTab(9);
  const third = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(third.pages.length, 2);
  assert.deepEqual(third.pages.map((page) => page.title), ["login.js", "session.js"]);
  assert.equal(app.writes.length, 0, "page text must not be persisted");
  assert.equal(app.requests.length, 0, "polling must not send page text to an API itself");
});

test("the private-page shield clears both current and previous page context before it can reach voice", async () => {
  const app = background({ hostPermission: true });
  await app.send("roody:openVoice", { pageContext: "Initial public page" });
  await app.send("roody:followBrowser", { enabled: true }, voiceSender);
  assert.equal((await app.send("roody:voiceContextPoll", undefined, voiceSender)).status, "ready");
  app.tabContexts.set(7, { text: "SECRET PASSWORD OR OTP MUST NEVER LEAVE THIS PAGE", title: "Sign in", site: "example.com", sensitive: true });
  const blocked = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(blocked.status, "private");
  assert.equal(blocked.pageContext, null);
  assert.deepEqual(blocked.pages, []);
  assert.ok(!JSON.stringify(blocked).includes("SECRET PASSWORD"));
  assert.equal((await app.send("roody:companionState", undefined, voiceSender)).pageContext, null);
  app.tabContexts.set(7, { text: "Public documentation again", title: "Docs", site: "example.com", sensitive: false });
  const recovered = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.pages.length, 1);
});

test("unsupported browser pages clear stale current context without injecting scripts", async () => {
  const app = background({ hostPermission: true });
  await app.send("roody:openVoice", { pageContext: "Old public context" });
  await app.send("roody:followBrowser", { enabled: true }, voiceSender);
  await app.send("roody:voiceContextPoll", undefined, voiceSender);
  const readCount = app.tabMessages.filter((message) => message.type === "roody:readVoiceContext").length;
  app.tabs[0].url = "chrome://settings";
  const unavailable = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.pageContext, null);
  assert.equal(app.injections.length, 0);
  assert.equal(app.tabMessages.filter((message) => message.type === "roody:readVoiceContext").length, readCount);
});

test("automatic injection is available only during granted follow and an absent listener fails without leaking errors", async () => {
  const app = background({ hostPermission: true });
  await app.send("roody:openVoice");
  app.tabErrors.set(7, new Error(`Could not read page containing ${apiKey}`));
  await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(app.injections.length, 0);
  await app.send("roody:followBrowser", { enabled: true }, voiceSender);
  const failed = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.pageContext, null);
  assert.ok(app.injections.length > 0);
  assert.ok(!JSON.stringify(failed).includes(apiKey));
  assert.ok(!JSON.stringify(app.sessionStorage).includes(apiKey));
});

test("orb status persists bounded display fields only in session storage and does not broadcast credentials or raw context", async () => {
  const app = background({ initial: { roodyOpenAIKey: apiKey } });
  await app.send("roody:openVoice", { pageContext: "Raw code context" });
  const response = await app.send("roody:voiceStatus", {
    state: "speaking", title: "Roody is speaking ".repeat(40), active: true, following: false, sharing: true, speakUp: true,
    transcript: "Useful explanation. ".repeat(100), roodyOpenAIKey: apiKey, pageContext: "Raw code context", unexpected: "secret",
  }, voiceSender);
  assert.equal(response.ok, true);
  assert.ok(app.sessionWrites.length > 0);
  assert.equal(app.writes.length, 0);
  const status = Object.values(app.sessionStorage).find((value) => value?.state === "speaking");
  assert.ok(status);
  assert.ok(status.title.length <= 200);
  assert.ok(status.transcript.length <= 600);
  assert.equal(status.active, true);
  assert.equal(status.sharing, true);
  const broadcast = app.tabMessages.find((message) => message.type === "roody:voiceStatus");
  assert.ok(broadcast);
  assert.ok(!JSON.stringify({ status, broadcast }).includes(apiKey));
  assert.ok(!JSON.stringify({ status, broadcast }).includes("Raw code context"));
  assert.ok(!Object.hasOwn(status, "unexpected"));
});

test("pausing, closing the popup and revoking optional permission stop following and erase page caches", async () => {
  for (const cleanup of ["pause", "close", "revoke"]) {
    const app = background({ hostPermission: true });
    await app.send("roody:openVoice", { pageContext: "Initial docs" });
    await app.send("roody:followBrowser", { enabled: true }, voiceSender);
    await app.send("roody:voiceContextPoll", undefined, voiceSender);
    if (cleanup === "pause") await app.send("roody:voiceStatus", { state: "paused", active: false, following: false }, voiceSender);
    if (cleanup === "close") app.closeVoice();
    if (cleanup === "revoke") app.revokePermission();
    await new Promise((resolve) => setImmediate(resolve));
    const response = await app.send("roody:voiceContextPoll", undefined, voiceSender);
    assert.equal(response.following, false, cleanup);
    assert.equal(response.pageContext, null, cleanup);
    assert.deepEqual(response.pages, [], cleanup);
    assert.equal((await app.send("roody:companionState", undefined, voiceSender)).pageContext, null, cleanup);
  }
});

test("minimizing the trusted live voice popup keeps its session and page context", async () => {
  const app = background();
  await app.send("roody:openVoice", { pageContext: "Shared page" });
  const response = await app.send("roody:voiceMinimize", undefined, voiceSender);
  assert.equal(response.ok, true);
  assert.ok(app.windowUpdates.some((update) => update.id === 11 && update.state === "minimized"));
  assert.equal((await app.send("roody:companionState", undefined, voiceSender)).pageContext.text, "Shared page");
});

test("a late page read cannot replace the active tab's newer context", async () => {
  const app = background({ hostPermission: true });
  await app.send("roody:openVoice");
  await app.send("roody:followBrowser", { enabled: true }, voiceSender);
  let resolveOld;
  const delayed = new Promise((resolve) => { resolveOld = resolve; });
  app.tabContexts.set(7, () => delayed);
  const oldRead = app.send("roody:voiceContextPoll", undefined, voiceSender);
  await new Promise((resolve) => setImmediate(resolve));
  app.tabs.push({ id: 8, windowId: 1, active: false, url: "https://example.com/new.js", title: "new.js" });
  app.tabContexts.set(8, { text: "New active file", title: "new.js", site: "example.com", pageMode: "code", sensitive: false });
  app.activateTab(8);
  const latest = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(latest.pageContext.text, "New active file");
  resolveOld({ text: "STALE CONTEXT MUST NOT RETURN", title: "Old page", site: "example.com", sensitive: false });
  const late = await oldRead;
  assert.equal(late.pageContext.text, "New active file");
  assert.ok(!JSON.stringify(late).includes("STALE CONTEXT"));
  assert.equal((await app.send("roody:companionState", undefined, voiceSender)).pageContext.text, "New active file");
});

test("the Settings off state prevents browser extraction and automatic injection", async () => {
  const app = background({ hostPermission: true, initial: { roodyEnabled: false } });
  await app.send("roody:openVoice");
  await app.send("roody:followBrowser", { enabled: true }, voiceSender);
  const result = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(result.status, "unavailable");
  assert.equal(result.pageContext, null);
  assert.equal(app.tabMessages.filter((message) => message.type === "roody:readVoiceContext").length, 0);
  assert.equal(app.injections.length, 0);
});

test("display status strips key-looking strings and treats malformed active states as paused", async () => {
  const app = background();
  await app.send("roody:openVoice");
  const redacted = await app.send("roody:voiceStatus", {
    state: "listening", active: true, title: `Listening ${apiKey}`, transcript: `Do not show ${apiKey} or Bearer secret-token-over-12chars`,
  }, voiceSender);
  assert.ok(!JSON.stringify(redacted).includes(apiKey));
  assert.ok(!JSON.stringify(redacted).includes("secret-token-over-12chars"));
  assert.match(redacted.status.transcript, /redacted/);
  const malformed = await app.send("roody:voiceStatus", { state: "execute-anything", active: true, sharing: true, speakUp: true }, voiceSender);
  assert.equal(malformed.status.state, "paused");
  assert.equal(malformed.status.active, false);
  assert.equal(malformed.status.sharing, false);
  assert.equal(malformed.status.speakUp, false);
});

test("worker restart restores safe orb display only for a surviving voice tab and never restores browser consent", async () => {
  const saved = { state: "listening", title: "Here with you", active: true, following: true, sharing: true, speakUp: true, transcript: `Do not expose ${apiKey}`, unexpected: apiKey };
  const app = background({ initialSession: { roodyVoiceStatus: saved }, hostPermission: true });
  app.tabs.push({ id: 23, windowId: 11, active: true, url: voiceUrl, title: "Roody Companion" });
  const hydrated = await app.send("roody:getVoiceStatus");
  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.status.active, true);
  assert.equal(hydrated.status.following, false);
  assert.ok(!JSON.stringify(hydrated).includes(apiKey));
  const context = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(context.following, false);
  assert.equal(context.pageContext, null);
  const closed = background({ initialSession: { roodyVoiceStatus: saved } });
  const stale = await closed.send("roody:getVoiceStatus");
  assert.equal(stale.status.active, false);
  assert.equal(stale.status.state, "paused");
  assert.deepEqual(await closed.send("roody:getVoiceStatus", undefined, { ...contentSender, id: "untrusted-extension" }), { ok: false });
});

test("opening voice after worker restart restores an existing minimized host instead of creating a duplicate", async () => {
  const app = background();
  app.tabs.push({ id: 23, windowId: 11, active: true, url: voiceUrl, title: "Roody Companion" });
  const response = await app.send("roody:openVoice", { pageContext: "Freshly selected page", title: "New docs", site: "example.com" });
  assert.equal(response.ok, true);
  assert.equal(app.createdWindows.length, 0);
  assert.ok(app.windowUpdates.some((update) => update.id === 11 && update.state === "normal" && update.focused === true));
  assert.equal((await app.send("roody:companionState", undefined, voiceSender)).pageContext.text, "Freshly selected page");
});

test("the Settings off state prevents minting voice credentials even when an API key exists", async () => {
  const app = background({ initial: { roodyEnabled: false, roodyOpenAIKey: apiKey } });
  const response = await app.send("roody:voiceToken", undefined, voiceSender);
  assert.equal(response.ok, false);
  assert.match(response.error, /off|disabled|Settings/i);
  assert.ok(!JSON.stringify(response).includes(apiKey));
  assert.equal(app.requests.length, 0);
  assert.equal(app.writes.length, 0);
});

test("two editor files with one project URL and title remain distinct while edits refresh their existing snapshot", async () => {
  const app = background({ hostPermission: true });
  app.tabs[0].url = "https://example.com/editor/project";
  app.tabs[0].title = "Roody project";
  await app.send("roody:openVoice");
  await app.send("roody:followBrowser", { enabled: true }, voiceSender);
  const file = (name, code) => ({ text: `FILE / EDITOR: ${name}\n${code}`, title: "Roody project", site: "example.com", pageMode: "code", sensitive: false });
  app.tabContexts.set(7, file("login.js", "function login() { return fetch('/login'); }"));
  const login = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(login.pages.length, 1);
  app.tabContexts.set(7, file("session.js", "export const session = readCookie();"));
  const session = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(session.pages.length, 2);
  assert.ok(session.pages.some((page) => page.text.includes("FILE / EDITOR: login.js")));
  assert.ok(session.pages.some((page) => page.text.includes("FILE / EDITOR: session.js")));
  app.tabContexts.set(7, file("session.js", "export const session = readSecureCookie();"));
  const edited = await app.send("roody:voiceContextPoll", undefined, voiceSender);
  assert.equal(edited.pages.length, 2);
  assert.match(edited.pageContext.text, /readSecureCookie/);
  assert.ok(edited.pages.some((page) => page.text.includes("FILE / EDITOR: login.js")));
});
