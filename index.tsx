/**
 * @fileoverview Control real time music with text prompts
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {css, CSSResultGroup, html, LitElement, svg, unsafeCSS} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';

import {
  GoogleGenAI,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai';
import {decode, decodeAudioData} from './utils';

// Use process.env.API_KEY as per guidelines
const ai = new GoogleGenAI({apiKey: process.env.API_KEY});
let model = 'lyria-realtime-exp';

interface Prompt {
  readonly promptId: string;
  readonly color: string;
  text: string;
  weight: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/** Throttles a callback to be called at most once per `freq` milliseconds. */
function throttle(func: (...args: unknown[]) => void, delay: number) {
  let lastCall = 0;
  return (...args: unknown[]) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      func(...args);
      lastCall = now;
    }
  };
}

const PROMPT_TEXT_PRESETS = [
  'Happy Birthday Song',
  'Twinkle Twinkle Little Star',
  'Funny Animal Sounds Song',
  'Sleepy Lullaby',
  'Dancing Robots',
  'Singing Dinosaurs',
  'Magical Unicorn Ride',
  'Silly Monsters March',
  'Bouncing Bunnies',
  'Zooming Cars Tune',
  'Playful Kittens Melody',
  'Floating Bubbles Song',
];

// Child-friendly color palette
const COLORS = [
  '#FF6384', // Bright Pink/Red
  '#FFCD56', // Sunny Yellow
  '#4BC0C0', // Teal
  '#36A2EB', // Sky Blue
  '#9966FF', // Playful Purple
  '#FF9F40', // Bright Orange
  '#83F28F', // Light Green
  '#F06292', // Soft Pink
];

// Consistent focus/accent color from the palette
const ACCENT_COLOR = COLORS[3]; // Sky Blue

function getUnusedRandomColor(usedColors: string[]): string {
  const availableColors = COLORS.filter((c) => !usedColors.includes(c));
  if (availableColors.length === 0) {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }
  return availableColors[Math.floor(Math.random() * availableColors.length)];
}

// WeightSlider component
// -----------------------------------------------------------------------------
/** A slider for adjusting and visualizing prompt weight. */
@customElement('weight-slider')
class WeightSlider extends LitElement {
  static override styles = css`
    :host {
      cursor: ns-resize;
      position: relative;
      height: 100%;
      display: flex;
      justify-content: center;
      flex-direction: column;
      align-items: center;
      padding: 5px;
    }
    .scroll-container {
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .value-display {
      font-size: 1.3vmin;
      color: #555; /* Darker text for light background */
      margin: 0.5vmin 0;
      user-select: none;
      text-align: center;
      font-weight: bold;
    }
    .slider-container {
      position: relative;
      width: 12px; /* Slightly wider */
      height: 100%;
      background-color: #e0e0e0; /* Lighter background */
      border-radius: 6px; /* More rounded */
    }
    #thumb {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      border-radius: 6px; /* More rounded */
      box-shadow: 0 0 3px rgba(0, 0, 0, 0.3);
    }
  `;

  @property({type: Number}) value = 0; // Range 0-2
  @property({type: String}) color = '#000';

  @query('.scroll-container') private scrollContainer!: HTMLDivElement;

  private dragStartPos = 0;
  private dragStartValue = 0;
  private containerBounds: DOMRect | null = null;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.containerBounds = this.scrollContainer.getBoundingClientRect();
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('touchmove', this.handleTouchMove, {
      passive: false,
    });
    window.addEventListener('pointerup', this.handlePointerUp, {once: true});
    this.updateValueFromPosition(e.clientY);
  }

  private handlePointerMove(e: PointerEvent) {
    this.updateValueFromPosition(e.clientY);
  }

  private handleTouchMove(e: TouchEvent) {
    e.preventDefault();
    this.updateValueFromPosition(e.touches[0].clientY);
  }

  private handlePointerUp(e: PointerEvent) {
    window.removeEventListener('pointermove', this.handlePointerMove);
    document.body.classList.remove('dragging');
    this.containerBounds = null;
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY;
    this.value = this.value + delta * -0.005;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchInputEvent();
  }

  private updateValueFromPosition(clientY: number) {
    if (!this.containerBounds) return;

    const trackHeight = this.containerBounds.height;
    const relativeY = clientY - this.containerBounds.top;
    const normalizedValue =
      1 - Math.max(0, Math.min(trackHeight, relativeY)) / trackHeight;
    this.value = normalizedValue * 2;

    this.dispatchInputEvent();
  }

  private dispatchInputEvent() {
    this.dispatchEvent(new CustomEvent<number>('input', {detail: this.value}));
  }

  override render() {
    const thumbHeightPercent = (this.value / 2) * 100;
    const thumbStyle = styleMap({
      height: `${thumbHeightPercent}%`,
      backgroundColor: this.color,
      display: this.value > 0.01 ? 'block' : 'none',
    });
    const displayValue = this.value.toFixed(2);

    return html`
      <div
        class="scroll-container"
        @pointerdown=${this.handlePointerDown}
        @wheel=${this.handleWheel}>
        <div class="slider-container">
          <div id="thumb" style=${thumbStyle}></div>
        </div>
        <div class="value-display">${displayValue}x</div>
      </div>
    `;
  }
}

