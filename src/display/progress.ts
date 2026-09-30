/**
 * Progress display module
 * Provides beautiful progress bars and spinners
 */

import cliProgress from "cli-progress";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import figures from "figures";

export interface ProgressBarOptions {
  total: number;
  format?: string;
  showETA?: boolean;
  showSpeed?: boolean;
}

/**
 * Create a progress bar for indexing with elapsed time, ETA, rate, and live file tracking
 */
export function createIndexingProgressBar(options: ProgressBarOptions): cliProgress.SingleBar {
  const bar = new cliProgress.SingleBar(
    {
      format: (_barOptions, params, payload) => {
        const terminalWidth = process.stdout.columns || 80;

        // Visual bar length dynamically adapts to terminal width
        const barLength = Math.max(10, Math.min(20, Math.floor(terminalWidth / 6)));
        const progress = Math.max(0, Math.min(1, params.progress || 0));
        const completeChars = Math.round(progress * barLength);
        const incompleteChars = Math.max(0, barLength - completeChars);
        const barStr = chalk.cyan("█".repeat(completeChars)) + chalk.gray("░".repeat(incompleteChars));

        // Percentage
        const pct = (progress * 100).toFixed(1).padStart(5, " ") + "%";

        // Counts
        const counts = `${formatNumber(params.value)}/${formatNumber(params.total)}`;

        // Timing
        const elapsedMs = Math.max(0, Date.now() - params.startTime);
        const elapsedStr = formatDuration(elapsedMs);

        // Rate & ETA
        const rate = params.value > 0 && elapsedMs > 0 ? params.value / (elapsedMs / 1000) : 0;
        const remaining = Math.max(0, params.total - params.value);
        const etaMs = rate > 0 ? (remaining / rate) * 1000 : 0;
        const etaStr = remaining === 0 ? "0s" : formatDuration(etaMs);
        const rateStr = rate > 0 ? `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}/s` : "--/s";

        // Worker & File status
        let fileInfo = "";
        if (payload?.filename) {
          const workerPrefix = payload.workerCount && payload.workerCount > 1
            ? (payload.workerId ? `[W${payload.workerId}] ` : `[${payload.workerCount}w] `)
            : "";
          const activeSuffix = payload.activeCount && payload.activeCount > 1
            ? ` (+${payload.activeCount - 1})`
            : "";
          fileInfo = `${workerPrefix}${payload.filename}${activeSuffix}`;
        }

        const prefix = `${barStr} ${chalk.bold.white(pct)} | ${chalk.white(counts)} | ${chalk.yellow("⏱ " + elapsedStr)} | ${chalk.green("ETA: " + etaStr)} | ${chalk.gray(rateStr)}`;

        // Strip ANSI codes to measure visible text width
        const prefixClean = prefix.replace(/\u001b\[[0-9;]*m/g, "");
        const separator = " | ";
        const availableWidth = terminalWidth - prefixClean.length - separator.length - 1;

        if (fileInfo && availableWidth > 8) {
          let truncatedFile = fileInfo;
          if (truncatedFile.length > availableWidth) {
            truncatedFile = "..." + truncatedFile.slice(-(availableWidth - 3));
          }
          return `${prefix}${chalk.gray(separator)}${chalk.cyan(truncatedFile)}`;
        }

        return prefix;
      },
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: false,
      forceRedraw: true,
      fps: 10,
    },
    cliProgress.Presets.shades_classic
  );

  return bar;
}

/**
 * Create a simple progress bar
 */
export function createSimpleProgressBar(total: number): cliProgress.SingleBar {
  const bar = new cliProgress.SingleBar(
    {
      format: `${chalk.cyan("{bar}")} ${chalk.white("{percentage}%")} | ${chalk.white("{value}/{total}")}`,
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
      clearOnComplete: false,
    },
    cliProgress.Presets.shades_classic
  );

  bar.start(total, 0);
  return bar;
}

/**
 * Create a spinner for long-running tasks
 */
export function createSpinner(text: string): Ora {
  return ora({
    text,
    spinner: "dots",
    color: "cyan",
  });
}

/**
 * Progress tracker class for complex operations
 */
export class ProgressTracker {
  private bar: cliProgress.SingleBar | null = null;
  private spinner: Ora | null = null;
  private startTime: number = 0;

  /**
   * Start a new phase with a spinner
   */
  startPhase(_name: string, message: string): void {
    this.stopCurrent();
    this.startTime = Date.now();
    this.spinner = createSpinner(message);
    this.spinner.start();
  }

  /**
   * Start a progress bar phase
   */
  startProgressPhase(_name: string, total: number, message?: string): void {
    this.stopCurrent();
    this.startTime = Date.now();

    if (message) {
      console.log(chalk.white(message));
    }

    this.bar = createIndexingProgressBar({ total });
    this.bar.start(total, 0, { filename: "" });
  }

  /**
   * Update progress
   */
  update(value: number, payload?: Record<string, unknown>): void {
    if (this.bar) {
      this.bar.update(value, payload);
    }
  }

  /**
   * Increment progress
   */
  increment(payload?: object): void {
    if (this.bar) {
      if (payload) {
        this.bar.increment(payload);
      } else {
        this.bar.increment();
      }
    }
  }

  /**
   * Update spinner text
   */
  setText(text: string): void {
    if (this.spinner) {
      this.spinner.text = text;
    }
  }

  /**
   * Stop current progress indicator
   */
  stopCurrent(): void {
    if (this.bar) {
      this.bar.stop();
      this.bar = null;
    }
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  /**
   * Mark phase as successful
   */
  succeed(message?: string): void {
    if (this.spinner) {
      this.spinner.succeed(message);
      this.spinner = null;
    } else if (this.bar) {
      this.bar.stop();
      this.bar = null;
      if (message) {
        console.log(chalk.green(`${figures.tick} ${message}`));
      }
    }
  }

  /**
   * Mark phase as failed
   */
  fail(message?: string): void {
    if (this.spinner) {
      this.spinner.fail(message);
      this.spinner = null;
    } else if (this.bar) {
      this.bar.stop();
      this.bar = null;
      if (message) {
        console.log(chalk.red(`${figures.cross} ${message}`));
      }
    }
  }

  /**
   * Mark phase as warning
   */
  warn(message?: string): void {
    if (this.spinner) {
      this.spinner.warn(message);
      this.spinner = null;
    } else if (this.bar) {
      this.bar.stop();
      this.bar = null;
      if (message) {
        console.log(chalk.yellow(`${figures.warning} ${message}`));
      }
    }
  }

  /**
   * Get elapsed time for current phase
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Format elapsed time
   */
  getElapsedFormatted(): string {
    const ms = this.getElapsedMs();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format duration in milliseconds to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Format number with commas
 */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}
