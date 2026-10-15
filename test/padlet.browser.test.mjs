import test from 'node:test';
import assert from 'node:assert/strict';
import { PadletSession, PadletBrowser } from '../server/padlet.mjs';

// Opt-in local fixture: no requests or posts are sent to Padlet.
const enabled = process.env.BROWSER_TESTS === '1';
const fixture = `<!doctype html><meta charset="utf-8"><button id="add">Add post</button><section id="posts"></section>
<div id="composer" hidden><input placeholder="Subject"><div role="textbox" contenteditable="true"></div><button id="publish">Publish</button></div>
<script>
document.querySelector('#add').onclick = () => document.querySelector('#composer').hidden = false;
document.querySelector('#publish').onclick = async () => {
  const title = document.querySelector('input').value;
  const text = document.querySelector('[contenteditable]').textContent;
  const response = await fetch('/fixture-posts', {method: 'POST', body: JSON.stringify({title, text})});
  if (!response.ok) return;
  document.querySelector('#composer').hidden = true;
  if (new URL(location.href).searchParams.has('unconfirmed')) return;
  const post = document.createElement('article');
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = text;
  post.append(h, p); document.querySelector('#posts').append(post);
};
</script>`;

// Observed on the live board: aria-labels override the visible Publish text,
// section buttons precede the main action, and the body is labeled Post body.
function currentFixture({ testIds = true, english = false } = {}) {
  return fixture
    .replace('<button id="add">Add post</button>', `<button>이 섹션에 게시 추가</button><button id="add" ${testIds ? 'data-testid="surfaceAddPostButton"' : ''} aria-label="${english ? 'Create a new post' : '새 게시 작성하기'}">+</button>`)
    .replace('<input placeholder="Subject">', '<textarea aria-label="게시물 제목" placeholder="제목"></textarea>')
    .replace('<div role="textbox" contenteditable="true">', '<div role="textbox" aria-label="Post body" contenteditable="true">')
    .replace('<button id="publish">Publish</button>', `<button id="publish" ${testIds ? 'data-testid="publishPostButton"' : ''} aria-label="${english ? 'Publish post' : '게시물 게시'}">게시</button>`)
    .replace("document.querySelector('input').value", "document.querySelector('textarea').value");
}

// Live guest flow: Publish opens a delayed name form while the composer stays
// visible. Done submits the original post, without another Publish click.
function guestFixture({ english = false, empty = false, stuck = false } = {}) {
  return currentFixture({ english }).replace('</script>', `
const submitPost = document.querySelector('#publish').onclick;
let named = false;
document.querySelector('#publish').onclick = () => {
  if (named) return submitPost();
  setTimeout(() => {
    const form = document.createElement('form');
    form.innerHTML = '<input data-testid="surfaceGuestIdModalUserNameInput" aria-label="${english ? 'Name' : '이름'}" value="${empty ? '' : '나뭇결달'}"><button>${english ? 'Done' : '완료'}</button>';
    form.onsubmit = event => {
      event.preventDefault();
      const input = form.querySelector('input');
      document.body.dataset.confirmedName = input.value;
      document.body.dataset.nameSubmits = Number(document.body.dataset.nameSubmits || 0) + 1;
      if (!input.value.trim() || ${stuck}) return;
      named = true; form.remove(); submitPost();
    };
    document.body.append(form);
  }, 250);
};
</script>`);
}

