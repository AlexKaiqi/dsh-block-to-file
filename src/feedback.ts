/**
 * Renders `[b2f]` feedback strings for the model from transactional reports.
 * @module @deepseek-ai/dsh-block-to-file
 */

import type {
  B2FCommittedReport,
  B2FEditUnresolvedReport,
  B2FError,
  B2FFailedReport,
  B2FPreconditionFailedReport,
  B2FProjectionFailedReport,
  B2FPublicationFailedReport,
  B2FPublicationReceipt,
  B2FReport,
  B2FStaleReport,
  B2FUnchangedReport,
  B2FWorktreeDirtyReport,
  MaterializeResult,
} from './types.ts'

/** Render one committed transaction. */
export function renderSuccessFeedback(report: B2FCommittedReport): string {
  return appendPublications(renderResults(`[b2f] committed ${report.commit}`, report.results), report.publications)
}

/** Render an all-no-op transaction. */
export function renderUnchangedFeedback(report: B2FUnchangedReport): string {
  return appendPublications(
    renderResults(`[b2f] unchanged; no commit was created.\nrepoRevision: ${report.repoRevision}`, report.results),
    report.publications,
  )
}

function renderResults(prefix: string, results: readonly MaterializeResult[]): string {
  const lines = [prefix]
  for (const result of results) {
    lines.push(renderResultLine(result))
    if (result.diffText !== null && result.diffText.length > 0) {
      lines.push('', result.diffText)
    }
  }
  return lines.join('\n')
}

function appendPublications(text: string, publications?: readonly B2FPublicationReceipt[]): string {
  if (publications === undefined || publications.length === 0) return text
  const lines = publications.map(publication =>
    `[b2f] published ${publication.scope} revision ${publication.revision}${publication.noOp ? ' (unchanged)' : ''}`)
  return `${text}\n${lines.join('\n')}`
}

function renderResultLine(result: MaterializeResult): string {
  switch (result.status) {
    case 'created':
      return `[b2f] created ${result.path} (${result.lines} lines)`
    case 'updated':
      return `[b2f] wrote ${result.path} (${result.lines} lines, +${result.added}/-${result.removed})`
    case 'appended':
      return `[b2f] appended ${result.path} (${result.added} lines, total ${result.lines} lines)`
    case 'deleted':
      return `[b2f] deleted ${result.path} (${result.removed} lines removed)`
    case 'unchanged':
      if (result.mode === 'append') return `[b2f] append skipped ${result.path} (already present, ${result.lines} lines)`
      if (result.mode === 'delete') return `[b2f] delete skipped ${result.path} (already absent)`
      return `[b2f] write skipped ${result.path} (content unchanged, ${result.lines} lines)`
  }
}

/** Render a validation or repository failure. */
export function renderFailureFeedback(report: B2FFailedReport): string {
  return renderErrors(`[b2f] error: ${report.errors.length} file block(s) failed; nothing was committed.`, report.errors)
}

/** Render operation existence failures separately from concurrent changes. */
export function renderPreconditionFailureFeedback(report: B2FPreconditionFailedReport, numbered = false): string {
  const lines = [
    renderErrors('[b2f] precondition failed; nothing was committed.', report.errors),
    `repoRevision: ${report.repoRevision}`,
  ]
  for (const file of report.files) {
    lines.push('', `${file.path} currentVersion: ${file.fileVersion}`, ...renderEcho(file.path, file.content, numbered))
  }
  return lines.join('\n')
}

function renderErrors(prefix: string, errors: readonly B2FError[]): string {
  const lines = errors.map((error, index) => {
    const path = error.path === null || error.path.length === 0 ? '<missing file>' : error.path
    return `${index + 1}. \`\`\` file=${path}\n   ${error.code}: ${error.hint}`
  })
  return [prefix, '', ...lines].join('\n')
}

