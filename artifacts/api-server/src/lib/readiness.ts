interface ReadinessState {
  ready: boolean;
  reason: string;
}

let state: ReadinessState = {
  ready: false,
  reason: "bootstrap",
};

export function markReady(): void {
  state = { ready: true, reason: "ready" };
}

export function markUnready(reason: string): void {
  state = { ready: false, reason };
}

export function getReadiness(): ReadinessState {
  return { ...state };
}
