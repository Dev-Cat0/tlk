export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('실행 설정이 필요합니다.');
  let channel = String(input.channel ?? '').trim();
  if (/^https?:\/\//i.test(channel)) {
    const url = new URL(channel);
    if (url.hostname !== 'tlk.io' || url.port || url.username || url.password || url.search || url.hash) throw new Error('tlk.io 채널 주소를 입력하세요.');
    channel = decodeURIComponent(url.pathname.replace(/^\//, '').replace(/\/$/, ''));
  }
  channel = channel.replace(/^#/, '');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(channel)) throw new Error('채널은 영문, 숫자, -와 _로 1~80자 입력하세요.');
  const integer = (key, min, max, label) => {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: ${min}~${max} 사이의 정수가 필요합니다.`);
    return value;
  };
  const botCount = integer('botCount', 1, 5, '봇 수');
  const interval = input.interval;
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0 || interval > 3600) throw new Error('전송 간격은 0~3600초 사이의 숫자로 입력하세요. 소수도 사용할 수 있습니다.');
  const limit = input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('총 전송 수는 1 이상의 안전한 정수로 입력하세요.');
  const message = String(input.message ?? '').trim();
  const prefix = String(input.prefix ?? 'notice-bot').trim();
  if (!message || message.length > 1000) throw new Error('메시지는 1~1,000자 입력하세요.');
  if (!/^[\p{L}\p{N}_-]{1,20}$/u.test(prefix)) throw new Error('봇 이름은 문자, 숫자, -와 _로 1~20자 입력하세요.');
  return { channel, botCount, interval, limit, message, prefix };
}
