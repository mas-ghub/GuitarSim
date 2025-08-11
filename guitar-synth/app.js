/*
  Guitar Simulator using Tone.js
  - Karplus–Strong via FeedbackCombFilter
  - Slides/Bends using rampTo on delayTime (pitch) and detune helper
  - Acoustic/Electric toggle (electric adds drive, chorus, reverb)
*/

const NUM_STRINGS = 6;
const NUM_FRETS = 22; // standard 22; easy to change
const STANDARD_TUNING = [
  "E2", // 6th string (index 0 visually bottom, but we render 0..5 top-to-bottom)
  "A2",
  "D3",
  "G3",
  "B3",
  "E4", // 1st string
];

// Utility: note name to frequency via Tone.Frequency
function noteToFreq(note) {
  return Tone.Frequency(note).toFrequency();
}

function semitoneDistance(freqA, freqB) {
  return 12 * Math.log2(freqB / freqA);
}

// Build fretboard data
const stringOpenFreqs = STANDARD_TUNING.map(noteToFreq);
const fretFrequenciesPerString = stringOpenFreqs.map((openFreq) => {
  const freqs = [];
  for (let fret = 0; fret <= NUM_FRETS; fret += 1) {
    const freq = openFreq * Math.pow(2, fret / 12);
    freqs.push(freq);
  }
  return freqs;
});

const noteNames = (() => {
  const names = [];
  const base = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  for (let midi = 0; midi < 128; midi += 1) {
    const name = base[midi % 12] + Math.floor(midi / 12 - 1);
    names.push(name);
  }
  return names;
})();

function freqToNoteName(frequency) {
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  return noteNames[Math.max(0, Math.min(127, midi))];
}

// UI Elements
const startBtn = document.getElementById("start-audio");
const modeToggle = document.getElementById("mode-toggle");
const volumeSlider = document.getElementById("volume");
const reverbSlider = document.getElementById("reverb");
const bendRangeSlider = document.getElementById("bend-range");
const fretboardContainer = document.getElementById("fretboard-container");
const fretboardEl = document.getElementById("fretboard");
const fretMarkersEl = document.getElementById("fret-markers");

// Audio graph (initialized on user gesture)
let audioReady = false;
let mixer = null;
let masterLimiter = null;
let reverb = null;
let chorus = null;
let distortion = null;
let outputGain = null;

// Active touches map: id -> voice
const activeVoices = new Map();
let nextPointerId = 1;

class KarplusStringVoice {
  constructor({ destination, electric }) {
    // Excitation noise burst
    this.noise = new Tone.Noise({ type: "white" });
    this.ampEnv = new Tone.AmplitudeEnvelope({
      attack: 0.001,
      decay: 0.2,
      sustain: 0.0,
      release: 0.08,
    });

    // Comb filter loop acts as the string
    this.comb = new Tone.FeedbackCombFilter({
      delayTime: 1 / 220, // temporary, set on trigger
      resonance: 0.95, // energy retention (0..1)
    });

    // Gentle damping post-loop
    this.damping = new Tone.Filter({ type: "lowpass", frequency: 6000, Q: 0 });

    // Electric chain
    this.preFX = new Tone.Gain(1);
    this.postFX = new Tone.Gain(1);

    // Connect graph: noise -> env -> preFX -> comb -> damping -> postFX -> destination
    this.noise.connect(this.ampEnv);
    this.ampEnv.connect(this.preFX);
    this.preFX.connect(this.comb);
    this.comb.connect(this.damping);
    this.damping.connect(this.postFX);
    this.postFX.connect(destination);

    // Always start noise; gated by envelope
    this.noise.start();

    // Defaults
    this.currentFrequency = 220;
    this.electric = !!electric;
  }

  setMode({ electric }) {
    this.electric = !!electric;
    // Adjust pre/post FX coloration
    if (this.electric) {
      this.preFX.gain.rampTo(1.0, 0.02);
      this.damping.frequency.rampTo(4500, 0.05);
    } else {
      this.preFX.gain.rampTo(1.0, 0.02);
      this.damping.frequency.rampTo(6500, 0.05);
    }
  }

