interface PendingMasterBallConfirmation {
  readonly count: number;
  readonly resolve: (approved: boolean) => void;
}

type Listener = () => void;

let pending: PendingMasterBallConfirmation | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getPendingMasterBallConfirmation(): PendingMasterBallConfirmation | null {
  return pending;
}

export function subscribeToMasterBallConfirmation(listener: Listener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function requestMasterBallConfirmation(count: number): Promise<boolean> {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`大师球确认数量必须是正整数，收到：${count}`);
  }
  if (pending) throw new Error('已有待处理的大师球确认');

  return new Promise<boolean>((resolve) => {
    pending = { count, resolve };
    notify();
  });
}

export function settleMasterBallConfirmation(approved: boolean): void {
  const active = pending;
  if (!active) return;

  pending = null;
  notify();
  active.resolve(approved);
}
