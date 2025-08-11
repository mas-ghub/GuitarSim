/*
  Guitar Simulator using Tone.js
  - Karplus–Strong via FeedbackCombFilter
  - Slides/Bends using rampTo on delayTime (pitch) and detune helper
  - Acoustic/Electric toggle (electric adds drive, chorus, reverb)
*/

// ---- Reactive State ----
const state = {
  numStrings: 6,
  numFrets: 22,
  tuningName: "standard",
  tuningNotes: ["E2", "A2", "D3", "G3", "B3", "E4"],
  stringOpenFreqs: [],
  fretFrequenciesPerString: [],
};

const TUNING_PRESETS = {
  standard: ["E2", "A2", "D3", "G3", "B3", "E4"],
  dropd: ["D2", "A2", "D3", "G3", "B3", "E4"],
  dadgad: ["D2", "A2", "D3", "G3", "A3", "D4"],
  openG: ["D2", "G2", "D3", "G3", "B3", "D4"],
  openD: ["D2", "A2", "D3", "F#3", "A3", "D4"],
};

// Utility: note name to frequency via Tone.Frequency
function noteToFreq(note) { return Tone.Frequency(note).toFrequency(); }

function recomputeFrequencies() {
  state.stringOpenFreqs = state.tuningNotes.map(noteToFreq);
  state.fretFrequenciesPerString = state.stringOpenFreqs.map((openFreq) => {
    const freqs = [];
    for (let fret = 0; fret <= state.numFrets; fret += 1) {
      freqs.push(openFreq * Math.pow(2, fret / 12));
    }
    return freqs;
  });
}
recomputeFrequencies();

const noteNames = (() => {
  const names = [];
  const base = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  for (let midi = 0; midi < 128; midi += 1) {
    names.push(base[midi % 12] + Math.floor(midi / 12 - 1));
  }
  return names;
})();
function freqToNoteName(frequency) {
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  return noteNames[Math.max(0, Math.min(127, midi))];
}

// ---- UI Elements ----
const startBtn = document.getElementById("start-audio");
const modeToggle = document.getElementById("mode-toggle");
const volumeSlider = document.getElementById("volume");
const reverbSlider = document.getElementById("reverb");
const bendRangeSlider = document.getElementById("bend-range");
const fretsCountSlider = document.getElementById("frets-count");
const tuningPresetSelect = document.getElementById("tuning-preset");
const boardColorInput = document.getElementById("board-color");
const themeSelect = document.getElementById("theme-select");

const fretboardContainer = document.getElementById("fretboard-container");
const fretboardEl = document.getElementById("fretboard");
const fretMarkersEl = document.getElementById("fret-markers");

// ---- Audio graph (initialized on user gesture) ----
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
    this.noise = new Tone.Noise({ type: "white" });
    this.ampEnv = new Tone.AmplitudeEnvelope({ attack: 0.001, decay: 0.22, sustain: 0.0, release: 0.1 });
    this.comb = new Tone.FeedbackCombFilter({ delayTime: 1 / 220, resonance: 0.965 });
    this.damping = new Tone.Filter({ type: "lowpass", frequency: 6200, Q: 0 });
    this.preFX = new Tone.Gain(1);
    this.postFX = new Tone.Gain(1);

    this.noise.connect(this.ampEnv);
    this.ampEnv.connect(this.preFX);
    this.preFX.connect(this.comb);
    this.comb.connect(this.damping);
    this.damping.connect(this.postFX);
    this.postFX.connect(destination);

    this.noise.start();
    this.currentFrequency = 220;
    this.electric = !!electric;
  }
  setMode({ electric }) {
    this.electric = !!electric;
    if (this.electric) {
      this.preFX.gain.rampTo(1.0, 0.02);
      this.damping.frequency.rampTo(4500, 0.05);
    } else {
      this.preFX.gain.rampTo(1.0, 0.02);
      this.damping.frequency.rampTo(6800, 0.05);
    }
  }
  trigger(frequency, velocity = 0.85) {
    this.currentFrequency = frequency;
    const delay = 1 / frequency;
    this.comb.delayTime.rampTo(delay, 0.002);
    this.ampEnv.triggerAttackRelease(0.012, "+0", velocity);
  }
  bendTo(frequency, rampSeconds = 0.065) {
    this.currentFrequency = frequency;
    this.comb.delayTime.rampTo(1 / frequency, rampSeconds);
  }
  dispose() {
    this.noise.stop();
    [this.noise, this.ampEnv, this.comb, this.damping, this.preFX, this.postFX].forEach((n) => n && n.dispose());
  }
}

