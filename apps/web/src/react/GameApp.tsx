import type { ReactElement } from 'react';
import {
  ChoiceDialog,
  InspectDialog,
  LeaveGameDialog,
  PassDialog,
  RulesDialog,
  WinDialog,
} from './game/GameDialogs.js';
import { GameScreen } from './game/GameScreen.js';
import {
  HomeScreen,
  LobbyScreen,
  LocalSetup,
  OnlineSetup,
  copyInviteLink,
} from './game/SetupScreens.js';
import { TutorialCoach } from './game/TutorialCoach.js';
import { EMPTY_SELECTION, isNarrowViewport } from './game/app-model.js';
import { idleMessage } from './game/local-turn.js';
import { cardFrom } from './game/model.js';
import { tutorialSteps } from './game/tutorial.js';
import { useGameRuntime } from './game/useGameRuntime.js';
import { useTableActions } from './game/useTableActions.js';
import { useTurnAutomation } from './game/useTurnAutomation.js';

export function GameApp(): ReactElement {
  const runtime = useGameRuntime();
  const actions = useTableActions(runtime);
  useTurnAutomation(runtime);
  const { game, online, tutorial } = runtime;
  const idleNotice = game && online ? idleMessage(game, online, runtime.now) : null;
  const inspectCard = runtime.inspectCardId && game ? cardFrom(game, runtime.inspectCardId) : null;

  return (
    <>
      {runtime.screen === 'home' ? (
        <HomeScreen
          onChooseLocal={() => {
            runtime.setScreen('local-config');
          }}
          onChooseOnline={() => {
            runtime.setScreen('online-config');
          }}
          onOpenRules={() => {
            runtime.setRulesOpen(true);
          }}
          onStartTutorial={runtime.startTutorial}
        />
      ) : null}
      {runtime.screen === 'local-config' ? (
        <LocalSetup
          config={runtime.localConfig}
          onBack={() => {
            runtime.setScreen('home');
          }}
          onSelectPlayerCount={runtime.selectPlayerCount}
          onUpdateSeat={runtime.updateSeat}
          onChangeMegas={(megas) => {
            runtime.setLocalConfig((config) => ({ ...config, megas }));
          }}
          onChangePokemart={(pokemart) => {
            runtime.setLocalConfig((config) => ({ ...config, pokemart }));
          }}
          onStart={runtime.startLocalGame}
        />
      ) : null}
      {runtime.screen === 'online-config' ? (
        <OnlineSetup
          config={runtime.onlineConfig}
          creatingRoom={runtime.creatingRoom}
          onBack={() => {
            runtime.setScreen('home');
          }}
          onChange={runtime.setOnlineConfig}
          onCreate={() => void runtime.createOnlineRoom()}
          onJoin={() => {
            runtime.openOnlineRoom(runtime.onlineConfig.roomCode, false);
          }}
        />
      ) : null}
      {runtime.screen === 'lobby' && online ? (
        <LobbyScreen
          online={online}
          config={runtime.onlineConfig}
          onStart={(options) => runtime.onlineSessionRef.current?.start(options)}
          onLeave={runtime.leaveToHome}
          onCopy={() => void copyInviteLink(runtime.showToast)}
        />
      ) : null}
      {runtime.screen === 'game' && game ? (
        <GameScreen
          game={game}
          online={online}
          selection={runtime.selection}
          phase={runtime.phase}
          busy={runtime.busy}
          logOpen={runtime.logOpen}
          idleNotice={idleNotice}
          canInteract={actions.canInteract}
          localUndoAvailable={runtime.undoStackRef.current.length >= 2}
          tutorialHideEndTurn={
            tutorial !== null &&
            !tutorial.completed &&
            tutorialSteps(tutorial.mode)[tutorial.stepIndex]?.hideEndTurn === true
          }
          onOpenLog={() => {
            runtime.setLogOpen(true);
          }}
          onCloseLog={() => {
            runtime.setLogOpen(false);
          }}
          onOpenRules={() => {
            runtime.setRulesOpen(true);
          }}
          onLeave={() => {
            runtime.setLeaveConfirmOpen(true);
          }}
          onSupplyTake={actions.onSupplyTake}
          onSupplyReturn={actions.onSupplyReturn}
          onConfirmTake={actions.confirmBallTake}
          onClearTake={() => {
            runtime.setSelection(EMPTY_SELECTION);
          }}
          onSelectCard={actions.selectCard}
          onInspect={(id) => {
            if (isNarrowViewport()) runtime.setInspectCardId(id);
          }}
          onSelectDeck={actions.selectDeck}
          onReserveSelectedCard={actions.reserveSelectedCard}
          onReserveSelectedDeck={actions.reserveSelectedDeck}
          onCaptureSelectedCard={() => void actions.captureSelectedCard()}
          onDiscard={actions.discardBall}
          onEvolve={actions.evolve}
          onMegaEvolve={actions.megaEvolve}
          onTakeMega={actions.takeMega}
          onEndTurn={() => {
            if (online) runtime.dispatchOnline({ type: 'endTurn' });
            else actions.endLocalTurn();
          }}
          onUndo={actions.handleUndo}
          onVoteUndo={(approve) => runtime.onlineSessionRef.current?.voteUndo(approve)}
        />
      ) : null}
      <RulesDialog open={runtime.rulesOpen} onOpenChange={runtime.setRulesOpen} />
      <InspectDialog
        card={inspectCard}
        onClose={() => {
          runtime.setInspectCardId(null);
        }}
      />
      <ChoiceDialog
        choice={actions.choice}
        cardById={(id) => (game ? cardFrom(game, id) : null)}
        onChangeSelected={(selected) => {
          actions.setChoice((request) => (request ? { ...request, selected } : request));
        }}
        onResolve={actions.resolveCardChoice}
      />
      <WinDialog game={game} open={runtime.winOpen && !tutorial} onLeave={runtime.leaveToHome} />
      <PassDialog
        game={game}
        seat={runtime.passSeat}
        onReady={() => {
          runtime.setPassSeat(null);
        }}
      />
      <LeaveGameDialog
        open={runtime.leaveConfirmOpen}
        tutorial={tutorial !== null && !tutorial.completed}
        onCancel={() => {
          runtime.setLeaveConfirmOpen(false);
        }}
        onConfirm={() => {
          runtime.setLeaveConfirmOpen(false);
          runtime.leaveToHome();
        }}
      />
      <TutorialCoach
        tutorial={tutorial}
        onNext={runtime.advanceTutorial}
        onExit={() => {
          if (tutorial?.completed) runtime.leaveToHome();
          else runtime.setLeaveConfirmOpen(true);
        }}
      />
      {runtime.toast ? (
        <div className="app-toast" role="status">
          {runtime.toast}
        </div>
      ) : null}
    </>
  );
}
