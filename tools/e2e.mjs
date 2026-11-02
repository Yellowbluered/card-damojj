// 端到端測試：用真實 Chrome 開兩個「裝置」，驗證跨頁同步、刪除同步、無 JS 錯誤
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const API = 'http://127.0.0.1:8787/exec?k=test';
const WEB = 'http://127.0.0.1:8788';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; }

  static async open(url) {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: 'PUT' });
    const info = await res.json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    const page = new Page(ws);
    await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err; });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && page.pending.has(msg.id)) {
        const { resolve, reject } = page.pending.get(msg.id);
        page.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        page.errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        page.errors.push((msg.params.entry.url || '') + ' ' + msg.params.entry.text);
      }
    };
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    if (url) await page.goto(url);
    return page;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 20000);
    });
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 120; i++) {
      await sleep(150);
      try {
        const ready = await this.eval('document.readyState');
        if (ready === 'complete') return;
      } catch { /* 載入中 */ }
    }
    throw new Error('頁面載入超時: ' + url);
  }

  async activate() {
    try { await this.send('Page.bringToFront'); } catch { }
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval 失敗: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { } }
}

function assert(cond, msg) {
  if (!cond) throw new Error('❌ 斷言失敗：' + msg);
  console.log('  ✓ ' + msg);
}

async function waitFor(page, expr, expect, label, tries = 15) {
  let last;
  for (let i = 0; i < tries; i++) {
    await sleep(1000);
    last = await page.eval(expr);
    if (last === expect) { assert(true, label); return last; }
  }
  assert(false, label + `（等了 ${tries}s，最後 = ${last}）`);
}