function setupAudio() {
  if (audioReady) return;
  audioReady = true;

  masterLimiter = new Tone.Limiter(-1);
  reverb = new Tone.Reverb({ decay: 2.6, wet: parseFloat(reverbSlider.value) });
  chorus = new Tone.Chorus({ frequency: 1.6, delayTime: 3.4, depth: 0.22, wet: 0.2 }).start();
  distortion = new Tone.Distortion({ distortion: 0.55, oversample: "4x", wet: 0.0 });
  outputGain = new Tone.Gain(Tone.dbToGain(parseFloat(volumeSlider.value)));

  mixer = new Tone.Gain(1);
  mixer.chain(chorus, distortion, reverb, masterLimiter, outputGain, Tone.Destination);

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
  // Update active voices coloration
  activeVoices.forEach(({ voice }) => voice.setMode({ electric }));
}

// ---- Fretboard rendering ----
function buildFretboard() {
  // Clear previous strings and grid
  fretboardEl.innerHTML = "";
  // remove prior string-line children from container
  Array.from(fretboardContainer.querySelectorAll(".string-line")).forEach((n) => n.remove());

  // grid: rows = strings, cols = frets 0..state.numFrets
  const grid = document.createElement("div");
  grid.className = "fret-grid";
  grid.style.gridTemplateColumns = `repeat(${state.numFrets + 1}, var(--fret-width, 72px))`;

  // String lines backdrop
  for (let s = 0; s < state.numStrings; s++) {
    const line = document.createElement("div");
    line.className = `string-line string-${s}`;
    fretboardContainer.appendChild(line);
  }

  // Build cells
  for (let s = 0; s < state.numStrings; s++) {
    const row = document.createElement("div");
    row.className = "fret-row";
    for (let f = 0; f <= state.numFrets; f++) {
      const cell = document.createElement("div");
      cell.className = "fret" + (f === 0 ? " zero" : "");
      cell.dataset.string = String(s);
      cell.dataset.fret = String(f);

      const noteFreq = state.fretFrequenciesPerString[s][f];
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

  fretboardEl.appendChild(grid);

  // Fret markers at typical positions
  buildFretMarkers();

  // Pointer interactions
  grid.addEventListener("pointerdown", onPointerDown);
}

function buildFretMarkers() {
  const markerPositions = [3, 5, 7, 9, 12, 15, 17, 19];
  fretMarkersEl.style.gridTemplateColumns = `24px repeat(${state.numFrets}, var(--fret-width, 72px))`;
  fretMarkersEl.innerHTML = "";
  for (let f = 0; f <= state.numFrets; f++) {
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

function makeVoiceKey(pointerId) { return `p${pointerId}`; }

// ---- String visual animation ----
function wobbleString(stringIndex, velocity = 0.9) {
  const el = fretboardContainer.querySelector(`.string-${stringIndex}`);
  if (!el || !el.animate) return;
  const amp = Math.max(0.8, 2.8 * velocity);
  el.animate(
    [
      { transform: "translateY(0px)" },
      { transform: `translateY(${amp}px)` },
      { transform: `translateY(${-amp * 0.6}px)` },
      { transform: `translateY(${amp * 0.3}px)` },
      { transform: "translateY(0px)" },
    ],
    { duration: 500, easing: "ease-out" }
  );
}

// ---- Pointer handlers ----
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

  const freq = state.fretFrequenciesPerString[stringIndex][fretIndex];
  voice.trigger(freq, 0.92);
  wobbleString(stringIndex, 1.0);

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
  if (info.cell && info.cell.setPointerCapture) info.cell.setPointerCapture(ev.pointerId);
}

function onPointerMove(ev) {
  if (!audioReady) return;
  const id = ev.pointerId;
  const voiceKey = makeVoiceKey(id);
  const entry = activeVoices.get(voiceKey);
  if (!entry) return;

  const { voice, stringIndex, startY, startX, startFret } = entry;

  // Horizontal movement -> continuous slide in semitones
  const deltaX = ev.clientX - startX;
  const fretWidth = getFretWidthPx();
  const fretDelta = deltaX / Math.max(28, fretWidth);
  const continuousFret = clamp(startFret + fretDelta, 0, state.numFrets);
  const openFreq = state.stringOpenFreqs[stringIndex];
  const slideFreq = openFreq * Math.pow(2, continuousFret / 12);

  // Vertical movement -> bend up to N semitones
  const bendRange = parseInt(bendRangeSlider.value, 10);
  const deltaY = startY - ev.clientY; // dragging up is positive
  const bendSemitones = clamp((deltaY / 80) * bendRange, -1.0, bendRange);
  const bendRatio = Math.pow(2, bendSemitones / 12);

  const targetFreq = slideFreq * bendRatio;
  voice.bendTo(targetFreq, 0.05);
  entry.lastFreq = targetFreq;
}

function onPointerUp(ev) {
  const id = ev.pointerId;
  const voiceKey = makeVoiceKey(id);
  const entry = activeVoices.get(voiceKey);
  if (!entry) return;

  wobbleString(entry.stringIndex, 0.6);
  const { voice } = entry;
  setTimeout(() => voice.dispose(), 1500);
  activeVoices.delete(voiceKey);
}

function getFretWidthPx() {
  const sampleFret = document.querySelector(".fret");
  return sampleFret ? sampleFret.getBoundingClientRect().width : 72;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- Controls wiring ----
startBtn.addEventListener("click", async () => {
  await Tone.start();
  setupAudio();
  startBtn.disabled = true;
  startBtn.textContent = "Audio Ready";
});

modeToggle.addEventListener("change", () => setModeElectric(modeToggle.checked));

volumeSlider.addEventListener("input", () => {
  if (!audioReady) return;
  outputGain.gain.rampTo(Tone.dbToGain(parseFloat(volumeSlider.value)), 0.05);
});

reverbSlider.addEventListener("input", () => {
  if (!audioReady) return;
  reverb.wet.rampTo(parseFloat(reverbSlider.value), 0.1);
});

fretsCountSlider.addEventListener("input", () => {
  state.numFrets = parseInt(fretsCountSlider.value, 10);
  recomputeFrequencies();
  buildFretboard();
});

tuningPresetSelect.addEventListener("change", () => {
  state.tuningName = tuningPresetSelect.value;
  state.tuningNotes = TUNING_PRESETS[state.tuningName] || TUNING_PRESETS.standard;
  recomputeFrequencies();
  buildFretboard();
});

boardColorInput.addEventListener("input", () => {
  fretboardContainer.style.setProperty("--board", boardColorInput.value);
});

themeSelect.addEventListener("change", () => {
  document.body.classList.remove("theme-midnight", "theme-rosewood", "theme-maple", "theme-slate");
  const themeClass = `theme-${themeSelect.value}`;
  document.body.classList.add(themeClass);
});

// Global pointer listeners to ensure smooth slide/bend even if pointer leaves the grid
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerUp);

// Initial UI
document.body.classList.add("theme-midnight");
fretboardContainer.style.setProperty("--board", boardColorInput.value);
buildFretboard();