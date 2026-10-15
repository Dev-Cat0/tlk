import test from 'node:test';
import assert from 'node:assert/strict';
import { PadletSession } from '../server/padlet.mjs';

// Opt-in local fixture: no requests or posts are sent to Padlet.
const enabled = process.env.BROWSER_TESTS === '1';
const fixture = `<!doctype html><button id="add">Add post</button><section id="posts"></section>
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

test('browser adapter fills, confirms, isolates guests, stops on 429 and rejects missing confirmation', { skip: !enabled }, async t => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const sent = [], contexts = [];
  const provider = { get: async () => ({ newContext: async options => {
    const context = await browser.newContext(options); contexts.push(context);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await page.route('**/*', async route => {
        if (route.request().method() === 'POST') {
          sent.push(JSON.parse(route.request().postData()));
          await route.fulfill({ status: new URL(page.url()).searchParams.has('rate') ? 429 : 200, body: '{}' });
        } else await route.fulfill({ contentType: 'text/html', body: fixture });
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
  const rate = new PadletSession({ browser: provider, timeout: 10000 });
  await rate.join('https://padlet.com/test/board?rate=1');
  await assert.rejects(rate.send('limited'), /전송 제한/);
  assert.equal(rate.confirmed, 0); await rate.close();
  const missing = new PadletSession({ browser: provider, timeout: 3000 });
  await missing.join('https://padlet.com/test/board?unconfirmed=1');
  await assert.rejects(missing.send('not visible'), /게시 완료/);
  assert.equal(missing.confirmed, 0); await missing.close();
});
