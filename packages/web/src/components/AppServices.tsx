import { useEffect, useRef, useState } from 'react';
import { Download, Play, ScanText, Square, Volume2 } from 'lucide-react';
import { api, post } from '../lib/api';
import { errorText, toast } from '../lib/toast';
import { t, tMaybe } from '../i18n';

interface Service { id: 'ocr' | 'piper'; title: string; detail: string; image: string; port: number; downloaded: boolean; container: { state: string; status: string } | null; healthy: boolean }
interface Job { id: string; status: string; output: string }

/**
 * local-agent's own helper containers (OCR, Piper voices), built from Dockerfiles shipped in the app.
 * Download ahead builds the image; Start runs it; the job log streams live underneath.
 */
export function AppServices({ onChange }: { onChange?: () => void }) {
  const [services, setServices] = useState<Service[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const timers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const load = () => api<{ services: Service[] }>('/api/services').then((data) => setServices(data.services)).catch(() => undefined);
  useEffect(() => { void load(); const all = timers.current; return () => Object.values(all).forEach(clearInterval); }, []);

  const run = async (service: Service, action: 'download' | 'start' | 'stop') => {
    try {
      const { job } = await post<{ job: Job }>(`/api/services/${service.id}/${action}`, {});
      setJobs((rows) => ({ ...rows, [service.id]: job }));
      clearInterval(timers.current[service.id]);
      timers.current[service.id] = setInterval(async () => {
        const data = await api<{ job: Job }>(`/api/jobs/${job.id}`).catch(() => null);
        if (!data) return;
        setJobs((rows) => ({ ...rows, [service.id]: data.job }));
        if (data.job.status !== 'running') {
          clearInterval(timers.current[service.id]);
          await load(); onChange?.();
          toast(data.job.status === 'completed' ? t('{0}: done.', [tMaybe(service.title)]) : t('{0}: failed. See the log.', [tMaybe(service.title)]), data.job.status === 'completed' ? 'ok' : 'error');
        }
      }, 1200);
    } catch (error) { toast(errorText(error), 'error'); }
  };

  if (!services.length) return null;
  return (
    <section className="card app-services">
      <h3>{t('App services')}</h3>
      <p className="faint">{t('Built on this machine from the app’s own Dockerfiles; nothing third-party to trust. Download ahead so they start offline later.')}</p>
      {services.map((service) => {
        const job = jobs[service.id];
        const running = service.container?.state === 'running';
        const state = service.healthy ? t('Running') : running ? t('Starting…') : service.downloaded ? t('Downloaded, stopped') : t('Not downloaded');
        return (
          <div key={service.id} className="service-row" data-service={service.id}>
            <span className="service-icon" aria-hidden>{service.id === 'ocr' ? <ScanText size={18} /> : <Volume2 size={18} />}</span>
            <div className="grow">
              <strong>{tMaybe(service.title)}</strong>
              <p className="faint">{tMaybe(service.detail)} <span className="mono">{service.image} · 127.0.0.1:{service.port}</span></p>
              <span className={`svc-state ${service.healthy ? 'ok' : running ? 'warn' : ''}`} data-state={service.healthy ? 'healthy' : running ? 'starting' : service.downloaded ? 'stopped' : 'missing'}>{state}</span>
            </div>
            <div className="row">
              {!service.downloaded && <button className="btn small" disabled={job?.status === 'running'} onClick={() => void run(service, 'download')}><Download size={14} /> {t('Download')}</button>}
              {!running && <button className="btn small primary" disabled={job?.status === 'running'} onClick={() => void run(service, 'start')}><Play size={14} /> {t('Start')}</button>}
              {running && <button className="btn small ghost" disabled={job?.status === 'running'} onClick={() => void run(service, 'stop')}><Square size={14} /> {t('Stop')}</button>}
            </div>
            {job && <pre className="mono job-log" aria-live="polite">{job.output.split('\n').slice(-8).join('\n') || t('Working…')}</pre>}
          </div>
        );
      })}
    </section>
  );
}