test('browser adapter fills, confirms, isolates guests, stops on 429 and rejects missing confirmation', { skip: !enabled }, async t => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const sent = [], contexts = [];
  let maxPages = 0, maxContexts = 0;
  const provider = { get: async () => ({ newContext: async options => {
    const context = await browser.newContext(options); contexts.push(context);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      maxPages = Math.max(maxPages, browser.contexts().reduce((n, context) => n + context.pages().length, 0));
      maxContexts = Math.max(maxContexts, browser.contexts().length);
      await page.route('**/*', async route => {
        if (route.request().method() === 'POST') {
          sent.push(JSON.parse(route.request().postData()));
          await route.fulfill({ status: new URL(page.url()).searchParams.has('rate') ? 429 : 200, body: '{}' });
        } else {
          const params = new URL(route.request().url()).searchParams;
          await route.fulfill({ status: params.has('denied') ? 403 : 200, contentType: 'text/html', body: params.has('guest') ? guestFixture({ english: params.has('english'), empty: params.has('empty'), stuck: params.has('stuck') }) : params.has('current') ? currentFixture({ testIds: !params.has('noids'), english: params.has('english') }) : params.has('readonly') ? '<h1>Read-only board</h1>' : fixture });
        }
      });
      return page;
    };
    return context;
  } }) };
  const first = new PadletSession({ browser: provider, subject: '제목', timeout: 10000 });
  const second = new PadletSession({ browser: provider, timeout: 10000 });
  await first.join('https://padlet.com/test/board');
  await second.join('https://padlet.com/test/board');
  await contexts[0].addCookies([{ name: 'guest', value: 'first', domain: 'padlet.com', path: '/' }]);
  assert.deepEqual(await contexts[1].cookies(), []);
  assert.equal(await first.send('내용'), '화면확인-1');
  assert.equal(await first.send('내용'), '화면확인-2');
  assert.deepEqual(sent.slice(0, 2), [{ title: '제목', text: '내용' }, { title: '제목', text: '내용' }]);
  await first.close(); await second.close();
  for (const query of ['current', 'current&english=1', 'current&noids=1', 'current&english=1&noids=1']) {
    await t.test(`current Padlet composer: ${query}`, async () => {
      const session = new PadletSession({ browser: provider, subject: '제목', timeout: 3000 });
      try {
        await session.join(`https://padlet.com/test/board?${query}`);
        assert.equal(await session.send('본문'), '화면확인-1');
        assert.deepEqual(sent.at(-1), { title: '제목', text: '본문' });
      } finally { await session.close(); }
    });
  }
  for (const [query, error] of [['denied', /HTTP 403/], ['readonly', /페이지는 열렸지만.*작성 버튼/]]) {
    const session = new PadletSession({ browser: provider, timeout: 300 });
    try { await assert.rejects(session.join(`https://padlet.com/test/board?${query}`), error); }
    finally { await session.close(); }
  }
  for (const query of ['guest', 'guest&english=1', 'guest&empty=1', 'guest&stuck=1']) {
    await t.test(`guest name confirmation: ${query}`, async () => {
      const progress = [];
      const session = new PadletSession({ browser: provider, subject: 'dd', timeout: 1500, readyTimeout: 1500, onProgress: step => progress.push(step) });
      const start = sent.length;
      try {
        await session.join(`https://padlet.com/test/board?${query}`);
        if (query.includes('stuck')) {
          await assert.rejects(session.send('dd'), /작성창 닫힘 확인.*중복 방지/);
          assert.equal(session.confirmed, 0);
          assert.equal(sent.length, start);
        } else {
          assert.equal(await session.send('dd'), '화면확인-1');
          assert.equal(sent.length, start + 1);
          assert.deepEqual(sent.at(-1), { title: 'dd', text: 'dd' });
          assert.equal(await session.page.locator('body').getAttribute('data-confirmed-name'), query.includes('empty') ? 'Guest' : '나뭇결달');
          // A subsequent post by the same guest skips the name form.
          assert.equal(await session.send('dd'), '화면확인-2');
          assert.equal(sent.length, start + 2);
        }
        assert.equal(await session.page.locator('body').getAttribute('data-name-submits'), '1');
        assert.equal(progress.filter(step => step === '게스트 이름 확인').length, 1);
      } finally { await session.close(); }
    });
  }
  const rate = new PadletSession({ browser: provider, timeout: 10000 });
  await rate.join('https://padlet.com/test/board?rate=1');
  await assert.rejects(rate.send('limited'), /전송 제한/);
  assert.equal(rate.confirmed, 0); await rate.close();
  const missing = new PadletSession({ browser: provider, timeout: 3000 });
  await missing.join('https://padlet.com/test/board?unconfirmed=1');
  await assert.rejects(missing.send('not visible'), /보드에 게시물 표시 확인.*중복 방지/);
  assert.equal(missing.confirmed, 0); await missing.close();
  await t.test('five isolated guests share one live page across queued sends', async () => {
    maxPages = 0;
    maxContexts = 0;
    const pooled = new PadletBrowser();
    pooled.get = provider.get;
    const sessions = Array.from({ length: 5 }, () => new PadletSession({ browser: pooled, timeout: 3000 }));
    try {
      for (const [index, session] of sessions.entries()) {
        await session.join('https://padlet.com/test/board?current');
        await session.context.addCookies([{ name: 'guest', value: String(index), domain: 'padlet.com', path: '/' }]);
      }
      assert.deepEqual(await Promise.all(sessions.map(session => session.send('queued body'))), Array(5).fill('화면확인-1'));
      assert.equal(maxPages, 1);
      assert.equal(maxContexts, 1);
      for (const [index, session] of sessions.entries()) {
        const cookies = session.context ? await session.context.cookies() : session.storageState.cookies;
        assert.equal(cookies.find(cookie => cookie.name === 'guest').value, String(index));
      }
    } finally { await Promise.all(sessions.map(session => session.close())); }
  });
});

test('slow board readiness has its own budget and skips only nonessential assets', { skip: !enabled }, async t => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const continued = [], aborted = [];
  const provider = { get: async () => ({ newContext: async options => {
    const context = await browser.newContext(options);
    const installRoute = context.route.bind(context);
    context.route = (pattern, handler) => installRoute(pattern, route => handler({
      request: () => route.request(),
      abort: async () => { aborted.push(route.request().resourceType()); await route.abort(); },
      continue: async () => {
        const type = route.request().resourceType(); continued.push(type);
        if (type === 'document') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><img src="/avatar.png"><script src="/app.js"></script>` });
        return route.fulfill({ contentType: 'application/javascript', body: `setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<button data-testid="surfaceAddPostButton">+</button>'); }, 200);` });
      }
    }));
    return context;
  } }) };
  const session = new PadletSession({ browser: provider, timeout: 50, readyTimeout: 2000 });
  t.after(() => session.close());
  await session.join('https://padlet.com/test/slow-board');
  assert.ok(continued.includes('document'));
  assert.ok(continued.includes('script'));
  assert.ok(aborted.includes('image'));
  assert.ok(!continued.includes('image'));
});
