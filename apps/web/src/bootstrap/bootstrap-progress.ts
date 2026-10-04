export type BootstrapPhase = 'modules' | 'wasm' | 'assets' | 'decode' | 'audio' | 'gpu';
export type BootstrapProgress = Readonly<{
  phase: BootstrapPhase;
  progress: number;
}>;
export type ReadinessReporter = (phase: BootstrapPhase, completed: number) => void;

export function createBootstrapProgress(
  options: Readonly<{
    visualBytes: number;
    visualCount: number;
    lobbyAudioBytes: number;
    onProgress: (progress: BootstrapProgress) => void;
  }>,
): ReadinessReporter {
  const total: Record<BootstrapPhase, number> = {
    modules: 1,
    wasm: 1,
    assets: options.visualBytes,
    decode: options.visualCount + 1,
    audio: options.lobbyAudioBytes,
    gpu: 1,
  };
  const completed: Record<BootstrapPhase, number> = {
    modules: 0,
    wasm: 0,
    assets: 0,
    decode: 0,
    audio: 0,
    gpu: 0,
  };
  const phases: BootstrapPhase[] = ['modules', 'wasm', 'assets', 'decode', 'audio', 'gpu'];
  const totalBytes = total.assets + total.audio;
  function publish() {
    const completedBytes = completed.assets + completed.audio;
    const bytesRatio = totalBytes > 0 ? completedBytes / totalBytes : 1;
    // Four non-byte gates and one byte-weighted resource gate. No elapsed-time progress.
    const progress =
      (completed.modules +
        completed.wasm +
        bytesRatio +
        completed.decode / total.decode +
        completed.gpu) /
      5;
    options.onProgress({
      phase: phases.find((phase) => completed[phase] < total[phase]) ?? 'gpu',
      progress,
    });
  }
  publish();
  return (phase, count) => {
    const normalized = Math.max(0, Math.min(total[phase], count));
    if (completed[phase] === normalized) return;
    completed[phase] = normalized;
    publish();
  };
}