// Base class for icon buttons.
class IconButton extends LitElement {
  static override styles: CSSResultGroup = [css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    :host(:hover) svg {
      transform: scale(1.2);
    }
    svg {
      width: 100%;
      height: 100%;
      transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99);
    }
    .hitbox {
      pointer-events: all;
      position: absolute;
      width: 65%;
      aspect-ratio: 1;
      top: 9%;
      border-radius: 50%;
      cursor: pointer;
    }
    /* SVG styling for button housing */
    .button-housing-outer-ring {
        fill: #f0f0f0; /* Lighter fill */
        fill-opacity: 0.6;
      }
    .button-housing-stroke {
      stroke: #cccccc; /* Lighter stroke */
      stroke-opacity: 0.7;
    }
    .button-housing-main {
      fill: #ffffff; /* White main part */
      fill-opacity: 0.8;
    }
    .icon-path {
      fill: #333333; /* Darker icon for contrast on light button */
    }
  `];

  // Method to be implemented by subclasses to provide the specific icon SVG
  protected renderIcon() {
    return svg``; // Default empty icon
  }

  private renderSVG() {
    // Using a more child-friendly aesthetic for the button housing
    return html` <svg
      width="140"
      height="140"
      viewBox="0 -10 140 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      <rect
        class="button-housing-outer-ring"
        x="22"
        y="6"
        width="96"
        height="96"
        rx="48" />
      <rect
        class="button-housing-stroke"
        x="23.5"
        y="7.5"
        width="93"
        height="93"
        rx="46.5"
        stroke-width="3" />
      <g filter="url(#filter0_ddi_1048_7373_child)">
        <rect
          class="button-housing-main"
          x="25"
          y="9"
          width="90"
          height="90"
          rx="45"
          shape-rendering="crispEdges" />
      </g>
      ${this.renderIcon()}
      <defs>
        <filter
          id="filter0_ddi_1048_7373_child"
          x="0"
          y="0"
          width="140"
          height="140"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="3" /> <!-- Softer shadow -->
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.15 0" /> <!-- Lighter shadow -->
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_1048_7373" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="10" /> <!-- Smaller offset -->
          <feGaussianBlur stdDeviation="8" /> <!-- Softer blur -->
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0" /> <!-- Lighter shadow -->
          <feBlend
            mode="normal"
            in2="effect1_dropShadow_1048_7373"
            result="effect2_dropShadow_1048_7373" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect2_dropShadow_1048_7373"
            result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="1" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.9 0 0 0 0 0.9 0 0 0 0 0.9 0 0 0 0.1 0" /> <!-- Lighter inner highlight -->
          <feBlend
            mode="normal"
            in2="shape"
            result="effect3_innerShadow_1048_7373" />
        </filter>
      </defs>
    </svg>`;
  }

  override render() {
    return html`${this.renderSVG()}<div class="hitbox" role="button" aria-label=${this.constructor.name.replace(/Button$/, '').toLowerCase()}></div>`;
  }
}

// PlayPauseButton
// -----------------------------------------------------------------------------

/** A button for toggling play/pause. */
@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({type: String}) playbackState: PlaybackState = 'stopped';

  static override styles = [
    ...IconButton.styles,
    css`
      .loader {
        stroke: ${unsafeCSS(ACCENT_COLOR)}; /* Use accent color for loader */
        stroke-width: 4; /* Thicker loader */
        stroke-linecap: round;
        animation: spin linear 1s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(359deg);
        }
      }
    `,
  ];

  private renderPause() {
    return svg`<path class="icon-path"
      d="M75.0037 69V39H83.7537V69H75.0037ZM56.2537 69V39H65.0037V69H56.2537Z"
    />`;
  }

  private renderPlay() {
    return svg`<path class="icon-path" d="M60 71.5V36.5L87.5 54L60 71.5Z" />`;
  }

  private renderLoading() {
    return svg`<path shape-rendering="crispEdges" class="loader" d="M70,74.2L70,74.2c-10.7,0-19.5-8.7-19.5-19.5l0,0c0-10.7,8.7-19.5,19.5-19.5
            l0,0c10.7,0,19.5,8.7,19.5,19.5l0,0"/>`;
  }

  override renderIcon() {
    if (this.playbackState === 'playing') {
      return this.renderPause();
    } else if (this.playbackState === 'loading') {
      return this.renderLoading();
    } else {
      return this.renderPlay();
    }
  }
}

@customElement('reset-button')
export class ResetButton extends IconButton {
  private renderResetIcon() {
    return svg`<path class="icon-path" d="M71,77.1c-2.9,0-5.7-0.6-8.3-1.7s-4.8-2.6-6.7-4.5c-1.9-1.9-3.4-4.1-4.5-6.7c-1.1-2.6-1.7-5.3-1.7-8.3h4.7
      c0,4.6,1.6,8.5,4.8,11.7s7.1,4.8,11.7,4.8c4.6,0,8.5-1.6,11.7-4.8c3.2-3.2,4.8-7.1,4.8-11.7s-1.6-8.5-4.8-11.7
      c-3.2-3.2-7.1-4.8-11.7-4.8h-0.4l3.7,3.7L71,46.4L61.5,37l9.4-9.4l3.3,3.4l-3.7,3.7H71c2.9,0,5.7,0.6,8.3,1.7
      c2.6,1.1,4.8,2.6,6.7,4.5c1.9,1.9,3.4,4.1,4.5,6.7c1.1,2.6,1.7,5.3,1.7,8.3c0,2.9-0.6,5.7-1.7,8.3c-1.1,2.6-2.6,4.8-4.5,6.7
      s-4.1,3.4-6.7,4.5C76.7,76.5,73.9,77.1,71,77.1z"/>`;
  }

  override renderIcon() {
    return this.renderResetIcon();
  }
}

// AddPromptButton component
// -----------------------------------------------------------------------------
/** A button for adding a new prompt. */
@customElement('add-prompt-button')
export class AddPromptButton extends IconButton {
  private renderAddIcon() {
    return svg`<path class="icon-path" d="M67 40 H73 V52 H85 V58 H73 V70 H67 V58 H55 V52 H67 Z" />`;
  }

  override renderIcon() {
    return this.renderAddIcon();
  }
}

// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #555; /* Darker for contrast on light UIs */
      color: white;
      padding: 15px 20px;
      border-radius: 8px; /* More rounded */
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 250px; /* Wider */
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
      z-index: 11;
      box-shadow: 0 4px 10px rgba(0,0,0,0.2);
      font-size: 1.6vmin;
    }
    button {
      background: #fff3;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      border: none;
      color: #fff;
      cursor: pointer;
      font-size: 18px;
      line-height: 28px;
      transition: background-color 0.2s;
    }
    button:hover {
      background: #fff6;
    }
    .toast:not(.showing) {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
    }
  `;

  @property({type: String}) message = '';
  @property({type: Boolean}) showing = false;

  override render() {
    return html`<div class=${classMap({showing: this.showing, toast: true})} role="alert">
      <div class="message">${this.message}</div>
      <button @click=${this.hide} aria-label="Close message">✕</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
    // Automatically hide after some time
    setTimeout(() => {
      if (this.showing && this.message === message) { // only hide if it's still the same message
        this.hide();
      }
    }, 6000);
  }

  hide() {
    this.showing = false;
  }
}

