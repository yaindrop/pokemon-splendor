import { useState, type ReactElement } from 'react';
import type { RoomStartOptions } from '../../net.js';
import type { OnlineSessionState } from '../../session/types.js';
import { GameButton, GameInput, GameSelect, GameSwitch } from '../components/primitives.js';
import { seatAvatar, seatColor } from './model.js';
import {
  DIFFICULTY_OPTIONS,
  SEAT_KIND_OPTIONS,
  TIMEOUT_OPTIONS,
  sanitizedRoomCode,
  timeoutChoice,
  timeoutMsFromChoice,
  type LocalConfig,
  type LocalSeatConfig,
  type OnlineConfig,
} from './app-model.js';
import type { TutorialMode } from './tutorial.js';

export async function copyInviteLink(onDone: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(location.href);
    onDone('邀请链接已复制');
  } catch {
    onDone(location.href);
  }
}

interface HomeScreenProps {
  readonly onChooseLocal: () => void;
  readonly onChooseOnline: () => void;
  readonly onOpenRules: () => void;
  readonly onStartTutorial: (mode: TutorialMode) => void;
}

export function HomeScreen({
  onChooseLocal,
  onChooseOnline,
  onOpenRules,
  onStartTutorial,
}: HomeScreenProps): ReactElement {
  return (
    <main className="screen">
      <section className="setup-card setup-hub">
        <h1 className="brand">
          <span className="brand-splendor">璀璨宝石</span>
          <span className="brand-dot">·</span>
          <span className="brand-pkmn">宝可梦</span>
        </h1>
        <p className="tagline">收集精灵球，捕捉并进化宝可梦，率先达到 18 分成为冠军训练家！</p>
        <div className="mode-grid" aria-label="选择游戏模式">
          <GameButton className="mode-card mode-online" onClick={onChooseOnline}>
            <span className="mode-icon" aria-hidden="true">
              ◎
            </span>
            <span className="mode-eyebrow">ONLINE ROOM</span>
            <strong>和朋友联机</strong>
            <small>创建房间，分享链接，跨设备一起玩</small>
            <span className="mode-enter">进入联机大厅 →</span>
          </GameButton>
          <GameButton className="mode-card mode-local" onClick={onChooseLocal}>
            <span className="mode-icon" aria-hidden="true">
              ⌁
            </span>
            <span className="mode-eyebrow">SOLO TABLE</span>
            <strong>单机对战</strong>
            <small>同屏多人，或与电脑训练家立即开局</small>
            <span className="mode-enter">设置本地对局 →</span>
          </GameButton>
        </div>
        <div className="setup-actions home-extras">
          <GameButton className="ghost" onClick={onOpenRules}>
            规则说明
          </GameButton>
          <GameButton
            className="ghost"
            onClick={() => {
              onStartTutorial('base');
            }}
          >
            🎓 新手教程
          </GameButton>
          <GameButton
            className="ghost"
            onClick={() => {
              onStartTutorial('megas');
            }}
          >
            ⚡ 超级进化教程
          </GameButton>
        </div>
        <div className="credit">素材源自 TTS 模组「璀璨宝石：宝可梦」 · 卡牌数据由原始卡面提取</div>
      </section>
    </main>
  );
}

interface LocalSetupProps {
  readonly config: LocalConfig;
  readonly onBack: () => void;
  readonly onSelectPlayerCount: (count: number) => void;
  readonly onUpdateSeat: (index: number, update: Partial<LocalSeatConfig>) => void;
  readonly onChangeMegas: (enabled: boolean) => void;
  readonly onChangePokemart: (enabled: boolean) => void;
  readonly onStart: () => void;
}

