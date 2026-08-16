// pitch-shifter-processor.js
// Simple granular (overlap-add) real-time pitch shifter.
// Shifts pitch independently of playback rate/duration.
// semitones param range: -12..+12 (matches the UI slider)

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitch", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.grainSize = 1048;       // smaller grain = less smearing/room-like tail
    this.overlap = 4;            // grains overlapping at once (COLA-correct for Hann @ hop=size/4)
    this.hop = this.grainSize / this.overlap;
    // Big enough circular buffer that grain reads never wrap into freshly-written,
    // not-yet-settled samples — that wraparound was a source of clicks/roominess.
    this.bufLen = this.grainSize * 8;
    this.inBuf = new Float32Array(this.bufLen);
    this.writePos = 0;
    this.grainWindow = new Float32Array(this.grainSize);
    for (let i = 0; i < this.grainSize; i++) {
      this.grainWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.grainSize - 1)); // Hann window
    }
    this.pending = [];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const semitones = parameters.pitch[0] ?? 0;
    const ratio = Math.pow(2, semitones / 12);

    const inCh = input[0];
    const outCh = output[0];

    // FAST PATH - no pitch shift requested (the common case). Pass every
    // channel through untouched. Previously the grain engine ran even at
    // 0 semitones, which cost CPU on every clip for no reason.
    if (!semitones) {
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)];
        if (src && output[c]) output[c].set(src);
      }
      // Keep the ring buffer warm so switching pitch on mid-clip doesn't pop.
      for (let i = 0; i < inCh.length; i++) {
        this.inBuf[this.writePos] = inCh[i];
        this.writePos = (this.writePos + 1) % this.bufLen;
      }
      return true;
    }

    for (let i = 0; i < inCh.length; i++) {
      this.inBuf[this.writePos] = inCh[i];
      this.writePos = (this.writePos + 1) % this.bufLen;

      if (this.writePos % this.hop === 0) {
        this.pending.push({ pos: 0, start: (this.writePos - this.grainSize + this.bufLen) % this.bufLen });
      }

      let sample = 0;
      let windowSum = 0; // track actual accumulated window energy for THIS output sample
      for (let g = this.pending.length - 1; g >= 0; g--) {
        const grain = this.pending[g];
        const winIdx = Math.floor(grain.pos);
        if (winIdx >= this.grainSize) {
          this.pending.splice(g, 1);
          continue;
        }

        // Linear interpolation instead of nearest-neighbor — this is what removes
        // the metallic/robotic buzz, since a pitch ratio != 1 rarely lands on an
        // exact integer sample index.
        const readPos = grain.start + grain.pos * ratio;
        const idx0 = Math.floor(readPos) % this.bufLen;
        const idx1 = (idx0 + 1) % this.bufLen;
        const frac = readPos - Math.floor(readPos);
        const interpolated = this.inBuf[idx0] * (1 - frac) + this.inBuf[idx1] * frac;

        const w = this.grainWindow[winIdx];
        sample += interpolated * w;
        windowSum += w;
        grain.pos += 1;
      }

      // Divide by the ACTUAL window energy present this sample (not a fixed
      // constant) — this is what kills the amplitude warble/"room" pumping
      // you were hearing from grains fading in/out unevenly.
      outCh[i] = windowSum > 0.0001 ? Math.max(-1, Math.min(1, sample / windowSum)) : 0;
    }

    // Mirror the processed channel into every remaining output channel.
    // Only output[0] used to be written, so a stereo output left channel 1 as
    // silence - every pitched clip played out of the LEFT SPEAKER ONLY.
    for (let c = 1; c < output.length; c++) {
      if (output[c]) output[c].set(outCh);
    }

    return true;
  }
}

registerProcessor("pitch-shifter-processor", PitchShifterProcessor);
