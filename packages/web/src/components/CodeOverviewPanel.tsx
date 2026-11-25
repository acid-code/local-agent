import { Bot, Download, FileCode2, Files, FolderGit2, GitBranch, ListChecks, ListTree, Terminal } from 'lucide-react';
import { diffStats } from '../lib/work-steps';
import type { DiffEdit, MiniAgentRow } from './ChatUpgrades';
import { t } from '../i18n';

interface WorkspaceRootItem {
  id: string;
  label: string;
  branch?: string | null;
  dirty?: number;
}

/** Right-side Overview rail for desktop Code View (Review stats, Files, Terminal, Subagents, Plan, Trace). */
export function CodeOverviewPanel({
  edits,
  roots,
  helpers,
  plan,
  stepCount,
  onOpenFiles,
  onOpenEditFile,
  onDownloadEditFile,
  onOpenContext,
  onOpenWorkspace,
  onToggleTrace,
  onOpenTerminal,
  onJumpToReview,
}: {
  edits: DiffEdit[];
  roots: WorkspaceRootItem[];
  helpers: MiniAgentRow[];
  plan: { items: { status: string }[] } | null;
  stepCount: number;
  onOpenFiles: () => void;
  onOpenEditFile?: (filePath: string) => void;
  onDownloadEditFile?: (filePath: string) => void;
  onOpenContext: () => void;
  onOpenWorkspace: () => void;
  onToggleTrace: () => void;
  onOpenTerminal: () => void;
  onJumpToReview: () => void;
}) {
  const stats = edits.length ? diffStats(edits.map((e) => e.diff)) : { added: 0, removed: 0 };
  const changedFileList: string[] = [];
  const seenFiles = new Set<string>();
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    for (const part of edits[i]!.label.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!seenFiles.has(part)) {
        seenFiles.add(part);
        changedFileList.push(part);
      }
    }
  }
  const changedFiles = changedFileList.length;
  const runningHelpers = helpers.filter((h) => h.status === 'running' || h.status === 'queued' || h.status === 'waiting').length;
  const donePlan = plan?.items.filter((i) => i.status === 'done').length ?? 0;

  return (
    <aside className="side-panel code-overview" aria-label={t('Overview')}>
      <div className="overview-head">
        <strong>{t('Overview')}</strong>
      </div>
      <div className="overview-body">
        <div className="overview-list">
          <button type="button" className="overview-item" onClick={onJumpToReview}>
            <FileCode2 size={15} className="overview-ico" aria-hidden />
            <span className="overview-title">{t('Review')}</span>
            {edits.length > 0 ? (
              <span className="overview-diff mono">
                <span className="add">+{stats.added}</span>{' '}
                <span className="del">-{stats.removed}</span>
              </span>
            ) : (
              <span className="overview-badge faint">0</span>
            )}
          </button>

          <button type="button" className="overview-item" onClick={onOpenFiles}>
            <Files size={15} className="overview-ico" aria-hidden />
            <span className="overview-title">{t('Files')}</span>
            <span className="overview-badge faint">{changedFiles || roots.length}</span>
          </button>

          <button type="button" className="overview-item" onClick={onOpenTerminal}>
            <Terminal size={15} className="overview-ico" aria-hidden />
            <span className="overview-title">{t('Terminal')}</span>
          </button>

          <button type="button" className="overview-item" onClick={onOpenWorkspace}>
            <FolderGit2 size={15} className="overview-ico" aria-hidden />
            <span className="overview-title">{t('Workspaces')}</span>
            <span className="overview-badge faint">{roots.length}</span>
          </button>
        </div>

        {changedFileList.length > 0 && (
          <>
            <div className="overview-sep" />
            <div className="overview-files" aria-label={t('Changed files')}>
              {changedFileList.map((filePath) => {
                const base = filePath.split('/').pop() || filePath;
                return (
                  <div key={filePath} className="overview-file-row">
                    <button
                      type="button"
                      className="overview-file-open"
                      title={filePath}
                      onClick={() => onOpenEditFile?.(filePath)}
                    >
                      <FileCode2 size={14} className="overview-ico" aria-hidden />
                      <span className="ellipsis" dir="auto">{base}</span>
                    </button>
                    {onDownloadEditFile && (
                      <button
                        type="button"
                        className="overview-file-dl"
                        aria-label={t('Download {0}', [base])}
                        title={t('Download {0}', [filePath])}
                        onClick={() => onDownloadEditFile(filePath)}
                      >
                        <Download size={13} aria-hidden />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="overview-sep" />

        <div className="overview-list">
          <button type="button" className="overview-item" onClick={onOpenContext}>
            <Bot size={15} className="overview-ico" aria-hidden />
            <span className="overview-title">{t('Subagents')}</span>
            {runningHelpers > 0 && <span className="overview-live-dot" aria-hidden />}
            <span className="overview-badge faint">{helpers.length}</span>
          </button>

          {plan && plan.items.length > 0 && (
            <div className="overview-item static">
              <ListChecks size={15} className="overview-ico" aria-hidden />
              <span className="overview-title">{t('Plan')}</span>
              <span className="overview-badge faint">{donePlan}/{plan.items.length}</span>
            </div>
          )}

          <button type="button" className="overview-item" onClick={onToggleTrace}>
            <ListTree size={15} className="overview-ico" aria-hidden />
            <span className="overview-title">{t('Trace')}</span>
            <span className="overview-badge faint">{stepCount}</span>
          </button>
        </div>

        {roots.length > 0 && (
          <>
            <div className="overview-sep" />
            <div className="overview-repos">
              {roots.map((root) => (
                <button key={root.id} type="button" className="overview-repo-chip" onClick={onOpenFiles} title={root.label}>
                  <GitBranch size={12} aria-hidden />
                  <span className="ellipsis">{root.label}</span>
                  {root.branch && <span className="faint mono">{root.branch}</span>}
                  {Boolean(root.dirty) && <span className="dirty-dot" aria-hidden />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