  trigger(frequency, velocity = 0.8) {
    this.currentFrequency = frequency;
    const delay = 1 / frequency;
    // Smoothly set pitch before excitation for crisp onset
    this.comb.delayTime.rampTo(delay, 0.002);
    // Short burst
    this.ampEnv.triggerAttackRelease(0.01, "+0", velocity);
  }

  bendTo(frequency, rampSeconds = 0.08) {
    this.currentFrequency = frequency;
    const delay = 1 / frequency;
    this.comb.delayTime.rampTo(delay, rampSeconds);
  }

  dispose() {
    this.noise.stop();
    [this.noise, this.ampEnv, this.comb, this.damping, this.preFX, this.postFX].forEach((n) => n && n.dispose());
  }
}

function setupAudio() {
  if (audioReady) return;
  audioReady = true;

  // Global chain
  masterLimiter = new Tone.Limiter(-1);
  reverb = new Tone.Reverb({ decay: 2.5, wet: parseFloat(reverbSlider.value) });
  chorus = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.2, wet: 0.2 }).start();
  distortion = new Tone.Distortion({ distortion: 0.5, oversample: "4x", wet: 0.0 });
  outputGain = new Tone.Gain(Tone.dbToGain(parseFloat(volumeSlider.value)));

  // Mixer route: mixer -> optional FX -> master
  mixer = new Tone.Gain(1);

  // We will crossfade electric/acoustic by adjusting FX wet amounts during mode changes
  mixer.chain(chorus, distortion, reverb, masterLimiter, outputGain, Tone.Destination);

  // Initialize wet to low unless Electric
  chorus.wet.value = 0.0;
  distortion.wet.value = 0.0;
}

function setModeElectric(electric) {
  if (!audioReady) return;
  if (electric) {
    chorus.wet.rampTo(0.25, 0.1);
    distortion.wet.rampTo(0.5, 0.1);
    reverb.wet.rampTo(parseFloat(reverbSlider.value) + 0.1, 0.1);
  } else {
    chorus.wet.rampTo(0.0, 0.1);
    distortion.wet.rampTo(0.0, 0.1);
    reverb.wet.rampTo(parseFloat(reverbSlider.value), 0.1);
  }
}

