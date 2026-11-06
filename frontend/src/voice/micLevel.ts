/**
 * Live microphone loudness (0..1) for the voice visualisation. Optional: if the
 * microphone can't be opened, the meter silently does nothing (recognition may
 * still work, since it captures audio itself).
 */
export async function startMicLevel(onLevel: (level: number) => void): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") return () => {};
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return () => {};
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let frame = 0;
  let smoothed = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / data.length);
    smoothed = smoothed * 0.7 + Math.min(1, rms * 4) * 0.3;
    onLevel(smoothed);
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    onLevel(0);
  };
}
