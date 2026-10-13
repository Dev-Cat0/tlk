// Expand scientific notation without rounding away small decimal values.
export function decimalText(value) {
  const text = String(value);
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) return text;
  const [, sign, whole, fraction = '', exponent] = match;
  const digits = whole + fraction;
  if (!/[1-9]/.test(digits)) return '0';
  const point = whole.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function readNumericInput(text, kind) {
  text = text.trim();
  const value = Number(text);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(value)) {
    throw new Error('올바른 숫자를 입력하세요.');
  }
  if (kind === 'interval') {
    if (value < 0 || value > 3600) throw new Error('전송 간격은 0~3600초로 입력하세요.');
    if (value === 0 && /[1-9]/.test(text.split(/[eE]/)[0])) throw new Error('입력한 간격이 너무 작아 숫자로 표현할 수 없습니다.');
  } else {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('개수는 1~9007199254740991 사이의 정수로 입력하세요.');
    // Check the original decimal as well: Number() can round fractional counts.
    const expanded = decimalText(text);
    if (expanded.includes('.') && /[1-9]/.test(expanded.split('.')[1])) {
      throw new Error('개수는 1~9007199254740991 사이의 정수로 입력하세요.');
    }
  }
  return value;
}
