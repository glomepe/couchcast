import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** Touche de clavier stylisée. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Bouton icône avec info-bulle (libellé + raccourci éventuel). */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  active,
  tone,
  className = '',
  ...rest
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  tone?: 'danger';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`icon-btn ${active ? 'is-active' : ''} ${tone ? `tone-${tone}` : ''} ${className}`}
      aria-label={label}
      aria-pressed={active}
      {...rest}
    >
      <Icon size={18} strokeWidth={1.8} />
      <span className="tip" role="tooltip">
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </span>
    </button>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: Array<{ id: T; label: string; icon: LucideIcon }>;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map(({ id, label, icon: Icon }) => (
        <button key={id} role="tab" aria-selected={value === id} className={value === id ? 'is-active' : ''} onClick={() => onChange(id)}>
          <Icon size={15} strokeWidth={1.9} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: Array<{ id: T; label: string; icon?: LucideIcon }>;
}) {
  return (
    <div className="segmented">
      {items.map(({ id, label, icon: Icon }) => (
        <button key={String(id)} className={value === id ? 'is-active' : ''} onClick={() => onChange(id)}>
          {Icon && <Icon size={14} strokeWidth={1.9} />}
          {label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span className="toggle-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}