export function LocalSetup({
  config,
  onBack,
  onSelectPlayerCount,
  onUpdateSeat,
  onChangeMegas,
  onChangePokemart,
  onStart,
}: LocalSetupProps): ReactElement {
  return (
    <main className="screen">
      <section className="setup-card setup-hub config-open">
        <div className="config-head">
          <GameButton className="ghost small" onClick={onBack}>
            ← 返回
          </GameButton>
          <strong>单机对战设置</strong>
          <span aria-hidden="true" />
        </div>
        <div className="setup-row">
          <label>玩家人数</label>
          <div className="seg" aria-label="玩家人数">
            {[2, 3, 4].map((count) => (
              <GameButton
                key={count}
                className={config.seats.length === count ? 'active' : ''}
                aria-pressed={config.seats.length === count}
                onClick={() => {
                  onSelectPlayerCount(count);
                }}
              >
                {count}
              </GameButton>
            ))}
          </div>
        </div>
        <div className="seats">
          {config.seats.map((seat, index) => (
            <div className="seat" key={index}>
              <span
                className="pid"
                aria-hidden="true"
                style={{
                  backgroundColor: seatColor(index),
                  backgroundImage: `url(${seatAvatar(index)})`,
                }}
              />
              <GameInput
                className="seat-input"
                type="text"
                value={seat.name}
                maxLength={10}
                aria-label={`${index + 1} 号训练家名字`}
                onValueChange={(value) => {
                  onUpdateSeat(index, { name: value });
                }}
              />
              <GameSelect
                className="seat-select"
                value={seat.ai ? 'ai' : 'human'}
                options={SEAT_KIND_OPTIONS}
                ariaLabel={`${seat.name || `训练家 ${index + 1}`} 类型`}
                onValueChange={(value) => {
                  onUpdateSeat(index, { ai: value === 'ai' });
                }}
              />
              <GameSelect
                className="seat-select"
                value={seat.difficulty}
                disabled={!seat.ai}
                options={DIFFICULTY_OPTIONS}
                ariaLabel={`${seat.name || `训练家 ${index + 1}`} 难度`}
                onValueChange={(value) => {
                  onUpdateSeat(index, { difficulty: value });
                }}
              />
            </div>
          ))}
        </div>
        <div className="setup-row">
          <label>扩展</label>
          <GameSwitch
            className="exp-toggle"
            ariaLabel="启用超级进化扩展"
            checked={config.megas}
            onCheckedChange={onChangeMegas}
          >
            超级进化（Megas）：第 4 级 Mega 卡 + Mega 代币
          </GameSwitch>
          <GameSwitch
            className="exp-toggle"
            ariaLabel="启用 Pokémart 扩展"
            checked={config.pokemart}
            onCheckedChange={onChangePokemart}
          >
            Pokémart：药水、进化石、图鉴、糖果与驱虫喷雾
          </GameSwitch>
        </div>
        <div className="setup-actions">
          <GameButton className="primary" onClick={onStart}>
            开始单机对战
          </GameButton>
        </div>
      </section>
    </main>
  );
}

interface OnlineSetupProps {
  readonly config: OnlineConfig;
  readonly creatingRoom: boolean;
  readonly onBack: () => void;
  readonly onChange: (config: OnlineConfig) => void;
  readonly onCreate: () => void;
  readonly onJoin: () => void;
}

export function OnlineSetup({
  config,
  creatingRoom,
  onBack,
  onChange,
  onCreate,
  onJoin,
}: OnlineSetupProps): ReactElement {
  return (
    <main className="screen">
      <section className="setup-card setup-hub config-open">
        <div className="config-head">
          <GameButton className="ghost small" onClick={onBack}>
            ← 返回
          </GameButton>
          <strong>联机房间</strong>
          <span aria-hidden="true" />
        </div>
        <label className="field-label" htmlFor="online-name">
          训练家名字
        </label>
        <GameInput
          id="online-name"
          className="setup-input"
          type="text"
          maxLength={20}
          autoComplete="nickname"
          value={config.name}
          onValueChange={(value) => {
            onChange({ ...config, name: value });
          }}
        />
        <div className="online-create-box">
          <div className="online-section-title">
            <span>创建新房间</span>
            <small>房主设置</small>
          </div>
          <GameSwitch
            className="timeout-toggle"
            ariaLabel="启用超时 AI 接管"
            checked={config.timeoutEnabled}
            onCheckedChange={(enabled) => {
              onChange({ ...config, timeoutEnabled: enabled });
            }}
          >
            <span>
              <strong>启用超时 AI 接管</strong>
              <small>默认关闭；玩家超时后由服务器完成本回合</small>
            </span>
          </GameSwitch>
          <label className={`timeout-duration${config.timeoutEnabled ? '' : ' disabled'}`}>
            <span>等待时间</span>
            <GameSelect
              className="timeout-select"
              value={timeoutChoice(config.timeoutMs)}
              options={TIMEOUT_OPTIONS}
              disabled={!config.timeoutEnabled}
              ariaLabel="超时等待时间"
              onValueChange={(value) => {
                onChange({ ...config, timeoutMs: timeoutMsFromChoice(value) });
              }}
            />
          </label>
          <GameButton className="primary wide" disabled={creatingRoom} onClick={onCreate}>
            {creatingRoom ? '创建中…' : '创建联机房间'}
          </GameButton>
        </div>
        <div className="online-join-box">
          <div className="online-section-title">
            <span>加入朋友的房间</span>
          </div>
          <div className="join-row">
            <GameInput
              className="setup-input"
              type="text"
              maxLength={32}
              placeholder="输入房间码"
              autoComplete="off"
              autoCapitalize="characters"
              value={config.roomCode}
              onValueChange={(value) => {
                onChange({ ...config, roomCode: sanitizedRoomCode(value) });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onJoin();
              }}
            />
            <GameButton className="ghost" onClick={onJoin}>
              加入
            </GameButton>
          </div>
        </div>
      </section>
    </main>
  );
}

