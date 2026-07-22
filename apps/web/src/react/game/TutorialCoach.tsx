import { useEffect, useState, type ReactElement } from 'react';
import { GameButton } from '../components/primitives.js';
import type { TutorialRun } from './app-model.js';
import { tutorialCompletion, tutorialSteps } from './tutorial.js';

export function TutorialCoach({
  tutorial,
  onNext,
  onExit,
}: {
  readonly tutorial: TutorialRun | null;
  readonly onNext: () => void;
  readonly onExit: () => void;
}): ReactElement | null {
  const [spotlight, setSpotlight] = useState<DOMRect | null>(null);
  const step =
    tutorial && !tutorial.completed ? tutorialSteps(tutorial.mode)[tutorial.stepIndex] : null;

  useEffect(() => {
    if (!step?.target) {
      setSpotlight(null);
      return undefined;
    }
    const updateSpotlight = (): void => {
      const target = document.querySelector<HTMLElement>(step.target ?? '');
      if (!target) {
        setSpotlight(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        setSpotlight(null);
        return;
      }
      setSpotlight(rect);
    };
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(step.target ?? '');
      target?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      updateSpotlight();
    });
    window.addEventListener('resize', updateSpotlight);
    window.addEventListener('scroll', updateSpotlight, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateSpotlight);
      window.removeEventListener('scroll', updateSpotlight, true);
    };
  }, [step]);

  if (!tutorial) return null;
  const complete = tutorial.completed;
  const copy = complete ? tutorialCompletion(tutorial.mode) : (step?.copy ?? []);
  const title = complete
    ? tutorial.mode === 'megas'
      ? '⚡ 学会超级进化！'
      : '🏆 恭喜通关！'
    : step?.title;
  return (
    <>
      {spotlight ? (
        <div
          className="tutorial-spotlight"
          aria-hidden="true"
          style={{
            left: spotlight.left - 8,
            top: spotlight.top - 8,
            width: spotlight.width + 16,
            height: spotlight.height + 16,
          }}
        />
      ) : null}
      <aside className="tutorial-coach" aria-live="polite" aria-label="新手教程">
        <div className="tutorial-step">
          {complete
            ? '教程完成'
            : `第 ${(tutorial.stepIndex + 1).toString()} / ${tutorialSteps(tutorial.mode).length.toString()} 步`}
        </div>
        <h2>{title}</h2>
        <div className="tutorial-copy">
          {copy.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="tutorial-actions">
          {complete ? (
            <GameButton className="primary" onClick={onExit}>
              开始一局对局
            </GameButton>
          ) : step?.next ? (
            <GameButton className="primary" onClick={onNext}>
              下一步 ▶
            </GameButton>
          ) : (
            <>
              <span className="tutorial-hint">按上面的提示操作…</span>
              <GameButton className="ghost small" onClick={onNext}>
                跳过此步
              </GameButton>
            </>
          )}
          <GameButton className="ghost small" onClick={onExit}>
            {complete ? '返回主页' : '退出教程'}
          </GameButton>
        </div>
      </aside>
    </>
  );
}
