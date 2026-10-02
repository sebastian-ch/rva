/** Sustained frame times control resolution; loading and tab pauses are not GPU benchmarks. */
export class AdaptiveResolution {
  private readonly steps: number[];
  private index: number;
  private changeAfter: number;
  private elapsed = 0;
  private frames = 0;

  constructor(devicePixelRatio: number, now = 0) {
    const cap = Math.min(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1, 2);
    this.steps = [...new Set([1, 1.5, 2].map(value => Math.min(value, cap)))];
    this.index = this.steps.indexOf(Math.min(1.5, cap));
    this.changeAfter = now + 4000;
  }

  get pixelRatio(): number { return this.steps[this.index]; }

  /** Returns a new ratio only when it changes, avoiding render-target reallocations every frame. */
  sample(frameMs: number, now: number, eligible: boolean): number | null {
    if (!eligible || !Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 250) {
      this.elapsed = 0;
      this.frames = 0;
      this.changeAfter = now + 4000;
      return null;
    }
    if (now < this.changeAfter) return null;
    this.elapsed += frameMs;
    this.frames++;
    if (this.elapsed < 1500 || this.frames < 30) return null;

    const average = this.elapsed / this.frames;
    this.elapsed = 0;
    this.frames = 0;
    const next = average > 28 ? Math.max(0, this.index - 1)
      : average < 19 ? Math.min(this.steps.length - 1, this.index + 1) : this.index;
    if (next === this.index) return null;
    this.index = next;
    this.changeAfter = now + 5000;
    return this.pixelRatio;
  }
}
