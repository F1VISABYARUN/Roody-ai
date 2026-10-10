const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const voiceSource = path.resolve(__dirname, "../src/voice.js");
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Element {
  constructor() {
    this.textContent = "";
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.children = [];
    this.handlers = new Map();
    this.srcObject = null;
    this.scrollHeight = 12;
    this.readyState = 4;
    this.videoWidth = 1920;
    this.videoHeight = 1080;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(name, handler) {
    const handlers = this.handlers.get(name) || [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  setAttribute(name, value) { this[name] = value; }
  play() { return Promise.resolve(); }
  pause() {}
  async emit(name) { for (const handler of this.handlers.get(name) || []) await handler({ target: this }); }
  click() { return this.emit("click"); }
}

// These mocks exercise the actual popup program at its browser boundaries,
// including explicit permission gestures, RTC events and late async results.
// Virtual time lets us verify recurring cleanup and idle behavior immediately.
function voiceEnvironment({ mic, token, fetcher, display, permission = true, poll, staticFrames = false } = {}) {
  const nodes = new Map();
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  el("speak-up").checked = true;
  const track = () => ({ stopped: false, stop() { this.stopped = true; } });
  const microphoneTrack = track();
  const screenTrack = track();
  const stream = { getTracks: () => [microphoneTrack], getAudioTracks: () => [microphoneTrack], getVideoTracks: () => [] };
  const screenStream = { getTracks: () => [screenTrack], getVideoTracks: () => [screenTrack] };
  const calls = [], connections = [], fetchCalls = [], microphoneCalls = [], displayCalls = [], permissionCalls = [];
  const windowEvents = {};
  let storageListener, runtimeListener;
  let time = 1_000_000, timerId = 0, imageId = 0, frameSample = 0;
  const timers = new Map();
  const schedule = (handler, delay, repeat) => {
    const id = ++timerId;
    timers.set(id, { handler, due: time + Number(delay || 0), repeat });
    return id;
  };
  const clear = (id) => timers.delete(id);
  const date = class extends Date { static now() { return time; } };
  let pageResult = poll || { ok: true, following: true, pageContext: { text: "function login() { return fetch('/login'); }", title: "login.js", site: "example.com", pageMode: "code" }, pages: [{ text: "function login() { return fetch('/login'); }", title: "login.js", site: "example.com", pageMode: "code" }], status: "ready", changed: true };
  class PeerConnection {
    constructor() { this.connectionState = "new"; this.closed = false; connections.push(this); }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "test-sdp" }; }
    async setLocalDescription() {}
    createDataChannel() {
      this.channel = {
        readyState: "connecting", events: [],
        send(event) { this.events.push(JSON.parse(event)); },
        close() { this.readyState = "closed"; this.onclose?.(); },
      };
      return this.channel;
    }
    async setRemoteDescription() { this.connectionState = "connected"; this.channel.readyState = "open"; this.channel.onopen(); }
    close() { this.closed = true; this.connectionState = "closed"; }
  }
  const document = {
    getElementById: el,
    createElement(tag) {
      const node = new Element();
      if (tag === "canvas") {
        node.getContext = () => ({
          drawImage() {}, clearRect() {},
          getImageData(x, y, width, height) { return { data: new Uint8ClampedArray(width * height * 4).fill(staticFrames ? 20 : (++frameSample * 20) % 255) }; },
        });
        node.toDataURL = () => `data:image/jpeg;base64,frame-${++imageId}`;
      }
      return node;
    },
    body: { dataset: {} },
  };
  const context = vm.createContext({
    document,
    navigator: { mediaDevices: {
      getUserMedia(options) { microphoneCalls.push(clone(options)); return mic ? mic.promise : Promise.resolve(stream); },
      getDisplayMedia(options) { displayCalls.push(clone(options)); return display ? display.promise : Promise.resolve(screenStream); },
    } },
    chrome: {
      runtime: {
        id: "roody-test-extension",
        async sendMessage(message) {
          calls.push(clone(message));
          if (message.type === "roody:companionState") return { ok: true, state: { goal: "Fix login", tasks: [], preferences: { persona: "developer", mode: "teach", language: "en" } }, pageContext: { text: "Initial page text", title: "Docs", site: "example.com" } };
          if (message.type === "roody:voiceToken") return token ? token.promise : { ok: true, value: "ephemeral-test-only" };
          if (message.type === "roody:followBrowser") return { ok: true, enabled: !!message.payload.enabled };
          if (message.type === "roody:voiceContextPoll") return clone(pageResult);
          return { ok: true };
        },
        async openOptionsPage() {},
        onMessage: { addListener(listener) { runtimeListener = listener; } },
      },
      permissions: { async request(options) { permissionCalls.push(clone(options)); return permission; } },
      storage: { onChanged: { addListener(listener) { storageListener = listener; } } },
    },
    window: { addEventListener(name, listener) { windowEvents[name] = listener; } },
    RTCPeerConnection: PeerConnection,
    MediaStream: class {},
    AbortController,
    URL,
    Date: date,
    performance: { now: () => time },
    async fetch(url, options) { fetchCalls.push({ url, ...options }); return fetcher ? fetcher.promise : { ok: true, text: async () => "answer-sdp" }; },
    setTimeout: (handler, delay) => schedule(handler, delay, 0),
    clearTimeout: clear,
    setInterval: (handler, delay) => schedule(handler, delay, Number(delay)),
    clearInterval: clear,
    console,
  });
  vm.runInContext(fs.readFileSync(voiceSource, "utf8"), context, { filename: "voice.js" });
  const advance = async (milliseconds) => {
    const target = time + milliseconds;
    while (true) {
      let nextId, next;
      for (const [id, timer] of timers) if (timer.due <= target && (!next || timer.due < next.due)) { nextId = id; next = timer; }
      if (!next) break;
      time = next.due;
      if (next.repeat) next.due += next.repeat;
      else timers.delete(nextId);
      await next.handler();
      await flush();
    }
    time = target;
    await flush();
  };
  const emitRealtime = (event) => connections.at(-1)?.channel.onmessage?.({ data: JSON.stringify(event) });
  return {
    el, context, calls, connections, fetchCalls, microphoneCalls, displayCalls, permissionCalls,
    microphoneTrack, screenTrack, stream, screenStream, windowEvents, timers, advance, emitRealtime,
    storage: () => storageListener,
    runtime: () => runtimeListener,
    setPoll(value) { pageResult = value; },
    events: () => connections.at(-1)?.channel.events || [],
    cleanup() { windowEvents.pagehide?.(); },
  };
}

test("voice requires a start gesture, uses an ephemeral credential and greets with a useful question", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  assert.equal(env.microphoneCalls.length, 0);
  assert.equal(env.displayCalls.length, 0);
  assert.equal(env.permissionCalls.length, 0);
  await env.el("voice-toggle").click();
  assert.equal(env.context.document.body.dataset.state, "listening");
  assert.equal(env.fetchCalls[0].url, "https://api.openai.com/v1/realtime/calls");
  assert.equal(env.fetchCalls[0].headers.Authorization, "Bearer ephemeral-test-only");
  assert.ok(env.events().some((event) => event.type === "session.update" && /Initial page text/.test(event.session.instructions)));
  const greeting = env.events().find((event) => event.type === "response.create").response.instructions;
  assert.match(greeting, /question/);
  assert.match(greeting, /Fix login/);
  assert.match(greeting, /thoughtful coding companion/);
  assert.match(greeting, /Speak English/);
  assert.match(greeting, /Initial page text/);
  assert.match(greeting, /untrusted data/);
  assert.equal(env.displayCalls.length, 0);
});

