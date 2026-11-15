import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '../lib/api';
import { errorText, toast, type Toast } from '../lib/toast';
import { t } from '../i18n';

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const onToast = (event: Event) => {
      const item = (event as CustomEvent<Toast>).detail;
      setItems((rows) => [...rows.slice(-2), item]);
      setTimeout(() => setItems((rows) => rows.filter((row) => row.id !== item.id)), item.kind === 'error' ? 7000 : 3500);
    };
    // Failed API calls that nothing caught used to vanish. Show them instead.
    const onReject = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof ApiError || event.reason instanceof TypeError) {
        event.preventDefault();
        toast(event.reason instanceof TypeError ? t('The server did not answer. Check that it is running.') : errorText(event.reason), 'error');
      }
    };
    window.addEventListener('la-toast', onToast);
    window.addEventListener('unhandledrejection', onReject);
    return () => { window.removeEventListener('la-toast', onToast); window.removeEventListener('unhandledrejection', onReject); };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`}>
          <span>{item.text}</span>
          <button className="icon-btn" aria-label={t('Dismiss')} onClick={() => setItems((rows) => rows.filter((row) => row.id !== item.id))}><X size={16} /></button>
        </div>
      ))}
    </div>
  );
}
