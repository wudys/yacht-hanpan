export interface GoldenDropResult {
  signature: string;
  samples: Float32Array<ArrayBuffer>;
}

export interface WorkerRunRequest {
  kind: 'run';
  id: number;
  seed: string;
  inputBuffer: ArrayBuffer;
}

export type CompatibilityWorkerRequest = WorkerRunRequest;

export interface WorkerReadyResponse {
  kind: 'ready';
  rapierVersion: string;
}

export interface WorkerResultResponse {
  kind: 'result';
  id: number;
  signature: string;
  samplesBuffer: ArrayBuffer;
}

export interface WorkerErrorResponse {
  kind: 'error';
  id: number;
  message: string;
}

export type CompatibilityWorkerResponse =
  WorkerReadyResponse | WorkerResultResponse | WorkerErrorResponse;
