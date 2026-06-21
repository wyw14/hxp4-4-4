import { CRTRenderer } from './renderer';
import { AudioManager } from './audio';
import { KnobController, type KnobParam } from './knobs';
import {
  findBestSignalMatch,
  getSignalColor,
  WeatherSystem,
  lerp,
  type SignalMatch
} from './signal';
import { PlaybackSystem, HIT_SIGNAL_THRESHOLD, type PlaybackSnapshot } from './playback';
import type { Signal, SignalsData, TunerState, WeatherOffset } from './types';

class Game {
  private renderer: CRTRenderer | null = null;
  private audioManager: AudioManager;
  private knobController: KnobController | null = null;
  private weatherSystem: WeatherSystem | null = null;
  private playbackSystem: PlaybackSystem;

  private signals: Signal[] = [];
  private tuner: TunerState = { vhf: 100, uhf: 400, antenna: 180 };
  private weatherOffset: WeatherOffset = { vhfShift: 0, uhfShift: 0, antennaShift: 0 };
  private currentMatch: SignalMatch = { signal: null, strength: 0, vhfMatch: 0, uhfMatch: 0, antennaMatch: 0 };

  private smoothedStrength: number = 0;
  private smoothedDistortion: number = 1;
  private smoothedStatic: number = 1;
  private smoothedVhsTint: number = 0;
  private smoothedSignalColor: [number, number, number] = [0.08, 0.08, 0.1];

  private foundSignals: Set<string> = new Set();
  private signalOverlayActive: boolean = false;
  private lastOverlaySignalId: string | null = null;
  private binaryStream: string = '';
  private binaryTimer: number = 0;

  private isReplayMode: boolean = false;
  private lastWeatherResult: { offset: WeatherOffset; rainIntensity: number; flash: boolean } | null = null;

  private elements: {
    signalFill: HTMLElement;
    signalOverlay: HTMLElement;
    signalName: HTMLElement;
    signalDescription: HTMLElement;
    binaryStream: HTMLElement;
    foundCount: HTMLElement;
    audioToggle: HTMLButtonElement;
    playbackStatus: HTMLElement;
    timelineTrack: HTMLElement;
    timelineFill: HTMLElement;
    timelineSignals: HTMLElement;
    timelineHandle: HTMLElement;
    liveBtn: HTMLButtonElement;
    playbackTime: HTMLElement;
    playbackDuration: HTMLElement;
  };

  constructor() {
    this.audioManager = new AudioManager();
    this.playbackSystem = new PlaybackSystem();
    this.elements = this.getElements();
    this.setupPlaybackCallbacks();
  }

