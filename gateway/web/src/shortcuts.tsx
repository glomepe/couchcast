import { Keyboard, X } from 'lucide-react';
import { useEffect } from 'react';
import { useI18n } from './i18n';
import { Kbd } from './ui';

// Raccourcis de la fenêtre. Les mêmes définitions servent au gestionnaire et à l'aide.
export type ShortcutAction =
  | 'launch'
  | 'fullscreen'
  | 'mute'
  | 'clip30'
  | 'clip120'
  | 'record'
  | 'stats'
  | 'settings'
  | 'library'
  | 'gamepad'
  | 'stop'
  | 'help'
  | 'close';

export const SHORTCUTS: Array<{ action: ShortcutAction; keys: string[]; label: string; match: (e: KeyboardEvent) => boolean }> = [
  { action: 'launch', keys: ['Espace'], label: 'sc.launch', match: (e) => e.code === 'Space' },
  { action: 'fullscreen', keys: ['F'], label: 'sc.fullscreen', match: (e) => e.code === 'KeyF' && !e.shiftKey },
  { action: 'mute', keys: ['M'], label: 'sc.mute', match: (e) => e.code === 'KeyM' },
  { action: 'clip30', keys: ['C'], label: 'sc.clip30', match: (e) => e.code === 'KeyC' && !e.shiftKey },
  { action: 'clip120', keys: ['⇧', 'C'], label: 'sc.clip120', match: (e) => e.code === 'KeyC' && e.shiftKey },
  { action: 'record', keys: ['R'], label: 'sc.record', match: (e) => e.code === 'KeyR' },
  { action: 'stats', keys: ['T'], label: 'sc.stats', match: (e) => e.code === 'KeyT' },
  { action: 'settings', keys: [','], label: 'sc.settings', match: (e) => e.key === ',' },
  { action: 'library', keys: ['L'], label: 'sc.library', match: (e) => e.code === 'KeyL' },
  { action: 'gamepad', keys: ['G'], label: 'sc.gamepad', match: (e) => e.code === 'KeyG' },
  { action: 'stop', keys: ['⇧', 'X'], label: 'sc.stop', match: (e) => e.code === 'KeyX' && e.shiftKey },
  { action: 'help', keys: ['?'], label: 'sc.help', match: (e) => e.key === '?' },
  { action: 'close', keys: ['Échap'], label: 'sc.close', match: (e) => e.key === 'Escape' },
];

export const GLOBAL_SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['⌃', '⌥', 'C'], label: 'sc.clip30' },
  { keys: ['⌃', '⌥', '⇧', 'C'], label: 'sc.clip120' },
  { keys: ['⌃', '⌥', 'R'], label: 'sc.record' },
  { keys: ['⌃', '⌥', 'S'], label: 'sc.show' },
];

export function shortcutKeys(action: ShortcutAction): string {
  return SHORTCUTS.find((s) => s.action === action)?.keys.join(' ') ?? '';
}

/** Écoute les raccourcis de la fenêtre (ignorés pendant la saisie dans un champ). */
export function useShortcuts(handler: (action: ShortcutAction) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable]')) {
        if (e.key === 'Escape') el.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const sc = SHORTCUTS.find((s) => s.match(e));
      if (sc) {
        e.preventDefault();
        handler(sc.action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handler]);
}

export function ShortcutList() {
  const { t, lang } = useI18n();
  const key = (k: string) => (lang === 'en' ? ({ Espace: 'Space', 'Échap': 'Esc' } as Record<string, string>)[k] ?? k : k);
  return (
    <div className="shortcut-cols">
      <section>
        <h4>{t('sc.inApp')}</h4>
        <ul className="shortcut-list">
          {SHORTCUTS.map((s) => (
            <li key={s.action}>
              <span>{t(s.label as never)}</span>
              <span className="keys">
                {s.keys.map((k) => (
                  <Kbd key={k}>{key(k)}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>{t('sc.global')}</h4>
        <ul className="shortcut-list">
          {GLOBAL_SHORTCUTS.map((s) => (
            <li key={s.label}>
              <span>{t(s.label as never)}</span>
              <span className="keys">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet help" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <Keyboard size={18} />
          <h2>{t('sc.title')}</h2>
          <span className="spacer" />
          <button className="icon-btn plain" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </header>
        <ShortcutList />
      </div>
    </div>
  );
}
