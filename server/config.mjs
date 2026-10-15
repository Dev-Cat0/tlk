export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('실행 설정이 필요합니다.');
  const platform = input.platform ?? 'tlk';
  if (!['tlk', 'padlet'].includes(platform)) throw new Error('지원하지 않는 서비스입니다.');
  if (platform === 'padlet') {
    if (input.checkOnly !== undefined && typeof input.checkOnly !== 'boolean') throw new Error('연결 검사 설정은 true 또는 false여야 합니다.');
    const boardUrl = normalizePadletUrl(input.boardUrl ?? input.boardId);
    const boardId = new URL(boardUrl).pathname.split('/').filter(Boolean).at(-1);
    const subject = String(input.subject ?? '').trim();
    if (subject.length > 200) throw new Error('게시물 제목은 200자 이내로 입력하세요.');
    const common = validateConfig({ ...input, platform: 'tlk', channel: 'padlet', prefix: 'guest' });
    return { ...common, platform, boardId, boardUrl, subject, checkOnly: input.checkOnly === true };
  }
  let channel = String(input.channel ?? '').trim();
  if (/^https?:\/\//i.test(channel)) {
    const url = new URL(channel);
    if (url.hostname !== 'tlk.io' || url.port || url.username || url.password || url.search || url.hash) throw new Error('tlk.io 채널 주소를 입력하세요.');
    channel = decodeURIComponent(url.pathname.replace(/^\//, '').replace(/\/$/, ''));
  }
  channel = channel.replace(/^#/, '');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(channel)) throw new Error('채널은 영문, 숫자, -와 _로 1~80자 입력하세요.');
  const botCount = input.botCount;
  if (!Number.isSafeInteger(botCount) || botCount < 1) throw new Error('봇 수는 1 이상의 안전한 정수로 입력하세요.');
  const interval = input.interval;
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0 || interval > 3600) throw new Error('전송 간격은 0~3600초 사이의 숫자로 입력하세요. 소수도 사용할 수 있습니다.');
  const limit = input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('총 전송 수는 1 이상의 안전한 정수로 입력하세요.');
  const message = String(input.message ?? '').trim();
  const prefix = String(input.prefix ?? 'notice-bot').trim();
  if (!message || message.length > 1000) throw new Error('메시지는 1~1,000자 입력하세요.');
  if (!/^[\p{L}\p{N}_-]{1,20}$/u.test(prefix)) throw new Error('봇 이름은 문자, 숫자, -와 _로 1~20자 입력하세요.');
  return { platform, channel, botCount, interval, limit, message, prefix };
}

export function normalizePadletUrl(value) {
  const text = String(value ?? '').trim();
  let url;
  try { url = new URL(text); } catch { throw new Error('https://padlet.com/… 형식의 보드 링크를 입력하세요.'); }
  if (url.protocol !== 'https:' || !/(^|\.)padlet\.(com|org)$/.test(url.hostname) || url.port || url.username || url.password || url.pathname === '/') throw new Error('올바른 HTTPS 패들렛 보드 링크를 입력하세요.');
  url.hash = '';
  return url.href;
}
