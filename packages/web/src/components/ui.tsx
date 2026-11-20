import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronRight, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { t } from '../i18n';

/** Page title row: optional breadcrumb, title, one-line description, actions on the right. */
export function PageHeader({ title, description, actions, crumbs }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; crumbs?: { label: string; to?: string }[] }) {
  return (
    <header className="page-head">
      {crumbs && crumbs.length > 0 && (
        <nav className="crumbs" aria-label={t('Breadcrumb')}>
          {crumbs.map((crumb, index) => (
            <span key={index} className="crumb">
              {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
              {index < crumbs.length - 1 && <ChevronRight size={13} aria-hidden />}
            </span>
          ))}
        </nav>
      )}
      <div className="page-head-row">
        <div className="page-head-text">
          <h1>{title}</h1>
          {description && <p className="lede">{description}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </header>
  );
}

/** A friendly empty state with one next step. */
export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {Icon && <span className="empty-icon" aria-hidden><Icon size={22} /></span>}
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
      {action && <div className="row">{action}</div>}
    </div>
  );
}

/** A titled group of settings or content inside a page. */
export function Section({ id, title, description, actions, children }: { id?: string; title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card section" id={id} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="card-head">
        <div>
          <h3 id={id ? `${id}-title` : undefined}>{title}</h3>
          {description && <p className="faint section-desc">{description}</p>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  /** Renders a divider above this item. */
  separator?: boolean;
  /** A small group label above this item. */
  heading?: string;
  /** Shows a check mark (current choice). */
  checked?: boolean;
  /** Keep the menu open after selecting this item (e.g. inline refresh). */
  keepOpen?: boolean;
}

/**
 * Dropdown / overflow menu. Rendered in a portal and positioned from the trigger so it never gets clipped,
 * flips up or left near the window edge, closes on outside click, Esc, or ancestor scroll (never background stream scroll),
 * and supports arrow keys, Home/End and type-ahead. Focus returns to the trigger.
 */
export function Menu({ items, label = 'More actions', icon: Icon = MoreHorizontal, text, className, align = 'end', trailing, busy, lead, hint }: { items: MenuItem[]; label?: string; icon?: LucideIcon | null; text?: string; className?: string; align?: 'start' | 'end'; trailing?: ReactNode; busy?: boolean; lead?: ReactNode; hint?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback((refocus = true) => { setOpen(false); setPos(null); if (refocus) trigger.current?.focus(); }, []);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = panel.current.offsetWidth;
    const height = panel.current.offsetHeight;
    let left = align === 'end' ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    let side: 'top' | 'bottom' = 'bottom';
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 6);
      side = 'top';
    }
    setPos({ top, left, side });
    const first = panel.current.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
  }, [open, align, items.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      close(false);
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (panel.current && target instanceof Node && panel.current.contains(target)) return;
      // Ignore unrelated scroll containers (like .messages auto-scrolling during streaming replies).
      if (target === document || target === window || (target instanceof Node && trigger.current && target.contains(trigger.current))) {
        close(false);
      }
    };
    const onResize = () => close(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const onKey = (event: React.KeyboardEvent) => {
    const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (next: number) => { event.preventDefault(); buttons[(next + buttons.length) % buttons.length]?.focus(); };
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') go(index + 1);
    else if (event.key === 'ArrowUp') go(index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(buttons.length - 1);
    else if (event.key === 'Tab') close(false);
    else if (event.key.length === 1) {
      const match = buttons.findIndex((button, i) => i > index && button.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      const wrap = match >= 0 ? match : buttons.findIndex((button) => button.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (wrap >= 0) go(wrap);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className ?? (text ? 'btn ghost small menu-trigger' : 'icon-btn menu-trigger')}
        aria-label={text ? undefined : label}
        title={hint ?? (text ? undefined : label)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => { event.stopPropagation(); if (open) close(); else setOpen(true); }}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}
      >
        {lead}{Icon && <Icon size={16} aria-hidden className={busy ? 'spin' : undefined} />}{text && <span className="menu-trigger-text">{text}</span>}{trailing}
      </button>
      {open && createPortal(
        <div ref={panel} id={id} role="menu" aria-label={label} className="menu-panel" data-side={pos?.side ?? 'bottom'} style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? 'visible' : 'hidden' }} onKeyDown={onKey}>
          {items.map((item, index) => (
            <div key={`${item.label}-${index}`} role="none">
              {item.separator && index > 0 && <div className="menu-sep" role="separator" />}
              {item.heading && <div className="menu-heading">{item.heading}</div>}
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked === undefined ? undefined : item.checked}
                className={item.danger ? 'menu-item danger' : 'menu-item'}
                disabled={item.disabled}
                onClick={() => { if (!item.keepOpen) close(); item.onSelect?.(); }}
              >
                {item.icon ? <item.icon size={15} aria-hidden /> : <span className="menu-icon-gap" aria-hidden />}
                <span className="menu-label">{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
                {item.checked && <Check size={15} aria-label="current" className="menu-check" />}
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Vertical tabs with groups (Settings). The active tab follows the URL hash so links and Back work. */
export function useHashTab(ids: string[], fallback: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const hash = location.hash.slice(1);
  const tab = ids.includes(hash) ? hash : fallback;
  const select = (next: string) => { if (next !== tab) navigate({ hash: `#${next}` }); };
  return [tab, select] as const;
}
