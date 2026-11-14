import { useNavigate } from 'react-router-dom';
import { ChevronDown, FolderGit2, FolderPlus, Pencil, Settings2, UserPlus, X } from 'lucide-react';
import { Menu, type MenuItem } from './ui';
import { Face } from './Face';
import type { PanelAgent, WorkspaceRow, WorkspaceSet } from './PersonaPanel';

/** Composer chip: shows the persona answering this chat; switch, edit, create or manage personas from here. */
export function PersonaChip({ agents, active, onSwitch, onEdit, onNew }: {
  agents: PanelAgent[]; active: PanelAgent | undefined; onSwitch: (id: string) => void; onEdit: () => void; onNew: () => void;
}) {
  const navigate = useNavigate();
  const items: MenuItem[] = [
    ...agents.map((agent, index) => ({ label: agent.name, heading: index === 0 ? 'Switch persona' : undefined, hint: agent.title || undefined, checked: agent.id === active?.id, onSelect: () => { if (agent.id !== active?.id) onSwitch(agent.id); } })),
    { label: active ? `Edit ${active.name}…` : 'Edit persona…', icon: Pencil, separator: true, disabled: !active, onSelect: onEdit },
    { label: 'New persona…', icon: UserPlus, onSelect: onNew },
    { label: 'Manage personas…', icon: Settings2, onSelect: () => navigate('/agents') },
  ];
  return (
    <Menu className="pill persona-chip" align="start" label="Switch persona (Ctrl+/)" hint="Persona for this chat · Ctrl+/ to switch" icon={null}
      lead={active ? <Face agent={active} size={20} /> : undefined} text={active?.name || 'Pick a persona'} trailing={<ChevronDown size={14} aria-hidden className="faint" />} items={items} />
  );
}

/** Composer chip: the workspace set this chat works in, with branch and a dirty dot; attach, detach or add one. */
export function WorkspaceChip({ sets, workspaces, activeId, onAttach, onAdd, canManage }: {
  sets: WorkspaceSet[]; workspaces: WorkspaceRow[]; activeId: string | null | undefined; onAttach: (id: string | null) => void; onAdd: () => void; canManage: boolean;
}) {
  const navigate = useNavigate();
  const active = sets.find((set) => set.id === activeId);
  const rows = active ? workspaces.filter((row) => active.projects.includes(row.label) && row.source === 'project') : [];
  const dirty = rows.reduce((sum, row) => sum + row.dirty, 0);
  const branch = rows.find((row) => row.branch)?.branch;
  const items: MenuItem[] = [
    ...sets.map((set, index) => ({ label: set.name, heading: index === 0 ? 'Work in' : undefined, hint: set.projects.join(' + '), checked: set.id === activeId, onSelect: () => onAttach(set.id) })),
    ...(canManage ? [{ label: 'Add folder, repo or clone…', icon: FolderPlus, separator: sets.length > 0, onSelect: onAdd }] : []),
    { label: 'Manage workspaces…', icon: Settings2, onSelect: () => navigate('/workspace') },
  ];
  if (sets.length === 0 && !canManage) return null;
  return (
    <span className={active ? 'ws-chip on' : 'ws-chip'}>
      <Menu className="pill" align="start" label="Workspace for this chat" hint={active ? `${active.projects.join(' + ')}${dirty ? ` · ${dirty} uncommitted` : ''}` : 'Attach a folder or repo'} icon={FolderGit2}
        text={active ? `${active.name}${branch ? ` · ${branch}` : ''}` : 'Workspace'} trailing={dirty ? <span className="dirty-dot" aria-label={`${dirty} uncommitted changes`} /> : undefined} items={items} />
      {active && <button type="button" className="chip-x" aria-label={`Detach ${active.name}`} title="Detach from this chat" onClick={() => onAttach(null)}><X size={12} /></button>}
    </span>
  );
}

/** Three starter prompts in the persona's own area, picked from its tools. */
export function startersFor(agent: PanelAgent | undefined, code: boolean): string[] {
  const tools = agent?.toolAllowlist || [];
  if (code || tools.includes('apply_patch') || tools.includes('git')) return ['Explain how this repo is laid out', 'Find and fix a failing test', 'Plan a small refactor, then wait for my OK'];
  if (tools.includes('web_search')) return ['What changed in the news on this topic this week?', 'Compare three options and cite sources', 'Summarise this page for me'];
  if (tools.includes('shell') || tools.includes('docker_ps')) return ['How much disk and memory is free?', 'Which containers are running?', 'Check that the backups ran'];
  return ['Help me plan my week', 'Remember that I prefer short answers', 'Draft a friendly reply to this message'];
}

export function greetingFor(agent: PanelAgent | undefined): string {
  if (!agent) return 'Set up a persona to start.';
  return agent.description?.trim() ? `I'm ${agent.name}. ${agent.description.trim()}` : `Hi, I'm ${agent.name}. What are we working on?`;
}
