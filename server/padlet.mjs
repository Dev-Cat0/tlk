import { normalizePadletUrl } from './config.mjs';

// One browser per run; each bot has an isolated guest cookie jar.
export class PadletBrowser {
  // Only one live board page fits reliably on the 512 MiB runner. Queue work
  // while preserving each guest's cookies and local storage separately.
  async run(session, work, signal) {
    const previous = this.tail ?? Promise.resolve();
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      signal?.throwIfAborted();
      if (this.activeSession !== session) {
        await this.activeSession?.park();
        signal?.throwIfAborted();
        this.activeSession = session;
      }
      return await work();
    } finally { release(); }
  }
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
  constructor({ subject = '', browser, timeout = 30000, readyTimeout = timeout * 3, onProgress = () => {} }) {
    this.subject = subject;
    this.browser = browser;
    this.timeout = timeout;
    this.readyTimeout = readyTimeout;
    this.confirmed = 0;
    this.onProgress = onProgress;
  }
  async operation(signal, work, message) {
    signal?.throwIfAborted();
    const abort = () => { void this.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = this.browser.run ? await this.browser.run(this, work, signal) : await work();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (['BrowserSetupError', 'PadletAccessError'].includes(error.name)) throw error;
      throw new Error(this.blocked || (typeof message === 'function' ? message(error) : message), { cause: error });
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async join(boardUrl, _name, signal) {
    this.boardUrl = normalizePadletUrl(boardUrl);
    await this.operation(signal, () => this.open(signal), '익명 게시 화면을 열지 못했습니다. 링크·방문자 작성 권한·로그인 요구 여부를 확인하세요.');
  }
  async open(signal) {
      signal?.throwIfAborted();
      if (this.page && !this.page.isClosed()) return;
      const browser = await this.browser.get();
      signal?.throwIfAborted();
      if (!this.context) {
        this.context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, reducedMotion: 'reduce', storageState: this.storageState });
        signal?.throwIfAborted();
      await this.context.route('**/*', async route => {
        const request = route.request();
        // Text-only posting does not need board attachments, avatars or web fonts.
        // Keep scripts, styles and API requests so the normal composer still works.
        if (['image', 'media', 'font'].includes(request.resourceType())) {
          await route.abort(); return;
        }
        if (request.isNavigationRequest() && request.frame() === this.page?.mainFrame()) {
          try { normalizePadletUrl(request.url()); }
          catch { await route.abort(); return; }
        }
        await route.continue();
      });
      }
      this.page = await this.context.newPage();
      signal?.throwIfAborted();
      this.page.setDefaultTimeout(this.timeout);
      this.page.setDefaultNavigationTimeout(this.readyTimeout);
      const failures = { requests: 0, http: 0, crashed: false };
      this.page.on('crash', () => { failures.crashed = true; });
      this.page.on('requestfailed', request => {
        if (['document', 'script', 'xhr', 'fetch'].includes(request.resourceType())) failures.requests++;
      });
      this.page.on('response', response => {
        if (response.status() >= 400 && ['document', 'script', 'xhr', 'fetch'].includes(response.request().resourceType())) failures.http++;
        if (!['POST', 'PUT', 'PATCH'].includes(response.request().method())) return;
        if (!/(^|\.)padlet\.(com|org)$/.test(new URL(response.url()).hostname)) return;
        if (response.status() === 429) this.blocked = '패들렛 전송 제한으로 중지했습니다. 자동 재시도하지 않습니다.';
        if ([401, 403].includes(response.status())) this.blocked = '익명 게시 권한이 없거나 추가 인증이 필요합니다. 보드 설정을 확인하세요.';
        if (this.blocked) void this.close();
      });
      const response = await this.page.goto(this.boardUrl, { waitUntil: 'domcontentloaded' });
      if (!response?.ok()) {
        const status = response?.status();
        throw Object.assign(new Error(`패들렛 보드를 불러오지 못했습니다${status ? ` (HTTP ${status})` : ''}. 링크와 접근 권한을 확인하세요.`), { name: 'PadletAccessError' });
      }
      try { await this.postButton().waitFor({ state: 'visible', timeout: this.readyTimeout }); }
      catch (error) {
        if (this.blocked || signal?.aborted) throw error;
        const detail = failures.crashed ? '브라우저 페이지가 중단되었습니다. 서버 메모리를 확인하세요.' : `${this.readyTimeout / 1000}초 대기, 필수 요청 실패 ${failures.requests}건, HTTP 오류 ${failures.http}건. 서버 부하·방문자 작성 권한·로그인 요구를 확인하세요.`;
        throw Object.assign(new Error(`패들렛 페이지는 열렸지만 게시물 작성 버튼을 찾지 못했습니다. ${detail}`), { name: 'PadletAccessError', cause: error });
      }
  }
  async park() {
    if (!this.context) return;
    // Closing just the tab leaves renderer/cache allocations in its context.
    // Retain guest storage, then release the entire inactive context.
    this.storageState = await this.context.storageState({ indexedDB: true });
    await this.context.close();
    this.context = null;
    this.page = null;
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
    let stage = '게시 차례 대기', publishAttempted = false;
    const step = value => { stage = value; this.onProgress(value); };
    return this.operation(signal, async () => {
      if (this.blocked) throw new Error(this.blocked);
      step('보드 다시 열기');
      await this.open(signal);
      const visibleCopies = this.page.getByText(text, { exact: true }).filter({ visible: true });
      const before = await visibleCopies.count();
      step('작성창 열기');
      await this.postButton().click();
      const publish = this.publishButton();
      await publish.waitFor({ state: 'visible' });
      const title = this.page.getByPlaceholder(/^(Subject|Title|제목|주제)$/i).filter({ visible: true });
      step('제목 입력');
      if (this.subject) await title.fill(this.subject);
      step('본문 입력');
      const labeledBody = this.page.getByRole('textbox', { name: 'Post body', exact: true }).filter({ visible: true });
      const body = await labeledBody.count() ? labeledBody : this.page.locator('[contenteditable="true"][role="textbox"]:visible, [contenteditable="true"][data-placeholder]:visible');
      if (await body.count() === 1) await body.fill(text);
      else await this.page.getByPlaceholder(/Write something|내용|본문|무언가|멋진/i).filter({ visible: true }).fill(text);
      signal?.throwIfAborted();
      step('게시 버튼 클릭');
      publishAttempted = true;
      await publish.click();
      step('작성창 닫힘 확인');
      // First-time guests must confirm Padlet's generated display name before
      // the pending post is submitted. The modal can appear asynchronously.
      const guestName = this.page.getByTestId('surfaceGuestIdModalUserNameInput');
      const next = await Promise.race([
        publish.waitFor({ state: 'hidden', timeout: this.readyTimeout }).then(() => 'published'),
        guestName.waitFor({ state: 'visible', timeout: this.readyTimeout }).then(() => 'guest-name')
      ]);
      if (next === 'guest-name') {
        signal?.throwIfAborted();
        step('게스트 이름 확인');
        // Keep the suggested anonymous name; never use a real account identity.
        if (!(await guestName.inputValue()).trim()) await guestName.fill('Guest');
        await this.page.locator('form').filter({ has: guestName })
          .getByRole('button', { name: /^(Done|완료)$/i }).click();
        step('작성창 닫힘 확인');
        await publish.waitFor({ state: 'hidden', timeout: this.readyTimeout });
      }
      // Closing the editor alone is not confirmation; new content must appear.
      step('보드에 게시물 표시 확인');
      await visibleCopies.nth(before).waitFor({ state: 'visible' });
      if (this.blocked) throw new Error(this.blocked);
      return `화면확인-${++this.confirmed}`;
    }, error => `${stage} 단계에서 ${error.name === 'TimeoutError' ? '대기 시간이 초과되었습니다' : '오류가 발생했습니다'}. ${publishAttempted ? '게시 요청이 전달됐을 수 있으므로 보드에서 확인하세요. 중복 방지를 위해 자동 재시도하지 않습니다.' : '게시 버튼을 누르기 전에 중지했습니다.'}`);
  }
  async close() {
    if (!this.context) return;
    this.closing ??= this.context.close().catch(() => {});
    await this.closing;
  }
}
