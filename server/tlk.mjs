const BASE = 'https://tlk.io';

export function parseChannel(html) {
  const csrf = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i)?.[1];
  const chatId = html.match(/Talkio\.Variables\.chat_id\s*=\s*['"](\d+)['"]/)?.[1];
  const anonymous = html.match(/"allow_anonymous"\s*:\s*(true|false)/)?.[1];
  if (!csrf || !chatId || !anonymous) throw new Error('tlk.io 채널 형식을 확인할 수 없습니다. 서비스 변경 또는 접근 제한을 확인하세요.');
  if (anonymous !== 'true') throw new Error('이 채널은 익명 참가를 허용하지 않습니다.');
  return { csrf, chatId };
}

export class TlkSession {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl;
    this.cookies = new Map();
  }
  async request(path, { signal, json } = {}) {
    signal?.throwIfAborted();
    const response = await this.fetch(`${BASE}${path}`, {
      method: json ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
      headers: {
        Accept: json ? 'application/json' : 'text/html',
        'User-Agent': 'tlk-control/1.0',
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(json ? { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf, Origin: BASE, Referer: `${BASE}/${this.channel}` } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0];
      const split = pair.indexOf('=');
      if (split > 0) this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    if (!response.ok) {
      if (response.status === 429) throw new Error('tlk.io 전송 제한(429)으로 중지했습니다. 나중에 다시 실행하세요.');
      if ([401, 403, 422].includes(response.status)) throw new Error(`tlk.io가 요청을 거절했습니다 (${response.status}). 채널 권한 또는 서버 IP 제한을 확인하세요.`);
      throw new Error(`tlk.io 응답 오류 (${response.status}). 중복 전송 방지를 위해 자동 재시도하지 않습니다.`);
    }
    return response;
  }
  async join(channel, nickname, signal) {
    this.channel = channel;
    const page = await this.request(`/${encodeURIComponent(channel)}`, { signal });
    Object.assign(this, parseChannel(await page.text()));
    const response = await this.request('/api/participant', { signal, json: { nickname } });
    const user = await response.json();
    if (!user?.token || typeof user.nickname !== 'string') throw new Error('tlk.io 참가 응답을 확인하지 못했습니다.');
  }
  async send(body, signal) {
    const response = await this.request(`/api/chats/${this.chatId}/messages`, { signal, json: { body } });
    const message = await response.json();
    if (!message?.id) throw new Error('전송 결과를 확인하지 못했습니다. 중복 전송 방지를 위해 중지합니다.');
    return String(message.id);
  }
  close() { this.cookies.clear(); this.csrf = undefined; }
}