test("transcripts replace delta text once completed and local memory updates reach the active voice session", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  env.storage()({ roodyCompanion: { newValue: { goal: "Fix a cookie bug", tasks: [{ title: "Read session.js", status: "blocked" }], preferences: { persona: "founder", mode: "with", language: "te" } } } }, "local");
  assert.ok(env.events().some((event) => event.type === "session.update" && /Fix a cookie bug/.test(event.session.instructions)));
  env.emitRealtime({ type: "response.output_audio_transcript.delta", item_id: "reply-1", delta: "Inspect " });
  env.emitRealtime({ type: "response.output_audio_transcript.done", item_id: "reply-1", transcript: "Inspect the cookie." });
  assert.equal(env.el("transcript").children.length, 1);
  assert.equal(env.el("transcript").children[0].children[1].textContent, "Inspect the cookie.");
});

test("pausing a pending microphone request stops its late stream without creating a voice connection", async (t) => {
  const pending = deferred();
  const env = voiceEnvironment({ mic: pending });
  t.after(() => env.cleanup());
  await flush();
  const start = env.el("voice-toggle").click();
  await env.el("voice-toggle").click();
  pending.resolve(env.stream);
  await start;
  assert.equal(env.microphoneTrack.stopped, true);
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(env.connections.length, 0);
  assert.equal(env.el("voice-toggle").textContent, "Start conversation");
});

test("pausing a pending SDP exchange aborts it and a late response cannot restore the voice session", async (t) => {
  const pending = deferred();
  const env = voiceEnvironment({ fetcher: pending });
  t.after(() => env.cleanup());
  await flush();
  const start = env.el("voice-toggle").click();
  await flush();
  assert.equal(env.fetchCalls.length, 1);
  await env.el("voice-toggle").click();
  assert.equal(env.fetchCalls[0].signal.aborted, true);
  pending.resolve({ ok: true, text: async () => "late answer" });
  await start;
  assert.equal(env.context.document.body.dataset.state, "paused");
  assert.equal(env.connections[0].closed, true);
  assert.equal(env.microphoneTrack.stopped, true);
});

