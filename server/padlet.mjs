import { normalizePadletUrl } from './config.mjs';

// One browser per run; each bot has an isolated guest cookie jar.
export class PadletBrowser {
  async get() {
    this.pending ??= import('playwright').then(({ chromium }) => chromium.launch({ headless: true }));
    try { return await this.pending; }
    catch { throw Object.assign(new Error('패들렛 브라우저를 시작하지 못했습니다. 실행기에서 npm ci 및 npx playwright install chromium을 실행하세요.'), { name: 'BrowserSetupError' }); }
  }
  async close() {
    if (this.pending) await this.pending.then(browser => browser.close()).catch(() => {});
  }
}

export class PadletSession {
  constructor({ subject = '', browser, timeout = 15000 }) {
    this.subject = subject;
    this.browser = browser;
    this.timeout = timeout;
    this.confirmed = 0;
  }
  async operation(signal, work, message) {
    signal?.throwIfAborted();
    const abort = () => { void this.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await work();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (['BrowserSetupError', 'PadletAccessError'].includes(error.name)) throw error;
      throw new Error(this.blocked || message, { cause: error });
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async join(boardUrl, _name, signal) {
    boardUrl = normalizePadletUrl(boardUrl);
    await this.operation(signal, async () => {
      const browser = await this.browser.get();
      signal?.throwIfAborted();
      this.context = await browser.newContext({ locale: 'en-US', acceptDownloads: false });
      signal?.throwIfAborted();
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(this.timeout);
      this.page.setDefaultNavigationTimeout(45000);
      await this.context.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) {
          try { normalizePadletUrl(request.url()); }
          catch { await route.abort(); return; }
        }
        await route.continue();
      });
      this.page.on('response', response => {
        if (!['POST', 'PUT', 'PATCH'].includes(response.request().method())) return;
        if (!/(^|\.)padlet\.(com|org)$/.test(new URL(response.url()).hostname)) return;
        if (response.status() === 429) this.blocked = '패들렛 전송 제한으로 중지했습니다. 자동 재시도하지 않습니다.';
        if ([401, 403].includes(response.status())) this.blocked = '익명 게시 권한이 없거나 추가 인증이 필요합니다. 보드 설정을 확인하세요.';
        if (this.blocked) void this.close();
      });
      const response = await this.page.goto(boardUrl, { waitUntil: 'domcontentloaded' });
      if (!response?.ok()) {
        const status = response?.status();
        throw Object.assign(new Error(`패들렛 보드를 불러오지 못했습니다${status ? ` (HTTP ${status})` : ''}. 링크와 접근 권한을 확인하세요.`), { name: 'PadletAccessError' });
      }
      try { await this.postButton().waitFor({ state: 'visible' }); }
      catch (error) {
        if (this.blocked || signal?.aborted) throw error;
        throw Object.assign(new Error('패들렛 페이지는 열렸지만 게시물 작성 버튼을 찾지 못했습니다. 방문자 작성 권한·로그인 요구·페이지 로딩 상태를 확인하세요.'), { name: 'PadletAccessError', cause: error });
      }
    }, '익명 게시 화면을 열지 못했습니다. 링크·방문자 작성 권한·로그인 요구 여부를 확인하세요.');
  }
  postButton() {
    // Padlet's current accessible names differ from the visible button text.
    // Its test IDs also work across board languages and section layouts.
    return this.page.getByTestId('surfaceAddPostButton').or(
      this.page.getByRole('button', { name: /^(?:\+\s*)?(?:Add (?:a )?post|Post|New post|(?:Create|Write) (?:a )?new post|게시물 추가|게시물 작성|새 게시물|새 게시 작성하기)(?:\s*\(.*\))?$/i })
    ).filter({ visible: true }).first();
  }
  publishButton() {
    return this.page.getByTestId('publishPostButton').or(
      this.page.getByRole('button', { name: /^(?:Publish(?: post)?|게시|게시하기|게시물 게시|발행)$/i })
    ).filter({ visible: true }).first();
  }
  async send(text, signal) {
    return this.operation(signal, async () => {
      if (this.blocked) throw new Error(this.blocked);
      const visibleCopies = this.page.getByText(text, { exact: true }).filter({ visible: true });
      const before = await visibleCopies.count();
      await this.postButton().click();
      const publish = this.publishButton();
      await publish.waitFor({ state: 'visible' });
      const title = this.page.getByPlaceholder(/^(Subject|Title|제목|주제)$/i).filter({ visible: true });
      if (this.subject) await title.fill(this.subject);
      const labeledBody = this.page.getByRole('textbox', { name: 'Post body', exact: true }).filter({ visible: true });
      const body = await labeledBody.count() ? labeledBody : this.page.locator('[contenteditable="true"][role="textbox"]:visible, [contenteditable="true"][data-placeholder]:visible');
      if (await body.count() === 1) await body.fill(text);
      else await this.page.getByPlaceholder(/Write something|내용|본문|무언가|멋진/i).filter({ visible: true }).fill(text);
      signal?.throwIfAborted();
      await publish.click();
      await publish.waitFor({ state: 'hidden' });
      // Closing the editor alone is not confirmation; new content must appear.
      await visibleCopies.nth(before).waitFor({ state: 'visible' });
      if (this.blocked) throw new Error(this.blocked);
      return `화면확인-${++this.confirmed}`;
    }, '게시 완료를 화면에서 확인하지 못했습니다. 보드에서 게시 여부를 확인하세요. 화면 변경·승인 대기·추가 인증일 수 있으며 중복 방지를 위해 자동 재시도하지 않습니다.');
  }
  async close() {
    if (!this.context) return;
    this.closing ??= this.context.close().catch(() => {});
    await this.closing;
  }
}
