import { afterEach, describe, expect, it } from 'vitest';
import {
  getPendingMasterBallConfirmation,
  requestMasterBallConfirmation,
  settleMasterBallConfirmation,
  subscribeToMasterBallConfirmation,
} from '../src/react/masterBallConfirmation.js';

afterEach(() => {
  settleMasterBallConfirmation(false);
});

describe('master ball confirmation bridge', () => {
  it('publishes a request and resolves the selected answer', async () => {
    let notifications = 0;
    const unsubscribe = subscribeToMasterBallConfirmation(() => {
      notifications += 1;
    });

    const answer = requestMasterBallConfirmation(2);
    expect(getPendingMasterBallConfirmation()?.count).toBe(2);

    settleMasterBallConfirmation(true);
    await expect(answer).resolves.toBe(true);
    expect(getPendingMasterBallConfirmation()).toBeNull();
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('rejects overlapping or invalid requests', () => {
    expect(() => requestMasterBallConfirmation(0)).toThrow(RangeError);

    void requestMasterBallConfirmation(1);
    expect(() => requestMasterBallConfirmation(2)).toThrow('已有待处理的大师球确认');
  });
});
