const BASE = 'https://graph.instagram.com';
export const INSTAGRAM_API_VERSION = 'v25.0';

export class InstagramSession {
  constructor({ accountId, accessToken, fetchImpl = fetch }) {
    this.accountId = accountId;
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
  }
  async join(recipientId, _name, signal) {
    signal?.throwIfAborted();
    this.recipientId = recipientId;
  }
  async send(text, signal) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await this.fetch(`${BASE}/${INSTAGRAM_API_VERSION}/${this.accountId}/messages`, {
        method: 'POST', redirect: 'error',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: this.recipientId }, message: { text } }),
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error('Instagram 응답을 확인하지 못했습니다. DM에서 전송 여부를 확인하세요. 중복 전송 방지를 위해 자동 재시도하지 않습니다.');
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('Instagram 응답 형식을 확인하지 못했습니다. DM에서 전송 여부를 확인하세요.'); }
    // Do not forward upstream error strings: they may contain credentials or request data.
    if (!response.ok || data?.error) {
      const code = data?.error?.code;
      if (response.status === 429 || [4, 17, 32, 613].includes(code)) throw new Error('Instagram 전송 제한으로 중지했습니다. 나중에 다시 실행하세요.');
      if (response.status === 401 || code === 190) throw new Error('Instagram 액세스 토큰이 만료되었거나 유효하지 않습니다. 새 토큰을 입력하세요.');
      if (response.status === 403 || [10, 200, 551].includes(code)) throw new Error('Instagram이 DM을 허용하지 않았습니다. 메시지 권한·수신 대상·24시간 응답 가능 시간을 확인하세요.');
      throw new Error(`Instagram 전송 요청이 거절되었습니다 (HTTP ${response.status}). 계정 ID·수신자 IGSID·권한·응답 가능 시간을 확인하세요. 자동 재시도하지 않습니다.`);
    }
    if (typeof data?.message_id !== 'string' || !data.message_id || data.recipient_id !== this.recipientId) throw new Error('Instagram 전송 결과를 확인하지 못했습니다. DM에서 전송 여부를 확인하세요. 중복 전송 방지를 위해 중지합니다.');
    return data.message_id;
  }
  close() { this.accessToken = undefined; this.recipientId = undefined; }
}
