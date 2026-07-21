import { Button } from '@base-ui/react/button';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
}

interface AppErrorBoundaryState {
  readonly failed: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application render failed', error, info);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="screen app-error-screen">
        <section className="setup-card app-error-card" role="alert">
          <p className="mode-eyebrow">TABLETOP RECOVERY</p>
          <h1>牌桌暂时没有加载成功</h1>
          <p>你的房间仍在服务器上。重新加载页面后可用同一浏览器标签页恢复连接。</p>
          <Button
            className="primary"
            onClick={() => {
              location.reload();
            }}
          >
            重新加载
          </Button>
        </section>
      </main>
    );
  }
}
