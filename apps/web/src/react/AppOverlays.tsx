import { AlertDialog } from '@base-ui/react/alert-dialog';
import { type ReactElement, useSyncExternalStore } from 'react';
import {
  getPendingMasterBallConfirmation,
  settleMasterBallConfirmation,
  subscribeToMasterBallConfirmation,
} from './masterBallConfirmation.js';

export function AppOverlays(): ReactElement {
  const pending = useSyncExternalStore(
    subscribeToMasterBallConfirmation,
    getPendingMasterBallConfirmation,
    getPendingMasterBallConfirmation,
  );

  return (
    <AlertDialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settleMasterBallConfirmation(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="base-dialog-backdrop" />
        <AlertDialog.Viewport className="base-dialog-viewport">
          <AlertDialog.Popup className="modal-box master-confirm-box">
            <div className="master-confirm-token" aria-hidden="true">
              <span className="ball purple" />
              <span className="master-confirm-badge">×{pending?.count ?? 0}</span>
            </div>
            <AlertDialog.Title>使用大师球？</AlertDialog.Title>
            <AlertDialog.Description>
              这次捕捉将消耗 <strong>{pending?.count ?? 0}</strong> 个大师球。
            </AlertDialog.Description>
            <div className="master-confirm-actions">
              <AlertDialog.Close className="ghost">返回</AlertDialog.Close>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  settleMasterBallConfirmation(true);
                }}
              >
                使用并捕捉
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
