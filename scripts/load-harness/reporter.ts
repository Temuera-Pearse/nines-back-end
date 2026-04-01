import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import type {
  FinalSummary,
  HarnessAnomaly,
  ReporterEvent,
  SnapshotReport,
} from './types.js'
import { formatHumanSummary } from './summaryFormatter.js'

type ReporterOptions = Readonly<{
  outputPath?: string
  emit?: (event: ReporterEvent) => void
}>

function emitJsonLine(event: ReporterEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

export class JsonReporter {
  constructor(private readonly options: ReporterOptions = {}) {}

  snapshot(payload: SnapshotReport): void {
    const event: ReporterEvent = { type: 'snapshot', payload }
    this.options.emit?.(event)
    if (!this.options.emit) emitJsonLine(event)
  }

  anomaly(payload: HarnessAnomaly): void {
    const event: ReporterEvent = { type: 'anomaly', payload }
    this.options.emit?.(event)
    if (!this.options.emit) emitJsonLine(event)
  }

  async summary(payload: FinalSummary): Promise<void> {
    const event: ReporterEvent = { type: 'summary', payload }
    this.options.emit?.(event)
    if (!this.options.emit) emitJsonLine(event)
    if (this.options.outputPath) {
      await mkdir(path.dirname(this.options.outputPath), { recursive: true })
      await writeFile(
        this.options.outputPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      )
    }
    process.stderr.write(
      `${formatHumanSummary(payload, this.options.outputPath)}\n`,
    )
  }
}