  private getElements() {
    const get = (id: string): HTMLElement => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Element not found: ${id}`);
      return el;
    };

    return {
      signalFill: get('signalFill'),
      signalOverlay: get('signalOverlay'),
      signalName: get('signalOverlay').querySelector('.signal-name') as HTMLElement,
      signalDescription: get('signalOverlay').querySelector('.signal-description') as HTMLElement,
      binaryStream: get('signalOverlay').querySelector('.binary-stream') as HTMLElement,
      foundCount: get('foundCount'),
      audioToggle: get('audioToggle') as HTMLButtonElement,
      playbackStatus: get('playbackStatus'),
      timelineTrack: get('timelineTrack'),
      timelineFill: get('timelineFill'),
      timelineSignals: get('timelineSignals'),
      timelineHandle: get('timelineHandle'),
      liveBtn: get('liveBtn') as HTMLButtonElement,
      playbackTime: get('playbackTime'),
      playbackDuration: get('playbackDuration')
    };
  }

  private setupPlaybackCallbacks(): void {
    this.playbackSystem.setOnModeChange((mode) => {
      this.isReplayMode = mode === 'replay';
      this.elements.playbackStatus.textContent = mode === 'replay' ? 'REPLAY' : 'LIVE';
      this.elements.playbackStatus.classList.toggle('replay', mode === 'replay');
      this.elements.timelineHandle.classList.toggle('active', mode === 'replay');
    });

    this.playbackSystem.setOnSnapshot((snapshot: PlaybackSnapshot) => {
      this.applySnapshot(snapshot);
    });
  }

  private applySnapshot(snapshot: PlaybackSnapshot): void {
    this.tuner = { ...snapshot.tuner };
    this.smoothedStrength = snapshot.signalStrength;

    if (this.knobController) {
      this.knobController.setValue('vhf', snapshot.tuner.vhf);
      this.knobController.setValue('uhf', snapshot.tuner.uhf);
      this.knobController.setValue('antenna', snapshot.tuner.antenna);
    }

    if (snapshot.hitChannelId) {
      const signal = this.signals.find(s => s.id === snapshot.hitChannelId);
      if (signal) {
        this.currentMatch.signal = signal;
        this.currentMatch.strength = snapshot.signalStrength;
      }
    } else {
      this.currentMatch.signal = null;
      this.currentMatch.strength = snapshot.signalStrength;
    }

    this.smoothedDistortion = 1 - this.smoothedStrength * 0.85;
    this.smoothedStatic = 1 - this.smoothedStrength * 0.7;
    this.smoothedVhsTint = this.smoothedStrength > 0.4 ? this.smoothedStrength : 0;
    const targetColor = getSignalColor(this.currentMatch.signal, this.smoothedStrength);
    this.smoothedSignalColor = targetColor;
  }

  async init(): Promise<void> {
    try {
      const signalsData = await this.loadSignals();
      this.signals = signalsData.signals;
      this.weatherSystem = new WeatherSystem(signalsData.weatherConfig);
    } catch (e) {
      console.error('Failed to load signals:', e);
      return;
    }

    const canvas = document.getElementById('glCanvas') as HTMLCanvasElement;
    this.renderer = new CRTRenderer(canvas);

    this.knobController = new KnobController([
      {
        param: 'vhf',
        element: document.getElementById('vhfKnob')!,
        valueElement: document.getElementById('vhfValue')!,
        min: 0,
        max: 250,
        initialValue: 100,
        sensitivity: 0.8
      },
      {
        param: 'uhf',
        element: document.getElementById('uhfKnob')!,
        valueElement: document.getElementById('uhfValue')!,
        min: 100,
        max: 800,
        initialValue: 400,
        sensitivity: 1.2
      },
      {
        param: 'antenna',
        element: document.getElementById('antennaKnob')!,
        valueElement: document.getElementById('antennaValue')!,
        min: 0,
        max: 360,
        initialValue: 180,
        sensitivity: 1.5
      }
    ], (param: KnobParam, value: number) => {
      if (!this.isReplayMode) {
        this.tuner[param] = value;
      }
    });

    this.elements.audioToggle.addEventListener('click', async () => {
      if (!this.audioManager['isInitialized']) {
        await this.audioManager.init();
      }
      this.audioManager.resume();
      const enabled = this.audioManager.toggle();
      this.elements.audioToggle.classList.toggle('active', enabled);
    });

    this.setupTimelineEvents();
    this.setupLiveButton();

    window.addEventListener('resize', () => {
      this.renderer?.resize();
    });

    void this.knobController;

    this.animate();
  }

  private setupTimelineEvents(): void {
    const track = this.elements.timelineTrack;
    let isDragging = false;

    const getProgress = (clientX: number): number => {
      const rect = track.getBoundingClientRect();
      const x = clientX - rect.left;
      return Math.max(0, Math.min(1, x / rect.width));
    };

    const startSeek = (progress: number): void => {
      isDragging = true;
      this.playbackSystem.seekTo(progress);
      this.playbackSystem.beginSeek();
    };

    const updateSeek = (progress: number): void => {
      if (isDragging) {
        this.playbackSystem.seekTo(progress);
      }
    };

    const endSeek = (): void => {
      if (isDragging) {
        isDragging = false;
        this.playbackSystem.endSeek();
      }
    };

    track.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startSeek(getProgress(e.clientX));
    });

    window.addEventListener('mousemove', (e) => {
      updateSeek(getProgress(e.clientX));
    });

    window.addEventListener('mouseup', () => {
      endSeek();
    });

    track.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length > 0) {
        startSeek(getProgress(e.touches[0].clientX));
      }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) {
        updateSeek(getProgress(e.touches[0].clientX));
      }
    });

    window.addEventListener('touchend', () => {
      endSeek();
    });

    window.addEventListener('touchcancel', () => {
      endSeek();
    });
  }

  private setupLiveButton(): void {
    this.elements.liveBtn.addEventListener('click', () => {
      this.playbackSystem.resumeLive();
    });
  }

  private async loadSignals(): Promise<SignalsData> {
    const response = await fetch('/signals.json');
    if (!response.ok) throw new Error('Failed to load signals');
    return response.json();
  }

  private updateSignalMatch(): void {
    this.currentMatch = findBestSignalMatch(this.tuner, this.signals, this.weatherOffset);
  }

  private updateSmoothing(): void {
    const targetStrength = this.currentMatch.strength;
    this.smoothedStrength = lerp(this.smoothedStrength, targetStrength, 0.12);

    const targetDistortion = 1 - this.smoothedStrength * 0.85;
    this.smoothedDistortion = lerp(this.smoothedDistortion, targetDistortion, 0.1);

    const targetStatic = 1 - this.smoothedStrength * 0.7;
    this.smoothedStatic = lerp(this.smoothedStatic, targetStatic, 0.15);

    const targetVhsTint = this.smoothedStrength > 0.4 ? this.smoothedStrength : 0;
    this.smoothedVhsTint = lerp(this.smoothedVhsTint, targetVhsTint, 0.08);

    const targetColor = getSignalColor(this.currentMatch.signal, this.smoothedStrength);
    this.smoothedSignalColor = [
      lerp(this.smoothedSignalColor[0], targetColor[0], 0.1),
      lerp(this.smoothedSignalColor[1], targetColor[1], 0.1),
      lerp(this.smoothedSignalColor[2], targetColor[2], 0.1)
    ];
  }

  private updateUI(): void {
    const fillPercent = Math.min(100, this.smoothedStrength * 100);
    this.elements.signalFill.style.width = `${fillPercent.toFixed(1)}%`;

    const shouldShowOverlay = this.smoothedStrength > 0.7;
    const currentSignalId = this.currentMatch.signal?.id ?? null;
    const signalChanged = currentSignalId !== this.lastOverlaySignalId;

    if (shouldShowOverlay !== this.signalOverlayActive || (shouldShowOverlay && signalChanged)) {
      this.signalOverlayActive = shouldShowOverlay;
      this.elements.signalOverlay.classList.toggle('active', shouldShowOverlay);

      if (shouldShowOverlay && this.currentMatch.signal) {
        const signal = this.currentMatch.signal;
        this.elements.signalName.textContent = signal.name;
        this.elements.signalDescription.textContent = signal.description;
        this.binaryStream = signal.fragmentPath;

        if (!this.foundSignals.has(signal.id)) {
          this.foundSignals.add(signal.id);
          this.elements.foundCount.textContent = `Signals found: ${this.foundSignals.size} / ${this.signals.length}`;
        }
      }
      this.lastOverlaySignalId = currentSignalId;
    }

    this.binaryTimer += 1;
    if (this.binaryTimer > 3 && this.signalOverlayActive) {
      this.binaryTimer = 0;
      const len = this.binaryStream.length;
      const extra = Math.floor(Math.random() * 12) + 4;
      let display = this.binaryStream;
      for (let i = 0; i < extra; i++) {
        display += Math.random() > 0.5 ? '1' : '0';
      }
      this.elements.binaryStream.textContent = display.substring(0, Math.min(len + extra, 80));
    }
  }

  private updateTimelineUI(): void {
    const records = this.playbackSystem.getRecords();
    const duration = this.playbackSystem.getDurationMs();
    const maxDuration = 120000;

    const fillPercent = duration > 0 ? (duration / maxDuration) * 100 : 0;
    this.elements.timelineFill.style.width = `${fillPercent.toFixed(1)}%`;

    this.elements.playbackDuration.textContent = this.formatTime(Math.min(maxDuration, duration));

    if (this.isReplayMode) {
      const progress = this.playbackSystem.getReplayProgress();
      const elapsedMs = progress * duration;
      this.elements.playbackTime.textContent = this.formatTime(elapsedMs);
      this.elements.timelineHandle.style.left = `${(progress * 100).toFixed(2)}%`;
    } else {
      this.elements.playbackTime.textContent = this.formatTime(duration);
      this.elements.timelineHandle.style.left = `${fillPercent.toFixed(2)}%`;
    }

    this.updateSignalMarkers(records);
  }

  private updateSignalMarkers(records: { timestamp: number; signalStrength: number; hitChannelId: string | null }[]): void {
    if (records.length < 2) return;

    const startTime = records[0].timestamp;
    const duration = records[records.length - 1].timestamp - startTime;
    if (duration <= 0) return;

    const markers: { percent: number }[] = [];
    let lastWasHit = false;

    for (const rec of records) {
      const isHit = rec.hitChannelId !== null && rec.signalStrength >= HIT_SIGNAL_THRESHOLD;
      if (isHit && !lastWasHit) {
        const percent = ((rec.timestamp - startTime) / duration) * 100;
        markers.push({ percent });
      }
      lastWasHit = isHit;
    }

    const existingMarkers = this.elements.timelineSignals.querySelectorAll('.timeline-signal-marker');
    existingMarkers.forEach(m => m.remove());

    for (const marker of markers) {
      const el = document.createElement('div');
      el.className = 'timeline-signal-marker';
      el.style.left = `${marker.percent}%`;
      this.elements.timelineSignals.appendChild(el);
    }
  }

  private formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  private animate(): void {
    if (this.weatherSystem) {
      if (!this.isReplayMode) {
        const weatherResult = this.weatherSystem.update();
        this.lastWeatherResult = weatherResult;
        this.weatherOffset = weatherResult.offset;
        this.updateSignalMatch();
        this.updateSmoothing();

        this.playbackSystem.record(
          this.tuner,
          this.smoothedStrength,
          this.currentMatch.signal?.id ?? null
        );
      } else {
        this.playbackSystem.updateReplay();
      }

      if (this.renderer && this.lastWeatherResult) {
        this.renderer.render({
          signalStrength: this.smoothedStrength,
          staticAmount: this.smoothedStatic,
          distortionAmount: this.smoothedDistortion,
          vhsTint: this.smoothedVhsTint,
          signalColor: this.smoothedSignalColor,
          rainIntensity: this.lastWeatherResult.rainIntensity,
          flash: this.lastWeatherResult.flash
        });
      }

      this.audioManager.setNoiseIntensity(this.smoothedStrength);
      if (this.currentMatch.signal && this.smoothedStrength > 0.3) {
        const baseFreq = this.currentMatch.signal.id === 'signal_01' ? 220
          : this.currentMatch.signal.id === 'signal_02' ? 440
          : this.currentMatch.signal.id === 'signal_03' ? 660
          : 330;
        const wobble = Math.sin(performance.now() * 0.008) * 15;
        this.audioManager.setSignalTone(baseFreq + wobble, this.smoothedStrength);
      } else {
        this.audioManager.setSignalTone(0, 0);
      }
      this.audioManager.update();

      this.updateUI();
      this.updateTimelineUI();
    }

    requestAnimationFrame(() => this.animate());
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const game = new Game();
  await game.init();
});
