import {
  masterBallConfirmationAtom,
  type PendingMasterBallConfirmation,
  uiStore,
} from './uiStore.js';

export function getPendingMasterBallConfirmation(): PendingMasterBallConfirmation | null {
  return uiStore.get(masterBallConfirmationAtom);
}

export function requestMasterBallConfirmation(count: number): Promise<boolean> {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`大师球确认数量必须是正整数，收到：${count}`);
  }
  if (uiStore.get(masterBallConfirmationAtom)) throw new Error('已有待处理的大师球确认');

  return new Promise<boolean>((resolve) => {
    uiStore.set(masterBallConfirmationAtom, { count, resolve });
  });
}

export function settleMasterBallConfirmation(approved: boolean): void {
  const active = uiStore.get(masterBallConfirmationAtom);
  if (!active) return;

  uiStore.set(masterBallConfirmationAtom, null);
  active.resolve(approved);
}
