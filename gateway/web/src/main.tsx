import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStatus } from './api';
import { I18nProvider } from './i18n';
import { Library } from './Library';
import { Player } from './Player';
import { Remote } from './Remote';
import { Setup } from './Setup';
import { Toasts } from './studio/Controls';
import './styles.css';

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '');
}

function App() {
  const status = useStatus();
  const route = useHash();

  if (!status) {
    return (
      <div className="boot">
        <span className="brand big">
          <span className="brand-mark" />
          <span className="brand-name">couchcast</span>
        </span>
      </div>
    );
  }

  return (
    <I18nProvider serverLang={status.lang}>
      {route === 'obs' ? (
        <Player status={status} obs />
      ) : (
        <>
          {status.state === 'unpaired' ? (
            <Setup status={status} />
          ) : route === 'bibliotheque' ? (
            <Library status={status} />
          ) : route === 'telecommande' ? (
            <Remote status={status} />
          ) : (
            <Player status={status} />
          )}
          <Toasts status={status} />
        </>
      )}
    </I18nProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
