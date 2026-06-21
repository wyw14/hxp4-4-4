import type { PlaybackRecord, TunerState } from './types';

const MAX_DURATION_MS = 120000;
const RECORD_INTERVAL_MS = 50;

export interface PlaybackSnapshot {
  tuner: TunerState;
  signalStrength: number;
  hitChannelId: string | null;
}

type PlaybackMode = 'live' | 'replay';

type ModeChangeCallback = (mode: PlaybackMode) => void;
type SnapshotCallback = (snapshot: PlaybackSnapshot) => void;

export class PlaybackSystem {
  private records: PlaybackRecord[] = [];
  private mode: PlaybackMode = 'live';
  private replayIndex: number = -1;
  private replayTime: number = 0;
  private lastRecordTime: number = 0;
  private onModeChange: ModeChangeCallback | null = null;
  private onSnapshot: SnapshotCallback | null = null;

  constructor() {}

  setOnModeChange(callback: ModeChangeCallback): void {
    this.onModeChange = callback;
  }

  setOnSnapshot(callback: SnapshotCallback): void {
    this.onSnapshot = callback;
  }

  getMode(): PlaybackMode {
    return this.mode;
  }

  getRecords(): PlaybackRecord[] {
    return this.records;
  }

  getDurationMs(): number {
    if (this.records.length < 2) return 0;
    return this.records[this.records.length - 1].timestamp - this.records[0].timestamp;
  }

  record(tuner: TunerState, signalStrength: number, hitChannelId: string | null): void {
    if (this.mode !== 'live') return;

    const now = performance.now();
    if (now - this.lastRecordTime < RECORD_INTERVAL_MS) return;
    this.lastRecordTime = now;

    this.records.push({
      timestamp: now,
      vhf: tuner.vhf,
      uhf: tuner.uhf,
      antenna: tuner.antenna,
      signalStrength,
      hitChannelId
    });

    this.trimOldRecords();
  }

  private trimOldRecords(): void {
    if (this.records.length === 0) return;
    const latestTime = this.records[this.records.length - 1].timestamp;
    const cutoff = latestTime - MAX_DURATION_MS;
    while (this.records.length > 0 && this.records[0].timestamp < cutoff) {
      this.records.shift();
    }
  }

  seekTo(progress: number): void {
    if (this.records.length === 0) return;

    progress = Math.max(0, Math.min(1, progress));

    if (this.mode !== 'replay') {
      this.setMode('replay');
    }

    const startTime = this.records[0].timestamp;
    const duration = this.getDurationMs();
    const targetTime = startTime + duration * progress;

    let nearestIndex = 0;
    let nearestDiff = Infinity;
    for (let i = 0; i < this.records.length; i++) {
      const diff = Math.abs(this.records[i].timestamp - targetTime);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearestIndex = i;
      }
    }

    this.replayIndex = nearestIndex;
    this.replayTime = this.records[nearestIndex].timestamp;
    this.emitSnapshot(nearestIndex);
  }

  resumeLive(): void {
    this.replayIndex = -1;
    this.replayTime = 0;
    this.setMode('live');
  }

  updateReplay(): void {
    if (this.mode !== 'replay') return;
    if (this.replayIndex < 0 || this.replayIndex >= this.records.length) return;

    const now = performance.now();
    const elapsed = now - this._lastReplayFrameTime;
    this._lastReplayFrameTime = now;

    if (elapsed <= 0) return;

    let targetTime = this.replayTime + elapsed;
    const latestTime = this.records[this.records.length - 1].timestamp;

    if (targetTime >= latestTime) {
      this.resumeLive();
      return;
    }

    while (this.replayIndex < this.records.length - 1 && this.records[this.replayIndex + 1].timestamp <= targetTime) {
      this.replayIndex++;
    }

    this.replayTime = targetTime;
    this.emitSnapshot(this.replayIndex);
  }

  private _lastReplayFrameTime: number = 0;

  startReplay(progress: number = 0): void {
    if (this.records.length === 0) return;
    this._lastReplayFrameTime = performance.now();
    this.seekTo(progress);
  }

  private setMode(mode: PlaybackMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.onModeChange?.(mode);
    }
  }

  private emitSnapshot(index: number): void {
    if (index < 0 || index >= this.records.length) return;
    const record = this.records[index];
    this.onSnapshot?.({
      tuner: {
        vhf: record.vhf,
        uhf: record.uhf,
        antenna: record.antenna
      },
      signalStrength: record.signalStrength,
      hitChannelId: record.hitChannelId
    });
  }
}