/** Render stale files as complete new observations for immediate model retry. */
export function renderStaleFeedback(report: B2FStaleReport, numbered = false): string {
  const lines = [
    '[b2f] stale: transaction rejected; nothing was committed.',
    `repoRevision: ${report.repoRevision}`,
  ]
  for (const file of report.staleFiles) {
    lines.push(
      '',
      `${file.path} changed since your observation.`,
      `observedVersion: ${file.observedVersion}`,
      `fileVersion: ${file.fileVersion}`,
      ...renderEcho(file.path, file.content, numbered),
    )
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

/** Render local filesystem drift that would otherwise be overwritten. */
export function renderWorktreeDirtyFeedback(report: B2FWorktreeDirtyReport, numbered = false): string {
  const lines = [
    '[b2f] worktree dirty: transaction rejected; nothing was committed.',
    `repoRevision: ${report.repoRevision}`,
    'Resolve, import, or discard these local changes before retrying:',
  ]
  for (const file of report.dirtyFiles) {
    lines.push(
      '',
      file.path,
      `expectedVersion: ${file.expectedVersion}`,
      `targetVersion: ${file.targetVersion}`,
      `worktreeVersion: ${file.fileVersion}`,
    )
    if (file.content === null && file.fileVersion !== 'absent') {
      lines.push('<path is not a regular file>')
    } else {
      lines.push(...renderEcho(file.path, file.content, numbered))
    }
  }
  return lines.join('\n')
}

export function renderProjectionFailureFeedback(report: B2FProjectionFailedReport): string {
  const detail = report.errors.map(error => error.hint).join('; ')
  return `[b2f] projection failed at canonical revision ${report.repoRevision}; tool execution is blocked.\n${detail}`
}

export function renderPublicationFailureFeedback(report: B2FPublicationFailedReport): string {
  const local = report.commit === null
    ? `workspace revision ${report.repoRevision} was unchanged`
    : `workspace commit ${report.commit} succeeded`
  const detail = report.errors.map(error => error.hint).join('; ')
  return `[b2f] external publication failed after ${local}; tool execution is blocked.\n${detail}`
}

/**
 * Render one content echo as an INERT block.
 *
 * Echoes use `path=`, not `file=`: the parser keeps only blocks carrying `file=`
 * (`parser.ts`), so a model that copies an echo back verbatim writes nothing and
 * raises no error. With `file=` a copied-back numbered window would be written
 * to disk complete with its line-number prefixes.
 *
 * @param path - the file this content belongs to.
 * @param content - current file content, or null when the path is absent.
 * @param numbered - prefix each line with its 1-based number, matching the read
 *   tool's `N: text` shape so line-anchored dialects can reuse the numbers.
 */
function renderEcho(path: string, content: string | null, numbered = false): string[] {
  if (content === null) return ['<file is absent>']
  const body = numbered ? numberLines(content) : content
  const fence = safeFence(body)
  return [`${fence} path=${path}${numbered ? ' numbered' : ''}`, body, fence]
}

/** Prefix every line with its 1-based number, as the read tool renders content. */
function numberLines(content: string): string {
  const lines = content.split('\n')
  // A trailing newline yields a final empty element that is not a line.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line, index) => `${index + 1}: ${line}`).join('\n')
}

/** Render an unresolved edit with the current content the model should re-anchor on. */
export function renderEditUnresolvedFeedback(report: B2FEditUnresolvedReport, numbered: boolean): string {
  const lines = [
    renderErrors('[b2f] edit not applied; nothing was committed.', report.errors),
    `repoRevision: ${report.repoRevision}`,
    'The file is unchanged and current. Re-anchor your edit on the content below.',
  ]
  for (const file of report.files) {
    lines.push('', `${file.path} currentVersion: ${file.fileVersion}`, ...renderEcho(file.path, file.content, numbered))
  }
  return lines.join('\n')
}

export function renderFeedback(report: B2FReport, numbered = false): string {
  switch (report.status) {
    case 'committed': return renderSuccessFeedback(report)
    case 'unchanged': return renderUnchangedFeedback(report)
    case 'stale': return renderStaleFeedback(report, numbered)
    case 'precondition-failed': return renderPreconditionFailureFeedback(report, numbered)
    case 'worktree-dirty': return renderWorktreeDirtyFeedback(report, numbered)
    case 'edit-unresolved': return renderEditUnresolvedFeedback(report, numbered)
    case 'failed': return renderFailureFeedback(report)
    case 'projection-failed': return renderProjectionFailureFeedback(report)
    case 'publication-failed': return renderPublicationFailureFeedback(report)
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
