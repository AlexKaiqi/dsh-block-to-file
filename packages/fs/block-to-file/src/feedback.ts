/**
 * Renders `[b2f]` feedback strings for the model from pipeline reports.
 * @module @deepseek-ai/dsh-block-to-file
 */

import type { B2FError, B2FReport, MaterializeResult } from './types.ts'

/** Render the success feedback for every materialized block. */
export function renderSuccessFeedback(report: B2FReport): string {
  const lines: string[] = []
  for (const result of report.results) {
    lines.push(renderResultLine(result))
    if (result.diffText !== null && result.diffText.length > 0) {
      lines.push('')
      lines.push(result.diffText)
    }
  }
  if (report.gitStatus !== null && report.gitStatus.length > 0) {
    lines.push('')
    lines.push('git status --short')
    lines.push(report.gitStatus)
  }
  return lines.join('\n')
}

/** Render one `[b2f]` result line. */
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

/** Render the failure feedback for a validation or materialization failure. */
export function renderFailureFeedback(report: B2FReport): string {
  const written = report.results.length
  const suffix = written === 0
    ? 'nothing was written.'
    : `${written} file(s) were written before the failure.`
  const prefix = `[b2f] error: ${report.errors.length} file block(s) failed, ${suffix}`
  const lines = report.errors.map((error, index) => {
    const path = error.path === null || error.path.length === 0 ? '<missing file>' : error.path
    return `${index + 1}. \`\`\` file=${path}\n   ${error.code}: ${error.hint}`
  })
  return [prefix, '', ...lines].join('\n')
}

/** Render a feedback message for any report (success with failures is possible after partial IO failure). */
export function renderFeedback(report: B2FReport): string {
  if (report.ok) return renderSuccessFeedback(report)
  if (report.results.length === 0) return renderFailureFeedback(report)
  // Partial materialization failure: report what was written before the failure.
  return `${renderSuccessFeedback(report)}\n\n${renderFailureFeedback(report)}`
}

/** Errors that apply to the whole message rather than one block path. */
export function isMessageLevelError(error: B2FError): boolean {
  return error.code === 'TOTAL_SIZE_EXCEEDED' || error.code === 'TOO_MANY_FILES'
}
