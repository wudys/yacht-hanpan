import '@/bootstrap/startup-failure.css';

import { translate } from '@/i18n';
import { readStoredLocale } from '@/runtime/preferences/preferences-store';

export function showStartupFailure(): () => void {
  const locale = readStoredLocale({ getItem: (key) => window.localStorage.getItem(key) });
  const notice = document.createElement('main');
  notice.dataset.startupFailure = '';
  notice.lang = locale;
  const heading = document.createElement('h1');
  heading.textContent = translate(locale, 'resource.failureTitle');
  const message = document.createElement('p');
  message.textContent = translate(locale, 'resource.failureMessage');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = translate(locale, 'common.refresh');
  refresh.addEventListener('click', () => window.location.reload());
  notice.append(heading, message, refresh);
  (document.querySelector('#root') ?? document.body).replaceChildren(notice);
  return () => notice.remove();
}