interface LobbyScreenProps {
  readonly online: OnlineSessionState;
  readonly config: OnlineConfig;
  readonly onStart: (options: RoomStartOptions) => void;
  readonly onLeave: () => void;
  readonly onCopy: () => void;
}

export function LobbyScreen({
  online,
  config,
  onStart,
  onLeave,
  onCopy,
}: LobbyScreenProps): ReactElement {
  const [megas, setMegas] = useState(false);
  const [pokemart, setPokemart] = useState(false);
  const [timeoutEnabled, setTimeoutEnabled] = useState(config.timeoutEnabled);
  const [timeoutMs, setTimeoutMs] = useState(config.timeoutMs);
  const status =
    online.status === 'connecting'
      ? '连接中…'
      : online.status === 'connected'
        ? '已连接'
        : '已断开，重连中…';
  const hostCanStart = online.host && online.roster.length >= 2;
  return (
    <main className="screen">
      <section className="setup-card lobby-card">
        <h1 className="brand">
          <span className="brand-splendor">联机房间</span>
        </h1>
        <div className="lobby-code">
          房间码 <b>{online.code}</b>
          <GameButton className="ghost small" onClick={onCopy}>
            复制邀请链接
          </GameButton>
        </div>
        <div className="lobby-status">
          状态：{status}
          {online.seat === null
            ? ''
            : online.seat < 0
              ? '（观战）'
              : `（你是 ${online.seat + 1} 号位${online.host ? ' · 房主' : ''}）`}
        </div>
        <div className="lobby-roster">
          {online.roster.length ? (
            online.roster.map((player) => (
              <div className="lr-row" key={player.seat}>
                <span className={`lr-dot ${player.connected ? 'on' : 'off'}`} />
                {player.seat + 1}. {player.name}
                {player.seat === 0 ? ' 👑' : ''}
                {player.seat === online.seat ? '（你）' : ''}
              </div>
            ))
          ) : (
            <div className="muted">等待玩家加入…</div>
          )}
        </div>
        <div className="setup-row lobby-exp">
          <label>扩展</label>
          <GameSwitch
            className="exp-toggle"
            ariaLabel="启用超级进化扩展"
            checked={megas}
            disabled={!online.host}
            onCheckedChange={setMegas}
          >
            超级进化（Megas）
          </GameSwitch>
          <GameSwitch
            className="exp-toggle"
            ariaLabel="启用 Pokémart 扩展"
            checked={pokemart}
            disabled={!online.host}
            onCheckedChange={setPokemart}
          >
            Pokémart
          </GameSwitch>
        </div>
        <div className="setup-row lobby-timeout">
          <label>超时接管</label>
          <GameSwitch
            className="timeout-toggle compact"
            ariaLabel="启用超时 AI 接管"
            checked={timeoutEnabled}
            disabled={!online.host}
            onCheckedChange={setTimeoutEnabled}
          >
            <span>
              <strong>启用</strong>
              <small>默认关闭</small>
            </span>
          </GameSwitch>
          <GameSelect
            className="setup-select"
            value={timeoutChoice(timeoutMs)}
            options={TIMEOUT_OPTIONS}
            disabled={!online.host || !timeoutEnabled}
            ariaLabel="超时等待时间"
            onValueChange={(value) => {
              setTimeoutMs(timeoutMsFromChoice(value));
            }}
          />
        </div>
        <div className="setup-actions">
          {online.host ? (
            <GameButton
              className="primary"
              disabled={!hostCanStart}
              onClick={() => {
                onStart({ megas, pokemart, turnTimeoutMs: timeoutEnabled ? timeoutMs : null });
              }}
            >
              开始游戏
            </GameButton>
          ) : null}
          <GameButton className="ghost" onClick={onLeave}>
            离开房间
          </GameButton>
        </div>
        <div className="lobby-hint">
          把邀请链接发给朋友；等他们加入后，房主点「开始游戏」。刷新或断线会自动使用同一座位重连。
        </div>
      </section>
    </main>
  );
}
