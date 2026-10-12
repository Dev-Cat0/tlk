const $ = id => document.getElementById(id);
const activeStates = new Set(['starting', 'running', 'stopping']);
const labels = { starting: '연결 중', running: '전송 중', stopping: '중지 중', stopped: '중지됨', failed: '오류', completed: '완료' };
let serverUrl = '';
let job = null;
let connected = false;
let pollTimer;
let polling = false;
let busy = false;
let generation = 0;
let logSignature = '';

const defaultServerUrl = 'https://tlk-runner.onrender.com';
$('server-url').value = defaultServerUrl;
try { $('server-url').value = localStorage.getItem('tlk-server-url') || defaultServerUrl; } catch {}

function showError(id, error) { $(id).textContent = error?.message || ''; $(id).hidden = !error; }
function openSettings() { if (!$('settings').open) $('settings').showModal(); }
$('settings-open').onclick = openSettings;
$('guide-open').onclick = openSettings;
$('settings-close').onclick = () => $('settings').close();

function connectionState(ok) {
  connected = ok;
  $('connection').classList.toggle('connected', ok);
  $('connection').replaceChildren(Object.assign(document.createElement('i'), {}), document.createTextNode(ok ? '서버 연결됨' : '서버 연결 전'));
  $('stale-note').hidden = ok || !job || !activeStates.has(job.status);
  updateControls();
}
function updateControls() {
  const active = job && activeStates.has(job.status);
  $('config-fields').disabled = Boolean(active) || busy;
  $('start').disabled = Boolean(active) || busy;
  $('stop').disabled = !connected || !active || job.status === 'stopping' || busy;
  $('download-log').disabled = !job?.logs?.length;
}
function readConfig() {
  return { channel: $('channel').value.trim(), botCount: Number($('bot-count').value), prefix: $('prefix').value.trim(), message: $('message').value.trim(), interval: Number($('interval').value), limit: Number($('limit').value) };
}
function updateSummary() {
  const config = readConfig();
  $('char-count').textContent = `${$('message').value.length.toLocaleString('ko-KR')} / 1,000`;
  $('summary').textContent = `봇 ${config.botCount || '—'}개가 각각 ${$('interval').value === '' ? '—' : config.interval}초 간격으로 합계 ${config.limit || '—'}건 전송`;
}
$('run-form').addEventListener('input', updateSummary);
document.querySelectorAll('[data-step]').forEach(button => { button.onclick = () => { $('bot-count').value = Math.min(5, Math.max(1, Number($('bot-count').value) + Number(button.dataset.step))); updateSummary(); }; });

async function request(path, { method = 'GET', body, url = serverUrl, timeout = 20000 } = {}) {
  let response;
  try {
    response = await fetch(`${url}${path}`, { method, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeout), headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new Error('서버에 연결할 수 없습니다. 주소·서버 상태·허용 도메인을 확인하세요. Render 무료 서버가 잠들었다면 잠시 후 다시 연결하세요.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('서버가 올바른 응답을 반환하지 않았습니다. 서버 기동이 끝난 뒤 다시 연결하세요.'); }
  if (!response.ok) throw new Error(data.error || `서버 오류 (${response.status})`);
  if (!data || !Object.hasOwn(data, 'job')) throw new Error('tlk 실행기 서버인지 확인하세요.');
  return data;
}

$('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  showError('connection-error', null);
  let url;
  try {
    url = new URL($('server-url').value.trim());
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('경로 없이 서버 기본 주소를 입력하세요.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPS 서버 주소가 필요합니다.');
  } catch (error) { showError('connection-error', error); return; }
  $('connect').disabled = true;
  $('connect').textContent = '서버 응답 기다리는 중…';
  try {
    const result = await request('/api/status', { url: url.origin, timeout: 65000 });
    generation++;
    serverUrl = url.origin;
    try { localStorage.setItem('tlk-server-url', serverUrl); } catch {}
    connectionState(true);
    render(result.job);
    $('settings').close();
    schedulePoll();
  } catch (error) { showError('connection-error', error); }
  finally { $('connect').disabled = false; $('connect').textContent = '서버 연결 확인 →'; }
});

function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 2500); }
async function poll() {
  if (polling || !serverUrl || busy) { schedulePoll(); return; }
  polling = true;
  const version = generation;
  try {
    const result = await request('/api/status');
    if (version === generation) { connectionState(true); render(result.job); }
  } catch {
    if (version === generation) connectionState(false);
  } finally { polling = false; schedulePoll(); }
}

