const BASE = 'https://api.padlet.dev/v1';

export class PadletSession {
  constructor({ apiKey, subject = '', sectionId = '', fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.subject = subject;
    this.sectionId = sectionId;
    this.fetch = fetchImpl;
  }
  async join(boardId, _name, signal) {
    signal?.throwIfAborted();
    this.boardId = boardId;
  }
  async send(text, signal) {
    signal?.throwIfAborted();
    const data = { type: 'post', attributes: { content: { body: text, ...(this.subject ? { subject: this.subject } : {}) } } };
    if (this.sectionId) data.relationships = { section: { data: { id: this.sectionId } } };
    let response;
    try {
      response = await this.fetch(`${BASE}/boards/${encodeURIComponent(this.boardId)}/posts`, {
        method: 'POST', redirect: 'error',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
        headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json' },
        body: JSON.stringify({ data }),
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error('패들렛 응답을 확인하지 못했습니다. 보드에서 게시 여부를 확인하세요. 중복 게시 방지를 위해 자동 재시도하지 않습니다.');
    }
    // Never expose upstream error bodies: they may echo credentials or request data.
    if (!response.ok) {
      if (response.status === 429) throw new Error('패들렛 전송 제한으로 중지했습니다. 나중에 다시 실행하세요.');
      if (response.status === 401) throw new Error('Padlet API 키가 유효하지 않습니다. 개발자 설정에서 키를 확인하세요.');
      if (response.status === 403) throw new Error('패들렛 게시 권한이 없습니다. 유료 계정과 보드 관리자 권한을 확인하세요.');
      if (response.status === 404) throw new Error('패들렛 보드 또는 섹션을 찾을 수 없습니다. ID와 접근 권한을 확인하세요.');
      throw new Error(`패들렛 게시 요청이 거절되었습니다 (HTTP ${response.status}). 보드·섹션·게시물 내용을 확인하세요. 자동 재시도하지 않습니다.`);
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('패들렛 응답 형식을 확인하지 못했습니다. 보드에서 게시 여부를 확인하세요. 자동 재시도하지 않습니다.'); }
    const post = result?.data;
    const board = post?.relationships?.board?.data?.id;
    if (result?.errors?.length || post?.type !== 'post' || typeof post.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(post.id) || (board && board !== this.boardId)) throw new Error('패들렛 게시 결과를 확인하지 못했습니다. 보드에서 게시 여부를 확인하세요. 중복 게시 방지를 위해 중지합니다.');
    return post.id;
  }
  close() { this.apiKey = undefined; this.boardId = undefined; }
}
