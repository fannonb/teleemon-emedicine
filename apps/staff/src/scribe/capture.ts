import { AUDIO_RATE, MAX_AUDIO_SECONDS, wavBytes } from '@teleemon/core';

export interface CaptureCallbacks { chunk(bytes: Uint8Array): void; levels(microphone: number, remote: number): void; interrupted(reason: string): void }
export class AudioCapture {
  private context?: AudioContext; private streams: MediaStream[] = []; private node?: AudioWorkletNode;
  private frame = 0; private stopping = false; private finish?: () => void; private timer?: ReturnType<typeof setTimeout>; private interrupted?: (reason: string) => void;
  static supported(): boolean { return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.AudioWorkletNode === 'function'; }
  async prepare(meet: boolean, callbacks: CaptureCallbacks): Promise<void> {
    if (!AudioCapture.supported()) throw new Error('Recording requires a secure desktop browser with audio capture support.');
    this.stopping = false;
    this.interrupted = callbacks.interrupted;
    try {
      // Selection happens directly from the provider click, before awaiting server operations.
      const remote = meet ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }) : undefined;
      if (remote) {
        this.streams.push(remote);
        if (!remote.getAudioTracks().length || remote.getVideoTracks()[0]?.getSettings().displaySurface !== 'browser') throw new Error('Select the Google Meet browser tab and enable “Share tab audio”.');
      }
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); this.streams.push(microphone);
      this.context = new AudioContext({ sampleRate: AUDIO_RATE });
      if (this.context.sampleRate !== AUDIO_RATE) throw new Error('This browser cannot capture at the required audio rate. Use a supported desktop browser.');
      await this.context.audioWorklet.addModule(new URL('./pcm.worklet.js', import.meta.url));
      const destination = this.context.createGain(); destination.gain.value = meet ? 0.5 : 1;
      destination.channelCount = 1; destination.channelCountMode = 'explicit'; // Downmix stereo remote audio instead of losing its right channel.
      const sources = [microphone, ...(remote ? [new MediaStream(remote.getAudioTracks())] : [])].map((stream) => this.context!.createMediaStreamSource(stream));
      const analysers = sources.map((source) => { const analyser = this.context!.createAnalyser(); analyser.fftSize = 512; source.connect(analyser); source.connect(destination); return analyser; });
      this.node = new AudioWorkletNode(this.context, 'teleemon-pcm'); destination.connect(this.node);
      const mute = this.context.createGain(); mute.gain.value = 0; this.node.connect(mute); mute.connect(this.context.destination);
      this.node.port.postMessage('pause');
      this.node.port.onmessage = ({ data }: MessageEvent<{ pcm?: ArrayBuffer; stopped?: boolean }>) => { if (data.pcm) callbacks.chunk(wavBytes(new Int16Array(data.pcm))); if (data.stopped) this.finish?.(); };
      for (const stream of this.streams) for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (!this.stopping) { this.pause(); callbacks.interrupted('Audio sharing stopped. Recording paused; restore the source or finish the saved recording.'); } });
      const levels = (): void => {
        const values = analysers.map((a) => { const buffer = new Float32Array(a.fftSize); a.getFloatTimeDomainData(buffer); return Math.min(100, Math.sqrt(buffer.reduce((n, f) => n + f * f, 0) / buffer.length) * 400); });
        callbacks.levels(values[0] ?? 0, values[1] ?? 0); this.frame = requestAnimationFrame(levels);
      }; levels();
    } catch (error) { this.dispose(); throw error; }
  }
  async start(): Promise<void> { await this.context?.resume(); this.node?.port.postMessage('resume'); this.timer = setTimeout(() => { this.pause(); this.interrupted?.('Maximum session duration reached. Finish this recording before starting another.'); }, MAX_AUDIO_SECONDS * 1000); }
  pause(): void { this.node?.port.postMessage('pause'); }
  async resume(): Promise<void> {
    if (this.streams.some((s) => s.getTracks().some((t) => t.readyState !== 'live'))) throw new Error('The shared audio source ended. Finish this recording and start another capture.');
    await this.context?.resume(); this.node?.port.postMessage('resume');
  }
  async stop(): Promise<void> {
    if (!this.node || this.stopping) return; this.stopping = true;
    await new Promise<void>((resolve) => { this.finish = resolve; this.node!.port.postMessage('stop'); });
    this.dispose();
  }
  dispose(): void { this.stopping = true; clearTimeout(this.timer); cancelAnimationFrame(this.frame); for (const stream of this.streams) for (const track of stream.getTracks()) track.stop(); this.streams = []; this.node?.disconnect(); this.node = undefined; void this.context?.close(); this.context = undefined; }
}
