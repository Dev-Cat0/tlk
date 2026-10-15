export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('실행 설정이 필요합니다.');
  const platform = input.platform ?? 'tlk';
  if (!['tlk', 'padlet'].includes(platform)) throw new Error('지원하지 않는 서비스입니다.');
  if (platform === 'padlet') {
    let boardId = String(input.boardId ?? '').trim();
    let boardUrl;
    if (/^https?:\/\//i.test(boardId)) {
      const url = new URL(boardId);
      if (url.protocol !== 'https:' || !/(^|\.)padlet\.(com|org)$/.test(url.hostname) || url.port || url.username || url.password) throw new Error('올바른 HTTPS 패들렛 보드 주소를 입력하세요.');
      const path = url.pathname.replace(/\/$/, '');
      boardId = path.split('/').at(-1).match(/(?:^|-)([a-zA-Z0-9_]{16,22})$/)?.[1] ?? '';
      boardUrl = `${url.origin}${path}`;
    }
    if (!/^[a-zA-Z0-9_]{16,22}$/.test(boardId)) throw new Error('패들렛 보드 ID 또는 ID가 포함된 보드 주소를 입력하세요. 맞춤 주소는 보드의 개발자 메뉴에서 ID를 확인하세요.');
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new Error('올바른 Padlet API 키를 입력하세요.');
    const subject = String(input.subject ?? '').trim();
    if (subject.length > 200) throw new Error('게시물 제목은 200자 이내로 입력하세요.');
    const sectionId = String(input.sectionId ?? '').trim();
    if (sectionId && !/^[a-zA-Z0-9_]{16,22}$/.test(sectionId)) throw new Error('올바른 패들렛 섹션 ID를 입력하세요.');
    const common = validateConfig({ ...input, platform: 'tlk', channel: boardId, botCount: 1, prefix: 'padlet' });
    return { ...common, platform, boardId, boardUrl: boardUrl ?? `https://padlet.com/${boardId}`, apiKey, subject, sectionId };
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
