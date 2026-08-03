const DEFAULT_CAPS = Object.freeze({
  weapon: 7,
  impact: 9,
  feedback: 5,
  ui: 3,
  cinematic: 4,
  global: 24,
});

const EVENT_COOLDOWNS = Object.freeze({
  shoot: 0.036,
  impact: 0.042,
  kill: 0.07,
  lane: 0.055,
  gateBreak: 0.14,
  upgrade: 0.18,
  warning: 0.22,
  overdrive: 0.22,
  boss: 0.4,
  victory: 0.5,
  soundOn: 0.12,
});

const CATEGORY_VOLUME = Object.freeze({
  weapon: 0.78,
  impact: 0.84,
  feedback: 0.86,
  ui: 0.76,
  cinematic: 0.96,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let number = value;
    number = Math.imul(number ^ (number >>> 15), number | 1);
    number ^= number + Math.imul(number ^ (number >>> 7), number | 61);
    return ((number ^ (number >>> 14)) >>> 0) / 4294967296;
  };
}

function safeDisconnect(node) {
  try {
    node.disconnect();
  } catch {
    // The browser may already have disconnected a finished one-shot node.
  }
}

export function createToyAudioSystem({
  getTheme = () => 'zombie',
  getElapsed = () => 0,
  muted: initialMuted = false,
  masterVolume: initialMasterVolume = 0.82,
} = {}) {
  let context = null;
  let graph = null;
  let muted = Boolean(initialMuted);
  let masterVolume = clamp(Number(initialMasterVolume) || 0.82, 0, 1.2);
  let disposed = false;
  let voiceId = 0;
  let random = mulberry32(0x51f15e7);
  const buffers = new Map();
  const activeVoices = new Map();
  const lastPlayedAt = new Map();
  const eventCounts = Object.create(null);
  const droppedVoices = Object.create(null);
  const lastEvents = [];

  function themeId() {
    return getTheme?.() === 'deadline' ? 'deadline' : 'zombie';
  }

  function countEvent(name, detail = '') {
    eventCounts[name] = (eventCounts[name] || 0) + 1;
    lastEvents.push({
      name,
      theme: themeId(),
      detail,
      gameTime: Number((Number(getElapsed?.()) || 0).toFixed(2)),
      at: Date.now(),
    });
    if (lastEvents.length > 18) lastEvents.shift();
  }

  function countDrop(category, reason) {
    const key = `${category}:${reason}`;
    droppedVoices[key] = (droppedVoices[key] || 0) + 1;
  }

  function createAudioBuffer(name, duration, render) {
    const key = `${name}:${context.sampleRate}`;
    if (buffers.has(key)) return buffers.get(key);
    const length = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    const seeded = mulberry32(hashString(key));
    render(data, context.sampleRate, seeded);
    buffers.set(key, buffer);
    return buffer;
  }

  function buildBuffers() {
    createAudioBuffer('mechanical-click', 0.085, (data, sampleRate, seeded) => {
      let last = 0;
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        const envelope = Math.exp(-t * 58);
        const grit = seeded() * 2 - 1;
        const impulse = index < 9 ? (1 - index / 9) * (index % 2 ? -1 : 1) : 0;
        last = last * 0.34 + grit * 0.66;
        data[index] = (impulse * 0.85 + last * 0.32 + Math.sin(t * 2900) * 0.12) * envelope;
      }
    });
    createAudioBuffer('cannon-body', 0.32, (data, sampleRate, seeded) => {
      let brown = 0;
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        brown = brown * 0.97 + (seeded() * 2 - 1) * 0.03;
        const pitch = 74 * Math.exp(-t * 4.6) + 33;
        const body = Math.sin(t * Math.PI * 2 * pitch + Math.sin(t * 33) * 0.7);
        data[index] = (body * 0.72 + brown * 1.3) * Math.exp(-t * 11.5);
      }
    });
    createAudioBuffer('rust-tail', 0.2, (data, sampleRate, seeded) => {
      let previous = 0;
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        const noise = seeded() * 2 - 1;
        const high = noise - previous * 0.82;
        previous = noise;
        const ring = Math.sin(t * 4900) * Math.sin(t * 710) * 0.22;
        data[index] = (high * 0.58 + ring) * Math.exp(-t * 23);
      }
    });
    createAudioBuffer('wet-impact', 0.22, (data, sampleRate, seeded) => {
      let low = 0;
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        low = low * 0.86 + (seeded() * 2 - 1) * 0.14;
        const slap = Math.sin(t * Math.PI * 2 * (128 - t * 220)) * Math.exp(-t * 28);
        data[index] = (low * 0.78 + slap * 0.52) * Math.exp(-t * 13);
      }
    });
    createAudioBuffer('bone-crack', 0.14, (data, sampleRate, seeded) => {
      const spikes = [0.004, 0.017, 0.031, 0.054];
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        let value = 0;
        spikes.forEach((spike, spikeIndex) => {
          const distance = Math.abs(t - spike);
          if (distance < 0.0035) value += (1 - distance / 0.0035) * (spikeIndex % 2 ? -0.76 : 0.94);
        });
        value += (seeded() * 2 - 1) * Math.exp(-t * 36) * 0.2;
        data[index] = value;
      }
    });
    createAudioBuffer('explosion', 0.78, (data, sampleRate, seeded) => {
      let brown = 0;
      let last = 0;
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        const white = seeded() * 2 - 1;
        brown = brown * 0.985 + white * 0.015;
        const crack = white - last * 0.65;
        last = white;
        const boom = Math.sin(t * Math.PI * 2 * (66 * Math.exp(-t * 2.8) + 29));
        const envelope = Math.exp(-t * 5.2);
        data[index] = (brown * 2.1 + crack * Math.exp(-t * 25) * 0.42 + boom * 0.72) * envelope;
      }
    });
    createAudioBuffer('debris', 0.42, (data, sampleRate, seeded) => {
      const hits = Array.from({ length: 18 }, () => ({
        at: 0.025 + seeded() * 0.34,
        size: 0.25 + seeded() * 0.75,
        sign: seeded() < 0.5 ? -1 : 1,
      }));
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        let value = 0;
        hits.forEach((hit) => {
          const distance = Math.abs(t - hit.at);
          if (distance < 0.0025) value += hit.sign * hit.size * (1 - distance / 0.0025);
        });
        data[index] = value * Math.exp(-t * 2.6);
      }
    });
    createAudioBuffer('keyboard', 0.11, (data, sampleRate, seeded) => {
      const keys = [0, 0.019, 0.046, 0.071];
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        let value = 0;
        keys.forEach((key, keyIndex) => {
          const local = t - key;
          if (local >= 0 && local < 0.018) {
            value += ((seeded() * 2 - 1) * 0.34 + Math.sin(local * (5900 + keyIndex * 730)) * 0.42) * Math.exp(-local * 170);
          }
        });
        data[index] = value;
      }
    });
    createAudioBuffer('paper', 0.23, (data, sampleRate, seeded) => {
      let last = 0;
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        const noise = seeded() * 2 - 1;
        const high = noise - last;
        last = noise;
        const flutter = 0.38 + Math.sin(t * 92) * 0.2 + Math.sin(t * 173) * 0.14;
        data[index] = high * flutter * Math.sin(Math.PI * clamp(t / 0.23, 0, 1)) * 0.62;
      }
    });
    createAudioBuffer('stamp', 0.2, (data, sampleRate, seeded) => {
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        const thud = Math.sin(t * Math.PI * 2 * (115 - t * 140)) * Math.exp(-t * 34);
        const click = (seeded() * 2 - 1) * Math.exp(-t * 76);
        data[index] = thud * 0.82 + click * 0.42;
      }
    });
    createAudioBuffer('glitch', 0.24, (data, sampleRate, seeded) => {
      let held = 0;
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        if (index % Math.max(1, Math.floor(sampleRate / (700 + seeded() * 1800))) === 0) held = seeded() * 2 - 1;
        const gate = Math.sin(t * 145) > -0.15 ? 1 : 0;
        data[index] = held * gate * Math.exp(-t * 9.5) * 0.7;
      }
    });
    createAudioBuffer('ice', 0.48, (data, sampleRate, seeded) => {
      const crystals = Array.from({ length: 14 }, () => ({
        at: seeded() * 0.31,
        frequency: 1500 + seeded() * 4900,
        decay: 32 + seeded() * 70,
      }));
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        let value = 0;
        crystals.forEach((crystal) => {
          const local = t - crystal.at;
          if (local >= 0) value += Math.sin(local * Math.PI * 2 * crystal.frequency) * Math.exp(-local * crystal.decay) * 0.17;
        });
        data[index] = value + (seeded() * 2 - 1) * Math.exp(-t * 20) * 0.035;
      }
    });
    createAudioBuffer('electric', 0.36, (data, sampleRate, seeded) => {
      let held = 0;
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        if (index % Math.floor(sampleRate * 0.0026) === 0) held = seeded() * 2 - 1;
        const arcs = Math.pow(Math.max(0, Math.sin(t * 237 + Math.sin(t * 51) * 2)), 8);
        data[index] = held * arcs * Math.exp(-t * 5.8) * 0.72;
      }
    });
  }

  function buildGraph() {
    const masterInput = context.createGain();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -19;
    compressor.knee.value = 14;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.15;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.07;
    const master = context.createGain();
    master.gain.value = muted ? 0 : masterVolume;
    masterInput.connect(compressor).connect(limiter).connect(master).connect(context.destination);

    const categories = {};
    Object.entries(CATEGORY_VOLUME).forEach(([name, volume]) => {
      const bus = context.createGain();
      bus.gain.value = volume;
      bus.connect(masterInput);
      categories[name] = bus;
    });

    const reverb = context.createConvolver();
    const reverbGain = context.createGain();
    reverbGain.gain.value = 0.2;
    const reverbBuffer = context.createBuffer(2, Math.floor(context.sampleRate * 0.62), context.sampleRate);
    for (let channel = 0; channel < reverbBuffer.numberOfChannels; channel += 1) {
      const channelData = reverbBuffer.getChannelData(channel);
      const seeded = mulberry32(0x78ad31 + channel * 37);
      for (let index = 0; index < channelData.length; index += 1) {
        const t = index / channelData.length;
        const early = index < context.sampleRate * 0.06 ? 1.25 : 1;
        channelData[index] = (seeded() * 2 - 1) * Math.pow(1 - t, 3.4) * early;
      }
    }
    reverb.buffer = reverbBuffer;
    reverb.connect(reverbGain).connect(masterInput);
    graph = { masterInput, compressor, limiter, master, categories, reverb, reverbGain };
    buildBuffers();
  }

  function ensureAudio() {
    if (disposed || muted) return null;
    if (!context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      try {
        context = new AudioContextClass({ latencyHint: 'interactive' });
        random = mulberry32((Date.now() ^ context.sampleRate ^ 0xa7010) >>> 0);
        buildGraph();
      } catch {
        context = null;
        graph = null;
        return null;
      }
    }
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  function categoryCount(category) {
    let total = 0;
    activeVoices.forEach((voice) => {
      if (voice.category === category) total += 1;
    });
    return total;
  }

  function finishVoice(voice) {
    if (!voice || voice.finished) return;
    voice.finished = true;
    voice.nodes.forEach((node) => {
      if (typeof node.stop === 'function') {
        try {
          node.stop();
        } catch {
          // A source can only be stopped once.
        }
      }
      safeDisconnect(node);
    });
    voice.nodes.clear();
    activeVoices.delete(voice.id);
    if (voice.timer) clearTimeout(voice.timer);
  }

  function beginVoice(name, category, duration, priority = 1) {
    const audio = ensureAudio();
    if (!audio || !graph?.categories[category]) return null;
    const now = audio.currentTime;
    const cooldown = EVENT_COOLDOWNS[name] || 0;
    const lastTime = lastPlayedAt.get(name) ?? -Infinity;
    if (now - lastTime < cooldown) {
      countDrop(category, 'cooldown');
      return null;
    }
    lastPlayedAt.set(name, now);

    const atCategoryCap = categoryCount(category) >= (DEFAULT_CAPS[category] || 4);
    const atGlobalCap = activeVoices.size >= DEFAULT_CAPS.global;
    if (atCategoryCap || atGlobalCap) {
      const candidates = [...activeVoices.values()]
        .filter((voice) => voice.category === category && voice.priority < priority)
        .sort((a, b) => a.priority - b.priority || a.startedAt - b.startedAt);
      if (candidates[0]) finishVoice(candidates[0]);
      else {
        countDrop(category, atGlobalCap ? 'global-cap' : 'category-cap');
        return null;
      }
    }

    const voice = {
      id: ++voiceId,
      name,
      category,
      priority,
      startedAt: now,
      nodes: new Set(),
      finished: false,
      timer: null,
    };
    activeVoices.set(voice.id, voice);
    voice.timer = setTimeout(() => finishVoice(voice), Math.ceil((duration + 0.25) * 1000));
    return voice;
  }

  function makePanner(pan = 0) {
    if (typeof context.createStereoPanner === 'function') {
      const panner = context.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      return panner;
    }
    return context.createGain();
  }

  function connectLayer(voice, source, gain, { category, pan = 0, reverb = 0, filter = null, drive = 0 } = {}) {
    let tail = source;
    if (filter) {
      const filterNode = context.createBiquadFilter();
      filterNode.type = filter.type || 'lowpass';
      filterNode.frequency.value = Math.max(30, filter.frequency || 1200);
      filterNode.Q.value = Math.max(0.0001, filter.q || 0.7);
      tail.connect(filterNode);
      tail = filterNode;
      voice.nodes.add(filterNode);
    }
    if (drive > 0) {
      const shaper = context.createWaveShaper();
      const curve = new Float32Array(257);
      const amount = 1 + drive * 18;
      for (let index = 0; index < curve.length; index += 1) {
        const x = index * 2 / (curve.length - 1) - 1;
        curve[index] = Math.tanh(x * amount) / Math.tanh(amount);
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
      tail.connect(shaper);
      tail = shaper;
      voice.nodes.add(shaper);
    }
    const panner = makePanner(pan);
    tail.connect(gain).connect(panner).connect(graph.categories[category]);
    if (reverb > 0) {
      const send = context.createGain();
      send.gain.value = reverb;
      panner.connect(send).connect(graph.reverb);
      voice.nodes.add(send);
    }
    voice.nodes.add(source);
    voice.nodes.add(gain);
    voice.nodes.add(panner);
  }

  function bufferLayer(voice, name, {
    category = voice.category,
    delay = 0,
    gain = 0.2,
    rate = 1,
    pan = 0,
    reverb = 0,
    filter = null,
    drive = 0,
    attack = 0.001,
    release = null,
    offset = 0,
  } = {}) {
    const buffer = buffers.get(`${name}:${context.sampleRate}`);
    if (!buffer) return;
    const source = context.createBufferSource();
    const gainNode = context.createGain();
    const start = context.currentTime + Math.max(0, delay);
    const duration = Math.max(0.012, (buffer.duration - offset) / Math.max(0.1, rate));
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.1, rate);
    gainNode.gain.setValueAtTime(0.0001, start);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + Math.min(attack, duration * 0.25));
    if (release) {
      gainNode.gain.setValueAtTime(Math.max(0.0002, gain), start + Math.max(attack, duration - release));
    }
    gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    connectLayer(voice, source, gainNode, { category, pan, reverb, filter, drive });
    source.start(start, clamp(offset, 0, Math.max(0, buffer.duration - 0.01)));
    source.stop(start + duration + 0.015);
  }

  function oscillatorLayer(voice, {
    category = voice.category,
    delay = 0,
    duration = 0.12,
    frequency = 220,
    endFrequency = frequency,
    type = 'sine',
    gain = 0.12,
    pan = 0,
    reverb = 0,
    filter = null,
    drive = 0,
    attack = 0.006,
  } = {}) {
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    const start = context.currentTime + Math.max(0, delay);
    const end = start + Math.max(0.018, duration);
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), end);
    gainNode.gain.setValueAtTime(0.0001, start);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + Math.min(attack, duration * 0.3));
    gainNode.gain.exponentialRampToValueAtTime(0.0001, end);
    connectLayer(voice, oscillator, gainNode, { category, pan, reverb, filter, drive });
    oscillator.start(start);
    oscillator.stop(end + 0.012);
  }

  function duck({ weapon = 0.55, impact = 0.68, duration = 0.3 } = {}) {
    if (!context || !graph) return;
    const now = context.currentTime;
    [['weapon', weapon], ['impact', impact]].forEach(([name, amount]) => {
      const bus = graph.categories[name];
      const normal = CATEGORY_VOLUME[name];
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(Math.min(normal, bus.gain.value), now);
      bus.gain.exponentialRampToValueAtTime(Math.max(0.05, normal * amount), now + 0.012);
      bus.gain.exponentialRampToValueAtTime(normal, now + duration);
    });
  }

  function playShoot(power = 1) {
    countEvent('shoot', `power:${Number(power).toFixed(2)}`);
    const strength = clamp(Number(power) || 1, 0.7, 3.4);
    const voice = beginVoice('shoot', 'weapon', 0.38, 1);
    if (!voice) return false;
    const pan = (random() - 0.5) * 0.34;
    const pitch = 0.94 + random() * 0.12;
    if (themeId() === 'deadline') {
      bufferLayer(voice, 'keyboard', { gain: 0.19, rate: pitch * (0.98 + strength * 0.035), pan, filter: { type: 'highpass', frequency: 780 } });
      bufferLayer(voice, 'paper', { delay: 0.018, gain: 0.105 + strength * 0.008, rate: 1.35 + strength * 0.08, pan: pan * 0.7, filter: { type: 'bandpass', frequency: 2300, q: 0.62 }, reverb: 0.05 });
      oscillatorLayer(voice, { delay: 0.008, duration: 0.1, frequency: 760 + strength * 75, endFrequency: 390 + strength * 30, type: 'sine', gain: 0.055, pan, filter: { type: 'lowpass', frequency: 2200 } });
      bufferLayer(voice, 'mechanical-click', { delay: 0.035, gain: 0.09, rate: 1.22, pan: -pan, filter: { type: 'bandpass', frequency: 3100, q: 1.2 } });
    } else {
      bufferLayer(voice, 'mechanical-click', { gain: 0.21, rate: pitch, pan, filter: { type: 'bandpass', frequency: 2300, q: 0.8 }, drive: 0.08 });
      bufferLayer(voice, 'cannon-body', { gain: 0.22 + strength * 0.032, rate: 0.94 - strength * 0.035, pan: pan * 0.5, filter: { type: 'lowpass', frequency: 720 + strength * 65 }, drive: 0.06 });
      bufferLayer(voice, 'rust-tail', { delay: 0.026, gain: 0.085, rate: 0.9 + random() * 0.2, pan: -pan, filter: { type: 'bandpass', frequency: 2500, q: 1.15 }, reverb: 0.08 });
    }
    return true;
  }

  function playImpact({ critical = false, heavy = false, gate = false, variant = 'normal' } = {}) {
    const special = ['blast', 'chain', 'frost'].includes(variant) ? variant : 'normal';
    countEvent('impact', `${gate ? 'gate' : special}${critical ? ':critical' : ''}${heavy ? ':heavy' : ''}`);
    const priority = critical || special !== 'normal' ? 3 : heavy || gate ? 2 : 1;
    const duration = special === 'blast' ? 0.86 : special === 'frost' ? 0.58 : 0.46;
    const voice = beginVoice('impact', 'impact', duration, priority);
    if (!voice) return false;
    const pan = (random() - 0.5) * 0.7;
    const deadline = themeId() === 'deadline';

    if (gate) {
      bufferLayer(voice, deadline ? 'stamp' : 'mechanical-click', { gain: heavy ? 0.29 : 0.18, rate: heavy ? 0.72 : 0.95, pan, filter: { type: 'lowpass', frequency: heavy ? 1250 : 2100 }, drive: heavy ? 0.13 : 0.04 });
      bufferLayer(voice, deadline ? 'paper' : 'debris', { delay: 0.025, gain: heavy ? 0.17 : 0.08, rate: heavy ? 0.82 : 1.25, pan: -pan, reverb: heavy ? 0.13 : 0.04 });
      oscillatorLayer(voice, { delay: 0.012, duration: heavy ? 0.22 : 0.1, frequency: deadline ? 190 : 128, endFrequency: deadline ? 83 : 54, type: 'sine', gain: heavy ? 0.16 : 0.075, pan: pan * 0.4 });
      if (heavy) duck({ duration: 0.2 });
      return true;
    }

    if (deadline) {
      bufferLayer(voice, critical || heavy ? 'stamp' : 'mechanical-click', { gain: critical ? 0.28 : heavy ? 0.21 : 0.105, rate: critical ? 0.78 : 1.05 + random() * 0.12, pan, filter: { type: 'bandpass', frequency: critical ? 1150 : 2700, q: 0.78 }, drive: critical ? 0.09 : 0 });
      bufferLayer(voice, 'glitch', { delay: 0.012, gain: critical ? 0.16 : heavy ? 0.105 : 0.045, rate: 1.15 + random() * 0.35, pan: -pan, filter: { type: 'highpass', frequency: 1250 }, reverb: critical ? 0.12 : 0.025 });
      oscillatorLayer(voice, { delay: 0.006, duration: critical ? 0.22 : 0.075, frequency: critical ? 620 : 430, endFrequency: critical ? 1260 : 250, type: 'sine', gain: critical ? 0.12 : 0.045, pan });
    } else {
      bufferLayer(voice, 'wet-impact', { gain: critical ? 0.31 : heavy ? 0.25 : 0.105, rate: critical ? 0.82 : 0.94 + random() * 0.15, pan, filter: { type: 'lowpass', frequency: critical ? 980 : heavy ? 820 : 1350 }, drive: heavy || critical ? 0.08 : 0.02 });
      if (heavy || critical) bufferLayer(voice, 'bone-crack', { delay: 0.012, gain: critical ? 0.22 : 0.14, rate: 0.88 + random() * 0.18, pan: -pan, filter: { type: 'bandpass', frequency: 2850, q: 0.65 }, reverb: 0.08 });
      oscillatorLayer(voice, { duration: critical ? 0.2 : 0.09, frequency: critical ? 104 : heavy ? 82 : 138, endFrequency: critical ? 38 : heavy ? 36 : 72, type: 'sine', gain: critical ? 0.18 : heavy ? 0.13 : 0.045, pan: pan * 0.4 });
    }

    if (special === 'blast') {
      bufferLayer(voice, 'explosion', { gain: deadline ? 0.28 : 0.39, rate: deadline ? 1.18 : 0.88, pan: pan * 0.4, filter: { type: 'lowpass', frequency: deadline ? 1450 : 920 }, drive: 0.1, reverb: 0.15 });
      bufferLayer(voice, deadline ? 'paper' : 'debris', { delay: 0.055, gain: 0.17, rate: deadline ? 0.78 : 1, pan: -pan, reverb: 0.1 });
      duck({ weapon: 0.34, impact: 0.62, duration: 0.34 });
    } else if (special === 'chain') {
      bufferLayer(voice, 'electric', { gain: deadline ? 0.16 : 0.24, rate: deadline ? 1.2 : 0.92, pan, filter: { type: 'bandpass', frequency: 2450, q: 0.72 }, drive: 0.04, reverb: 0.12 });
      [0, 0.045, 0.09].forEach((delay, index) => oscillatorLayer(voice, { delay, duration: 0.07, frequency: 480 + index * 310, endFrequency: 1180 + index * 440, type: 'sine', gain: 0.052, pan: clamp(pan + (index - 1) * 0.35, -1, 1) }));
    } else if (special === 'frost') {
      bufferLayer(voice, 'ice', { gain: 0.25, rate: deadline ? 1.12 : 0.94, pan, filter: { type: 'highpass', frequency: 1050 }, reverb: 0.25 });
      oscillatorLayer(voice, { duration: 0.38, frequency: deadline ? 940 : 710, endFrequency: deadline ? 520 : 360, type: 'sine', gain: 0.065, pan: -pan, reverb: 0.18 });
    }
    if (critical || heavy) duck({ duration: critical ? 0.24 : 0.16 });
    return true;
  }

  function playKill({ elite = false, boss = false, critical = false, combo = 1 } = {}) {
    if (boss) return false;
    countEvent('kill', `${elite ? 'elite' : 'normal'}:combo-${Math.round(combo)}`);
    const voice = beginVoice('kill', 'feedback', elite ? 0.62 : 0.34, elite || critical ? 3 : 1);
    if (!voice) return false;
    const pan = (random() - 0.5) * 0.62;
    const comboPitch = clamp(Number(combo) || 1, 1, 60) * 3.1;
    if (themeId() === 'deadline') {
      bufferLayer(voice, 'stamp', { gain: elite ? 0.26 : 0.115, rate: elite ? 0.72 : 1.15, pan, filter: { type: 'lowpass', frequency: elite ? 1550 : 2800 }, drive: elite ? 0.08 : 0 });
      bufferLayer(voice, 'paper', { delay: 0.03, gain: elite ? 0.16 : 0.07, rate: elite ? 0.8 : 1.4, pan: -pan, reverb: 0.08 });
      oscillatorLayer(voice, { delay: 0.035, duration: elite ? 0.31 : 0.12, frequency: 470 + comboPitch, endFrequency: elite ? 980 + comboPitch : 690 + comboPitch, type: 'sine', gain: elite ? 0.13 : 0.052, pan, reverb: elite ? 0.14 : 0.04 });
    } else {
      bufferLayer(voice, 'bone-crack', { gain: elite ? 0.27 : 0.11, rate: elite ? 0.7 : 1.03 + random() * 0.17, pan, filter: { type: 'bandpass', frequency: elite ? 1900 : 2950, q: 0.55 }, reverb: elite ? 0.14 : 0.035 });
      bufferLayer(voice, 'wet-impact', { gain: elite ? 0.28 : 0.1, rate: elite ? 0.68 : 1.15, pan: -pan, filter: { type: 'lowpass', frequency: elite ? 670 : 1150 }, drive: elite ? 0.1 : 0.02 });
      oscillatorLayer(voice, { duration: elite ? 0.36 : 0.12, frequency: elite ? 72 : 115 + comboPitch * 0.08, endFrequency: elite ? 29 : 62, type: 'sine', gain: elite ? 0.19 : 0.045, pan: pan * 0.3 });
    }
    if (elite || critical) duck({ duration: 0.2 });
    return true;
  }

  function playLane() {
    countEvent('lane');
    const voice = beginVoice('lane', 'ui', 0.32, 1);
    if (!voice) return false;
    if (themeId() === 'deadline') {
      bufferLayer(voice, 'keyboard', { gain: 0.12, rate: 1.32, pan: -0.25, filter: { type: 'highpass', frequency: 900 } });
      oscillatorLayer(voice, { delay: 0.018, duration: 0.16, frequency: 410, endFrequency: 720, type: 'sine', gain: 0.075, pan: 0.25 });
    } else {
      bufferLayer(voice, 'rust-tail', { gain: 0.13, rate: 0.76, pan: -0.22, filter: { type: 'bandpass', frequency: 920, q: 0.7 } });
      oscillatorLayer(voice, { duration: 0.2, frequency: 92, endFrequency: 176, type: 'sine', gain: 0.11, pan: 0.22, drive: 0.03 });
    }
    return true;
  }

  function playGateBreak() {
    countEvent('gateBreak');
    const voice = beginVoice('gateBreak', 'feedback', 1.05, 4);
    if (!voice) return false;
    duck({ weapon: 0.28, impact: 0.48, duration: 0.46 });
    const deadline = themeId() === 'deadline';
    bufferLayer(voice, deadline ? 'stamp' : 'explosion', { gain: deadline ? 0.38 : 0.46, rate: deadline ? 0.62 : 0.78, filter: { type: 'lowpass', frequency: deadline ? 1100 : 850 }, drive: 0.12, reverb: 0.15 });
    bufferLayer(voice, deadline ? 'paper' : 'debris', { delay: 0.07, gain: 0.24, rate: deadline ? 0.68 : 0.92, pan: -0.2, reverb: 0.2 });
    bufferLayer(voice, deadline ? 'glitch' : 'rust-tail', { delay: 0.11, gain: 0.17, rate: 0.76, pan: 0.25, reverb: 0.13 });
    [0, 0.075, 0.16].forEach((delay, index) => oscillatorLayer(voice, { delay, duration: 0.24, frequency: (deadline ? 220 : 105) * (1 + index * 0.5), endFrequency: (deadline ? 390 : 72) * (1 + index * 0.6), type: 'sine', gain: 0.1 - index * 0.018, pan: (index - 1) * 0.35, reverb: 0.1 }));
    return true;
  }

  function playUpgrade() {
    countEvent('upgrade');
    const voice = beginVoice('upgrade', 'cinematic', 1.38, 5);
    if (!voice) return false;
    duck({ weapon: 0.22, impact: 0.42, duration: 0.72 });
    const deadline = themeId() === 'deadline';
    bufferLayer(voice, deadline ? 'keyboard' : 'mechanical-click', { gain: 0.19, rate: deadline ? 0.94 : 0.74, pan: -0.3 });
    bufferLayer(voice, deadline ? 'stamp' : 'rust-tail', { delay: 0.29, gain: 0.23, rate: deadline ? 0.76 : 0.66, pan: 0.28, reverb: 0.18 });
    const root = deadline ? 294 : 196;
    [1, 1.25, 1.5, 2].forEach((ratio, index) => oscillatorLayer(voice, {
      delay: index * 0.105,
      duration: 0.32 + index * 0.04,
      frequency: root * ratio * 0.78,
      endFrequency: root * ratio,
      type: index === 3 ? 'triangle' : 'sine',
      gain: index === 3 ? 0.13 : 0.08,
      pan: (index - 1.5) * 0.18,
      reverb: 0.2,
    }));
    bufferLayer(voice, deadline ? 'glitch' : 'electric', { delay: 0.38, gain: 0.1, rate: deadline ? 1.3 : 0.75, filter: { type: 'bandpass', frequency: 2100, q: 0.8 }, reverb: 0.2 });
    return true;
  }

  function playWarning() {
    countEvent('warning');
    const voice = beginVoice('warning', 'cinematic', 1.05, 5);
    if (!voice) return false;
    duck({ weapon: 0.38, impact: 0.58, duration: 0.58 });
    const deadline = themeId() === 'deadline';
    if (deadline) bufferLayer(voice, 'glitch', { gain: 0.18, rate: 0.85, pan: -0.28, filter: { type: 'bandpass', frequency: 1600, q: 0.8 } });
    else bufferLayer(voice, 'rust-tail', { gain: 0.18, rate: 0.58, pan: -0.25, filter: { type: 'bandpass', frequency: 820, q: 1.1 }, drive: 0.04 });
    [0, 0.28].forEach((delay, index) => {
      oscillatorLayer(voice, { delay, duration: 0.24, frequency: deadline ? 440 - index * 70 : 128 - index * 22, endFrequency: deadline ? 315 - index * 48 : 83 - index * 13, type: 'sine', gain: 0.17, pan: index ? 0.22 : -0.22, drive: deadline ? 0 : 0.05, reverb: 0.12 });
      oscillatorLayer(voice, { delay: delay + 0.018, duration: 0.19, frequency: deadline ? 660 - index * 105 : 192 - index * 33, endFrequency: deadline ? 470 - index * 70 : 124 - index * 20, type: 'triangle', gain: 0.06, pan: index ? 0.22 : -0.22 });
    });
    return true;
  }

  function playOverdrive() {
    countEvent('overdrive');
    const voice = beginVoice('overdrive', 'cinematic', 1.25, 5);
    if (!voice) return false;
    duck({ weapon: 0.32, impact: 0.52, duration: 0.54 });
    const deadline = themeId() === 'deadline';
    bufferLayer(voice, deadline ? 'keyboard' : 'mechanical-click', { gain: 0.25, rate: deadline ? 0.78 : 0.7, pan: -0.32, drive: 0.06 });
    bufferLayer(voice, deadline ? 'glitch' : 'electric', { delay: 0.08, gain: 0.22, rate: deadline ? 0.84 : 0.68, pan: 0.25, filter: { type: 'bandpass', frequency: deadline ? 1750 : 1350, q: 0.65 }, reverb: 0.15 });
    const root = deadline ? 220 : 92;
    [1, 1.5, 2, 3].forEach((ratio, index) => oscillatorLayer(voice, { delay: 0.08 + index * 0.09, duration: 0.28, frequency: root * ratio * 0.7, endFrequency: root * ratio, type: index < 2 ? 'sine' : 'triangle', gain: 0.11 - index * 0.012, pan: (index - 1.5) * 0.2, reverb: 0.12 }));
    return true;
  }

  function playBoss() {
    countEvent('boss');
    const voice = beginVoice('boss', 'cinematic', 2.05, 9);
    if (!voice) return false;
    duck({ weapon: 0.12, impact: 0.28, duration: 1.2 });
    const deadline = themeId() === 'deadline';
    bufferLayer(voice, deadline ? 'glitch' : 'explosion', { gain: deadline ? 0.26 : 0.48, rate: deadline ? 0.55 : 0.66, filter: { type: 'lowpass', frequency: deadline ? 1300 : 720 }, drive: 0.12, reverb: 0.2 });
    bufferLayer(voice, deadline ? 'stamp' : 'debris', { delay: 0.58, gain: deadline ? 0.34 : 0.29, rate: deadline ? 0.56 : 0.68, pan: 0.18, reverb: 0.23 });
    const root = deadline ? 110 : 46;
    [0, 0.36, 0.72].forEach((delay, index) => {
      oscillatorLayer(voice, { delay, duration: 0.48, frequency: root * (1 + index * 0.08), endFrequency: root * 0.72, type: 'sine', gain: 0.22 - index * 0.025, pan: (index - 1) * 0.25, drive: deadline ? 0.035 : 0.08, reverb: 0.18 });
      oscillatorLayer(voice, { delay: delay + 0.02, duration: 0.38, frequency: root * 2.5, endFrequency: root * 1.72, type: 'triangle', gain: 0.07, pan: (1 - index) * 0.2 });
    });
    if (deadline) bufferLayer(voice, 'paper', { delay: 0.66, gain: 0.16, rate: 0.54, pan: -0.3, reverb: 0.18 });
    else bufferLayer(voice, 'rust-tail', { delay: 0.42, gain: 0.22, rate: 0.42, pan: -0.3, filter: { type: 'bandpass', frequency: 610, q: 1.3 }, reverb: 0.25 });
    return true;
  }

  function playVictory() {
    countEvent('victory');
    const voice = beginVoice('victory', 'cinematic', 1.85, 10);
    if (!voice) return false;
    duck({ weapon: 0.08, impact: 0.18, duration: 1.35 });
    const deadline = themeId() === 'deadline';
    bufferLayer(voice, deadline ? 'stamp' : 'explosion', { gain: deadline ? 0.36 : 0.42, rate: deadline ? 0.7 : 0.74, filter: { type: 'lowpass', frequency: deadline ? 1250 : 760 }, drive: 0.08, reverb: 0.18 });
    bufferLayer(voice, deadline ? 'paper' : 'debris', { delay: 0.13, gain: 0.2, rate: deadline ? 0.72 : 0.84, pan: -0.22, reverb: 0.22 });
    const root = deadline ? 262 : 196;
    const melody = deadline ? [1, 1.25, 1.5, 2, 2.5] : [1, 1.2, 1.5, 2, 2.4];
    melody.forEach((ratio, index) => oscillatorLayer(voice, { delay: 0.1 + index * 0.13, duration: index === melody.length - 1 ? 0.62 : 0.3, frequency: root * ratio * 0.92, endFrequency: root * ratio, type: index === melody.length - 1 ? 'triangle' : 'sine', gain: index === melody.length - 1 ? 0.15 : 0.085, pan: (index % 2 ? 1 : -1) * 0.22, reverb: 0.28 }));
    if (deadline) bufferLayer(voice, 'keyboard', { delay: 0.74, gain: 0.15, rate: 0.82, pan: 0.25 });
    else bufferLayer(voice, 'electric', { delay: 0.68, gain: 0.12, rate: 0.62, pan: 0.25, filter: { type: 'bandpass', frequency: 1650, q: 0.6 }, reverb: 0.18 });
    return true;
  }

  function playSoundOn() {
    countEvent('soundOn');
    const voice = beginVoice('soundOn', 'ui', 0.48, 3);
    if (!voice) return false;
    if (themeId() === 'deadline') bufferLayer(voice, 'keyboard', { gain: 0.13, rate: 1.18, pan: -0.2, filter: { type: 'highpass', frequency: 880 } });
    else bufferLayer(voice, 'mechanical-click', { gain: 0.14, rate: 0.9, pan: -0.2, filter: { type: 'bandpass', frequency: 1850, q: 0.7 } });
    oscillatorLayer(voice, { delay: 0.045, duration: 0.22, frequency: themeId() === 'deadline' ? 440 : 196, endFrequency: themeId() === 'deadline' ? 660 : 294, type: 'sine', gain: 0.09, pan: 0.2, reverb: 0.08 });
    return true;
  }

  const sfx = Object.freeze({
    shoot: playShoot,
    impact: playImpact,
    kill: playKill,
    lane: playLane,
    gateBreak: playGateBreak,
    upgrade: playUpgrade,
    warning: playWarning,
    overdrive: playOverdrive,
    boss: playBoss,
    victory: playVictory,
    soundOn: playSoundOn,
  });

  function setMuted(value) {
    muted = Boolean(value);
    if (graph?.master && context) {
      const now = context.currentTime;
      graph.master.gain.cancelScheduledValues(now);
      graph.master.gain.setValueAtTime(graph.master.gain.value, now);
      graph.master.gain.linearRampToValueAtTime(muted ? 0 : masterVolume, now + 0.045);
    }
    if (muted) [...activeVoices.values()].forEach(finishVoice);
    else ensureAudio();
    return muted;
  }

  function setMasterVolume(value) {
    masterVolume = clamp(Number(value) || 0, 0, 1.2);
    if (graph?.master && context && !muted) {
      graph.master.gain.setTargetAtTime(masterVolume, context.currentTime, 0.025);
    }
    return masterVolume;
  }

  function unlock() {
    return Boolean(ensureAudio());
  }

  function previewSound(name, options = {}) {
    const player = sfx[name];
    if (typeof player !== 'function') return false;
    if (name === 'impact') return player(options);
    if (name === 'kill') return player(options);
    if (name === 'shoot') return player(options.power || 1.4);
    return player();
  }

  function snapshot() {
    const activeByCategory = {};
    activeVoices.forEach((voice) => {
      activeByCategory[voice.category] = (activeByCategory[voice.category] || 0) + 1;
    });
    return {
      muted,
      contextState: context?.state || (muted ? 'muted' : 'not-created'),
      theme: themeId(),
      masterVolume,
      activeVoices: activeVoices.size,
      activeByCategory,
      voiceCaps: { ...DEFAULT_CAPS },
      eventCounts: { ...eventCounts },
      droppedVoices: { ...droppedVoices },
      lastEvents: lastEvents.slice(),
      bufferCount: buffers.size,
      mix: graph ? {
        compressor: { threshold: graph.compressor.threshold.value, ratio: graph.compressor.ratio.value, attack: graph.compressor.attack.value, release: graph.compressor.release.value },
        limiter: { threshold: graph.limiter.threshold.value, ratio: graph.limiter.ratio.value },
        categories: Object.fromEntries(Object.entries(graph.categories).map(([name, bus]) => [name, Number(bus.gain.value.toFixed(3))])),
      } : null,
    };
  }

  function dispose() {
    disposed = true;
    [...activeVoices.values()].forEach(finishVoice);
    if (context && context.state !== 'closed') context.close().catch(() => {});
    context = null;
    graph = null;
    buffers.clear();
  }

  return Object.freeze({
    sfx,
    unlock,
    setMuted,
    setMasterVolume,
    previewSound,
    snapshot,
    dispose,
  });
}
