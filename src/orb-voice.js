(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let state = { active: false, state: 'paused', sharing: false };
  let starting = false;
  let startAttempt = 0;
  let screenAttempt = 0;
  let screenPending = false;
  let screenStream = null;
  let frameTimer = null;
  let lastPixels = null;
  let framePending = false;
  let revision = 0;

  async function control(action, fields = {}) {
    const result = await chrome.runtime.sendMessage({ type: 'roody:orbVoiceControl', payload: { action, ...fields } });
    if (!result?.ok) throw new Error(result?.error || 'That control did not finish. Try again.');
    return result;
  }
  function showError(message) {
    document.body.dataset.state = 'error';
    $('status').textContent = 'Let’s check voice';
    $('detail').textContent = message;
  }
  function render() {
    document.body.dataset.state = state.state;
    $('status').textContent = starting ? 'Allow your microphone' : state.title || (state.active ? 'Here with you' : 'Talk with Roody');
    $('detail').textContent = starting ? 'Chrome will ask for microphone permission. You can cancel here.' : state.detail || 'Start here once, then speak while you work. Everything stays in your orb.';
    $('connection').textContent = starting ? 'Starting…' : state.active ? state.state === 'speaking' ? 'Speaking' : 'Mic on' : 'Mic off';
    $('toggle').textContent = starting ? 'Cancel' : state.active ? 'Pause voice' : 'Talk';
    const connected = state.active && ['listening', 'speaking'].includes(state.state);
    $('follow').disabled = !connected;
    $('share').disabled = !connected || screenPending;
    $('speak-up').disabled = !connected;
    $('follow').checked = state.following === true;
    $('speak-up').checked = state.active ? state.speakUp === true : true;
    $('share').textContent = state.sharing || screenStream ? 'Stop sharing' : 'See my screen';
    $('sharing').hidden = !state.sharing && !screenStream;
    $('sound').hidden = !state.soundBlocked;
    $('allowance').hidden = !state.demo;
    $('allowance').textContent = state.demo ? 'Demo voice · up to 3 minutes · 30 credits per session' : '';

  }
  function stopScreen(notify = false) {
    screenAttempt++;
    screenPending = false;
    clearInterval(frameTimer);
    frameTimer = null;
    const stream = screenStream;
    screenStream = null;
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    $('video').pause(); $('video').srcObject = null;
    lastPixels = null;
    if (notify) control('sharing', { enabled: false }).catch(() => {});
    render();
  }
  function receiveStatus(value) {
    revision++;
    state = value || { active: false, state: 'paused' };
    if (state.active || state.state === 'error') starting = false;
    if (!state.active && !starting) stopScreen();
    render();
  }

  $('toggle').addEventListener('click', async () => {
    if (starting) { startAttempt++; starting = false; control('pause').catch(() => {}); render(); return; }
    if (state.active) {
      startAttempt++;
      stopScreen(true);
      try { await control('pause'); } catch (error) { showError(error.message); }
      return;
    }
    const attempt = ++startAttempt;
    starting = true;
    render();
    let permissionStream;
    try {
      // This frame has the extension's origin and delegated microphone
      // permission. Grant it here on a real click before the persistent audio
      // host acquires the microphone. No key or audio crosses to the website.
      permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      permissionStream.getTracks().forEach(track => track.stop());
      permissionStream = null;
      if (attempt !== startAttempt) return;
      await control('start');
      if (attempt !== startAttempt) { await control('pause'); return; }
      if (attempt === startAttempt && !state.active) {
        $('status').textContent = 'Connecting voice';
        $('detail').textContent = 'Microphone allowed. Connecting your OpenAI voice session…';
      }
    } catch (error) {
      if (attempt !== startAttempt) return;
      starting = false; render();
      const microphoneErrors = {
        NotAllowedError: 'Microphone access was denied or this webpage blocks embedded microphone access. Allow Roody’s microphone in Chrome and try again.',
        NotFoundError: 'No microphone was found. Connect a microphone and try again.',
        NotReadableError: 'Chrome could not use the microphone. Check Windows microphone settings and other apps.'
      };
      showError(microphoneErrors[error.name] || error.message || 'Voice could not start.');
    } finally { permissionStream?.getTracks().forEach(track => track.stop()); }
  });
  $('follow').addEventListener('change', async () => {
    const enabled = $('follow').checked;
    let failure = '';
    $('follow').disabled = true;
    try {
      if (enabled && !(await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }))) throw new Error('Website access was not granted. You can still talk or share your code window.');
      await control('follow', { enabled });
    } catch (error) { failure = error.message; }
    finally { render(); if (failure) showError(failure); }
  });
  $('speak-up').addEventListener('change', async () => {
    try { await control('speak-up', { enabled: $('speak-up').checked }); }
    catch (error) { render(); showError(error.message); }
  });
  $('sound').addEventListener('click', async () => {
    try { await control('sound'); } catch (error) { showError(error.message); }
  });

  function frameFingerprint(canvas) {
    const thumbnail = document.createElement('canvas');
    thumbnail.width = 160; thumbnail.height = 90;
    const context = thumbnail.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, 0, 160, 90);
    const pixels = context.getImageData(0, 0, 160, 90).data;
    if (!lastPixels) return new Uint8ClampedArray(pixels);
    let total = 0, changed = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const delta = Math.abs(pixels[i] - lastPixels[i]) + Math.abs(pixels[i + 1] - lastPixels[i + 1]) + Math.abs(pixels[i + 2] - lastPixels[i + 2]);
      total += delta; if (delta > 30) changed++;
    }
    return changed / 14400 >= .003 || total / 43200 >= .6 ? new Uint8ClampedArray(pixels) : null;
  }
  async function sampleScreen() {
    if (!screenStream || framePending || !state.active) return;
    const attempt = screenAttempt;
    const video = $('video');
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    framePending = true;
    try {
      const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = frameFingerprint(canvas);
      if (!pixels) return;
      await control('image', { image: canvas.toDataURL('image/jpeg', .75) });
      if (attempt === screenAttempt) lastPixels = pixels;
    } catch {
      if (attempt === screenAttempt) showError('The shared screen could not be read. Stop sharing and select the editor again.');
    } finally { framePending = false; }
  }
  $('share').addEventListener('click', async () => {
    if (screenStream || state.sharing) { stopScreen(true); return; }
    if (!state.active || screenPending) return;
    const attempt = ++screenAttempt;
    screenPending = true; render();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (attempt !== screenAttempt || !state.active) { stream.getTracks().forEach(track => track.stop()); return; }
      screenStream = stream;
      await control('sharing', { enabled: true });
      if (attempt !== screenAttempt || !state.active) { stream.getTracks().forEach(track => track.stop()); return; }
      stream.getTracks().forEach(track => { track.onended = () => stopScreen(true); });
      $('video').srcObject = stream;
      $('video').onloadeddata = () => { if (attempt === screenAttempt) sampleScreen(); };
      await $('video').play();
      if (attempt !== screenAttempt) return;
      await sampleScreen();
      frameTimer = setInterval(sampleScreen, 12000);
    } catch (error) {
      if (attempt === screenAttempt) {
        stopScreen(true);
        showError(error.name === 'NotAllowedError' ? 'Screen sharing was cancelled or blocked. Voice is still on.' : error.message || 'Screen sharing could not start.');
      }
    } finally { if (attempt === screenAttempt) { screenPending = false; render(); } }
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('src/background.js'))) return;
    if (message.type === 'roody:orbVoiceStatus') receiveStatus(message.payload);
    if (message.type === 'roody:orbStopSharing') stopScreen();
  });
  window.addEventListener('pagehide', () => { startAttempt++; if (screenStream || screenPending) stopScreen(true); });
  const requestRevision = revision;
  chrome.runtime.sendMessage({ type: 'roody:getVoiceStatus' }).then(result => {
    if (revision === requestRevision && result?.ok) receiveStatus(result.status);
  }).catch(() => showError('Roody could not connect to its extension. Reload the extension and this page.'));
  render();
})();