$('run-form').addEventListener('submit', async event => {
  event.preventDefault();
  showError('form-error', null);
  if (!connected) { openSettings(); return; }
  if (busy || activeStates.has(job?.status)) return;
  busy = true; generation++; updateControls();
  try { const result = await request('/api/start', { method: 'POST', body: readConfig() }); render(result.job); }
  catch (error) { showError('form-error', error); connectionState(false); }
  finally { busy = false; updateControls(); schedulePoll(); }
});
$('stop').onclick = async () => {
  busy = true; generation++; updateControls(); showError('form-error', null);
  try { const result = await request('/api/stop', { method: 'POST' }); render(result.job); }
  catch (error) { showError('form-error', error); connectionState(false); }
  finally { busy = false; updateControls(); schedulePoll(); }
};

function setMetric(id, value, unit) {
  const small = document.createElement('small'); small.textContent = unit;
  $(id).replaceChildren(document.createTextNode(String(value)), small);
}
function render(nextJob) {
  const changed = job?.id !== nextJob?.id;
  job = nextJob;
  $('job-status').textContent = job ? labels[job.status] || job.status : '대기 중';
  $('job-status').className = `pill ${job?.status || ''}`;
  setMetric('sent', job?.sent || 0, '건');
  setMetric('active-bots', job?.bots?.length || 0, '개');
  const progress = job ? Math.min(100, Math.round(job.sent / job.config.limit * 100)) : 0;
  $('progress').style.width = `${progress}%`;
  $('progress').parentElement.setAttribute('aria-valuenow', String(progress));
  $('run-detail').textContent = job ? `#${job.config.channel} · ${job.sent} / ${job.config.limit}건` : '실행을 시작하면 여기에 표시됩니다.';
  $('channel-link').hidden = !job;
  if (job) $('channel-link').href = `https://tlk.io/${encodeURIComponent(job.config.channel)}`;
  if (changed && job && activeStates.has(job.status)) {
    for (const [id, key] of [['channel', 'channel'], ['bot-count', 'botCount'], ['prefix', 'prefix'], ['message', 'message'], ['interval', 'interval'], ['limit', 'limit']]) $(id).value = job.config[key];
    updateSummary();
  }
  $('bots').replaceChildren(...(job?.bots || []).map(bot => { const element = document.createElement('span'); element.className = 'bot-chip'; element.textContent = `${bot.name} · ${bot.sent}건`; return element; }));
  const signature = `${job?.id}:${job?.logs?.at(-1)?.id}`;
  if (signature !== logSignature) {
    logSignature = signature;
    if (job?.logs?.length) {
      const log = $('log');
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      log.replaceChildren(...job.logs.map(entry => {
        const line = document.createElement('div'); line.className = `log-entry ${entry.level}`;
        const time = document.createElement('time'); time.dateTime = entry.at; time.textContent = new Date(entry.at).toLocaleTimeString('ko-KR', { hour12: false });
        const text = document.createElement('span'); text.textContent = entry.text; line.append(time, text); return line;
      }));
      if (atBottom || changed) log.scrollTop = log.scrollHeight;
    } else {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      const title = document.createElement('p'); title.textContent = '아직 조용하네요.';
      const hint = document.createElement('span'); hint.textContent = '봇을 시작하면 연결과 전송 기록이 쌓입니다.';
      empty.append(title, hint); $('log').replaceChildren(empty);
    }
  }
  updateCountdown(); updateControls();
}
function updateCountdown() {
  $('countdown').textContent = connected && job?.status === 'running' && job.nextAt ? `${Math.max(0, Math.ceil((new Date(job.nextAt) - Date.now()) / 1000))}s` : '—';
}
setInterval(updateCountdown, 500);
$('download-log').onclick = () => {
  if (!job) return;
  const contents = job.logs.map(entry => `${entry.at} [${entry.level}] ${entry.text}`).join('\n');
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `tlk-${job.config.channel}-${job.id.slice(0, 8)}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
updateSummary();
serverUrl = $('server-url').value;
poll();
