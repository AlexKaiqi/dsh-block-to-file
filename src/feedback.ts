/**
 * Renders `[b2f]` feedback strings for the model from transactional reports.
 * @module @deepseek-ai/dsh-block-to-file
 */

import type { B2FCommittedReport, B2FError, B2FFailedReport, B2FProjectionFailedReport, B2FReport, B2FStaleReport, MaterializeResult } from './types.ts'

/** Render one committed transaction. */
export function renderSuccessFeedback(report: B2FCommittedReport): string {
  const lines = [`[b2f] committed ${report.commit}`]
  for (const result of report.results) {
    lines.push(renderResultLine(result))
    if (result.diffText !== null && result.diffText.length > 0) {
      lines.push('', result.diffText)
    }
  }
  return lines.join('\n')
}

function renderResultLine(result: MaterializeResult): string {
  switch (result.status) {
    case 'created':
      return `[b2f] created ${result.path} (${result.lines} lines)`
    case 'updated':
      return `[b2f] wrote ${result.path} (${result.lines} lines, +${result.added}/-${result.removed})`
    case 'appended':
      return `[b2f] appended ${result.path} (${result.added} lines, total ${result.lines} lines)`
    case 'unchanged':
      return `[b2f] append skipped ${result.path} (already present, ${result.lines} lines)`
  }
}

/** Render a validation or repository failure. */
export function renderFailureFeedback(report: B2FFailedReport): string {
  const prefix = `[b2f] error: ${report.errors.length} file block(s) failed; nothing was committed.`
  const lines = report.errors.map((error, index) => {
    const path = error.path === null || error.path.length === 0 ? '<missing file>' : error.path
    return `${index + 1}. \`\`\` file=${path}\n   ${error.code}: ${error.hint}`
  })
  return [prefix, '', ...lines].join('\n')
}

/** Render stale files as complete new observations for immediate model retry. */
export function renderStaleFeedback(report: B2FStaleReport): string {
  const lines = [
    '[b2f] stale: transaction rejected; nothing was committed.',
    `repoRevision: ${report.repoRevision}`,
  ]
  for (const file of report.staleFiles) {
    lines.push('', `${file.path} changed since your observation.`, `observedVersion: ${file.observedVersion}`, `fileVersion: ${file.fileVersion}`)
    if (file.content === null) {
      lines.push('<file is absent>')
    } else {
      const fence = safeFence(file.content)
      lines.push(`${fence} file=${file.path}`, file.content, fence)
    }
    if (file.changesSinceRead.length > 0) {
      lines.push('', 'Changes since observation:')
      for (const change of file.changesSinceRead) {
        const agent = change.agent === null ? 'unknown agent' : change.agent
        lines.push(`- ${change.commit} ${agent}: ${change.message}`)
      }
    }
  }
  return lines.join('\n')
}

export function renderProjectionFailureFeedback(report: B2FProjectionFailedReport): string {
  const detail = report.errors.map(error => error.hint).join('; ')
  return `[b2f] projection failed after canonical commit ${report.commit}; tool execution is blocked.\n${detail}`
}

export function renderFeedback(report: B2FReport): string {
  switch (report.status) {
    case 'committed': return renderSuccessFeedback(report)
    case 'stale': return renderStaleFeedback(report)
    case 'failed': return renderFailureFeedback(report)
    case 'projection-failed': return renderProjectionFailureFeedback(report)
  }
}

function safeFence(content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), match => match[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Errors that apply to the whole message rather than one block path. */
export function isMessageLevelError(error: B2FError): boolean {
  return error.code === 'TOTAL_SIZE_EXCEEDED' || error.code === 'TOO_MANY_FILES'
}