/** A single prompt input */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    .prompt {
      position: relative;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      box-sizing: border-box;
      overflow: hidden;
      background-color: #f8f8f8; /* Lighter background */
      border-radius: 10px; /* More rounded */
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      border: 1px solid #ddd;
    }
    .remove-button {
      position: absolute;
      top: 1vmin;
      left: 1vmin;
      background: #e0e0e0; /* Lighter button */
      color: #555; /* Darker text */
      border: none;
      border-radius: 50%;
      width: 3vmin;
      height: 3vmin;
      font-size: 2vmin;
      font-weight: bold;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 3vmin;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.2s, background-color 0.2s;
      z-index: 10;
    }
    .remove-button:hover {
      opacity: 1;
      background: #d0d0d0;
    }
    weight-slider {
      max-height: calc(100% - 10vmin); /* Adjusted for new text area size */
      flex: 1;
      min-height: 10vmin;
      width: 100%;
      box-sizing: border-box;
      overflow: hidden;
      margin: 2vmin 0 1vmin;
    }
    .controls {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      align-items: center;
      gap: 0.2vmin;
      width: 100%;
      height: 9vmin; /* Slightly taller for text input */
      padding: 0 0.8vmin;
      box-sizing: border-box;
      margin-bottom: 1vmin;
    }
    #text {
      font-family: 'Google Sans', sans-serif;
      font-size: 1.9vmin; /* Slightly larger text */
      width: 100%;
      flex-grow: 1;
      max-height: 100%;
      padding: 0.8vmin; /* More padding */
      box-sizing: border-box;
      text-align: center;
      word-wrap: break-word;
      overflow-y: auto;
      border: 1px solid #ccc; /* Subtle border */
      border-radius: 5px;
      outline: none;
      -webkit-font-smoothing: antialiased;
      color: #333; /* Dark text */
      background-color: #fff; /* White background for input */
      scrollbar-width: thin;
      scrollbar-color: #aaa #eee; /* Lighter scrollbar */
    }
    #text::-webkit-scrollbar {
      width: 8px;
    }
    #text::-webkit-scrollbar-track {
      background: #eee;
      border-radius: 4px;
    }
    #text::-webkit-scrollbar-thumb {
      background-color: #aaa;
      border-radius: 4px;
    }
    :host([filtered='true']) .prompt {
      border-color: #FF6384; /* Use a child-friendly "alert" color */
      background-color: #ffebee; /* Light pinkish for filtered */
    }
    :host([filtered='true']) #text {
      border-color: #FF6384;
    }
  `;

  @property({type: String, reflect: true}) promptId = '';
  @property({type: String}) text = '';
  @property({type: Number}) weight = 0;
  @property({type: String}) color = '';

  @query('weight-slider') private weightInput!: WeightSlider;
  @query('#text') private textInput!: HTMLSpanElement;

  private handleTextKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.updateText();
      (e.target as HTMLElement).blur();
    }
  }

  private dispatchPromptChange() {
    this.dispatchEvent(
      new CustomEvent<Prompt>('prompt-changed', {
        detail: {
          promptId: this.promptId,
          text: this.text,
          weight: this.weight,
          color: this.color,
        },
      }),
    );
  }

  private updateText() {
    const newText = this.textInput.textContent?.trim();
    if (newText === undefined || newText === '') { // Allow empty string to clear
      this.textInput.textContent = this.text; // Revert if empty on blur
      return;
    }
    this.text = newText;
    this.dispatchPromptChange();
  }

  private updateWeight() {
    this.weight = this.weightInput.value;
    this.dispatchPromptChange();
  }

  private dispatchPromptRemoved() {
    this.dispatchEvent(
      new CustomEvent<string>('prompt-removed', {
        detail: this.promptId,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const classes = classMap({
      'prompt': true,
    });
    return html`<div class=${classes}>
      <button class="remove-button" @click=${this.dispatchPromptRemoved} aria-label="Remove song idea">
        ✕
      </button>
      <weight-slider
        id="weight"
        value=${this.weight}
        color=${this.color}
        @input=${this.updateWeight}></weight-slider>
      <div class="controls">
        <span
          id="text"
          role="textbox"
          aria-label="Song idea text"
          spellcheck="false"
          contenteditable="plaintext-only"
          @keydown=${this.handleTextKeyDown}
          @blur=${this.updateText}
          >${this.text}</span
        >
      </div>
    </div>`;
  }
}

/** A panel for managing real-time music generation settings. */
@customElement('settings-controller')
class SettingsController extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 2vmin;
      background-color: #f0f0f0; /* Lighter background */
      color: #444; /* Darker text */
      box-sizing: border-box;
      border-radius: 8px; /* More rounded */
      font-family: 'Google Sans', sans-serif;
      font-size: 1.6vmin; /* Slightly larger base font */
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #aaa #d8d8d8; /* Lighter scrollbar */
      transition: width 0.3s ease-out max-height 0.3s ease-out;
      border: 1px solid #ccc;
    }
    :host([showadvanced]) {
      max-height: 45vmin; /* Adjusted max height */
    }
    :host::-webkit-scrollbar {
      width: 8px;
    }
    :host::-webkit-scrollbar-track {
      background: #d8d8d8;
      border-radius: 4px;
    }
    :host::-webkit-scrollbar-thumb {
      background-color: #aaa;
      border-radius: 4px;
    }
    .setting {
      margin-bottom: 1vmin; /* More spacing */
      display: flex;
      flex-direction: column;
      gap: 0.8vmin; /* More gap */
    }
    label {
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      white-space: nowrap;
      user-select: none;
      color: #333;
    }
    label span:last-child {
      font-weight: normal;
      color: #555;
      min-width: 3em;
      text-align: right;
    }
    input[type='range'] {
      --track-height: 10px; /* Thicker track */
      --track-bg: #d0d0d0; /* Lighter track background */
      --track-border-radius: 5px;
      --thumb-size: 20px; /* Larger thumb */
      --thumb-bg: ${unsafeCSS(ACCENT_COLOR)}; /* Child-friendly accent color */
      --thumb-border-radius: 50%;
      --thumb-box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      --value-percent: 0%;
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: var(--track-height);
      background: transparent;
      cursor: pointer;
      margin: 0.8vmin 0;
      border: none;
      padding: 0;
      vertical-align: middle;
    }
    input[type='range']::-webkit-slider-runnable-track {
      width: 100%;
      height: var(--track-height);
      cursor: pointer;
      border: none;
      background: linear-gradient(
        to right,
        var(--thumb-bg) var(--value-percent),
        var(--track-bg) var(--value-percent)
      );
      border-radius: var(--track-border-radius);
    }
    input[type='range']::-moz-range-track {
      width: 100%;
      height: var(--track-height);
      cursor: pointer;
      background: var(--track-bg);
      border-radius: var(--track-border-radius);
      border: none;
    }
    input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      height: var(--thumb-size);
      width: var(--thumb-size);
      background: var(--thumb-bg);
      border-radius: var(--thumb-border-radius);
      box-shadow: var(--thumb-box-shadow);
      cursor: pointer;
      margin-top: calc((var(--thumb-size) - var(--track-height)) / -2);
      border: 2px solid #fff; /* White border for thumb */
    }
    input[type='range']::-moz-range-thumb {
      height: var(--thumb-size);
      width: var(--thumb-size);
      background: var(--thumb-bg);
      border-radius: var(--thumb-border-radius);
      box-shadow: var(--thumb-box-shadow);
      cursor: pointer;
      border: 2px solid #fff;
    }
    input[type='number'],
    input[type='text'],
    select {
      background-color: #fff; /* White background for inputs */
      color: #333; /* Dark text */
      border: 1px solid #bbb; /* Lighter border */
      border-radius: 4px;
      padding: 0.6vmin;
      font-size: 1.5vmin;
      font-family: inherit;
      box-sizing: border-box;
    }
    input[type='number'] {
      width: 7em;
    }
    input[type='text'] {
      width: 100%;
    }
    input[type='text']::placeholder {
      color: #999;
    }
    input[type='number']:focus,
    input[type='text']:focus,
    select:focus {
      outline: none;
      border-color: ${unsafeCSS(ACCENT_COLOR)};
      box-shadow: 0 0 0 2px ${unsafeCSS(ACCENT_COLOR + '4D')}; /* Hex alpha for shadow */
    }
    select option {
      background-color: #fff;
      color: #333;
    }
    .checkbox-setting {
      flex-direction: row;
      align-items: center;
      gap: 1vmin;
    }
    input[type='checkbox'] {
      cursor: pointer;
      accent-color: ${unsafeCSS(ACCENT_COLOR)};
      width: 1.8vmin;
      height: 1.8vmin;
    }
    .core-settings-row {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 4vmin;
      margin-bottom: 1.5vmin;
      justify-content: space-evenly;
    }
    .core-settings-row .setting {
      min-width: 18vmin; /* Slightly wider */
    }
    .core-settings-row label span:last-child {
      min-width: 2.5em;
    }
    .advanced-toggle {
      cursor: pointer;
      margin: 2.5vmin 0 1.5vmin 0;
      color: ${unsafeCSS(ACCENT_COLOR)}; /* Use accent color */
      text-decoration: underline;
      user-select: none;
      font-size: 1.5vmin; /* Slightly larger */
      font-weight: bold;
      width: fit-content;
    }
    .advanced-toggle:hover {
      color: ${unsafeCSS(COLORS[4])}; /* Another child-friendly color for hover */
    }
    .advanced-settings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(12vmin, 1fr));
      gap: 3.5vmin; /* More gap */
      overflow: hidden;
      max-height: 0;
      opacity: 0;
      transition:
        max-height 0.3s ease-out,
        opacity 0.3s ease-out;
    }
    .advanced-settings.visible {
      max-width: 120vmin;
      max-height: 45vmin; /* Adjusted */
      opacity: 1;
    }
    hr.divider {
      display: none;
      border: none;
      border-top: 1px solid #ccc; /* Lighter divider */
      margin: 2.5vmin 0;
      width: 100%;
    }
    :host([showadvanced]) hr.divider {
      display: block;
    }
    .auto-row {
      display: flex;
      align-items: center;
      gap: 0.8vmin;
    }
    .setting[auto='true'] input[type='range'] {
      pointer-events: none;
      filter: grayscale(80%) opacity(70%); /* Less aggressive grayscale */
    }
    .auto-row span {
      margin-left: auto;
      font-weight: normal;
      color: #555;
    }
    .auto-row label {
      cursor: pointer;
      font-weight: normal;
      color: #444;
    }
    .auto-row input[type='checkbox'] {
      cursor: pointer;
      margin: 0;
    }
  `;

  private readonly defaultConfig: LiveMusicGenerationConfig = {
    temperature: 1.2, // Slightly more playful default
    topK: 50,         // More variety
    guidance: 3.5,    // Balanced guidance
    // density and brightness will be auto by default
  };


  @state() private config: LiveMusicGenerationConfig = {...this.defaultConfig};
  @state() showAdvanced = false;
  @state() autoDensity = true;
  @state() lastDefinedDensity: number | undefined = 0.5; // Default for display
  @state() autoBrightness = true;
  @state() lastDefinedBrightness: number | undefined = 0.5; // Default for display

  public resetToDefaults() {
    this.config = {...this.defaultConfig};
    this.autoDensity = true;
    this.lastDefinedDensity = 0.5;
    this.autoBrightness = true;
    this.lastDefinedBrightness = 0.5;
    // Ensure density and brightness are set to undefined in config if auto
    this.config.density = undefined;
    this.config.brightness = undefined;
    this.dispatchSettingsChange();
  }

  private updateSliderBackground(inputEl: HTMLInputElement) {
    if (inputEl.type !== 'range') {
      return;
    }
    const min = Number(inputEl.min) || 0;
    const max = Number(inputEl.max) || 100;
    const value = Number(inputEl.value);
    const percentage = ((value - min) / (max - min)) * 100;
    inputEl.style.setProperty('--value-percent', `${percentage}%`);
  }

 private handleInputChange(e: Event) {
    const target = e.target as HTMLInputElement; // Initial cast, will be refined for select
    const key = target.id as keyof LiveMusicGenerationConfig | 'auto-density' | 'auto-brightness';
    let value: string | number | boolean | undefined = target.value;

    if (target.type === 'number' || target.type === 'range') {
      value = target.value === '' ? undefined : Number(target.value);
      if (target.type === 'range') {
        this.updateSliderBackground(target);
      }
    } else if (target.type === 'checkbox') {
      value = target.checked;
    } else if (target.type === 'select-one') {
      const selectElement = target as unknown as HTMLSelectElement; // Corrected cast
      if (selectElement.options[selectElement.selectedIndex]?.disabled) {
        value = undefined;
      } else {
        value = selectElement.value; // Use selectElement.value
      }
    }

    const newConfig = { ...this.config };

    if (key === 'auto-density') {
      this.autoDensity = Boolean(value);
      newConfig.density = this.autoDensity ? undefined : this.lastDefinedDensity ?? 0.5;
    } else if (key === 'auto-brightness') {
      this.autoBrightness = Boolean(value);
      newConfig.brightness = this.autoBrightness ? undefined : this.lastDefinedBrightness ?? 0.5;
    } else {
      // @ts-ignore
      newConfig[key] = value;
       if (key === 'density' && value !== undefined) {
        this.lastDefinedDensity = Number(value);
      }
      if (key === 'brightness' && value !== undefined) {
        this.lastDefinedBrightness = Number(value);
      }
    }
    
    this.config = newConfig;
    this.dispatchSettingsChange();
  }


  override firstUpdated() {
    // Initialize with undefined if auto is true
    const initialConfig = {...this.config};
    if (this.autoDensity) initialConfig.density = undefined;
    else initialConfig.density = this.lastDefinedDensity ?? 0.5;

    if (this.autoBrightness) initialConfig.brightness = undefined;
    else initialConfig.brightness = this.lastDefinedBrightness ?? 0.5;

    this.config = initialConfig;
    this.requestUpdate(); // Ensure UI reflects this initial state
    this.dispatchSettingsChange(); // Dispatch initial settings
  }


  override updated(changedProperties: Map<string | symbol, unknown>) {
    super.updated(changedProperties);
    // Update sliders visuals if config or auto states change
    if (changedProperties.has('config') || changedProperties.has('autoDensity') || changedProperties.has('autoBrightness')) {
      this.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((slider: HTMLInputElement) => {
        const sliderId = slider.id as keyof LiveMusicGenerationConfig;
        let sliderValue: number | undefined;

        if (sliderId === 'density') {
          sliderValue = this.autoDensity ? this.lastDefinedDensity : this.config.density;
          slider.disabled = this.autoDensity;
        } else if (sliderId === 'brightness') {
          sliderValue = this.autoBrightness ? this.lastDefinedBrightness : this.config.brightness;
          slider.disabled = this.autoBrightness;
        } else {
          sliderValue = this.config[sliderId] as number | undefined;
        }
        
        slider.value = String(sliderValue ?? (sliderId === 'density' || sliderId === 'brightness' ? 0.5 : (slider.min || 0) ));
        this.updateSliderBackground(slider);
      });
    }
  }

  private dispatchSettingsChange() {
    this.dispatchEvent(
      new CustomEvent<LiveMusicGenerationConfig>('settings-changed', {
        detail: this.config,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleAdvancedSettings() {
    this.showAdvanced = !this.showAdvanced;
  }

  override render() {
    const cfg = this.config;
    const advancedClasses = classMap({
      'advanced-settings': true,
      'visible': this.showAdvanced,
    });
    const scaleMap = new Map<string, string>([
      ['Automatic', 'SCALE_UNSPECIFIED'],
      ['Happy Key (Major)', 'C_MAJOR_A_MINOR'], // Simplified names
      ['Playful Key (D Major)', 'D_MAJOR_B_MINOR'],
      ['Dreamy Key (F Major)', 'F_MAJOR_D_MINOR'],
      ['Sunny Key (G Major)', 'G_MAJOR_E_MINOR'],
      ['Warm Key (A Major)', 'A_MAJOR_G_FLAT_MINOR'],
    ]);

    return html`
      <div class="core-settings-row">
        <div class="setting">
          <label for="temperature">Playfulness<span>${(cfg.temperature ?? this.defaultConfig.temperature!).toFixed(1)}</span></label>
          <input
            type="range"
            id="temperature"
            min="0.1" max="2.5" step="0.1"
            .value=${(cfg.temperature ?? this.defaultConfig.temperature!).toString()}
            @input=${this.handleInputChange} />
        </div>
        <div class="setting">
          <label for="guidance">Focus<span>${(cfg.guidance ?? this.defaultConfig.guidance!).toFixed(1)}</span></label>
          <input
            type="range"
            id="guidance"
            min="1" max="8" step="0.1"
            .value=${(cfg.guidance ?? this.defaultConfig.guidance!).toString()}
            @input=${this.handleInputChange} />
        </div>
        <div class="setting">
          <label for="topK">Variety<span>${cfg.topK ?? this.defaultConfig.topK!}</span></label>
          <input
            type="range"
            id="topK"
            min="1" max="100" step="1"
            .value=${(cfg.topK ?? this.defaultConfig.topK!).toString()}
            @input=${this.handleInputChange} />
        </div>
      </div>
      <hr class="divider" />
      <div class=${advancedClasses}>
        <div class="setting">
          <label for="seed">Magic Number</label>
          <input
            type="number"
            id="seed"
            .value=${cfg.seed ?? ''}
            @input=${this.handleInputChange}
            placeholder="Random" />
        </div>
        <div class="setting">
          <label for="bpm">Speed (BPM)</label>
          <input
            type="number"
            id="bpm"
            min="50" max="200" step="1"
            .value=${cfg.bpm ?? ''}
            @input=${this.handleInputChange}
            placeholder="Auto" />
        </div>
        <div class="setting" auto=${this.autoDensity}>
          <label for="density">Fullness</label>
          <input
            type="range"
            id="density"
            min="0" max="1" step="0.05"
            .value=${(this.autoDensity ? this.lastDefinedDensity : cfg.density ?? 0.5).toString()}
            ?disabled=${this.autoDensity}
            @input=${this.handleInputChange} />
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-density"
              .checked=${this.autoDensity}
              @input=${this.handleInputChange} />
            <label for="auto-density">Automatic</label>
            <span>${(this.lastDefinedDensity ?? 0.5).toFixed(2)}</span>
          </div>
        </div>
         <div class="setting" auto=${this.autoBrightness}>
          <label for="brightness">Sparkle</label>
          <input
            type="range"
            id="brightness"
            min="0" max="1" step="0.05"
            .value=${(this.autoBrightness ? this.lastDefinedBrightness : cfg.brightness ?? 0.5).toString()}
            ?disabled=${this.autoBrightness}
            @input=${this.handleInputChange} />
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-brightness"
              .checked=${this.autoBrightness}
              @input=${this.handleInputChange} />
            <label for="auto-brightness">Automatic</label>
            <span>${(this.lastDefinedBrightness ?? 0.5).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting">
          <label for="scale">Music Key</label>
          <select
            id="scale"
            .value=${cfg.scale || 'SCALE_UNSPECIFIED'}
            @change=${this.handleInputChange}>
            ${[...scaleMap.entries()].map(
              ([displayName, enumValue]) =>
                html`<option value=${enumValue}>${displayName}</option>`,
            )}
          </select>
        </div>
        <div class="setting">
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteBass"
              .checked=${!!cfg.muteBass}
              @change=${this.handleInputChange} />
            <label for="muteBass" style="font-weight: normal;">No Bass Guitar</label>
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteDrums"
              .checked=${!!cfg.muteDrums}
              @change=${this.handleInputChange} />
            <label for="muteDrums" style="font-weight: normal;">No Drums</label>
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="onlyBassAndDrums"
              .checked=${!!cfg.onlyBassAndDrums}
              @change=${this.handleInputChange} />
            <label for="onlyBassAndDrums" style="font-weight: normal;">Only Bass & Drums</label>
          </div>
        </div>
      </div>
      <div class="advanced-toggle" @click=${this.toggleAdvancedSettings} role="button" tabindex="0">
        ${this.showAdvanced ? 'Less Music Fun!' : 'More Music Fun!'}
      </div>
    `;
  }
}

/** Component for the PromptDJ UI. */
@customElement('prompt-dj')
class PromptDj extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between; /* Distribute space */
      align-items: center;
      box-sizing: border-box;
      padding: 2vmin;
      position: relative;
      font-size: 1.8vmin;
      background-color: #fdfdfd; /* Very light, friendly background */
    }
    #background {
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      /* background is now set in :host, gradients will be overlaid here */
      opacity: 0.8; /* Soften gradients */
    }
    .prompts-area {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      flex-grow: 4; /* Takes more space */
      width: 100%;
      margin-top: 1vmin; /* Reduced margin */
      gap: 2vmin;
      max-height: 60vh; /* Max height for prompts area */
      min-height: 20vh;
    }
    #prompts-container {
      display: flex;
      flex-direction: row;
      align-items: flex-end; /* Align prompts to bottom */
      flex-shrink: 1;
      height: 100%; /* Fill prompts-area height */
      gap: 2vmin;
      margin-left: 10vmin; /* Space for add button, adjust as needed */
      padding: 1vmin 2vmin; /* Added vertical padding for scrollbar space */
      overflow-x: auto;
      overflow-y: hidden; /* Prevent vertical scroll */
      scrollbar-width: thin;
      scrollbar-color: #aaa #e0e0e0; /* Lighter scrollbar */
    }
    #prompts-container::-webkit-scrollbar {
      height: 10px; /* Thicker scrollbar */
    }
    #prompts-container::-webkit-scrollbar-track {
      background: #e0e0e0;
      border-radius: 5px;
    }
    #prompts-container::-webkit-scrollbar-thumb {
      background-color: #aaa;
      border-radius: 5px;
    }
    #prompts-container::-webkit-scrollbar-thumb:hover {
      background-color: #999;
    }
    #prompts-container::before,
    #prompts-container::after {
      content: '';
      flex-shrink: 0; /* Don't shrink the spacers */
      min-width: 1vmin; /* Small space to allow scrolling to ends */
    }
    .add-prompt-button-container {
      display: flex;
      align-items: flex-end; /* Align button to bottom */
      height: 100%; /* Match prompts-container height */
      flex-shrink: 0;
      padding-bottom: 1vmin; /* Align with prompts bottom padding */
    }
    #settings-container {
      flex-grow: 1; /* Takes available space */
      flex-shrink: 0;
      width: clamp(300px, 80%, 90vmin); /* Responsive width */
      margin: 2vmin 0;
      max-height: 35vh; /* Max height for settings */
      display: flex;
      justify-content: center;
    }
    settings-controller {
       width: 100%;
       max-height: 100%; /* Allow settings controller to use available space */
    }
    .playback-container {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
      margin-top: 1vmin; /* Space above playback */
      gap: 2vmin; /* Gap between buttons */
    }
    play-pause-button,
    add-prompt-button,
    reset-button {
      width: 13vmin; /* Slightly larger buttons */
      min-width: 80px;
      max-width: 120px;
      height: 13vmin;
      min-height: 80px;
      max-height: 120px;
      flex-shrink: 0;
    }
    prompt-controller {
      height: 100%; /* Fill available height in prompts-container */
      max-height: 55vmin; /* Max height of a single prompt controller */
      min-width: 15vmin; /* Min width */
      max-width: 18vmin; /* Max width */
      flex-shrink: 0; /* Prevent shrinking */
    }
  `;

  @property({
    type: Object,
    attribute: false,
  })
  private prompts: Map<string, Prompt>;
  private nextPromptId: number;
  private session!: LiveMusicSession; // Initialized in connectToSession
  private readonly sampleRate = 48000;
  private audioContext!: AudioContext;
  private outputNode!: GainNode;
  private nextStartTime = 0;
  private readonly bufferTime = 2;
  @state() private playbackState: PlaybackState = 'stopped';
  @property({type: Object})
  private filteredPrompts = new Set<string>();
  private connectionError = true;

  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;
  @query('settings-controller') private settingsController!: SettingsController;

  constructor(prompts: Map<string, Prompt>) {
    super();
    this.prompts = prompts;
    this.nextPromptId = this.prompts.size;
    this.initializeAudioContext();
  }

  private initializeAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioContextGlobal = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextGlobal) {
        this.audioContext = new AudioContextGlobal({
          sampleRate: this.sampleRate,
        });
        this.outputNode = this.audioContext.createGain();
        this.outputNode.connect(this.audioContext.destination);
      } else {
        console.error("AudioContext is not supported in this browser.");
        // Potentially show a message to the user
        this.toastMessage.show("Oops! Your browser doesn't support the magic sound maker (AudioContext).");
      }
    }
  }


  override async firstUpdated() {
    this.initializeAudioContext(); // Ensure it's called, even if constructor did.
    if (!this.audioContext) { // If initialization failed
      return; // Don't proceed with session connection etc.
    }
    await this.connectToSession();
    this.setSessionPrompts(); // Send initial prompts
    // Dispatch initial settings from settings-controller
    if (this.settingsController) {
      const initialSettings = this.settingsController['config']; // Access internal state
       if (initialSettings && Object.keys(initialSettings).length > 0) {
         await this.session?.setMusicGenerationConfig({ musicGenerationConfig: initialSettings });
       } else {
         // Fallback to default if needed, or ensure settings-controller dispatches its initial state
         const defaultConfig = this.settingsController['defaultConfig'];
         await this.session?.setMusicGenerationConfig({ musicGenerationConfig: defaultConfig });
       }
    }
  }

  private async connectToSession() {
    if (!this.audioContext) {
        this.toastMessage.show("Cannot connect: Audio system not ready.");
        this.playbackState = 'stopped';
        return;
    }

    if (this.session && !this.connectionError) { // Check if session exists and is not in error state
      try {
        // Ping or simple command to check if session is alive
        await this.session.setMusicGenerationConfig({ musicGenerationConfig: {} }); // Send empty config
        return; // Session is likely fine
      } catch (e) {
        console.warn("Session check failed, reconnecting.", e);
        // Proceed to close and reconnect
      }
    }

    // Close existing session if any
    if (this.session) {
        try {
            await this.session.close();
        } catch (e) {
            console.warn("Error closing existing session:", e);
        }
    }


    this.playbackState = 'loading'; // Indicate connection attempt
    try {
        this.session = await ai.live.music.connect({
        model: model,
        callbacks: {
            onmessage: async (e: LiveMusicServerMessage) => {
            console.log('Received message from the server:', e);
            if (e.setupComplete) {
                this.connectionError = false;
                if (this.playbackState === 'loading') { // If was connecting
                    // If user intended to play, transition to playing after buffer
                    // For now, let user click play again if they were in stopped/paused
                }
            }
            if (e.filteredPrompt) {
                this.filteredPrompts = new Set([
                ...this.filteredPrompts,
                e.filteredPrompt.text, // This might be the augmented prompt. Store original if needed for UI.
                ]);
                this.toastMessage.show(`"${e.filteredPrompt.text.substring(0,30)}..." idea is a bit tricky! ${e.filteredPrompt.filteredReason || ''}`);
            }
            if (e.serverContent?.audioChunks !== undefined) {
                if (
                this.playbackState === 'paused' ||
                this.playbackState === 'stopped'
                )
                return;

                if (!this.audioContext || this.audioContext.state === 'closed') {
                    console.warn("AudioContext closed or not available, cannot play audio.");
                    this.pauseAudio(); // Stop trying to play
                    return;
                }

                const audioBuffer = await decodeAudioData(
                decode(e.serverContent?.audioChunks[0].data),
                this.audioContext,
                this.sampleRate,
                2, // Assuming stereo
                );
                const source = this.audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.outputNode);
                if (this.nextStartTime === 0) { // First buffer after play/resume
                this.nextStartTime =
                    this.audioContext.currentTime + this.bufferTime;
                setTimeout(() => {
                    if (this.playbackState === 'loading') this.playbackState = 'playing';
                }, this.bufferTime * 1000);
                }

                if (this.nextStartTime < this.audioContext.currentTime) {
                console.warn('Audio under-run detected! Resetting playback.');
                this.playbackState = 'loading'; // Show loading spinner
                this.nextStartTime = this.audioContext.currentTime + this.bufferTime; // Re-buffer
                 // Do not immediately start, let it buffer
                }
                source.start(this.nextStartTime);
                this.nextStartTime += audioBuffer.duration;
            }
            },
            onerror: (e: ErrorEvent) => {
            console.error('Connection error:', e);
            this.connectionError = true;
            this.pauseAudio(); // Go to paused instead of stopped, user might want to retry.
            this.playbackState = 'paused';
            this.toastMessage.show('Oh no! Lost connection to the music magic. Try playing again.');
            },
            onclose: (e: CloseEvent) => {
            console.log('Connection closed.', e);
            if (!e.wasClean) { // If not closed by user action (e.g. page close)
                this.connectionError = true;
                 this.pauseAudio();
                 this.playbackState = 'paused';
                this.toastMessage.show('Music magic connection closed. Please try playing again.');
            }
            },
        },
        });
        this.connectionError = false;
        // After successful connection, send current prompts and settings
        await this.setSessionPrompts();
        if (this.settingsController) {
            const currentSettings = this.settingsController['config'];
            await this.session.setMusicGenerationConfig({ musicGenerationConfig: currentSettings });
        }

    } catch (error) {
        console.error("Failed to connect to session:", error);
        this.connectionError = true;
        this.playbackState = 'stopped'; // Or 'paused'
        this.toastMessage.show("Couldn't start the music magic. Is your internet okay?");
    }
  }

  private setSessionPrompts = throttle(async () => {
    if (!this.session || this.connectionError) {
      console.warn('Session not ready for setSessionPrompts');
      return;
    }
    const childFriendlyInstruction = "Music for a 5-year-old: ";
    const promptsToSend = Array.from(this.prompts.values())
      .filter((p) => {
        return !this.filteredPrompts.has(p.text) && p.weight > 0.01; // Only send active prompts
      })
      .map(p => ({
        ...p,
        text: `${childFriendlyInstruction}${p.text}. Make it simple, happy, and playful.`,
      }));

    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: promptsToSend,
      });
    } catch (e: any) {
      this.toastMessage.show(`Oops! Had trouble with song ideas: ${e.message}`);
      this.pauseAudio();
    }
  }, 250); // Slightly increased throttle

  private dispatchPromptsChange() {
    this.dispatchEvent(
      new CustomEvent('prompts-changed', {detail: this.prompts}),
    );
    setStoredPrompts(this.prompts); // Save prompts on change
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const {promptId, text, weight, color} = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('Prompt not found:', promptId);
      return;
    }

    prompt.text = text;
    prompt.weight = weight;
    // Color doesn't change via this event, but included for completeness of Prompt interface

    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);
    this.prompts = newPrompts;

    this.setSessionPrompts();
    // No direct requestUpdate needed as Lit handles property changes.
    this.dispatchPromptsChange();
  }

  private makeBackground() {
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    const MAX_WEIGHT = 0.6; // Adjusted for potentially more subtle effect
    const MAX_ALPHA = 0.4;  // Reduced max alpha for softer glows

    const bg: string[] = [];

    [...this.prompts.values()].forEach((p, i) => {
      if (p.weight <= 0.01) return; // Don't draw for inactive prompts

      const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
      const alpha = Math.round(alphaPct * 0xff)
        .toString(16)
        .padStart(2, '0');

      const spreadFactor = 1.5; // Make gradients larger
      const stop = (p.weight / 2) * 100 * spreadFactor;
      // Distribute origins more centrally and less grid-like
      const angle = (i / this.prompts.size) * 2 * Math.PI;
      const radius = 30; // % from center
      const x = 50 + radius * Math.cos(angle);
      const y = 50 + radius * Math.sin(angle);

      const s = `radial-gradient(circle at ${x}% ${y}%, ${p.color}${alpha} 0%, ${p.color}00 ${stop}%)`;
      bg.push(s);
    });
    return bg.join(', ');
  }

  private async handlePlayPause() {
    this.initializeAudioContext(); // Ensure AudioContext is ready
    if (!this.audioContext) {
        this.toastMessage.show("Cannot play: Audio system not ready.");
        return;
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    if (this.playbackState === 'playing') {
      this.pauseAudio();
    } else if (this.playbackState === 'paused' || this.playbackState === 'stopped') {
      if (this.connectionError || !this.session) {
        await this.connectToSession(); // This will also set prompts and config
        if (this.connectionError) return; // Connect failed
      }
      this.loadAudio();
    } else if (this.playbackState === 'loading') {
      // If currently loading, pressing button again could mean "stop loading/cancel"
      this.pauseAudio(); // Or stopAudio, depending on desired UX
    }
  }

 private pauseAudio() {
    if (this.session && !this.connectionError) {
      try {
        this.session.pause();
      } catch(e) { console.warn("Error pausing session:", e); }
    }
    this.playbackState = 'paused';
    if (this.outputNode && this.audioContext && this.audioContext.state === 'running') {
        this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    }
    this.nextStartTime = 0; // Reset buffer timing
  }

  private loadAudio() {
    if (!this.audioContext || this.audioContext.state !== 'running') {
        this.toastMessage.show("Audio system not ready to play.");
        this.playbackState = 'paused'; // or 'stopped'
        return;
    }

    if (!this.session || this.connectionError) {
        this.toastMessage.show("Trying to reconnect the music magic...");
        this.connectToSession().then(() => {
            if (!this.connectionError && this.session) { // Check session again after connect
                this.session.play();
                this.playbackState = 'loading';
                 if (this.outputNode && this.audioContext && this.audioContext.state === 'running') {
                    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
                    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.2);
                 }
            }
        });
        return;
    }

    try {
      this.session.play();
      this.playbackState = 'loading';
      if (this.outputNode && this.audioContext && this.audioContext.state === 'running') {
        this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime); // Start silent
        this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.2); // Fade in
      }
    } catch (e: any) {
        this.toastMessage.show(`Couldn't play: ${e.message}`);
        this.playbackState = 'paused'; // Or stopped
    }
  }

  private stopAudio() { // Full stop, might require session restart
    if (this.session && !this.connectionError) {
      try {
        this.session.stop(); // This might implicitly close or reset server state
      } catch (e) { console.warn("Error stopping session:", e); }
    }
    this.playbackState = 'stopped';
     if (this.outputNode && this.audioContext && this.audioContext.state === 'running') {
        this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    }
    this.nextStartTime = 0;
    // Consider if a full stop should also disconnect and require reconnect on next play
    // For now, keeps session alive but stopped.
  }


  private async handleAddPrompt() {
    if (this.prompts.size >= 8) { // Limit number of prompts for simplicity
        this.toastMessage.show("That's a lot of song ideas! Maybe remove one first?");
        return;
    }
    const newPromptId = `prompt-${this.nextPromptId++}`;
    const usedColors = [...this.prompts.values()].map((p) => p.color);
    const newPrompt: Prompt = {
      promptId: newPromptId,
      text: 'New Song Idea!', // Child-friendly default text
      weight: 0, // Start with no weight
      color: getUnusedRandomColor(usedColors),
    };
    const newPrompts = new Map(this.prompts);
    newPrompts.set(newPromptId, newPrompt);
    this.prompts = newPrompts;

    // Don't send to session yet, wait for user to edit and add weight
    // this.setSessionPrompts();
    this.dispatchPromptsChange(); // Save and update UI

    await this.updateComplete;

    const newPromptElement = this.renderRoot.querySelector<PromptController>(
      `prompt-controller[promptId="${newPromptId}"]`,
    );
    if (newPromptElement) {
      newPromptElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center', // Center the new prompt
      });

      const textSpan =
        newPromptElement.shadowRoot?.querySelector<HTMLSpanElement>('#text');
      if (textSpan) {
        textSpan.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(textSpan);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }

  private handlePromptRemoved(e: CustomEvent<string>) {
    e.stopPropagation();
    const promptIdToRemove = e.detail;
    if (this.prompts.has(promptIdToRemove)) {
      this.prompts.delete(promptIdToRemove);
      const newPrompts = new Map(this.prompts); // Create new map instance for reactivity
      this.prompts = newPrompts;
      this.setSessionPrompts();
      this.dispatchPromptsChange();
    } else {
      console.warn(
        `Attempted to remove non-existent prompt ID: ${promptIdToRemove}`,
      );
    }
  }

  private handlePromptsContainerWheel(e: WheelEvent) {
    const container = e.currentTarget as HTMLElement;
    // Allow vertical scroll on page, only prevent default for horizontal
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      container.scrollLeft += e.deltaX;
    }
  }

  private updateSettings = throttle(
    async (e: CustomEvent<LiveMusicGenerationConfig>) => {
      if (!this.session || this.connectionError) {
        console.warn('Session not ready for updateSettings');
        return;
      }
      try {
        await this.session.setMusicGenerationConfig({
          musicGenerationConfig: e.detail,
        });
      } catch (err: any) {
          this.toastMessage.show(`Setting change failed: ${err.message}`);
      }
    },
    250, // Slightly increased throttle
  );

  private async handleReset() {
    this.initializeAudioContext();
     if (!this.audioContext) {
        this.toastMessage.show("Cannot reset: Audio system not ready.");
        return;
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    if (this.connectionError || !this.session) {
      await this.connectToSession();
      if (this.connectionError) return;
    }

    this.pauseAudio(); // Pause current playback smoothly

    if (this.session) {
        try {
            await this.session.resetContext();
        } catch (e: any) {
            this.toastMessage.show(`Could not reset music context: ${e.message}`);
            // Attempt to continue anyway
        }
    }

    this.settingsController.resetToDefaults(); // This will dispatch settings-changed
    // The resetToDefaults in settingsController will trigger an updateSettings call
    // which will send the default config to the server.

    this.filteredPrompts.clear(); // Clear any filtered prompts

    // Brief delay then try to load/play to allow server to process reset
    setTimeout(() => {
      if (this.playbackState !== 'playing') { // Only auto-play if it wasn't already playing
         //this.loadAudio(); // Or let user press play again
      }
      this.toastMessage.show("Music all fresh and new!");
    }, 500);
  }

  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html`<div id="background" style=${bg}></div>
      <div class="prompts-area">
        <div
          id="prompts-container"
          @prompt-removed=${this.handlePromptRemoved}
          @wheel=${this.handlePromptsContainerWheel}>
          ${this.renderPrompts()}
        </div>
        <div class="add-prompt-button-container">
          <add-prompt-button @click=${this.handleAddPrompt} aria-label="Add new song idea"></add-prompt-button>
        </div>
      </div>
      <div id="settings-container">
        <settings-controller
          @settings-changed=${this.updateSettings}></settings-controller>
      </div>
      <div class="playback-container">
        <play-pause-button
          @click=${this.handlePlayPause}
          .playbackState=${this.playbackState}
          aria-label=${this.playbackState === 'playing' ? 'Pause music' : 'Play music'}></play-pause-button>
        <reset-button @click=${this.handleReset} aria-label="Reset music settings"></reset-button>
      </div>
      <toast-message></toast-message>`;
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      return html`<prompt-controller
        .promptId=${prompt.promptId}
        ?filtered=${this.filteredPrompts.has(prompt.text)}
        .text=${prompt.text}
        .weight=${prompt.weight}
        .color=${prompt.color}
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
}

function gen(parent: HTMLElement) {
  const initialPrompts = getStoredPrompts();
  const pdj = new PromptDj(initialPrompts);

  // Store prompts when they change
  pdj.addEventListener('prompts-changed', (e) => {
    // @ts-ignore
    setStoredPrompts(e.detail as Map<string, Prompt>);
  });

  parent.appendChild(pdj);
}

function getStoredPrompts(): Map<string, Prompt> {
  const {localStorage} = window;
  const storedPromptsJson = localStorage.getItem('promptsDjChildFriendly'); // Use new key for child version

  if (storedPromptsJson) {
    try {
      const storedPromptsArray = JSON.parse(storedPromptsJson) as [string, Prompt][];
      console.log('Loading stored song ideas', storedPromptsArray);
      return new Map(storedPromptsArray);
    } catch (e) {
      console.error('Failed to parse stored song ideas', e);
    }
  }

  console.log('No stored song ideas, creating new happy song ideas!');

  const numDefaultPrompts = Math.min(3, PROMPT_TEXT_PRESETS.length); // Start with 3 happy ideas
  const shuffledPresetTexts = [...PROMPT_TEXT_PRESETS].sort(
    () => Math.random() - 0.5,
  );
  const defaultPrompts: Prompt[] = [];
  const usedColors: string[] = [];
  for (let i = 0; i < numDefaultPrompts; i++) {
    const text = shuffledPresetTexts[i];
    const color = getUnusedRandomColor(usedColors);
    usedColors.push(color);
    defaultPrompts.push({
      promptId: `prompt-${i}`,
      text,
      weight: 0, // Start with no weight, user can activate
      color,
    });
  }
  // Randomly select one prompt to set its weight to 1.
  if (defaultPrompts.length > 0) {
      const randomIndex = Math.floor(Math.random() * defaultPrompts.length);
      defaultPrompts[randomIndex].weight = 1;
  }

  const newMap = new Map(defaultPrompts.map((p) => [p.promptId, p]));
  setStoredPrompts(newMap); // Save initial presets
  return newMap;
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  // Store map as an array of [key, value] pairs for easier JSON parsing
  const storedPrompts = JSON.stringify(Array.from(prompts.entries()));
  const {localStorage} = window;
  localStorage.setItem('promptsDjChildFriendly', storedPrompts);
}

function main(container: HTMLElement) {
  gen(container);
}

main(document.body);

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj': PromptDj;
    'prompt-controller': PromptController;
    'settings-controller': SettingsController;
    'add-prompt-button': AddPromptButton;
    'play-pause-button': PlayPauseButton;
    'reset-button': ResetButton;
    'weight-slider': WeightSlider;
    'toast-message': ToastMessage;
  }
}