test("denied microphone permission produces a helpful error before requesting a voice token", async (t) => {
  const pending = deferred();
  const env = voiceEnvironment({ mic: pending });
  t.after(() => env.cleanup());
  await flush();
  const start = env.el("voice-toggle").click();
  pending.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  await start;
  assert.match(env.el("status-detail").textContent, /permission was denied/);
  assert.equal(env.calls.filter((call) => call.type === "roody:voiceToken").length, 0);
});

test("following requests optional browser permission only from its control and updates two-file context", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  assert.equal(env.permissionCalls.length, 0);
  env.el("follow-browser").checked = true;
  await env.el("follow-browser").emit("change");
  assert.deepEqual(env.permissionCalls, [{ origins: ["http://*/*", "https://*/*"] }]);
  assert.ok(env.calls.some((call) => call.type === "roody:followBrowser" && call.payload.enabled));
  const pages = [
    { text: "function login() { return fetch('/login'); }", title: "login.js", site: "example.com", pageMode: "code" },
    { text: "export const session = readCookie();", title: "session.js", site: "example.com", pageMode: "code" },
  ];
  env.setPoll({ ok: true, following: true, pageContext: pages[1], pages, status: "ready", changed: true });
  await env.advance(5000);
  const instructions = env.events().filter((event) => event.type === "session.update").at(-1).session.instructions;
  assert.match(instructions, /login\.js/);
  assert.match(instructions, /session\.js/);
  assert.equal(env.displayCalls.length, 0);
});

test("denied optional host permission leaves browsing off without starting automatic polling", async (t) => {
  const env = voiceEnvironment({ permission: false });
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  env.el("follow-browser").checked = true;
  await env.el("follow-browser").emit("change");
  assert.equal(env.el("follow-browser").checked, false);
  await env.advance(15000);
  assert.equal(env.calls.filter((call) => call.type === "roody:voiceContextPoll").length, 0);
});

test("screen sharing needs its own gesture, bounds retained visual frames and stops with voice", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  assert.equal(env.displayCalls.length, 0);
  await env.el("share-screen").click();
  assert.equal(env.displayCalls.length, 1);
  assert.equal(env.displayCalls[0].audio, false);
  await env.advance(36_000);
  const imageItems = env.events().filter((event) => event.type === "conversation.item.create" && event.item.content?.some((content) => content.type === "input_image"));
  assert.ok(imageItems.length >= 3, "shared screen should refresh images");
  const deletes = env.events().filter((event) => event.type === "conversation.item.delete");
  assert.ok(deletes.length >= imageItems.length - 2, "retain at most two image items");
  await env.el("voice-toggle").click();
  assert.equal(env.screenTrack.stopped, true);
  assert.equal(env.microphoneTrack.stopped, true);
  const callsAfterStop = env.calls.length;
  const eventsAfterStop = env.events().length;
  await env.advance(60_000);
  assert.equal(env.calls.length, callsAfterStop);
  assert.equal(env.events().length, eventsAfterStop);
});

test("a late screen chooser result is stopped after pause and never sent as an image", async (t) => {
  const pending = deferred();
  const env = voiceEnvironment({ display: pending });
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  const sharing = env.el("share-screen").click();
  await env.el("voice-toggle").click();
  pending.resolve(env.screenStream);
  await sharing;
  assert.equal(env.screenTrack.stopped, true);
  assert.equal(env.events().filter((event) => event.type === "conversation.item.create").length, 0);
});

test("minimizing leaves live microphone active while closing the popup stops it", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  await env.el("minimize-voice").click();
  assert.ok(env.calls.some((call) => call.type === "roody:voiceMinimize"));
  assert.equal(env.microphoneTrack.stopped, false);
  assert.equal(env.connections[0].closed, false);
  env.windowEvents.pagehide();
  assert.equal(env.microphoneTrack.stopped, true);
  assert.equal(env.connections[0].closed, true);
});