// Render fretboard UI
function buildFretboard() {
  // grid: rows = strings, cols = frets 0..NUM_FRETS
  const grid = document.createElement("div");
  grid.className = "fret-grid";
  grid.style.gridTemplateColumns = `repeat(${NUM_FRETS + 1}, var(--fret-width, 72px))`;

  // String lines backdrop
  for (let s = 0; s < NUM_STRINGS; s++) {
    const line = document.createElement("div");
    line.className = `string-line string-${s}`;
    fretboardContainer.appendChild(line);
  }

  // Build cells
  for (let s = 0; s < NUM_STRINGS; s++) {
    const row = document.createElement("div");
    row.className = "fret-row";
    for (let f = 0; f <= NUM_FRETS; f++) {
      const cell = document.createElement("div");
      cell.className = "fret" + (f === 0 ? " zero" : "");
      cell.dataset.string = String(s);
      cell.dataset.fret = String(f);

      const noteFreq = fretFrequenciesPerString[s][f];
      const noteLabel = document.createElement("div");
      noteLabel.className = "note";
      noteLabel.textContent = freqToNoteName(noteFreq);
      const posLabel = document.createElement("div");
      posLabel.className = "pos";
      posLabel.textContent = f;

      cell.appendChild(noteLabel);
      cell.appendChild(posLabel);
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }

  fretboardEl.innerHTML = "";
  fretboardEl.appendChild(grid);

  // Fret markers at typical positions
  buildFretMarkers();

  // Pointer interactions
  grid.addEventListener("pointerdown", onPointerDown);
  grid.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function buildFretMarkers() {
  const markerPositions = [3, 5, 7, 9, 12, 15, 17, 19];
  fretMarkersEl.style.gridTemplateColumns = `24px repeat(${NUM_FRETS}, var(--fret-width, 72px))`;
  fretMarkersEl.innerHTML = "";
  for (let f = 0; f <= NUM_FRETS; f++) {
    const marker = document.createElement("div");
    marker.className = "fret-marker";
    if (markerPositions.includes(f)) {
      if (f === 12) {
        marker.classList.add("double");
        const dot1 = document.createElement("div");
        dot1.className = "dot";
        const dot2 = document.createElement("div");
        dot2.className = "dot second";
        marker.appendChild(dot1);
        marker.appendChild(dot2);
      } else {
        const dot = document.createElement("div");
        dot.className = "dot";
        marker.appendChild(dot);
      }
    }
    fretMarkersEl.appendChild(marker);
  }
}

function getCellFromEventTarget(target) {
  if (!(target instanceof HTMLElement)) return null;
  const cell = target.closest(".fret");
  if (!cell) return null;
  const stringIndex = parseInt(cell.dataset.string, 10);
  const fretIndex = parseInt(cell.dataset.fret, 10);
  return { cell, stringIndex, fretIndex };
}

function makeVoiceKey(pointerId) {
  return `p${pointerId}`;
}

function onPointerDown(ev) {
  if (!audioReady) return;
  const info = getCellFromEventTarget(ev.target);
  if (!info) return;
  const { stringIndex, fretIndex } = info;

  ev.preventDefault();
  const id = ev.pointerId || nextPointerId++;
  const voiceKey = makeVoiceKey(id);

  const electric = modeToggle.checked;
  const voice = new KarplusStringVoice({ destination: mixer, electric });
  voice.setMode({ electric });

  const freq = fretFrequenciesPerString[stringIndex][fretIndex];
  voice.trigger(freq, 0.9);

  activeVoices.set(voiceKey, {
    voice,
    stringIndex,
    startFreq: freq,
    lastFreq: freq,
    startY: ev.clientY,
    startX: ev.clientX,
    startFret: fretIndex,
  });

  // capture pointer to continue receiving events
  if (info.cell && info.cell.setPointerCapture) {
    info.cell.setPointerCapture(ev.pointerId);
  }
}

function onPointerMove(ev) {
  if (!audioReady) return;
  const id = ev.pointerId;
  const voiceKey = makeVoiceKey(id);
  const entry = activeVoices.get(voiceKey);
  if (!entry) return;

  const { voice, stringIndex, startFreq, startY, startX, startFret } = entry;

  // Horizontal movement -> slide along frets on the same string
  const deltaX = ev.clientX - startX;
  const fretWidth = getFretWidthPx();
  const fretDelta = deltaX / Math.max(24, fretWidth);
  const continuousFret = clamp(startFret + fretDelta, 0, NUM_FRETS);
  const openFreq = stringOpenFreqs[stringIndex];
  const slideFreq = openFreq * Math.pow(2, continuousFret / 12);

  // Vertical movement -> bend up to N semitones
  const bendRange = parseInt(bendRangeSlider.value, 10); // semitones
  const deltaY = startY - ev.clientY; // dragging up is positive
  const bendSemitones = clamp((deltaY / 120) * bendRange, -0.2, bendRange); // allow slight down-bend
  const bendRatio = Math.pow(2, bendSemitones / 12);

  const targetFreq = slideFreq * bendRatio;

  // Smooth ramp
  voice.bendTo(targetFreq, 0.06);
  entry.lastFreq = targetFreq;
}

function onPointerUp(ev) {
  const id = ev.pointerId;
  const voiceKey = makeVoiceKey(id);
  const entry = activeVoices.get(voiceKey);
  if (!entry) return;

  // Let it decay naturally; then dispose a bit later to allow effect tails
  const { voice } = entry;
  setTimeout(() => voice.dispose(), 1500);
  activeVoices.delete(voiceKey);
}

function getFretWidthPx() {
  const sampleFret = document.querySelector(".fret");
  return sampleFret ? sampleFret.getBoundingClientRect().width : 72;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Wire up controls
startBtn.addEventListener("click", async () => {
  await Tone.start();
  setupAudio();
  startBtn.disabled = true;
  startBtn.textContent = "Audio Ready";
});

modeToggle.addEventListener("change", () => {
  setModeElectric(modeToggle.checked);
});

volumeSlider.addEventListener("input", () => {
  if (!audioReady) return;
  outputGain.gain.rampTo(Tone.dbToGain(parseFloat(volumeSlider.value)), 0.05);
});

reverbSlider.addEventListener("input", () => {
  if (!audioReady) return;
  reverb.wet.rampTo(parseFloat(reverbSlider.value), 0.1);
});

// Build UI now
buildFretboard();