async function main() {
  await import('./mock-server.mjs');
  await sleep(400);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardpool-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/json/version`); up = true; break; } catch { await sleep(250); }
    }
    if (!up) throw new Error('Chrome 遠端除錯埠未啟動');

    const url = `${WEB}/index.html#db=${encodeURIComponent(API)}`;

    console.log('\n[1] 開啟裝置 A（電腦）');
    const A = await Page.open(url);
    await sleep(1200);
    const cfgA = await A.eval('localStorage.getItem("cardpool_cfg_v1")');
    assert(cfgA && cfgA.includes('8787'), '裝置 A 已由分享連結自動設定雲端網址');
    assert((await A.eval('location.hash')) === '', '網址列嘅 #db 已清理');

    console.log('\n[2] 裝置 A 登記 6 人各 ¥1000 入金');
    await A.eval(`(function(){
      document.getElementById('dep-amount').value = '1000';
      document.getElementById('form-deposit').requestSubmit();
      return true;
    })()`);
    await sleep(1500);
    const rowsA = await A.eval('document.querySelectorAll("#deposit-rows tr").length');
    assert(rowsA === 6, `裝置 A 顯示 6 筆入金（實際 ${rowsA}）`);
    const totalA = await A.eval('document.getElementById("stat-deposit").textContent');
    assert(totalA.replace(/[^\d.]/g, '') === '6000.00', `裝置 A 累計入金 = ${totalA}`);

    console.log('\n[3] 開啟裝置 B（手機），應該一打開就由雲端載入');
    const B = await Page.open(url);
    await sleep(2500);
    const rowsB0 = await B.eval('document.querySelectorAll("#deposit-rows tr").length');
    assert(rowsB0 === 6, `裝置 B 未做任何操作，開頁即載入 6 筆入金（實際 ${rowsB0}）`);

    console.log('\n[3b] 裝置 A 再加一筆 → 裝置 B 靠輪詢自動收到');
    await A.eval(`(function(){
      document.querySelectorAll('input[name="dep-member"]').forEach(function(c,i){ c.checked = (i===0); });
      document.getElementById('dep-amount').value = '500';
      document.getElementById('form-deposit').requestSubmit();
      return true;
    })()`);
    await waitFor(B, 'document.querySelectorAll("#deposit-rows tr").length', 7, '裝置 B 6 秒內自動多出一筆');

    console.log('\n[4] 裝置 B 刪除一筆入金 → 裝置 A 切返分頁後同步');
    await B.activate();
    await B.eval(`(function(){
      document.querySelector('#deposit-rows button[data-act="del-dep"]').click();
      return true;
    })()`);
    await sleep(300);
    const confirmVisible = await B.eval('!document.getElementById("modal-confirm").classList.contains("hidden")');
    assert(confirmVisible, '刪除前彈出確認視窗');
    await B.eval(`document.getElementById('confirm-ok').click()`);
    await sleep(1200);
    const rowsB2 = await B.eval('document.querySelectorAll("#deposit-rows tr").length');
    assert(rowsB2 === 6, `裝置 B 刪除後餘 6 筆（實際 ${rowsB2}）`);

    await A.activate();
    await waitFor(A, 'document.querySelectorAll("#deposit-rows tr").length', 6, '裝置 A 切返分頁後即時同步到刪除結果');

    console.log('\n[5] 裝置 A 買入一張卡 → 裝置 B 見到');
    await A.eval(`(function(){
      document.getElementById('tab-card').click();
      document.getElementById('buy-name').value = '測試卡 /99';
      document.getElementById('buy-price').value = '4500';
      document.getElementById('buy-fee').value = '50';
      document.getElementById('form-card').requestSubmit();
      return true;
    })()`);
    await sleep(1500);
    await B.activate();
    await waitFor(B, 'document.querySelectorAll("#card-rows tr[data-row]").length', 1, '裝置 B 自動見到新買入嘅卡牌');
    const nameB = await B.eval('document.querySelector("#card-rows tr[data-row] td").textContent');
    assert(nameB.includes('測試卡'), '卡牌名稱正確同步');

    const cashB = await B.eval('document.getElementById("stat-cash").textContent');
    assert(cashB.replace(/[^\d.]/g, '').startsWith('950'), `裝置 B 現金餘額 = ${cashB}（5500 − 4550）`);

    console.log('\n[6] 平倉賣出 → 分紅明細');
    await A.activate();
    await A.eval(`(function(){ document.querySelector('#card-rows button[data-act="sell"]').click(); return true; })()`);
    await sleep(300);
    await A.eval(`(function(){
      document.getElementById('sell-price').value = '6000';
      document.getElementById('sell-fee').value = '100';
      document.getElementById('form-sell').requestSubmit();
      return true;
    })()`);
    await sleep(1500);
    const profitA = await A.eval('document.getElementById("stat-profit").textContent');
    assert(profitA.replace(/[^\d.]/g, '') === '1350.00', `已實現盈虧 = ${profitA}（5900 − 4550）`);

    await A.eval(`document.querySelector('#card-rows button[data-act="dividend"]').click()`);
    await sleep(300);
    const divRows = await A.eval('document.querySelectorAll("#dividend-body tbody tr").length');
    assert(divRows === 6, '分紅明細列出 6 位成員');
    const divSum = await A.eval(`(function(){
      var cells = document.querySelectorAll('#dividend-body tbody tr td:last-child');
      var s = 0;
      cells.forEach(function(c){ s += Number(c.textContent.replace(/[^\\d.-]/g,'')); });
      return Math.round(s*100)/100;
    })()`);
    assert(Math.abs(divSum - 1350) < 1, `分紅合計 = ${divSum}（應等於盈虧 1350）`);

    console.log('\n[7] 回歸測試：確認視窗開住期間發生同步，刪除仍然一次搞掂');
    await A.activate();
    const n0 = await A.eval('document.querySelectorAll("#deposit-rows tr").length');
    await A.eval(`document.querySelector('#deposit-rows button[data-act="del-dep"]').click()`);
    await sleep(300);
    // 另一部機喺呢個時候新增資料，令 A 嘅 state 被整批換成新物件
    await B.eval(`(function(){
      document.querySelectorAll('input[name="dep-member"]').forEach(function(c,i){ c.checked = (i===0); });
      document.getElementById('dep-amount').value = '777';
      document.getElementById('form-deposit').requestSubmit();
      return true;
    })()`);
    await sleep(5500);   // 等 A 輪詢完，state 已被替換
    const during = await A.eval('document.querySelectorAll("#deposit-rows tr").length');
    assert(during === n0 + 1, `確認視窗開住期間已同步到新紀錄（${n0} → ${during}）`);
    await A.eval(`document.getElementById('confirm-ok').click()`);
    await sleep(1500);
    const n1 = await A.eval('document.querySelectorAll("#deposit-rows tr").length');
    assert(n1 === n0, `撳一次就刪到，唔需要撳兩次（實際 ${n1}，應為 ${n0}）`);

    await B.activate();
    await waitFor(B, 'document.querySelectorAll("#deposit-rows tr").length', n0, '另一部機亦同步到刪除結果');

    console.log('\n[8] 檢查兩個裝置有無 JavaScript 錯誤');
    const errs = [...A.errors, ...B.errors].filter((e) => !/favicon|tailwind|fonts\.googleapis|net::ERR/i.test(e));
    assert(errs.length === 0, '無 JavaScript 錯誤' + (errs.length ? ' → ' + errs.join(' | ') : ''));

    console.log('\n✅ 全部測試通過\n');
    A.close(); B.close();
  } finally {
    chrome.kill();
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error('\n' + ((e && e.stack) || e) + '\n'); process.exit(1); }
);