test("spoken check-ins obey the cooldown and do not race the user's speech or VAD response", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  env.emitRealtime({ type: "response.created" });
  env.emitRealtime({ type: "response.done", response: { status: "completed" } });
  env.el("follow-browser").checked = true;
  await env.el("follow-browser").emit("change");
  const replies = () => env.events().filter((event) => event.type === "response.create").length;
  assert.equal(replies(), 1);
  await env.advance(29_000);
  assert.equal(replies(), 1);
  await env.advance(1000);
  assert.equal(replies(), 2);
  const checkIn = env.events().filter((event) => event.type === "response.create").at(-1).response.instructions;
  assert.match(checkIn, /function login/);
  assert.match(checkIn, /Fix login/);
  assert.match(checkIn, /Speak English/);
  assert.match(checkIn, /untrusted data/);
  assert.match(checkIn, /Never request passwords/);
  env.emitRealtime({ type: "response.created" });
  env.emitRealtime({ type: "response.done", response: { status: "completed" } });
  env.emitRealtime({ type: "input_audio_buffer.speech_started" });
  const page = { text: "New version of the code", title: "session.js", site: "example.com", pageMode: "code" };
  env.setPoll({ ok: true, following: true, pageContext: page, pages: [page], status: "ready", changed: true });
  await env.advance(35_000);
  assert.equal(replies(), 2, "do not interrupt while the user is speaking");
  env.emitRealtime({ type: "input_audio_buffer.speech_stopped" });
  await env.advance(10_000);
  assert.equal(replies(), 2, "do not send response.create before VAD creates the user's response");
  env.emitRealtime({ type: "response.created" });
  await env.advance(10_000);
  assert.equal(replies(), 2, "do not overlap an in-flight response");
  env.emitRealtime({ type: "response.done", response: { status: "completed" } });
  assert.equal(replies(), 3, "a pending grounded observation resumes after the conversation is idle");
});

test("turning Speak up off suppresses autonomous responses while retaining shared context for questions", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  env.emitRealtime({ type: "response.done", response: { status: "completed" } });
  env.el("speak-up").checked = false;
  await env.el("speak-up").emit("change");
  env.el("follow-browser").checked = true;
  await env.el("follow-browser").emit("change");
  await env.advance(60_000);
  assert.equal(env.events().filter((event) => event.type === "response.create").length, 1);
  assert.match(env.events().filter((event) => event.type === "session.update").at(-1).session.instructions, /function login/);
  env.el("speak-up").checked = true;
  await env.el("speak-up").emit("change");
  assert.equal(env.events().filter((event) => event.type === "response.create").length, 2);
});

test("private-page polling clears old browser text and history from the active voice instructions", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  env.el("follow-browser").checked = true;
  await env.el("follow-browser").emit("change");
  env.setPoll({ ok: true, following: true, pageContext: null, pages: [], status: "private", changed: true });
  await env.advance(5000);
  const instructions = env.events().filter((event) => event.type === "session.update").at(-1).session.instructions;
  assert.match(instructions, /Current page text: null/);
  assert.match(instructions, /Previous pages \(historical\): \[\]/);
  assert.ok(!instructions.includes("function login()"));
  assert.match(env.el("live-context-detail").textContent, /Private or sensitive page/);
});

test("unchanged screen pixels are not repeatedly uploaded and browser Stop sharing leaves voice on", async (t) => {
  const env = voiceEnvironment({ staticFrames: true });
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  await env.el("share-screen").click();
  await env.advance(36_000);
  assert.equal(env.events().filter((event) => event.type === "conversation.item.create" && event.item.content?.some((content) => content.type === "input_image")).length, 1);
  env.screenTrack.onended();
  assert.equal(env.el("shared-video").srcObject, null);
  assert.equal(env.microphoneTrack.stopped, false);
  assert.equal(env.connections[0].closed, false);
  assert.ok(env.events().some((event) => event.type === "conversation.item.delete"));
});

test("only the extension can pause live voice remotely and the Settings off switch stops every stream", async (t) => {
  const env = voiceEnvironment();
  t.after(() => env.cleanup());
  await flush();
  await env.el("voice-toggle").click();
  await env.el("share-screen").click();
  env.runtime()({ type: "roody:pauseVoiceSession" }, { id: "untrusted-extension" }, () => { throw new Error("An untrusted pause message received a response"); });
  assert.equal(env.microphoneTrack.stopped, false);
  let response;
  env.runtime()({ type: "roody:pauseVoiceSession" }, { id: "roody-test-extension" }, (value) => { response = clone(value); });
  assert.deepEqual(response, { ok: true });
  assert.equal(env.screenTrack.stopped, true);
  assert.equal(env.microphoneTrack.stopped, true);
  assert.equal(env.connections[0].closed, true);
  const other = voiceEnvironment();
  t.after(() => other.cleanup());
  await flush();
  await other.el("voice-toggle").click();
  await other.el("share-screen").click();
  other.storage()({ roodyEnabled: { newValue: false } }, "local");
  assert.equal(other.screenTrack.stopped, true);
  assert.equal(other.microphoneTrack.stopped, true);
  assert.equal(other.connections[0].closed, true);
});
