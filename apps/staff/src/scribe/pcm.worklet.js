// Audio stays in memory until the authenticated scribe upload acknowledges it.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.parts = []; this.count = 0; this.paused = true;
    this.port.onmessage = ({ data }) => {
      if (data === 'pause') { this.flush(); this.paused = true; }
      if (data === 'resume') this.paused = false;
      if (data === 'stop') { this.paused = true; this.flush(); this.port.postMessage({ stopped: true }); }
    };
  }
  flush() {
    if (!this.count) return;
    const pcm = new Int16Array(this.count); let at = 0;
    for (const part of this.parts) { pcm.set(part, at); at += part.length; }
    this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]); this.parts = []; this.count = 0;
  }
  process(inputs) {
    const source = inputs[0]?.[0];
    if (source && !this.paused) {
      const pcm = new Int16Array(source.length);
      for (let i = 0; i < source.length; i++) { const sample = Math.max(-1, Math.min(1, source[i])); pcm[i] = Math.round(sample * (sample < 0 ? 32768 : 32767)); }
      this.parts.push(pcm); this.count += pcm.length;
      if (this.count >= sampleRate * 10) this.flush();
    }
    return true;
  }
}
registerProcessor('teleemon-pcm', PcmCapture);
