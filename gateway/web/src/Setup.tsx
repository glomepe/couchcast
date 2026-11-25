import { ArrowLeft, Check, ExternalLink, Gamepad2, Link2, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type DiscoveredHost, type Status } from './api';
import { useI18n, type Lang } from './i18n';
import { Field, Segmented } from './ui';

// Assistant d'appairage : 1) identifiant PSN, 2) choix de la console et code de la PS5.
export function Setup({ status }: { status: Status }) {
  const { t, lang, setLang } = useI18n();
  const [step, setStep] = useState<'account' | 'console'>(status.hasAccountId ? 'console' : 'account');

  return (
    <main className="page setup">
      <header className="setup-head">
        <span className="brand big">
          <span className="brand-mark" />
          <span className="brand-name">couchcast</span>
        </span>
        <span className="spacer" />
        <Segmented<Lang> value={lang} onChange={setLang} items={[{ id: 'fr', label: 'FR' }, { id: 'en', label: 'EN' }]} />
      </header>
      <p className="lede">{t('setup.subtitle')}</p>
      <ol className="steps">
        <li className={step === 'account' ? 'is-active' : 'is-done'}>
          <span className="step-dot">{step === 'account' ? <UserRound size={14} /> : <Check size={14} />}</span>
          {t('setup.step.account')}
        </li>
        <li className={step === 'console' ? 'is-active' : ''}>
          <span className="step-dot">
            <Gamepad2 size={14} />
          </span>
          {t('setup.step.console')}
        </li>
      </ol>
      {step === 'account' ? <AccountStep onDone={() => setStep('console')} /> : <ConsoleStep onBack={() => setStep('account')} />}
    </main>
  );
}

function AccountStep({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [redirectUrl, setRedirectUrl] = useState('');
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const openLogin = async () => {
    const { url } = await api.loginUrl();
    window.open(url, '_blank', 'noopener');
  };

  const submit = async (input: { redirectUrl?: string; accountId?: string }) => {
    setBusy(true);
    setError('');
    try {
      await api.accountId(input);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <h2>{t('setup.account.title')}</h2>
      <p className="muted">{t('setup.account.text')}</p>
      <button className="btn primary" onClick={openLogin}>
        <ExternalLink size={16} /> {t('setup.account.open')}
      </button>
      <Field label={t('setup.account.url')}>
        <input className="mono" value={redirectUrl} onChange={(e) => setRedirectUrl(e.target.value)} placeholder="https://remoteplay.dl.playstation.net/remoteplay/redirect?code=…" />
      </Field>
      <button className="btn" disabled={!redirectUrl || busy} onClick={() => submit({ redirectUrl })}>
        <Link2 size={16} /> {busy ? t('setup.account.checking') : t('common.validate')}
      </button>
      <details>
        <summary>{t('setup.account.manual')}</summary>
        <div className="row">
          <input className="mono" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="AbCdEfGhIjk=" />
          <button className="btn" disabled={!manual || busy} onClick={() => submit({ accountId: manual })}>
            {t('setup.account.use')}
          </button>
        </div>
      </details>
      {error && <p className="error">{error}</p>}
      <p className="note">
        <ShieldCheck size={15} /> {t('setup.account.privacy')}
      </p>
    </section>
  );
}

function ConsoleStep({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<DiscoveredHost[] | null>(null);
  const [selected, setSelected] = useState<DiscoveredHost | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const scan = async () => {
    setHosts(null);
    setError('');
    try {
      const { hosts } = await api.discover();
      const ps5 = hosts.filter((h) => h.ps5);
      setHosts(ps5);
      if (ps5.length === 1) setSelected(ps5[0]);
    } catch (e) {
      setError((e as Error).message);
      setHosts([]);
    }
  };

  useEffect(() => {
    scan();
  }, []);

  const pair = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await api.pair(selected, pin);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <h2>{t('setup.console.title')}</h2>
      <div className="hosts">
        {hosts === null && (
          <p className="muted">
            <RefreshCw size={14} className="spin" /> {t('setup.console.searching')}
          </p>
        )}
        {hosts?.length === 0 && <p className="muted">{t('setup.console.none')}</p>}
        {hosts?.map((h) => (
          <button key={h.id || h.host} className={`host ${selected?.host === h.host ? 'is-active' : ''}`} onClick={() => setSelected(h)}>
            <Gamepad2 size={22} strokeWidth={1.6} />
            <span>
              <strong>{h.name}</strong>
              <small className="muted mono">
                {h.host} · {h.state === 'ready' ? t('setup.console.ready') : h.state === 'standby' ? t('setup.console.standby') : h.state}
              </small>
            </span>
            {selected?.host === h.host && <Check size={18} className="host-check" />}
          </button>
        ))}
        <button className="btn ghost small" onClick={scan}>
          <RefreshCw size={14} /> {t('setup.console.rescan')}
        </button>
      </div>

      {selected && (
        <>
          <p className="muted">{t('setup.console.howto')}</p>
          <div className="row">
            <input
              className="pin mono"
              inputMode="numeric"
              maxLength={9}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/[^0-9 ]/g, ''))}
              placeholder="1234 5678"
            />
            <button className="btn primary" disabled={pin.replace(/ /g, '').length !== 8 || busy} onClick={pair}>
              <Link2 size={16} /> {busy ? t('setup.console.pairing') : t('setup.console.pair')}
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn ghost small" onClick={onBack}>
        <ArrowLeft size={14} /> {t('setup.console.changeAccount')}
      </button>
    </section>
  );
}
